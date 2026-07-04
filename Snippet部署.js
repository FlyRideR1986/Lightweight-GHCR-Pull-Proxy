/**
 * GHCR Pull Proxy - Cloudflare Snippet Edition
 *
 * 设计目标：
 * - 代理 GHCR 的 Registry v2 鉴权、token、manifest 请求
 * - 改写 WWW-Authenticate realm 到当前代理域名
 * - 不在 Snippet 内跟随 blob 重定向
 *
 * 支持：
 * - docker pull
 * - containerd / nerdctl pull
 * - 公共 GHCR 镜像
 * - 私有 GHCR 镜像（客户端自行 docker login）
 *
 * 不支持：
 * - docker push
 * - PUT / POST / PATCH / DELETE
 * - layer blob 由 Cloudflare 全程中转
 */

const UPSTREAM_ORIGIN = "https://ghcr.io";
const TOKEN_PATH = "/token";
const VERSION = "ghcr-snippet-control-plane/2026-07-04-v1";

export default {
  async fetch(request) {
    const clientUrl = new URL(request.url);

    // 方便确认 Snippet 是否已命中。
    if (clientUrl.pathname === "/") {
      return new Response(
        "GHCR Snippet proxy is ready.\n" +
        "Mode: token + manifest proxy; blob redirects are returned to the client.\n",
        {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-ghcr-proxy-version": VERSION,
            "x-ghcr-proxy-mode": "snippet-control-plane",
          },
        },
      );
    }

    // 只允许镜像拉取所需的只读方法。
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        {
          error: "This endpoint is pull-only. Only GET and HEAD are allowed.",
        },
        405,
        {
          "allow": "GET, HEAD",
        },
      );
    }

    const isRegistryRequest =
      clientUrl.pathname === "/v2" ||
      clientUrl.pathname.startsWith("/v2/");

    const isTokenRequest = clientUrl.pathname === TOKEN_PATH;

    if (!isRegistryRequest && !isTokenRequest) {
      return json(
        {
          error: "Only /v2/* and /token are available.",
        },
        404,
      );
    }

    const upstreamUrl = new URL(
      clientUrl.pathname + clientUrl.search,
      UPSTREAM_ORIGIN,
    );

    const headers = makeUpstreamHeaders(request.headers);

    let upstreamResponse;

    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,

        /*
         * Snippet 关键设置：
         *
         * 不跟随 GHCR blob 的 302/307 Location。
         *
         * 否则一次 blob 请求会消耗：
         * 1. Snippet -> ghcr.io
         * 2. Snippet -> GitHub CDN / object storage
         *
         * Pro Snippet 的 subrequest 上限只有 2，
         * 一旦上游出现额外重定向，就可能触发 1202。
         *
         * redirect: "manual" 会把 Location 原样交给 Docker 客户端，
         * 由 Docker 直接获取带签名的 blob 下载地址。
         */
        redirect: "manual",
      });
    } catch (error) {
      return json(
        {
          error: "Unable to reach ghcr.io.",
          detail: String(error?.message || error),
        },
        502,
      );
    }

    const responseHeaders = new Headers(upstreamResponse.headers);

    // /v2/ 或 manifest 未携带 token 时，GHCR 会返回 401 challenge。
    // 必须将 realm 改为当前 Snippet 域名，否则 Docker 会直接请求 ghcr.io/token。
    const authChallenge = responseHeaders.get("www-authenticate");

    if (authChallenge) {
      responseHeaders.set(
        "www-authenticate",
        rewriteAuthRealm(authChallenge, clientUrl.origin),
      );
    }

    // token 响应不应被浏览器/CDN意外缓存。
    if (isTokenRequest) {
      responseHeaders.set("cache-control", "no-store");
    }

    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("x-ghcr-proxy-version", VERSION);
    responseHeaders.set("x-ghcr-proxy-mode", "snippet-control-plane");

    /*
     * 注意：
     * - manifest 请求通常是 200，响应体经过 Snippet 返回。
     * - blob 请求若 GHCR 返回 302/307，这里会保留 Location。
     * - Docker 会自行跟随 Location 到 GHCR/GitHub 的对象存储。
     */
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};

/**
 * 保留 Registry 鉴权所需头：
 * - Authorization: Bearer / Basic
 * - Accept
 * - User-Agent
 *
 * 删除 Cloudflare / Hop-by-hop / 客户端伪造的转发头。
 */
function makeUpstreamHeaders(incomingHeaders) {
  const headers = new Headers(incomingHeaders);

  const blocked = [
    "host",
    "connection",
    "content-length",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ];

  for (const name of blocked) {
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
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-ghcr-proxy-version": VERSION,
      "x-ghcr-proxy-mode": "snippet-control-plane",
      ...extraHeaders,
    },
  });
}
