/**
 * Lightweight pull-only ghcr.io proxy for Cloudflare Workers.
 *
 * Supports:
 * - docker / containerd / nerdctl pull
 * - public GHCR images
 * - private GHCR images after:
 *   docker login <your-worker-domain>
 *
 * Does NOT support:
 * - docker push
 * - image deletion
 * - upload / PATCH / PUT / POST
 */

const UPSTREAM_ORIGIN = 'https://ghcr.io';
const TOKEN_PATH = '/token';
const PROXY_VERSION = 'ghcr-pull-proxy/2026-07-04-v2';

export default {
  async fetch(request) {
    const clientUrl = new URL(request.url);

    // 用于确认域名、Worker 路由、部署版本是否正确
    if (clientUrl.pathname === '/') {
      return new Response(
        'GHCR pull proxy is ready. Use this hostname as an image registry.\n',
        {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-ghcr-proxy-version': PROXY_VERSION,
          },
        },
      );
    }

    // pull 只需要 GET / HEAD。
    // 拒绝上传、删除等写操作，避免变成通用 GHCR 发布入口。
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(
        {
          error: 'This proxy is pull-only. Only GET and HEAD are allowed.',
        },
        405,
        {
          allow: 'GET, HEAD',
        },
      );
    }

    // 只暴露 Registry v2 和 token 接口。
    // 避免被拿来当开放 HTTP 代理。
    const isRegistryRequest =
      clientUrl.pathname === '/v2' ||
      clientUrl.pathname.startsWith('/v2/');

    const isTokenRequest = clientUrl.pathname === TOKEN_PATH;

    if (!isRegistryRequest && !isTokenRequest) {
      return json(
        {
          error: 'Only /v2/* and /token are exposed.',
        },
        404,
      );
    }

    // 保留原始路径与 query 参数，例如：
    // /v2/home-assistant/home-assistant/manifests/stable
    // /token?service=ghcr.io&scope=repository:xxx:pull
    const upstreamUrl = new URL(
      clientUrl.pathname + clientUrl.search,
      UPSTREAM_ORIGIN,
    );

    const headers = forwardHeaders(request.headers);

    let upstreamResponse;

    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,

        // GHCR blob 下载有时会跳转到 GitHub / 对象存储。
        // follow 让 Cloudflare Worker 跟随跳转，而不是把 Location 直接丢给客户端。
        redirect: 'follow',
      });
    } catch (error) {
      return json(
        {
          error: 'Unable to reach ghcr.io.',
          detail: String(error?.message || error),
        },
        502,
      );
    }

    const responseHeaders = new Headers(upstreamResponse.headers);

    // GHCR 第一次 /v2/ 请求通常返回：
    //
    // WWW-Authenticate:
    // Bearer realm="https://ghcr.io/token",service="ghcr.io",...
    //
    // 必须替换为当前 Worker 域名。
    // 否则 Docker 后续取 token 时会直接请求 ghcr.io，绕过代理。
    const authChallenge = responseHeaders.get('www-authenticate');

    if (authChallenge) {
      responseHeaders.set(
        'www-authenticate',
        rewriteAuthRealm(authChallenge, clientUrl.origin),
      );
    }

    responseHeaders.set('x-content-type-options', 'nosniff');
    responseHeaders.set('x-ghcr-proxy-version', PROXY_VERSION);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};

/**
 * 透传 Docker / Registry 请求需要的头。
 * 保留 Authorization：
 * - /token 时可能是 Basic Auth
 * - /v2/... 时通常是 Bearer Token
 */
function forwardHeaders(incomingHeaders) {
  const headers = new Headers(incomingHeaders);

  // 不把客户端伪造或 Cloudflare 边缘标识头传给 GHCR。
  // Host 不需要保留，fetch 会按 upstreamUrl 自动处理。
  const removeHeaders = [
    'host',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip',
  ];

  for (const name of removeHeaders) {
    headers.delete(name);
  }

  return headers;
}

/**
 * 将：
 * realm="https://ghcr.io/token"
 *
 * 改为：
 * realm="https://你的域名/token"
 */
function rewriteAuthRealm(challenge, proxyOrigin) {
  return challenge.replace(
    /realm=(?:"https:\/\/ghcr\.io\/token"|https:\/\/ghcr\.io\/token)/i,
    `realm="${proxyOrigin}${TOKEN_PATH}"`,
  );
}

function json(payload, status, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-ghcr-proxy-version': PROXY_VERSION,
      ...extraHeaders,
    },
  });
}
