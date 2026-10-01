# 设计说明

## 1. 目标与范围

SaaS 版客户端每次启动/进入下一个日程都会拉一次天气。这条链路原来是
`客户端 → ESA → FC（AstraSaaS-Go）→ 和风天气`，ESA 只是一个透明代理，
所以每次拉天气都要把 FC 调起来。

本仓库把「取天气」搬到边缘：边缘自己查和风天气、自己缓存，**FC 完全不参与这条路径**。

本仓库接管三类请求：

- 天气：`GET /api/weather/<城市>[/<省份>]` 与不带城市的 `GET /api/weather/`（第 3～5 节）；
- 课表版本：`GET /<学校>/<年级>/<班级>?version=<版本串>`（第 8 节）；
- 连通性探针：`/`（第 3.2 节，任何方法都在边缘作答、只回与源站同形的响应，不拉 FC 实例）。

其余请求（非 GET、路径不匹配、课表请求不带 `version` 参数）一律 `fetch(request)` 透传。

**天气一旦被接管就不再回源**：缺凭据、定位不到城市、上游失败都由边缘自己作答，
状态码与响应体形态对齐源站（见第 5 节）。

## 2. 数据模型

### 键

`w1.<base64url(城市)>.<base64url(省份)>`，省份为空时就是 `w1.<城市>.`。

| 规则 | 原因 |
|---|---|
| 必须编码 | ESA 边缘 KV 拒绝非 ASCII 键（实测：中文键返回 `InvalidKey.Malformed`），城市名全是中文 |
| 用 base64url | 编码输出只有 `A-Za-z0-9-_`，全是 KV 允许的字符 |
| 键里用 `.` 分隔 | base64url 的输出里不会出现 `.`，所以切分无歧义 |
| 键里**不带** host | 天气与租户无关（同一套和风天气凭据），多租户共用同一份缓存是想要的效果 |

### 值

```json
{ "b": "<响应体字符串>", "e": 1790392327 }
```

`b` 是**已经组装好的响应体**，命中时原样返回，边缘不再做任何拼装；`e` 是绝对 Unix 秒。

ESA 边缘 KV **没有 TTL 能力**（运行时的 `EdgeKV` 只有 `get` / `put` / `delete`），
所以过期时刻只能存在值里，由读取方自己比较。

### TTL 为什么是 600 秒

源站天气接口挂的是 `cache.CachePage(weatherCacheStore, 10*time.Minute, ...)`，
本来就是 10 分钟粒度。边缘取同一个值，语义不变，只是把缓存从「单个 FC 实例的内存」
挪到了全球共享的边缘 KV。

## 3. 请求流程

1. 方法不是 `GET` → 透传。
2. 路径不是 `/api/weather/<城市>[/<省份>]` 也不是 `/api/weather/`（例如
   `/api/weather/a/b/c`）→ 透传。
   路径段要做 `decodeURIComponent`：客户端把地区设置原样拼进 URL，Node 会把非 ASCII
   百分号编码，边缘拿到的是编码后的形态。解码失败（畸形百分号序列）一律不接管。
3. 路径是 `/api/weather/`（不带城市）时，用 `request.info.ip_city_en` 定位城市，见第 3.1 节。
4. 读函数变量拿和风天气凭据；缺任何一项 → 边缘回 403，不回源（见第 5 节）。
5. 读 KV：命中且 `e` 未过期 → 直接返回，带 `X-Astra-Edge-Weather: hit`。
6. 未命中 → 边缘查和风天气：
   - `GET /geo/v2/city/lookup?location=<城市>[&adm=<省份>]` → 城市 ID、经纬度、标准名；
   - `GET /v7/weather/now?location=<城市 ID>` → 实时天气（`temp` 为空视为失败）；
   - `GET /weatheralert/v1/current/<lat>/<lon>` → 预警，经纬度取 5 位小数（与源站一致）；
   - 预警失败**不算失败**，按空数组处理（源站也是 `warnResp, _ := ...`）。
