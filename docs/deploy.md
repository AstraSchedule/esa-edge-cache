# 部署步骤

> 本文件记录的是**实际执行过**的步骤（2026-09-26 上线）。所有命令都在仓库根目录执行。

## 1. 项目配置：esa.jsonc

```json
{
  "name": "esa-edge-cache",
  "entry": "./src/index.js",
  "installCommand": "",
  "buildCommand": ""
}
```

| 字段 | 值 | 原因 |
|---|---|---|
| `name` | `esa-edge-cache` | 部署目标项目名；不存在时 `esa-cli` 自动创建（本次就是新建的） |
| `entry` | `./src/index.js` | 边缘函数入口，不需要构建 |
| `installCommand` / `buildCommand` | `""` | 无依赖、无构建产物，空字符串表示跳过该步骤 |
| `assets` | **刻意不写** | 不托管静态资源，请求全部落到函数 |

## 2. 部署

```bash
cd esa-edge-cache
aliyun esa-cli deploy --environment production
```

首次执行会依次：检查登录态 → 创建 Routine → 上传 `src/index.js` → 生成代码版本 →
发布到生产环境。输出里会带一个**有效期 1 小时**的预览地址：

```
https://esa-edge-cache-1616808033455959.debug.er.aliyun-esa.net?esa_er_token=<token>
```

> 预览地址必须带 `esa_er_token`，否则 401。该 token 只在部署输出里出现，
> 想复用它做验证就在**同一条命令**里捕获，别手抄。

## 3. 函数变量（和风天气凭据）

变量按环境存储，且**改完必须重新部署一次**，新版本才会绑定新的变量快照。

```bash
# 主机名：明文变量
aliyun esa-cli env set "QW_API_HOST=<apihost>" --environment production -n esa-edge-cache

# API Key：加密 secret，从 stdin 读，避免落进命令历史
Get-Content <path-to-config.toml> -Raw | ... | aliyun esa-cli secret put QW_API_KEY --environment production -n esa-edge-cache --stdin

# 让新版本绑定这次的变量快照
aliyun esa-cli deploy --environment production

# 确认
aliyun esa-cli env list --environment production -n esa-edge-cache
```

两个坑，都踩过：

1. **用长参数 `--environment`，不要用 `-e`**。`-e` 会被 `aliyun` 主 CLI 自己吃掉，
   `esa-cli` 收到的是缺参数的调用，直接报 `Missing required argument: environment`。
2. 命令的工作目录会影响相对路径，读 `config.toml` 这类仓库外文件时给绝对路径。

变量名只能字母、数字、下划线。读不到变量时函数回 403（不再回源），表现为「部署成功但天气
报未配置认证信息」，排查时先看这里。

可选变量 `MIN_CLIENT_VERSION`（最低兼容客户端版本，明文即可；语义见 `docs/design.md` 3.3）：

```bash
# 低于该版本的客户端一律 426；留空或不设 = 闸门关闭（配成非点分纯数字也会自动关闭）
aliyun esa-cli env set "MIN_CLIENT_VERSION=202610.1.0" --environment production -n esa-edge-cache
aliyun esa-cli deploy --environment production
```

**在「携带版本号」的客户端构建确认发布之后再设这个值**：阈值一旦高于在跑的最低版本，那部分用户会
立刻在边缘被拦（只显示本地缓存），直到客户端自动更新完成。
## 4. 挂函数路由：用「路由」，**不要**用「域名绑定」

这是最容易做错的地方。

- **域名绑定**：把整个域名的全部请求交给函数。绑定之后这个域名就不再回原来那个源站了，
  **FC 被绕开，接口直接废掉**。不要对后端域名做域名绑定。
- **函数路由**：只有匹配的请求进入函数，其余继续走加速回源；函数内部 `fetch(request)`
  把请求转发给**该域名原本的源站**。

本函数接管天气前缀、带 `version` 的课表读、课表写入（写入要能触发 KV 失效），以及连通性探针
`/`（**任何方法**），所以路由按这几种条件收窄。线上是**两条**自定义规则：天气/课表那条用合并写法
（先按域名逐条建、拿到简单模式生成的写法后再合并成一条，避免每加一个租户域名就要动配置；
host 黑名单在每条子句里原样重复），根路径那条单独建：

```
(not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and starts_with(http.request.uri, "/api/weather/")) or (not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and http.request.uri.query contains "version") or (not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and not http.request.method in {"GET" "OPTIONS"}) or (not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and http.user_agent contains "AstraSchedule")
```

```bash
# 新建（单条）
aliyun esa CreateRoutineRoute --region cn-hangzhou --SiteId 178107369359596 \
  --RoutineName esa-edge-cache --RouteName edge-weather --RouteEnable on --Fallback on \
  --Rule '(not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and starts_with(http.request.uri, "/api/weather/")) or (not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and http.request.uri.query contains "version") or (not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and not http.request.method in {"GET" "OPTIONS"}) or (not http.host in {"getastra.cn" "sys.getastra.cn" "to.getastra.cn" "i.getastra.cn" "www.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and http.user_agent contains "AstraSchedule")'

# 查看线上真实配置
aliyun esa ListRoutineRoutes --region cn-hangzhou --RoutineName esa-edge-cache
```

