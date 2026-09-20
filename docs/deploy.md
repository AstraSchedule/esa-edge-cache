# 部署步骤

> **本次没有执行任何部署。** 下面的 API 名称与参数名都来自 `aliyun esa <API> --help` 的
> 实际查询结果，但整条流程（尤其是 OSS 直传那一步）**没有在真实环境中跑通过**，
> 首次执行时请逐步确认返回值。

## 0. 前置事实（已在账号上核实）

| 项 | 值 |
|---|---|
| 站点 | `getastra.cn`，SiteId `178107369359596`，basic 套餐，NS 接入 |
| 客户端 API | `class.getastra.cn` → 源站组 `astrasaas.origin-pool.getastra.cn` → FC `AstraSaaS-Go` |
| 边缘 KV 空间 | `astra`（NamespaceId `1039542590279634944`），1 GB，当前 0 B |
| 边缘函数 | 已用 5/20（`usr-dashboard` / `sys-dashboard` / `reg-go` / `docs-site` / `khbitcn-astro`） |
| 函数路由 | 0 条（现有 5 个函数都是通过「域名绑定」接入的） |
| 账号函数模式 | 推断为**免费模式**（函数数上限 20）：每账号每天 10 万次函数请求，超限直接 503 |

**动手前必须确认**：给 `class.getastra.cn` 挂上函数路由之后，该域名的**所有**请求都会进入
边缘函数并计入那 10 万次/天的账号级配额（含天气接口、`/web/*`、写请求），
超限会连累 docs-site 与两个 dashboard。见 `docs/design.md` 第 7.2 节。

## 1. 创建边缘函数

```bash
aliyun esa CreateRoutine --region cn-hangzhou \
  --Name astra-schedule-cache \
  --Description "课表边缘版本缓存"
```

## 2. 上传并提交代码

ESA 的函数代码走 **OSS 直传**，不能直接把源码字符串传给 API。

**a. 取上传凭证**

```bash
aliyun esa GetRoutineStagingCodeUploadInfo --region cn-hangzhou \
  --Name astra-schedule-cache \
  --CodeDescription "v1"
```

返回 `CodeVersion` 与 `OssPostConfig`，后者包含
`Url` / `OSSAccessKeyId` / `XOssSecurityToken` / `key` / `callback` / `x:codeDescription` /
`policy` / `Signature`。

**b. 用 multipart/form-data POST 到 `OssPostConfig.Url`**

表单字段就是 `OssPostConfig` 的各个键值对，另需**一个文件字段，字段名必须是 `key`，
文件名必须是 `index.js`**，内容为本仓库的 `src/index.js`。
官方说明要求必须带上 `OSSAccessKeyId` 与 `x-oss-security-token`。

**c. 提交为正式的测试版本代码**

```bash
aliyun esa CommitRoutineStagingCode --region cn-hangzhou \
  --Name astra-schedule-cache \
  --CodeDescription "v1"
```

## 3. 发布到生产环境

```bash
aliyun esa PublishRoutineCodeVersion --region cn-hangzhou \
  --Name astra-schedule-cache \
  --Env production \
  --CodeVersion "<第 2a 步返回的 CodeVersion>"
```

此时函数已经可以通过它的默认域名访问，但还没有挂在任何后端域名上，**不影响线上流量**。

## 4. 配置函数路由

### 覆盖范围

**所有承载后端 API 的域名**，也就是 `getastra.cn` 下**除**
`i.` / `sys.` / `dev.` / `go.` / `to.` / 裸域 / `www.` **之外**的全部子域。

原因是 namespace 由 Host 推导（usr-backend 的 `middleware.ParseHostToNamespace`：
`aaa-do.getastra.cn` → `cn/getastra/aaa-do`），所以租户子域同样直接提供客户端课表接口；
被排除的那几个是前端与文档站，不提供课表接口。

> **不要图省事写成 `*.getastra.cn/*`。** 被排除的域名已经用「域名绑定」接了别的函数
> （`usr-dashboard` / `sys-dashboard` / `reg-go` / `docs-site` / `khbitcn-astro`），
> 把它们的流量路由到这个函数会把前端直接劫持掉。

边缘函数按 **hostname** 分组缓存（键 `s1.<host>.<base64url(班级路径)>`），
多租户天然隔离，不需要为每个子域单独配置。

### 命令

```bash
aliyun esa CreateRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 \
  --RoutineName astra-schedule-cache \
  --RouteName astra-schedule-cache \
  --RouteEnable on \
  --Rule '(<规则表达式>)' \
  --Sequence 1 \
  --Timeout 20
```

**关于 `--Rule` 的表达式语法**：本地没有确认过真实格式，不建议直接猜。建议的做法是

1. 先在 ESA 控制台用「自定义模式」配置一条路由，条件写成
   「主机名 包含 `getastra.cn`」且「主机名 不等于 i./sys./dev./go./to./www./裸域」；
2. 再用下面的命令抄回实际生成的 `Rule`，之后就可以在脚本里复用：

```bash
aliyun esa ListRoutineRoutes --region cn-hangzhou --RoutineName astra-schedule-cache
```

路由生效后这些域名的请求都会进入函数。函数内部只对「三段班级路径的 GET」做版本判定，
其余（天气、`/web/*`、静态资源、写请求）一律 `fetch(request)` 透传，行为不变，只是多绕一跳。

## 5. 验证

```bash
# 第一次：缓存未命中，应回源并返回 200
curl -sS -D - -o /dev/null "https://class.getastra.cn/<school>/<grade>/<class>?version=0"

# 第二次：带上第一次响应头里的 X-Astra-Schedule-Version，应直接返回 304，
# 且带有 X-Astra-Edge-Cache: hit（说明是边缘回的，没有回源）
curl -sS -D - -o /dev/null \
  "https://class.getastra.cn/<school>/<grade>/<class>?version=<上一步的版本串>"
```

同时到 ESA 控制台的函数监控里看**请求数**与**子请求数**：命中时子请求数不增长，
说明没有回源。

## 6. 回滚

把路由关掉或删掉即可，边缘函数本身不再被调用，行为立刻回到「每次请求都回源」：

```bash
aliyun esa UpdateRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 --ConfigId <路由的 ConfigId> --RouteEnable off

# 或彻底删除
aliyun esa DeleteRoutineRoute --region cn-hangzhou \
  --SiteId 178107369359596 --ConfigId <路由的 ConfigId>
```

`ConfigId` 从 `ListRoutineRoutes` 的返回里取。

## 7. 与 usr-backend 的部署顺序

边缘函数依赖源站下发的 `X-Astra-Schedule-Version` / `X-Astra-Schedule-Expire` 响应头
（`usr-backend` 的 `router/client/getSchedule.go`）。

**先发布 usr-backend**，再挂路由。顺序反了也不会出错：源站没给头时边缘函数一律不写 KV、
直接透传，只是缓存不生效而已。
