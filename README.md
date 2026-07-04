# Lightweight GHCR Pull Proxy

一个部署在 Cloudflare Workers 上的轻量化 `ghcr.io` 拉取代理。

它只处理 Docker Registry v2 的镜像拉取链路：Registry 探测、Bearer Token 获取、manifest 获取和 layer blob 下载。目标不是搭建完整镜像仓库，也不支持镜像推送。

```text
Docker / containerd / nerdctl
        │
        ▼
https://ghcr-proxy.example.com/v2/...
        │
        ▼
Cloudflare Worker
        │
        ▼
https://ghcr.io/v2/...
```

## 功能范围

当前版本支持：

* 拉取公开 GHCR 镜像；
* 拉取已授权的私有 GHCR 镜像；
* Docker、containerd、nerdctl 等兼容 Docker Registry v2 的客户端；
* Registry v2 Bearer Token 鉴权；
* OCI Image Index、Docker Manifest List、单架构 Manifest；
* blob layer 的流式下载与上游重定向跟随；
* 透传客户端的 `Authorization` 请求头。

当前版本不支持：

* `docker push`；
* 上传镜像 layer；
* 删除镜像或 tag；
* Docker Hub、Quay、GCR 等其他 Registry；
* 镜像搜索页面；
* 主动缓存或镜像同步；
* 通用 HTTP 反向代理。

这是一个**拉取代理**，不是镜像仓库，也不是通用代理服务。

---

## 为什么需要改写 Token 地址

Docker Registry v2 的典型鉴权流程如下：

```text
1. 客户端访问 /v2/<repo>/manifests/<tag>
2. GHCR 返回 401，并在 WWW-Authenticate 中告知 token 地址
3. 客户端请求 token
4. 客户端带 Bearer Token 重试 manifest 请求
5. 客户端获取 image config 和 layer blobs
```

GHCR 原始响应通常类似：

```http
WWW-Authenticate: Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:owner/image:pull"
```

如果不改写 `realm`，Docker 会直接访问 `ghcr.io/token`，导致 token 请求绕过 Worker。

本项目会将其改写为当前代理域名：

```http
WWW-Authenticate: Bearer realm="https://ghcr-proxy.example.com/token",service="ghcr.io",scope="repository:owner/image:pull"
```

这样 token、manifest 和 blob 请求都会经过 Worker。

---

## 部署

### 1. 创建 Cloudflare Worker

进入 Cloudflare Dashboard：

```text
Workers & Pages
→ Create application
→ Create Worker
```

将项目中的 Worker 代码完整粘贴进去并部署。

建议文件名：

```text
worker.js
```

### 2. 绑定独立子域名

建议绑定独立 Registry 域名，例如：

```text
ghcr-proxy.example.com
```

不要将其挂在普通网站根域名、博客路径或业务 API 路径下。

推荐绑定方式：

```text
Workers & Pages
→ 目标 Worker
→ Settings
→ Domains & Routes
→ Add Custom Domain
```

或者通过 Route 绑定：

```text
ghcr-proxy.example.com/*
```

### 3. 验证部署版本

访问根路径：

```sh
curl -si https://ghcr-proxy.example.com/
```

预期返回：

```http
HTTP/2 200
x-ghcr-proxy-version: ghcr-pull-proxy/2026-07-04-v2
```

正文类似：

```text
GHCR pull proxy is ready. Use this hostname as an image registry.
```

如果没有看到 `x-ghcr-proxy-version`，通常表示域名没有命中当前 Worker，或仍被旧 Worker、Pages 项目、重复 Route 占用。

---

## 验证 Registry 鉴权链路

### 1. 验证 `/v2/` challenge

```sh
curl -si https://ghcr-proxy.example.com/v2/
```

预期返回 `401`，这是正常的 Registry v2 鉴权响应。

重点检查：

```http
www-authenticate: Bearer realm="https://ghcr-proxy.example.com/token",service="ghcr.io",...
x-ghcr-proxy-version: ghcr-pull-proxy/2026-07-04-v2
```

如果 `realm` 仍是：

```text
https://ghcr.io/token
```

说明 Worker 没有正确改写鉴权 challenge，Docker 的 token 请求会绕过代理。

### 2. 验证 token 接口