第二条：根路径连通性探针（设计见 design.md 3.2）。

```bash
aliyun esa CreateRoutineRoute --region cn-hangzhou --SiteId 178107369359596 \
  --RoutineName esa-edge-cache --RouteName edge-root-probe --RouteEnable on --Fallback on \
  --Sequence 2 \
  --Rule 'not http.host in {"getastra.cn" "www.getastra.cn" "i.getastra.cn" "dev.getastra.cn" "go.getastra.cn"} and http.request.uri.path == "/"'
```

**为什么单独一条**：单条规则的嵌套层级受套餐配额限制，实测往天气规则里追加 `/` 子句会报
`NestedRuleQuotaCheckFailed: The nesting level of rules allowed by the plan failed to be verified`；
单独一条只有 `A and B` 一层嵌套，可以正常创建。

根路径这条的黑名单只排 Pages 托管的五个域名（apex / `www.` / `i.` / `dev.` / `go.`），比天气那条少了
`sys.getastra.cn` 与 `to.getastra.cn`：天气规则含「非 GET/OPTIONS → 进函数」，必须排除这两个纯 API
域名以免劫持写请求；根路径只匹配 `/`，于是 API 域名的 `/` 也一并由边缘作答，不再拉 FC。

线上现在两条路由（都 `Mode custom`、`Fallback on`、`RouteEnable on`）：

| ConfigId | RouteName | Sequence | 作用 |
|---|---|---|---|
| `521112930863104` | `edge-weather-class` | 1 | 天气 + 课表版本读写 + 非 GET + UA `AstraSchedule` |
| `522037019918336` | `edge-root-probe` | 2 | API 域名的 `/`（任何方法）边缘作答，不拉 FC（`GET` Hello World / `HEAD` 200 空体 / `OPTIONS` 204 / 其余 404）；Pages 域名由 Pages 作答 |

### 覆盖范围与排除项

规则是「**除黑名单外的全部子域** + `/api/weather/` 前缀」，外加带 `version` 的课表读、非
GET/OPTIONS 的课表写、UA 含 `AstraSchedule` 的客户端请求，以及恰好是 `/` 的连通性探针，
所以新增租户域名不用改配置。
黑名单里的域名各有原因：

| 域名 | `/api/weather/北京` | 为什么排除 |
|---|---|---|
| `class` / `njx` / `kuohu` / `sandbox.getastra.cn` | 200 | 后端租户域名，走边缘天气 |
| `sys.getastra.cn` | 404 | sys-dashboard 前端 |
| `to.getastra.cn` | 404 | reg-to 前端 |
| `i.` / `dev.` / `go.` / `www.` / 裸域 | — | 已绑定别的 Pages，吞进函数会把前端劫持 |

**不要图省事去掉黑名单写 `*.getastra.cn/*`**：被排除的域名已经绑定了别的 Pages，
把整个域名吞进函数会把前端一起劫持。

## 5. 验证

```bash
# 1) 挂路由前先打预览地址，确认函数本身能出天气（miss 表示边缘现查的上游）
curl -sS -D - "https://<预览域名>/api/weather/%E5%8C%97%E4%BA%AC?esa_er_token=<token>"

# 2) 挂路由后打线上域名，响应该带 X-Astra-Edge-Weather: hit
curl -sS -D - "https://class.getastra.cn/api/weather/%E5%8C%97%E4%BA%AC"

# 3) 同一个域名上别的路径不受影响（不带 version 的课表读仍回源，不应带边缘头）
curl -sS -D - "https://class.getastra.cn/39/2023/1" -o /dev/null

# 3b) 带 version 的课表读：应 304 + X-Astra-Edge-Schedule: hit
#     （首次是 miss：回源带 version=0 拿到 200 写下 KV，之后即 hit；
#      出现 revalidated 说明源站又用第三段判定 304 了——正常路径不应该走到）
curl -sS -D - "https://class.getastra.cn/39/2023/1?version=1772129866:30" -o /dev/null

# 4) 不带城市的 /api/weather/：边缘按客户端 IP 定位（ESA request.info 的 ip_city_en），
#    应返回 200 + X-Astra-Edge-Weather，而不是迁移后源站那个 400
curl -sS -D - "https://class.getastra.cn/api/weather/"

# 5) KV 里确实有缓存条目
aliyun esa ListKvs --region cn-hangzhou --Namespace astra --Prefix w1.

# 6) 根路径连通性探针：任何方法都应由边缘作答（X-Astra-Edge-Root: hit），且没有 x-fc-request-id
curl -sS -D - -A "AstraSchedule/1.6.1" "https://class.getastra.cn/"
curl -sS -D - -A "AstraSchedule/1.6.1" "https://class.getastra.cn/?probe=1"
# POST 也必须在边缘结束（源站 gin 的默认 404），不能出现 x-fc-request-id
curl -sS -D - -X POST --data '{}' -A "AstraSchedule/1.6.1" "https://class.getastra.cn/"

# 7) 最低兼容客户端版本闸门（需先设 MIN_CLIENT_VERSION 并重新部署）
#    低于阈值：426 + X-Astra-Edge-Min-Version: block，且不能出现 x-fc-request-id
curl -sS -D - -A "AstraSchedule/1.6.1" "https://class.getastra.cn/"
#    等于/高于阈值：正常放行（阈值本身即通过）
curl -sS -D - -A "AstraSchedule/202610.1.0" "https://class.getastra.cn/"
#    非客户端 UA（浏览器/脚本）：放行
curl -sS -D - -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "https://class.getastra.cn/"
```