7. 组装响应体、写 KV、返回，带 `X-Astra-Edge-Weather: miss`。

### 3.1 不带城市：从 Cloudflare 的 CF-IPCity 换到 ESA 的 request.info

客户端没配地区时请求的是 `/api/weather/`，语义是「按客户端 IP 定位」。这条路径原来靠
Cloudflare 注入的 `CF-IPCity` / `CF-Region`，站点迁到 ESA 之后这两个头不再存在，
源站那条分支只剩 400（实测 `class.getastra.cn/api/weather/` 迁移后就是这个结果）。
ESA 的等价物是运行时的 `request.info`，实测形态：

```json
{ "ip_city_en": "Nanjing", "ip_region_en": "Jiangsu", "ip_region_id": "CN-JS",
  "ip_country_id": "CN", "ip_city_id": "320100", "remote_addr": "180.111.34.224" }
```

只有英文名和行政编码、没有中文名；和风天气的城市查询支持英文城市名（实测
`Nanjing` / `Chongqing` / `Beijing` / `Guangzhou` 都能查到正确的中文标准名），
所以直接用 `ip_city_en` 当 `location`，定位到的城市照常走第 3 节的同一套流程与缓存。

**不把 `ip_region_en` 当 `adm`**：实测带不带 adm 结果完全一致，而多传一个省名就多一种
对不上和风天气 adm 词表的可能（`Nei Mongol` / `Inner Mongolia` 这类拼法差异），
少一个参数少一种失败模式。

定位不到城市（`request.info` 缺失，或只有国家没有城市）→ 边缘回 400，不回源。

### 3.2 根路径 `/`：连通性探针不进 FC

客户端与监控常打 `GET /` 只为确认「网络通不通」，源站对它的响应是 gin 根路由的
`c.JSON(200, gin.H{"message": "Hello World"})`（`usr-backend/main.go`、
`sys-backend/router/setup.go`）。这条请求不承载业务，却会把 FC 实例拉起来（冷启动几百毫秒起），
也让「FC 层是否可用」的观测被连通性噪声污染。

接管规则（判定只看 `new URL(request.url).pathname` 是否恰好是 `/`，**不看方法**）：

- `GET /` → 200 + `{"message":"Hello World"}` + `Content-Type: application/json; charset=utf-8`，
  与源站根路由逐字同形；`HEAD /` → 200 空体；`OPTIONS /` → 204 空体。
- 其余方法（`POST`/`PUT`/`DELETE` …）→ 404 + `Content-Type: text/plain` + `404 page not found`
  （18 字节），即源站 gin 对未注册方法的默认 404。
- 以上所有分支都带标记头 `X-Astra-Edge-Root: hit`（值只会是 `hit`），且**都不回源**。
- 带查询串的 `/`（如 `/?probe=1`）同样接管；只有非 `/` 的路径返回 `null` 交回原流程。

为什么连 `POST /` 也不放回源：路由规则本身把 `http.request.uri.path == "/"` 的请求全量送进函数，
再放回去等于白拉一次 FC；而且写请求会先经过 `handleMutating`，等于为一句探针顺带跑一遍 KV 失效。
各方法的响应按**实测到的源站行为**镜像：源站只注册了 `GET /`，gin 按方法建路由树，`HEAD /` 与
`POST`/`PUT`/`DELETE /` 实际是 404（`text/plain`，18 字节），`OPTIONS /` 由 CORS 中间件回 204。
边缘对 `HEAD` 按「通」答 200 空体（探测只关心可达性），其余方法原样镜像状态码与体——于是
`/` 上**没有任何一个方法**会再拉起 FC 实例。

这条路径上还有两层会先于函数结束请求，实测：站点 WAF 的「非标 UA 挑战」对 API 主机上的
非第一方 UA 直接在边缘作答（`X-Tengine-Error: denied by http_custom`，没有 fc 头）；Pages 托管的
域名（`i.`/`www.`/`dev.`/`go.`/裸域）被路由规则的 host 黑名单排除，`/` 由 Pages 命中。函数这一层
兜住的是带着第一方 UA 打到 API 主机的探针（桌面端、监控）。