以下示例使用公开镜像 `home-assistant/home-assistant`：

```sh
curl -si \
  'https://ghcr-proxy.example.com/token?service=ghcr.io&scope=repository:home-assistant/home-assistant:pull'
```

预期：

```http
HTTP/2 200
content-type: application/json
x-ghcr-proxy-version: ghcr-pull-proxy/2026-07-04-v2
```

返回正文中会包含临时 token。不要在日志、Issue、截图或公开聊天中暴露完整 token。

### 3. 验证 manifest 拉取

OpenWrt 可用以下命令：

```sh
TOKEN="$(curl -fsS \
  'https://ghcr-proxy.example.com/token?service=ghcr.io&scope=repository:home-assistant/home-assistant:pull' \
  | jsonfilter -e '@.token')"

curl -sS -D - -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' \
  'https://ghcr-proxy.example.com/v2/home-assistant/home-assistant/manifests/stable'

unset TOKEN
```

成功时应看到：

```http
HTTP/2 200
content-type: application/vnd.oci.image.index.v1+json
docker-content-digest: sha256:...
x-ghcr-proxy-version: ghcr-pull-proxy/2026-07-04-v2
```

---

## 使用方法

原始 GHCR 镜像：

```text
ghcr.io/OWNER/IMAGE:TAG
```

改为代理域名：

```text
ghcr-proxy.example.com/OWNER/IMAGE:TAG
```

例如：

```sh
docker pull ghcr-proxy.example.com/home-assistant/home-assistant:stable
```

拉取完成后，本地镜像名也会带代理域名：

```text
ghcr-proxy.example.com/home-assistant/home-assistant:stable
```

如需保留原始标签名：

```sh
docker tag \
  ghcr-proxy.example.com/home-assistant/home-assistant:stable \
  ghcr.io/home-assistant/home-assistant:stable
```

---

## Docker Compose 示例

原始 Compose 配置：

```yaml
services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
```

改为：

```yaml
services:
  homeassistant:
    image: ghcr-proxy.example.com/home-assistant/home-assistant:stable
```

然后执行：

```sh
docker compose pull
docker compose up -d
```

---

## 私有 GHCR 镜像

私有 GHCR 包需要客户端自行提供 GitHub 认证信息。Worker 不应保存 GitHub PAT，也不应在 Worker 环境变量中写入账户密码。

先对代理域名登录：

```sh
echo 'YOUR_GITHUB_PAT' | docker login ghcr-proxy.example.com \
  -u YOUR_GITHUB_USERNAME \
  --password-stdin
```

然后拉取：

```sh
docker pull ghcr-proxy.example.com/OWNER/PRIVATE_IMAGE:TAG
```

建议使用权限最小化的 GitHub Personal Access Token。

对于仅拉取私有镜像，通常只需相关包的读取权限。具体是否能够拉取，还取决于：

* PAT 是否具有读取 Packages 的权限；
* GitHub 组织是否启用了 SSO；
* PAT 是否已授权该组织；
* 镜像包是否允许该账号访问；
* Package 与 Repository 的权限继承关系。

不要将 PAT 写入 Worker 代码、Git 仓库、Compose 文件或公开脚本。

---

## 设计边界

### Pull-only

Worker 只允许：

```text
GET
HEAD
```

以下方法会被拒绝：

```text
POST
PUT
PATCH
DELETE
```

因此：

```text
docker pull     支持
docker push     不支持
镜像删除         不支持
上传 layer       不支持
```

这是刻意设计，而不是功能缺失。

镜像 push 会产生大体积上传请求，而 Cloudflare Workers 对请求体大小、执行时间和资源使用存在限制。对于镜像分发场景，先保证拉取稳定、可控和不滥用，比将 Worker 改造成不完整的推送入口更合理。

### 不是 Docker Hub Mirror

Docker 的 `registry-mirrors` 主要用于 Docker Hub 镜像镜像源，并不会自动将所有：

```text
ghcr.io/...
```

透明替换为你的代理域名。

使用本项目时，应直接把镜像前缀改为：

```text
ghcr-proxy.example.com/...
```

---

## 缓存策略

当前版本不主动写入 Cloudflare Cache，也不实现 Registry blob 缓存。

这是有意为之，原因包括：

