# 部署步骤

> **本次没有执行任何部署。** 下面第 0 节先纠正一个本仓库早期版本搞错的前提。

## 0. 前提纠正：ESA 这边要建的是 **Pages**，不是独立的「边缘函数」

ESA 控制台「边缘计算和 AI > 函数和Pages > 创建 > **导入 Github 仓库**」这条路径，
产出的就是 **Pages**——官方文档标题即《通过导入 Github 仓库创建 Pages》。

这个账号里现有的 5 个（`usr-dashboard` / `sys-dashboard` / `reg-go` / `docs-site` /
`khbitcn-astro`）全都是这么来的：在 OpenAPI 里它们表现为 `Routine`，且 `HasAssets: true`
（实测 `ListUserRoutines`、`ListRoutineBuildConfigurations`）。

**Pages 可以同时承载静态资源和一段边缘函数**，两者是构建信息里的两个独立字段：

| 字段 | esa.jsonc | 含义 |
|---|---|---|
| 静态资源目录 | `assets.directory` | 构建产物中被静态托管的目录 |
| 函数文件路径 | `entry` | 边缘函数的入口文件 |

路由顺序是：请求到达 → 命中静态资源就直接响应 → **没命中就执行函数脚本** → 都没有才 404。
所以一个**不配置静态资源**的 Pages，等价于一个纯函数。

本仓库就是这个用法：`esa.jsonc` 只给 `entry`，不给 `assets`。

> 本仓库早期版本没有 `esa.jsonc`，ESA 只能靠猜，于是被识别成了静态站点 Pages。
> 这是那个版本的缺陷，现已补上。

## 1. esa.jsonc：让 ESA 不用猜

仓库根目录的 `esa.jsonc` 会被自动识别，并且**作为配置的唯一来源**——一旦存在，
控制台里对应的配置项全部不生效（官方明确的优先级）。所以它是本仓库部署时的唯一真相。

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
| `name` | `esa-edge-cache` | 部署目标项目名；不存在时 ESA 用这个名字自动创建 |
| `entry` | `./src/index.js` | 边缘函数入口。本仓库不需要构建，直接执行源码 |
| `installCommand` | `""` | 无依赖。文档明确「设置成空字符串，安装步骤将被跳过」 |
| `buildCommand` | `""` | 无构建产物，同上 |
| `assets` | **刻意不写** | 不托管静态资源，所有请求都落到函数脚本；写了 `assets.directory` 反而会让静态资源优先于函数 |

文件用严格 JSON（不带注释），避免依赖 ESA 对 JSONC 的容错。说明都放在这份文档里。

## 2. 创建 Pages

控制台：**边缘计算和 AI > 函数和Pages > 创建 > 导入 Github 仓库**，
选择 `AstraSchedule/esa-edge-cache`，分支 `main`。

仓库里有 `esa.jsonc`，构建信息会以它为准，界面上不需要额外填写。

## 3. 挂到后端域名：用「路由」，**不要**用「域名绑定」

这一条是本方案最容易做错的地方。

后端域名（`class.` / `njx.` / `kuohu.` / `sandbox.` …）现在的 DNS 记录指向
**源站组** `astrasaas.origin-pool.getastra.cn`，也就是 FC 函数 `AstraSaaS-Go`。

- **域名绑定**：把整个域名的全部请求交给 Pages。绑定之后这个域名就不再回原来那个源站了，
  **FC 被绕开，接口直接废掉**。不要对后端域名做域名绑定。
- **函数路由**：只有匹配的请求进入函数，其余继续走加速回源；函数内部 `fetch(request)`
  把请求转发给**该域名原本的源站**。这正是我们要的：命中版本缓存就直接回 304，
  没命中就原样透传给 FC，源站仍然是 FC。

操作位置：该 Pages 详情页 → **域名** → 路由 → 添加路由；或使用 OpenAPI `CreateRoutineRoute`。

### 覆盖范围

`getastra.cn` 下**除** `i.` / `sys.` / `dev.` / `go.` / `to.` / 裸域 / `www.`
**之外**的全部子域。

原因是 namespace 由 Host 推导（usr-backend 的 `middleware.ParseHostToNamespace`：
`aaa-do.getastra.cn` → `cn/getastra/aaa-do`），所以租户子域同样直接提供客户端课表接口；
被排除的那几个是前端/文档/Pages 站点，不提供课表接口。