对应 ESA 路由是**独立一条**（ConfigId `522037019918336`，RouteName `edge-root-probe`，
Sequence 2，`RouteEnable on`）：

```
not http.host in {"getastra.cn" "www.getastra.cn" "i.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and http.request.uri.path == "/"
```

> 字段选择：用 `http.request.uri.path`（只含路径）而不是 `http.request.uri`（阿里云文档口径为「路径 + 查询串」）。2026-10-01 实测 `http.request.uri == "/"` 在 ESA 函数路由里也能匹配 `/?probe=1`（`sys.`/`to.` 上带 `AstraSchedule` UA 仍回 `X-Astra-Edge-Root: hit`，而这两个域名被天气那条规则整体排除，POST `/web/auth/login` 又确实仍到 FC，说明函数只能从本路由进来），但既然文档把 `.path` 定义为纯路径，就用 `.path` 明示意图，不依赖等值比较的实现细节。

这条的黑名单比天气那条少两个（少了 `sys.getastra.cn` 与 `to.getastra.cn`）：天气那条含「非
GET/OPTIONS → 进函数」的子句，必须把这两个纯 API 域名排除掉，否则会劫持它们的写请求；根路径
规则只匹配 `/`，不存在这个问题。于是 API 域名（`class.`/`sys.`/`to.`/`njx.`/`sandbox.`/`kuohu.`）的
`/` 全部由边缘作答，只有 Pages 托管的五个域名继续交给 Pages。

**为什么不并进天气那条规则**：单条规则的嵌套层级受套餐配额限制，实测追加子句会报
`NestedRuleQuotaCheckFailed`；单独一条只有 `A and B` 一层，可正常创建。

实测（2026-10-01，生产）：

| 请求 | 结果 |
|---|---|
| `GET https://class.getastra.cn/`（UA `AstraSchedule/1.6.1`） | 200 `{"message":"Hello World"}`、`X-Astra-Edge-Root: hit`、**无** `x-fc-request-id` |
| `HEAD https://class.getastra.cn/` | 同上（空体） |
| `GET https://class.getastra.cn/?probe=1` | 同上 |
| `POST https://class.getastra.cn/` | 404 `404 page not found`（`text/plain`）、`X-Astra-Edge-Root: hit`、无 `x-fc-request-id` |
| `OPTIONS https://class.getastra.cn/` | 204 空体、`X-Astra-Edge-Root: hit`、无 `x-fc-request-id` |
| `GET https://class.getastra.cn/web/countdown?scope=39%2F2023%2F1` | 仍到 FC（有 `x-fc-request-id`） |
| `GET https://i.getastra.cn/`、`www.`、`go.getastra.cn/` | 仍由 Pages 作答（`X-Site-Cache-Status: HIT`） |
| `GET https://sys.getastra.cn/`、`https://to.getastra.cn/` | 200 `{"message":"Hello World"}`、`X-Astra-Edge-Root: hit`、无 `x-fc-request-id`（原先 `sys.` 的 Hello World 与 `to.` 的 404 都来自 FC） |
| `POST https://sys.getastra.cn/web/auth/login` | 仍到 FC（400 `{"detail":"无效参数"}`、有 `x-fc-request-id`）——API 写请求未受影响 |

### 3.3 最低兼容客户端版本闸门：旧客户端一律 426

函数做的第一件事（在根路径探针之前）是判客户端版本：函数变量 `MIN_CLIENT_VERSION` 一旦配置，
UA 版本低于它的客户端——**不论方法、路径、version 参数是什么**——都由边缘直接回 426，绝不回源。
返回 `null` 表示放行，交回原来的流程。

- 判据：UA 前缀 `AstraSchedule/<版本>`（`desktop/main/client-ua.js` 逐字生成），版本按**段数值**比较
  而不是字符串字典序（`202609.28.150` > `202609.5.1`），缺段按 0 补（`202610.1` 与 `202610.1.0` 相等），
  `>=` 阈值即放行。
