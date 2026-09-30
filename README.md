# esa-edge-cache

星程课表（AstraSchedule）SaaS 版的 **ESA 边缘函数**。

- 对应 issue：[AstraSchedule/desktop#63 基于 KV 存储的进一步压缩响应时间与部署成本的方法](https://github.com/AstraSchedule/desktop/issues/63)
- **当前内容：边缘天气 + 课表版本缓存**（issue #63 的两半）
- 课表版本缓存原因 desktop#57「更好的自动任务」会改版本串语义而暂缓；#57 已落地，2026-09-27 补上

只服务 SaaS 部署（`class.` / `njx.` / `kuohu.` / `sandbox.getastra.cn` → FC）。
自部署版本不接入边缘层。

## 边缘天气

客户端拉天气走 `GET /api/weather/:name1[/:name2]`（`desktop/main.js` 的
`requestWeatherWithRetry`）。原来这条请求即使到了 ESA 也会原样回源到 FC，
由 FC 查和风天气再返回；现在边缘直接把这件事做掉：

- 命中边缘 KV 就返回缓存体（10 分钟，与源站 `cache.CachePage(10*time.Minute)` 一致），
  **不回源、不查上游**；
- 未命中就在边缘查和风天气（城市查询 → 实时天气 → 预警），拼成与源站
  `model.WeatherResponse` 逐字同形的响应体，写进 KV 后返回；
- **失败也在边缘作答，不回源**：没配函数变量 → 403、定位不到城市 → 400、
  城市查询失败 → 404、上游异常 → 502，状态码与 JSON 键形状对齐源站
  （客户端只区分 2xx / 非 2xx，见 `docs/design.md` 第 5 节）；
  KV 抛异常不影响本次返回，只是不缓存。

和风天气凭据通过**函数变量**下发（`QW_API_HOST` 明文、`QW_API_KEY` 加密存储），
不写进代码。

## 课表版本缓存

课表读取是 `GET /{school}/{grade}/{class}?version=<版本串>`（无前缀，version 参数为客户端独有）。
边缘只缓存**版本号**，不缓存响应体：

- **命中**：路径恰好三段、带 `version` 参数、KV 里的版本串与客户端带来的串在**数据版本 + 教学周**
  上一致（第三段不参与判定，客户端可以不带），且未走到「到期时刻」→ 直接返回 **304**，不回源；
- **未命中 / 数据版本或教学周不同 / 越过到期时刻**：回源复核，并带 `version=0`——源站 200 时按响应体
  里的 `version` 刷新 KV 与到期时刻。不复用客户端的版本串：源站已不拿第三段判定，透传只会换回一个
  没有响应体的 304，边缘学不到当前变化点；
- **第三段为什么不参与判定**：它是每台设备各自的「最后一次生成快照那天 + 7 天」，跨一天就变而数据
  没变；拿它做整串比较时每个班在边缘只有一个 KV 槽、只能命中其中一台设备，其余全部回源，而源站对
  它们一律答 304——线上「本该在边缘答 304 的请求抵达源站」就是这个。详见 `docs/design.md` 第 8 节；
- **写入主动失效**：源站在写入响应里带 `X-Astra-Purge-Scopes`（逗号分隔的 `school/grade/class`，
  `usr-backend/router/client/putSchedule.go` 与 `router/web/helpers.go`），边缘据此删键。
  **头缺失或没有合法 scope 时不报错、不操作**——用户、认证这类接口本就与课表缓存无关。
  注意：用户管理端的写请求打的是 `class.khbit.cn`，该站点没挂边缘路由，失效头目前到不了边缘，
  手动改课表后要靠下面的到期时刻兜底（见 `docs/design.md` 8.3）；
- 版本串第三段是「下一次可能变化时刻」（源站 `service.VersionBoundary` 解析自动任务算出），
  越过它就必须回源：即使数据没变，快照也已跨出 7 天窗口；
- **没有第三段时不写「永不过期」**：源站只在确实存在未来变化点时才给第三段
  （`dataVersion:week`），此时边缘写 600 秒软过期，到点回源复核。否则边缘会一直替
  客户端答 304，客户端永久停在旧课表（源站侧同类故障见 `usr-backend/router/client/version_test.go`）。
  早期版本写下的 `e = 0` 条目同样回源一次，修好后恢复命中。

键为 `s1.<base64url(host)>.<base64url(school)>.<base64url(grade)>.<base64url(class)>`，
与天气的 `w1.` 前缀并列（同一存储空间 `astra`）；租户之间靠 host 区分。

### 线上验证（2026-09-27）

| 请求 | 结果 |
|---|---|
| `GET /39/2023/1?version=1772129866:30` ×3 | 第 1、2 次 `304 + X-Astra-Edge-Schedule: revalidated`（KV 最终一致，最长 300s），第 3 次 `304 + hit`（命中，不回源）——这是 2026-09-27 的记录；2026-10-01 改判据后回源带 `version=0`，正常路径第一、二次都应是 `miss`+|
| `GET /39/2023/1`（不带 version）| 透传回源，无边缘头 |
| `GET /api/weather/北京` | `200 + X-Astra-Edge-Weather: miss`（天气未回归）|
| KV | `s1.Y2xhc3MuZ2V0YXN0cmEuY24.Mzk.MjAyMw.MQ`（class.getastra.cn / 39 / 2023 / 1）|

路由复用现有那条 `edge-weather-class`：它的规则已包含「带 version 查询参数」「非 GET/OPTIONS」
与「UA 含 AstraSchedule」，正好覆盖课表读取与写入失效，无需新增规则。

## 天气设计摘要

- **缓存的是整个响应体**，键 `w1.<base64url(城市)>.<base64url(省份)>`。天气与租户无关
  （同一套和风天气凭据），所以键里不带 host，多租户共用同一份缓存。
- **过期时刻存在值里**（`{"b": 响应体, "e": 绝对秒}`）：ESA 边缘 KV 没有 TTL 能力，
  只有 `get` / `put` / `delete`。
- **接管 `GET /api/weather/<城市>[/<省份>]` 与不带城市的 `GET /api/weather/`**：
  带城市的按 URL 里的城市查；不带城市的按 ESA 运行时 `request.info` 里由客户端 IP
  定位到的 `ip_city_en` 查（原来这条路径靠 Cloudflare 注入的 `CF-IPCity`，
  站点迁到 ESA 之后换成 `request.info`）。写请求、其他接口一律透传。
- **路由按路径收窄**：函数路由只匹配 `/api/weather/` 前缀，外加「带 `version` 查询参数」
  「非 GET/OPTIONS」「UA 含 AstraSchedule」三类课表读写（同一条 `edge-weather-class` 规则），
  其余请求照旧回源——既不改变别的接口，也省函数配额。
- **环境变量键名只能是字母数字下划线**；主机名校验不通过或 API Key 为空时边缘回 403，
  不再回源（未配置变量的部署也不会把流量打到 FC）。

详细取舍、平台实测与已知风险见 [docs/design.md](docs/design.md)，
部署与回滚步骤见 [docs/deploy.md](docs/deploy.md)。

## 目录结构

```
esa.jsonc           ESA 项目配置：只声明 entry，不声明 assets
src/index.js        边缘函数本体（ESA 函数运行时，单文件，ES Module）
test/index.test.js  bun test 用例（伪造 EdgeKV、和风天气与源站）
docs/design.md      设计与取舍、ESA 平台限制、已知风险
docs/deploy.md      部署步骤（esa-cli）、验证与回滚
```

## 本地测试

```bash
bun test   # 无第三方依赖，不需要先 bun install
```

## 部署（2026-09-26 已上线）

```bash
cd esa-edge-cache
aliyun esa-cli deploy --environment production
aliyun esa-cli route list
```

首次上线时把和风天气凭据写进**生产环境**的函数变量，然后重新部署一次让新版本绑定
变量快照（详见 docs/deploy.md）。回滚 = 把 4 条路由 `RouteEnable off`。

## 相关仓库

- [AstraSchedule/usr-backend](https://github.com/AstraSchedule/usr-backend) —
  原来的天气实现（`router/client/getWeather.go`），边缘函数的响应体与它逐字对齐
- [AstraSchedule/desktop](https://github.com/AstraSchedule/desktop) — 客户端，无需改动
