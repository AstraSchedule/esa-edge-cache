# 设计说明

## 1. 目标与范围

SaaS 版客户端每次启动/进入下一个日程都会拉一次天气。这条链路原来是
`客户端 → ESA → FC（AstraSaaS-Go）→ 和风天气`，ESA 只是一个透明代理，
所以每次拉天气都要把 FC 调起来。

本仓库把「取天气」搬到边缘：边缘自己查和风天气、自己缓存，**FC 完全不参与这条路径**。

本仓库接管两类请求：

- 天气：`GET /api/weather/<城市>[/<省份>]` 与不带城市的 `GET /api/weather/`（第 3～5 节）；
- 课表版本：`GET /<学校>/<年级>/<班级>?version=<版本串>`（第 8 节）。

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

第二条强制通道在客户端侧：手动「更新课表」（渲染进程按钮与托盘菜单）与 WS `SyncConfig` 都带
`version=0`，`0` 与任何真实版本串的身份都不相等，**一定 miss → 回源 200 → 就地刷新 KV**，
不依赖写入失效（单测：`test/schedule.test.js` 的 `version=0 一律回源并刷新 KV`）。

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
