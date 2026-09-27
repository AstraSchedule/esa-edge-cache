# 设计说明

## 1. 目标与范围

SaaS 版客户端每次启动/进入下一个日程都会拉一次天气。这条链路原来是
`客户端 → ESA → FC（AstraSaaS-Go）→ 和风天气`，ESA 只是一个透明代理，
所以每次拉天气都要把 FC 调起来。

本仓库把「取天气」搬到边缘：边缘自己查和风天气、自己缓存，**FC 完全不参与这条路径**。

范围明确排除：

- 课表版本缓存（issue #63 的主体）——见第 8 节，等 desktop#57 落地再做。
- 任何非 `GET /api/weather/<城市>[/<省份>]` 的请求——一律 `fetch(request)` 透传。

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
4. 读函数变量拿和风天气凭据；缺任何一项 → 透传（未配置的部署行为与今天完全一致）。
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

定位不到城市（`request.info` 缺失，或只有国家没有城市）→ 透传回源，边缘不自己造响应。

## 4. 响应体为什么要「逐字同形」

这条链路的隐式契约是客户端：`desktop/js/renderer.js` 直接读 `temp` / `weat` / `warn` /
`brief_warn` 等字段。所以边缘拼的 JSON 必须与源站 `model.WeatherResponse` 一模一样：

```json
{ "where": "北京", "temp": "24", "weat": "晴", "wind": "西北风",
  "wind_power": "2", "warn": "...", "brief_warn": "..." }
```

预警文案的拼接规则也照抄源站：每条 `description` / `headline` 去掉换行后用 `；` 连接。

## 5. 降级策略：任何异常都回源

| 情况 | 行为 |
|---|---|
| 没配函数变量 / 主机名非法 / API Key 为空 | 不接管，透传 |
| 和风天气非 200、非 JSON、`code != "200"`、`now.temp` 为空 | 透传 |
| KV 构造、读、写、值解析失败 | 天气照常返回，只是不缓存 |
| 函数内部抛任何异常 | 捕获后 `fetch(request)` 透传 |
| 函数被平台打断（如 CPU 超限） | 路由的 `Fallback: on` 兜底回源 |

边缘只做加速，不做单点：**所有失败路径的响应形态都由源站决定**，边缘不自己造错误响应。

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
直连和风天气，所以降级策略是「回源到 FC」而不是「在边缘重试上游」。

### 7.3 函数配额是账号级共享的

超限会让 `docs-site`、两个 dashboard、`reg-go` 的函数一起 503。
所以路由写的是**单个路径前缀**而不是整个域名。

## 8. 课表版本缓存（暂不做）

issue #63 的主体是「把当前有效版本 + 必然失效时刻缓存到边缘 KV，客户端带着本地 version
回来时直接在边缘回 304」。它依赖源站下发 `X-Astra-Schedule-Version` /
`X-Astra-Schedule-Expire`，而这两个头的语义会被「更好的自动任务」（desktop#57）改动，
issue #63 本身也 blocked-by #57。现在实现等于等 #57 落地后重写。

恢复时的落点已经预留好：

- 前缀 `s1.<host>.<base64url(班级路径)>` 与 `g1.<host>`，与天气的 `w1.` 互不干扰；
- KV 空间复用 `astra`；
- 路由按 host 挂到租户域名上，届时同样用路径收窄。

## 9. 上线前验证状态（2026-09-26）

已实测通过：

1. `esa-cli deploy` 建项目、发版本，函数在真实运行时可用；
2. 函数变量（含加密项）读取成功——若读不到，函数会静默回源，实测确实拿到了天气数据；
3. `new EdgeKV({ namespace: "astra" })` 在运行时可用（`w1.*` 键确实写进了 KV）；
4. 命中路径在真实边缘上是 hit（连续 4 次请求都带 `X-Astra-Edge-Weather: hit`）；
5. 函数路由只影响 `/api/weather/*`：`class.getastra.cn/39/2023/1` 与无城市的
   `/api/weather/` 行为与挂路由前一致；
6. 和风天气 API Key 在本机直连实测：geo / weather now / weatheralert 三个接口都是 200；
7. 不带城市的 `/api/weather/` 在线上返回 `{"where":"南京",...}`（ESA 按客户端 IP 定位到
   南京），不再是迁移后那个 400；带城市路径与课表路径行为未变。

尚未在真实环境构造出来的：

- 和风天气故障时的回源降级（单测覆盖，生产上没人为制造上游故障）；
- 函数被平台打断时 `Fallback: on` 的兜底（属于平台行为，同上）。
