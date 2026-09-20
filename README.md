# esa-edge-cache

星程课表（AstraSchedule）SaaS 版的 **ESA 边缘版本缓存**。

对应 issue：[AstraSchedule/desktop#63 基于 KV 存储的进一步压缩响应时间与部署成本的方法](https://github.com/AstraSchedule/desktop/issues/63)

课表接口 `GET /:school/:grade/:class` 的响应很少变化，但客户端每次拉取都会把源站函数调起来、
查五张表算出版本号再决定 304。这个边缘函数把「当前有效版本 + 该版本必然失效的时刻」放进
ESA 边缘 KV，客户端带着本地 `version` 回来时直接在边缘回 304，**不回源**。

只服务 SaaS 部署（`class.getastra.cn` → FC）。自部署版本不接入边缘层。

部署载体是 ESA 的 **Pages**（控制台「导入 Github 仓库」那条路径产出的就是 Pages），
用 `esa.jsonc` 声明为**纯函数**（只给 `entry`、不给 `assets`），
再以**函数路由**挂到后端域名上——**不能**用域名绑定，那会绕开源站。详见
[`docs/deploy.md`](docs/deploy.md)。

## 设计摘要

- **KV 里只存版本元信息**，不存课表响应体。cache miss 一律回源，边缘不承担数据一致性。
- **回源时请求原样透传**（保留 `version` 参数），源站自己的 304 快路径照旧生效；
  版本与过期时刻由源站用响应头带回，边缘不需要发第二次请求。
- **过期时刻（`X-Astra-Schedule-Expire`）由源站计算**：取「自动任务条件翻转点」与
  「下一个本地零点」中较早的一个。少了零点这一项，边缘会在午夜后继续用前一天的版本判 304。
- **写请求用「世代键」整体失效**：会改数据的方法（`PUT`/`POST`/`PATCH`/`DELETE`）成功后把 `g1.<host>` 换一个新值，
  班级条目里记下写入时的世代，读取时二者必须一致。一次写入就能让该域名下所有班级失效，
  不必枚举键（边缘 KV 没有前缀枚举能力），也覆盖了 `/web/autorun` 这类一次影响多个班级的全局写入。
- **缓存是纯优化**：KV 不可用、抛异常、格式不认识、请求带 `Origin` 时一律降级为直接回源。
- **按 Host 头分租户**：后端 namespace 由 Host 推导
  （`ParseHostToNamespace`：剥端口 → 反转域名标签，**不做大小写折叠**），
  所以边缘缓存键直接取 **Host 头原值**（剥端口、只校验不清洗），键与世代都按它隔离。
  函数要覆盖 `getastra.cn` 下**除 `i.` / `sys.` / `dev.` / `go.` / `to.` / 裸域 / `www.` 之外**
  的全部子域。详见 `docs/design.md` 第 2 节。

详细的取舍、平台限制实测结果与已知风险见 [`docs/design.md`](docs/design.md)。

## 目录结构

```
esa.jsonc           ESA Pages 配置：只声明 entry，不声明 assets（纯函数）
src/index.js        边缘函数本体（ESA 函数运行时，单文件，ES Module）
test/index.test.js  bun test 用例（伪造 EdgeKV 与源站）
docs/design.md      设计与取舍、ESA 平台限制、上线前必须验证的假设
docs/deploy.md      部署步骤：建 Pages、挂函数路由、验证与回滚
```

## 本地测试

```bash
bun test   # 无第三方依赖，不需要先 bun install
```

## 部署（尚未执行）

> 本仓库目前**没有部署**，也没有在真实 ESA 上跑过。完整步骤见
> [`docs/deploy.md`](docs/deploy.md)：用 `esa.jsonc` 把仓库声明成纯函数 Pages →
> 导入 Github 仓库建 Pages → 添加**函数路由**（不是域名绑定）→ 验证 → 回滚。
> 执行前请先读完该文档第 3 节末尾「两个我无法离线确认的点」。

## 相关仓库

- [AstraSchedule/usr-backend](https://github.com/AstraSchedule/usr-backend) —
  下发 `X-Astra-Schedule-Version` / `X-Astra-Schedule-Expire` 响应头（saas 线）
- [AstraSchedule/desktop](https://github.com/AstraSchedule/desktop) — 客户端，无需改动