> **不要图省事写 `*.getastra.cn/*`**。被排除的域名已经绑定了别的 Pages
> （`usr-dashboard` / `sys-dashboard` / `reg-go` / `docs-site` / `khbitcn-astro`，
> 外加 `i.getastra.cn` 上那个 Pages 站点），路由把它们吞掉会把前端直接劫持。

边缘函数按 **hostname** 分组缓存（键 `s1.<host>.<base64url(班级路径)>`），
多租户天然隔离，不需要为每个子域单独配置。

### 两个我无法离线确认的点

1. **路由规则要求主机名在站点下存在 DNS 记录。** 官方文档写明：简单模式填带前缀的域名时，
   ESA 的 DNS 记录里必须有一条对应记录，否则访问会失败。
   但我实测 `ListRecords` 只返回 11 条，而 `i.getastra.cn` 明明解析正常却**不在其中**——
   说明 **Pages 的域名绑定会自己建 DNS 记录，且不出现在 `ListRecords` 里**。
   所以配路由时以**控制台里能选到的域名**为准，不要只信 `ListRecords` 的输出。
2. **函数路由下 `fetch(request)` 是否确实回源到该域名原有的源站。** 官方《基于 ESA 边缘函数的
   转发和重定向实践指南》用的是 `fetch(new Request(newUrl, request))` 转发到指定源站，
   说明回源是函数内的显式能力；但「路由命中的同域请求原样 `fetch` 会回到该域名的源站、
   而不是再次进入函数自身」这一点，我没有在真实环境验证过。
   **第一次上线必须先用一个非生产域名试，并观察 FC 的调用数是否正常增长。**

## 4. 验证

```bash
# 第一次：缓存未命中，应回源并返回 200
curl -sS -D - -o /dev/null "https://class.getastra.cn/<school>/<grade>/<class>?version=0"

# 第二次：带上第一次响应头里的 X-Astra-Schedule-Version，应直接返回 304，
# 且带有 X-Astra-Edge-Cache: hit（说明是边缘回的，没有回源）
curl -sS -D - -o /dev/null \
  "https://class.getastra.cn/<school>/<grade>/<class>?version=<上一步的版本串>"
```

同时到 Pages 的监控里看**请求数**与**子请求数**：命中时子请求数不增长，说明没有回源。

## 5. 回滚

把那条路由停掉或删掉即可，行为立刻回到「每次请求都回源」：

```bash
aliyun esa UpdateRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 --ConfigId <路由的 ConfigId> --RouteEnable off

# 或彻底删除
aliyun esa DeleteRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 --ConfigId <路由的 ConfigId>
```

`ConfigId` 从 `ListRoutineRoutes` 或控制台取。

## 6. 与 usr-backend 的部署顺序

边缘函数依赖源站下发的 `X-Astra-Schedule-Version` / `X-Astra-Schedule-Expire` 响应头
（`usr-backend` 的 `router/client/getSchedule.go`）。

**先发布 usr-backend，再挂路由。** 顺序反了也不会出错：源站没给头时边缘函数一律不写 KV、
直接透传，只是缓存不生效而已。

## 附录：不经 GitHub 的备选路径（未验证）

如果想绕开 Pages 的 Git 工作流，也可以用 OpenAPI 直接建 Routine 并上传代码。
账号里目前**没有这种先例**（现有 5 个全是 Git 构建），下面这条路径没有跑通过：

```bash
# a. 创建 Routine
aliyun esa CreateRoutine --region cn-hangzhou --Name esa-edge-cache

# b. 取 OSS 直传凭证
aliyun esa GetRoutineStagingCodeUploadInfo --region cn-hangzhou --Name esa-edge-cache

# c. 用 multipart/form-data POST 到返回的 OssPostConfig.Url，
#    表单字段就是 OssPostConfig 的各键值对，另加一个文件字段（字段名 key、文件名 index.js）
#    内容为 src/index.js，并带上 OSSAccessKeyId 与 x-oss-security-token

# d. 提交
aliyun esa CommitRoutineStagingCode --region cn-hangzhou --Name esa-edge-cache

# e. 发布
aliyun esa PublishRoutineCodeVersion --region cn-hangzhou \
  --Name esa-edge-cache --Env production --CodeVersion "<b 步返回的 CodeVersion>"
```

之后同样用第 3 节的 `CreateRoutineRoute` 挂路由。`--Rule` 的表达式语法本地没有确认过，
建议先用控制台配一条，再用 `ListRoutineRoutes` 抄回真实格式。
