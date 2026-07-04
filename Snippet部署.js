/**
 * GHCR Pull Proxy - Cloudflare Snippet Edition
 * Mode: follow redirects
 *
 * 目标：
 * - token / manifest / blob layer 均通过 Cloudflare 中转
 * - 让 layer 下载路径接近 Worker 版，通常比 manual redirect 更快
 *
 * 风险：
 * - Pro Snippet 每次请求只有 2 个 subrequests
 * - GHCR blob 常见为：
 *   Snippet -> ghcr.io -> GitHub object storage
 * - 一旦额外重定向，可能触发 Error 1202
 */

const UPSTREAM_ORIGIN = "https://ghcr.io";
const TOKEN_PATH = "/token";
const VERSION = "ghcr-snippet-follow/2026-07-04-v1";

export default {
  async fetch(request) {
    const clientUrl = new URL(request.url);

    // 用于确认 Snippet 是否命中
    if (clientUrl.pathname === "/") {
      return new Response(
        [
          "GHCR Snippet proxy is ready.",
          "Mode: follow redirects.",
          "Token, manifest and blobs are proxied through Cloudflare.",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-ghcr-proxy-version": VERSION,
            "x-ghcr-proxy-mode": "snippet-follow",
          },
        },
      );
    }

    // 只做 pull，不允许 push / delete / upload
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        {
          error: "This proxy is pull-only. Only GET and HEAD are allowed.",
        },
        405,
        {
          allow: "GET, HEAD",
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
         * 核心差异：
         *
         * follow:
         *   GHCR 返回 blob 302/307 后，
         *   Snippet 自动继续访问 GitHub CDN / object storage，
         *   然后把最终 layer 数据流回传给 Docker。
         *
         * 这会获得更接近 Worker 的数据路径和下载性能。
         */
        redirect: "follow",
      });
    } catch (error) {
      return json(
        {
          error: "Unable to reach upstream GHCR or redirected blob storage.",
          detail: String(error?.message || error),
        },
        502,
      );
    }

    const responseHeaders = new Headers(upstreamResponse.headers);

    // 将 GHCR 的 token realm 改写为当前 Snippet 域名
    const authChallenge = responseHeaders.get("www-authenticate");

    if (authChallenge) {
      responseHeaders.set(
        "www-authenticate",
        rewriteAuthRealm(authChallenge, clientUrl.origin),
      );
    }

    // Token 响应绝不能缓存
    if (isTokenRequest) {
      responseHeaders.set("cache-control", "no-store");
    }

    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("x-ghcr-proxy-version", VERSION);
    responseHeaders.set("x-ghcr-proxy-mode", "snippet-follow");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};

/**
 * 保留 Docker Registry 请求所需鉴权头：
 * - Authorization: Bearer / Basic
 * - Accept
 * - User-Agent
 *
 * 移除不该转发给 GHCR 的客户端 / Cloudflare 网络头。
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
 * 将:
 * realm="https://ghcr.io/token"
 *
 * 改为:
 * realm="https://当前代理域名/token"
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
      "x-ghcr-proxy-mode": "snippet-follow",
      ...extraHeaders,
    },
  });
}