上线当天实测结果：

| 请求 | 结果 |
|---|---|
| 4 个租户域名 `/api/weather/北京` | `200` + `X-Astra-Edge-Weather: hit` |
| `class.getastra.cn/39/2023/1` | 源站响应，无边缘头（未受影响） |
| `class.getastra.cn/api/weather/` | `200` + `edge=hit`，`{"where":"南京",...}`（按客户端 IP 定位） |
| `sys.getastra.cn/api/weather/` | `404`（规则排除，行为未变） |
| `class.getastra.cn/`（UA `AstraSchedule/1.6.1`） | `200 {"message":"Hello World"}` + `X-Astra-Edge-Root: hit`，无 `x-fc-request-id`（边缘作答） |
| `class.getastra.cn/`（`POST`） | `404 404 page not found`（`text/plain`，18 字节）+ `X-Astra-Edge-Root: hit`，无 `x-fc-request-id`（边缘作答） |
| `class.getastra.cn/`（`OPTIONS`） | `204` 空体 + `X-Astra-Edge-Root: hit`，无 `x-fc-request-id`（边缘作答） |
| `sys.getastra.cn/`、`to.getastra.cn/`（`GET`） | `200 {"message":"Hello World"}` + `X-Astra-Edge-Root: hit`，无 `x-fc-request-id`（原先这两条都来自 FC） |
| `sys.getastra.cn/web/auth/login`（`POST`） | 仍到 FC（有 `x-fc-request-id`）——API 未受影响 |
| KV | 出现 `w1.5YyX5Lqs.`（北京）、`w1.TmFuamluZw.`（Nanjing）等键 |

## 6. 回滚

把路由停掉（或删掉）即刻回到「每次请求都回源」，不需要动函数本身：

```bash
aliyun esa UpdateRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 --ConfigId <ConfigId> --RouteEnable off

# 或彻底删除
aliyun esa DeleteRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 --ConfigId <ConfigId>
```

只回滚代码则用 `aliyun esa-cli deployments list` 找到上一个版本，或直接
`aliyun esa-cli deploy` 重新发布一次当前分支。

## 7. 排障提示

| 现象 | 先查什么 |
|---|---|
| 部署成功但响应没有 `X-Astra-Edge-Weather` | 函数变量是否写进了**对应环境**；写完有没有**重新部署**；路由规则是否命中该 host+path |
| 一直 `miss`、每次都在查上游 | 边缘 KV 最终一致，新写入的城市最长 300 秒才全球可见；再看 `ListKvs` 里有没有对应键 |
| 全部 401 | 打的是预览地址但没带 `esa_er_token`；token 只有 1 小时 |
| `/api/weather/` 返回 400「无法从客户端 IP 定位城市…」 | 这是**边缘自己**答的：检查 `request.info` 是否有 `ip_city_en`（用预览地址打一次即可看到）|
| `/api/weather/` 返回源站那句 400「请确保请求经过 Cloudflare」或「未配置天气认证信息：请配置 JWT」 | 说明请求根本没进函数：路由没命中该 host，或直接打到了源站 |
| 课表读一直 `miss`、每次回源 | 边缘 KV 最终一致（最长 300 秒）；再不行看 `ListKvs --Namespace astra --Prefix s1.` 里的条目是否存在、数据版本/教学周是否与客户端带来的串一致（第三段不参与判定，写法差异不会再导致 miss）|
| `/` 回 Hello World 但没有 `X-Astra-Edge-Root` | 请求没进函数：`edge-root-probe` 那条路由是否 `RouteEnable on`；host 是否属于 Pages 托管的五个域名（它们的 `/` 由 Pages 作答，本就不该有该头） |
| 课表读出现 `revalidated` | 源站又回到了「用第三段判定 304」的旧版本（回源带的是 version=0，正常必得 200）：先看源站部署版本 |