- 426 响应带 `X-Astra-Edge-Min-Version: block` 与 `X-Astra-Min-Client-Version: <阈值>`，体是
  `{"error":"客户端版本过低…","min_version":"<阈值>"}`，并带 `Cache-Control: no-store`；
  `HEAD` 同样 426 但不带响应体。
- 三条边界：**变量没配、或值不是点分纯数字 → 闸门整体关闭**（fail-open，不因一次配置笔误把全量客户端
  挡在门外）；**非 `AstraSchedule` 的 UA（浏览器、脚本、扫描器）一律放行**（开发调试要用，这类来源在
  WAF 层另有 JS 质询兜底）；**客户端版本号缺失或含非数字段按 0 处理**，即同样被拦。

为什么要有这条闸门：

- 客户端默认开启自动更新，而 426 不影响更新流程，于是旧版本会**被迫升到携带版本号的构建**；升级完成前
  它在边缘拿不到任何数据（只显示本地缓存，不报错），也就不会再把 `version=0` 这种会整片打穿课表缓存的
  请求送进源站。
- 淘汰版本的轮询（含历史上那两台每 2.5 秒一次的失控重试）到此为止：426 在边缘作答，不拉起 FC 实例，
  源站不再为旧客户端的噪声买单。
- 与第 8 节的课表版本缓存**互补而不重叠**：闸门决定「谁能进这个函数」，缓存判据决定「进来之后要不要回源」。
  闸门不改变命中/回源逻辑，只把版本号不可信的来源挡在外面——所以它不能替代写入失效（8.3），
  源站那半边的 `X-Astra-Purge-Scopes` 仍然必须补上。
## 4. 响应体为什么要「逐字同形」

这条链路的隐式契约是客户端：`desktop/js/renderer.js` 直接读 `temp` / `weat` / `warn` /
`brief_warn` 等字段。所以边缘拼的 JSON 必须与源站 `model.WeatherResponse` 一模一样：

```json
{ "where": "北京", "temp": "24", "weat": "晴", "wind": "西北风",
  "wind_power": "2", "warn": "...", "brief_warn": "..." }
```

预警文案的拼接规则也照抄源站：每条 `description` / `headline` 去掉换行后用 `；` 连接。

## 5. 降级策略：失败也在边缘作答，不回源

| 情况 | 边缘行为 |
|---|---|
| 没配函数变量 / 主机名非法 / API Key 为空 | 403 |
| `request.info` 定位不到城市 | 400 |
| 和风城市查询失败（城市不存在等） | 404 |
| 和风实时天气失败（非 200、非 JSON、`code != "200"`、`now.temp` 为空） | 502 |
| KV 构造、读、写、值解析失败 | 天气照常返回（照旧查上游），只是不缓存 |
| 函数内部抛任何异常 | 捕获后回 502，不把异常抛给客户端 |
| 函数被平台打断（如 CPU 超限） | 路由的 `Fallback: on` 兜底回源 |

理由：迁移后源站那条天气分支只剩 400（第 3.1 节实测），定位不到城市时回源不可能成功，
只会把 FC 再拉起来一次；天气是客户端每次启动都要拉的链路，回源与「FC 完全不参与」的目标相悖。

响应形态对齐源站 `usr-backend/router/client/getWeather.go`：

| 状态码 | 响应体 |
|---|---|
| 403 | `{"error":"未配置天气认证信息：请在 ESA 边缘函数的函数变量中配置 QW_API_HOST 与 QW_API_KEY"}` |
| 400 | `{"error":"无法从客户端 IP 定位城市：请求可能没有经过 ESA 边缘节点，或运行时 request.info 缺少 ip_city_en"}` |
| 404 | `{"temp":"404","weat":"不存在","warning":"","brief_warn":""}`（逐字同形） |
| 502 | `{"error":"获取天气信息失败，超过最大重试次数，可能是上游服务器异常，或是本服务器存在网络波动"}`（逐字同形） |