* `latest`、`stable` 等 tag 可能随时指向新的 manifest；
* 私有镜像响应不应被错误共享；
* Token 响应绝不能缓存；
* Authorization 语义不能被简单 URL 缓存键破坏；
* 超大 layer 的边缘缓存命中率、对象大小和成本需要单独评估；
* 缓存错误可能导致旧镜像、鉴权异常或数据暴露。

后续若增加缓存，建议仅评估以下对象：

```text
公开镜像
无 Authorization
不可变 digest 对应 blob
/v2/<repo>/blobs/sha256:<digest>
```

不建议缓存：

```text
/token
带 Authorization 的请求
可变 tag 对应 manifest
私有包响应
```

---

## 安全建议

建议至少配置以下防护：

1. 为代理使用独立子域名，不和主网站共用路径。
2. 启用 Cloudflare WAF 或 Rate Limiting，限制异常高频请求。
3. 对 `/v2/*` 和 `/token` 设置合理访问频率限制。
4. 不要在 Worker 中保存 GitHub PAT。
5. 不要将 token、Authorization Header、Docker config.json 上传到 GitHub。
6. 定期检查 Cloudflare Worker Analytics、错误率和带宽使用情况。
7. 若代理仅供自己使用，可考虑增加 Cloudflare Access、IP Allowlist 或 WAF Allowlist。

需要注意：公开 GHCR 镜像本身无需认证，因此公开代理域名可能被他人用于中转拉取公共镜像。私有镜像不会因此自动泄露，因为仍需有效的 GitHub token；但公共流量、带宽和 Worker 请求额度可能被滥用。

---

## 常见问题

### `/v2/` 返回 401，是否代表失败？

不是。

Docker Registry v2 的首次请求通常就是：

```http
HTTP/2 401 Unauthorized
WWW-Authenticate: Bearer ...
```

关键不是状态码，而是 `WWW-Authenticate` 中的 `realm` 是否已经改成你的代理域名。

### `/v2/` 中仍出现 `https://ghcr.io/token`

说明 Worker 没有正确命中、没有部署最新版本，或被旧 Route / Pages 自定义域名覆盖。

优先检查：

```text
Workers & Pages
→ Worker
→ Settings
→ Domains & Routes
```

确认域名只绑定到当前 Worker。

### `/token` 返回 200，但 Docker 拉取仍失败

先确认 manifest 是否可通过 Bearer Token 获取。

如果 manifest 成功而 Docker 拉取失败，问题通常可能在：

* Docker daemon 的网络、DNS 或代理配置；
* blob layer 下载过程；
* 上游重定向目标被网络阻断；
* 镜像本身不存在对应平台架构；
* 私有镜像权限不足；
* Cloudflare WAF 或速率限制规则误拦截。

可执行：

```sh
docker pull --debug ghcr-proxy.example.com/OWNER/IMAGE:TAG
```

并重点保留报错末尾的 Registry、manifest 或 blob 相关信息。不要公开贴出 token、Authorization Header 或 Docker 登录配置。

### 为什么不加入镜像搜索页、多仓库路由和 Docker Hub 兼容？

因为当前目标是一个可验证、低复杂度、低攻击面的 GHCR 拉取代理。

增加搜索页、环境变量路由、多 Registry 兼容、伪装页、Docker Hub 特殊规则后，复杂度和故障面都会快速上升；而这些功能不会提高 GHCR 拉取链路的可靠性。

---

## 运行验证记录

一个成功的 GHCR manifest 验证响应应类似：

```http
HTTP/2 200
content-type: application/vnd.oci.image.index.v1+json
docker-content-digest: sha256:...
docker-distribution-api-version: registry/2.0
x-ghcr-proxy-version: ghcr-pull-proxy/2026-07-04-v2
```

这意味着以下链路都已验证：

```text
Worker 域名路由
→ GHCR /v2/ challenge
→ Token realm 改写
→ /token 请求转发
→ Authorization 透传
→ Manifest 获取
```

最后再执行一次真实镜像拉取：

```sh
docker pull ghcr-proxy.example.com/home-assistant/home-assistant:stable
```

若拉取完成，则 manifest、多架构平台选择、image config 和 layer blob 下载均已跑通。