- 只在**状态码与 JSON 键形状**上对齐源站：客户端 `desktop/main.js` 的
  `requestWeatherWithRetry` 只区分「2xx 就用 / 非 2xx 就静默重试」，不读错误文案。
- 403 / 400 的错误文案**故意与源站不同**：源站那句「请配置 JWT（kid/project_id/private_key_pem）」
  「请确保请求经过 ESA 或 Cloudflare」在边缘是假的，照抄只会误导排障。
- 所有边缘作答都带 `X-Astra-Edge-Weather: error`（命中是 `hit`、查上游是 `miss`），
  回源则完全没有这个头，排障时一眼可辨。
- 代价：源站 `usr-backend/router/client/stats.go` 的 `recordWeatherError`（按命名空间计的
  上游失败计数）从此看不到这些失败，观测口径需要用边缘日志补齐。

## 6. ESA 平台实测结果

| 项 | 实测 | 对设计的影响 |
|---|---|---|
| 边缘函数读变量 | `fetch(request, context, env)` 的**第三个**参数 | 取 `env`；为稳妥同时看一眼 `context` |
| 变量键字符集 | 只能字母、数字、下划线 | `QW_API_HOST` / `QW_API_KEY` |
| 加密变量 | `esa-cli secret put` 写入后控制台不回显，代码里拿到明文 | API Key 用 secret，主机名用明文 env |
| 变量生效时机 | 改完必须**重新部署版本**才绑定新快照 | 部署流程是「先写变量、再 deploy」 |
| KV 键字符集 | 非 ASCII、空格、`/` 都拒绝 | 城市名必须 base64url 编码 |
| KV TTL | OpenAPI 有 `--Expiration`，但运行时 `EdgeKV` 没有 | 过期时刻存值里 |
| KV 一致性 | 最终一致，最迟 300 秒同步全球 | 新写入的城市短时间内仍会 miss（实测如此） |
| KV 容量 | 单键 ≤512B、单值 ≤1.8MB | 键约 30 字节、值约 0.5KB，余量很大 |
| 客户端信息 | 运行时 `request.info` 提供 `ip_city_en` / `ip_region_en` / `ip_city_id` / `remote_addr` 等，**没有中文城市名**；本函数的请求里**看不到** `ali-ip-city` 这类托管转换头 | 不带城市的路径用 `ip_city_en`，用英文名查和风天气 |
| 函数路由规则 | `esa-cli route add -r "<host>/api/weather/*"` 会生成简单模式规则；线上最终用的是等价的自定义规则 `(not http.host in {...} and starts_with(http.request.uri, "/api/weather/"))` | 仍然只匹配一个路径前缀，不需要为每个租户域名单独配 |
| 函数配额 | 免费模式 20 个函数（当前用 6 个）、每天 10 万次函数请求，账号级共享 | 路由只匹配一个路径前缀，避免把整个域名流量算进配额 |

## 7. 已知风险

### 7.1 新写入的缓存有最长 300 秒的「看不见」窗口

边缘 KV 最终一致。实测：刚写进 KV 的条目，紧接着的请求仍可能 miss 并再次查和风天气。
这不会返回错数据，只是多花一次上游调用。对天气这种 10 分钟粒度、可重复取值的数据可以接受。

### 7.1.1 过期条目不会自己消失

边缘 KV 没有 TTL，过期只是「读到 `e` 已过就当作 miss」，条目本身仍在。同一个城市下一次
被访问时会原地覆盖，所以不会无限增长（键的数量 = 出现过的城市写法数），但**没人访问过的
冷门城市会一直留着**。量级上：单值约 0.5KB、空间 1GB，且每 10 分钟覆盖写同一个键，
可以忽略。

### 7.2 和风天气的额度由边缘共享

原来每个 FC 实例各有一份 10 分钟内存缓存，实例多时上游调用会被放大；现在全球共享一份，
调用量只会比原来更少。但反过来：**边缘 KV 一旦失效**（例如写不进去），所有城市的请求都会
直连和风天气——按第 5 节这种情况不回源，所以上游调用量会随 KV 失效一起放大。

### 7.3 函数配额是账号级共享的

超限会让 `docs-site`、两个 dashboard、`reg-go` 的函数一起 503。
所以路由写的是**单个路径前缀**而不是整个域名。

## 8. 课表版本缓存（2026-09-27 实现，2026-10-01 改判据）

issue #63 的主体是「客户端带着本地 `version` 回来时直接在边缘回 304」。实现不依赖源站新增
响应头，只用客户端本来就带的 `version` 查询参数与响应体里的 `version`：

- 命中：路径恰好三段、有 `version` 参数、KV 里的版本串与客户端带来的串**在「数据版本 + 教学周」
  上一致**（第三段不参与判定，客户端可以不带第三段）、且未越过存下来的到期时刻 → **304** +
  `X-Astra-Edge-Schedule: hit`，不回源；
- 回源一律带 `version=0`：源站 200 时按响应体里的 `version` 刷新 KV，到期时刻取该串第三段；
- 键 `s1.<base64url(host)>.<base64url(school)>.<base64url(grade)>.<base64url(class)>`，
  与天气的 `w1.` 并存于 `astra`；租户之间靠 host 区分。

### 8.1 为什么不能拿第三段做整串比较

版本串第三段是**每台设备各自的**「最后一次生成快照那天 + 7 天」（源站
`service.VersionBoundary` 里的 `dateOnly(now).AddDate(0, 0, 7)`）：同一天之内不变，跨一天就变，
而数据一个字都没改。源站 2026-10-01 起只按「数据版本 + 教学周」判定 304
（`usr-backend/router/client/getSchedule.go`，PR #53/#54），对任意一个仍在未来的第三段都答 304。

边缘每个班只有一个 KV 槽，整串比较时只能命中**其中一台设备**的串，其余设备全部 miss → 回源 →
源站答 304；旧实现这时还把请求者那串写回 KV，槽位就在各设备的串之间来回被覆盖，回源永不收敛
——线上表现就是大量本该在边缘答 304 的请求抵达源站，且期间没有任何数据变更。改成「只比数据版本 +
教学周」后，命中判定不再依赖槽里存的是谁的串，回源拿到 200 后槽里就是源站当前那串（带真实变化点），
到期时刻因此真正生效。

### 8.2 没有变化点段＝304 长期有效，过期由写入强制

源站 `scheduleVersion` 只在 `service.VersionBoundary` 算出未来变化点时才输出第三段，
注释写明「不存在后续变化点时省略该段，304 缓存长期有效」
（`usr-backend/router/client/getSchedule.go`）。边缘镜像这个口径：到期时刻只取源站给的第三段，
没有该段就存 `e = 0`；**边缘不设任何自造的 TTL 上界**（曾短暂写过 600 秒软过期，已按此口径撤销）。

数据陈旧由写入强制关闭：任意一次课表写入都会推进数据版本，源站在写入响应里带
`X-Astra-Purge-Scopes`，边缘在 `handleMutating` 里删掉对应键，下一次读回源即拿到新的数据版本与
新的到期时刻。命中不要求到期时刻 `> 0`：`e = 0` 表示当时没有已知的未来变化点，照常命中。

第二条强制通道在客户端侧：**时间驱动的日程状态变化**（`js/renderer.js` 的每秒 tick，进入下一个
日程时发 `getScheduleFromCloud` IPC）会让 `desktop/main.js` 的处理器先把 `currentVersionToken` 归零，
于是该次请求带 `version=0`；`0` 与任何真实版本串的身份都不相等，**一定 miss → 回源 200 → 就地刷新 KV**，
不依赖写入失效（单测：`test/schedule.test.js` 的 `version=0 一律回源并刷新 KV`）。冷启动时本地版本索引
取不到可复用串（`main/scheduleVersion.js` 的 `pickReusableVersion` 返回 null）同样以 `version=0` 首发。

**已知取舍**：部署版客户端的托盘菜单「更新课表」与 WS `SyncConfig` 直接调 `getScheduleFromCloud()`，
**不带** `version=0`（沿用本地令牌）——这两条路径会先走边缘判定，遇到陈旧条目时可能仍显示旧课表，
要等日程状态变化触发上面那条通道、或写入失效删键才被纠正。

### 8.3 已知风险

- **写入失效按写请求的 Host 拼键，两条管理端线的结果不同**：源站已在写入响应里带
  `X-Astra-Purge-Scopes`（`usr-backend/router/client/putSchedule.go`、`router/web/helpers.go`），
  边缘在 `handleMutating` 里用 `purgeKeysOf(hostOf(request), ...)` 删键
  （`src/index.js:686-699`；只有非 GET/HEAD 才进这条路径，见 `src/index.js:82-84`）。键对不对得上，
  取决于**写请求的 Host 是否等于客户端读取的 Host**：
  - SaaS 线（`usr-dashboard` 的 `saas/main`，ESA Pages）：后端地址由登录页填写并存在 localStorage
    （`src/views/Login.vue` 占位「例如：aaa-do.getastra.cn」、`src/global.js` 的 `getServer()`），
    写请求 Host 与客户端读取的 Host 一致，站点路由也覆盖非 GET/OPTIONS，因此失效键能对上、失效生效；
  - 旧自托管线（`main`）：`src/global.js:1` 硬编码 `https://class.khbit.cn`，该站点没有挂边缘路由
    （`aliyun esa ListSiteRoutes --SiteId 1154419338136032` → `TotalCount: 0`），失效头到不了边缘。
    这条线是自部署版本、目前不在线上运行，只作为地址填写示例保留。
  写入失效没到边缘时，正命中的客户端最晚等存下来的到期时刻到点才看到新数据：有变化点时最迟第 7 天末
  （`VersionBoundary` 取的是「真实变化点」与「当天 +7 天」的较早者）；没有变化点（`e = 0`）时，
  只能靠下一次写入——写入必然推进数据版本并带失效头；
- **KV 最终一致**（第 6 节，最长 300 秒）：刚部署或刚写过时，有的 POP 还没有条目、有的还是旧条目，
  这些请求会回源一次；回源带 `version=0`，拿到 200 与最新快照，所以客户端能顺带更新自己的版本串；
- **`revalidated` 只剩兜底语义**：源站不再用第三段判定后，回源正常必得 200。线上再出现
  `revalidated` 说明源站回到了旧版本（例如回滚）；此时边缘也不会拿请求者的串覆盖共享槽。

## 9. 上线前验证状态（2026-09-26）

已实测通过：

1. `esa-cli deploy` 建项目、发版本，函数在真实运行时可用；
2. 函数变量（含加密项）读取成功——若读不到，函数回 403（第 5 节），实测确实拿到了天气数据；
3. `new EdgeKV({ namespace: "astra" })` 在运行时可用（`w1.*` 键确实写进了 KV）；
4. 命中路径在真实边缘上是 hit（连续 4 次请求都带 `X-Astra-Edge-Weather: hit`）；
5. 函数路由只影响 `/api/weather/*` 与带 `version` 的课表读（外加非 GET/OPTIONS、UA 含
   AstraSchedule 的写）：不带 `version` 的 `class.getastra.cn/39/2023/1` 行为与挂路由前一致；
6. 和风天气 API Key 在本机直连实测：geo / weather now / weatheralert 三个接口都是 200；
7. 不带城市的 `/api/weather/` 在线上返回 `{"where":"南京",...}`（ESA 按客户端 IP 定位到
   南京），不再是迁移后那个 400；带城市路径与课表路径行为未变。

尚未在真实环境构造出来的：

- 和风天气故障时的边缘作答（403/400/404/502，单测覆盖，生产上没人为制造上游故障）；
- 函数被平台打断时 `Fallback: on` 的兜底（属于平台行为，同上）；
- 课表 KV 的到期时刻到点回源（单测覆盖，线上还没走到那一刻）。
