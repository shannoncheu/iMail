# 架构说明

## 范围

iMail 是一个面向个人使用的多账号邮件工作台。它展示第三方邮箱中的内容，但不会成为邮件的权威存储，也不实现 SMTP、IMAP 或 POP3。

计划支持的邮件来源是 Gmail、Outlook.com 和 Zoho Mail。GitHub 只用于确认所有者身份，不承担仓库、通知或邮件功能。

当前仓库已经有认证和会话基础代码，但邮件工作台仍由客户端 `MockMailProvider` 驱动。三个真实邮件适配器都没有实现，也没有连接任何真实数据库、OAuth App 或密钥。

## 当前运行边界

```text
Cloudflare Worker
  -> 把当前请求的运行时绑定交给 vinext App Router
     |
     +-> 认证路由
     |    -> 同源、Origin、Fetch Metadata 与 CSRF 校验
     |    -> GitHub OAuth（只验证身份）
     |    -> AuthRepository
     |         -> Neon PostgreSQL HTTP driver
     |
     +-> 页面会话门禁
     |    -> 未认证：登录页
     |    -> 已认证：CommunicationHub
     |
     +-> CommunicationHub（客户端）
          -> TanStack Query
             -> MockMailProvider
```

这意味着“能登录”和“能访问真实邮箱”是两件事。认证配置完成后可以保护工作台入口，但页面里的邮件仍是模拟数据。

真实邮件接入必须遵守下面的边界：

```text
浏览器
  -> 同源 BFF
     -> 鉴权与应用服务
        -> MailProvider port
           -> server-only Provider 注册表
              -> Gmail / Outlook / Zoho 适配器
                 -> 邮箱供应商 API
```

浏览器只能收到归一化后的领域对象，不能接触 access token、refresh token、OAuth client secret、供应商 SDK 对象或原始响应。应用服务负责授权、输入校验、幂等、并发协调、能力判断和部分失败报告；适配器只负责在供应商 API 与领域接口之间转换。

## 身份登录

GitHub 身份登录与邮箱账号连接完全分开。当前 GitHub 流程不请求 OAuth scope，步骤如下：

1. 浏览器向同源登录端点发起 POST。
2. 服务端校验请求目标、精确 `Origin` 和 Fetch Metadata。
3. 服务端生成高熵 `state`、PKCE S256 verifier/challenge 和浏览器绑定值。
4. `state` 摘要、加密后的临时敏感字段、固定回调地址、返回路径和过期时间写入 PostgreSQL。
5. GitHub 回调原子消费一次性事务，并在服务端交换 authorization code。
6. access token 仅用于调用 GitHub `/user`，读取不可变数字用户 ID、登录名和展示信息。
7. 数字用户 ID 必须命中 `ALLOWED_GITHUB_IDS`；用户名和邮箱不参与最终授权判断。
8. 身份校验完成后通过 GitHub API 吊销并丢弃 access token，再创建新的应用会话。

回调地址只能由 `APP_URL` 生成，不接受浏览器提交的任意地址。返回路径也必须是允许的站内路径，避免开放重定向。

主会话 Cookie 使用 `SameSite=Strict`。OAuth 临时绑定 Cookie 使用 `SameSite=Lax`，因为 GitHub 回调属于跨站顶层导航。两者都是不透明随机值；数据库只保存摘要。

## 请求防护

状态修改端点采用多层校验：

- 只允许明确的 HTTP 方法
- 请求 URL 的 Origin 必须等于配置中的 `APP_URL`
- `Origin` 必须精确匹配；不会把“同站”当作“同源”
- 拒绝 Fetch Metadata 表示为 `cross-site` 或 `same-site` 的请求
- JSON 端点检查 Content-Type
- 已登录的修改请求还必须提供与当前会话绑定的 CSRF token

登录发起端点没有现成会话，因此不要求会话 CSRF token，但仍然要求同源 POST、Origin 和 Fetch Metadata 校验。

## PostgreSQL 数据

迁移 `db/migrations/0001_auth_foundation.sql` 创建以下表：

| 表 | 用途 |
| --- | --- |
| `owners` | 内部所有者记录、禁用状态和最近认证时间 |
| `owner_identities` | GitHub 等外部身份与不可变 subject 的映射 |
| `oauth_transactions` | 短时、一次性的 OAuth state/PKCE 事务 |
| `sessions` | 会话摘要、轮换关系、有效期与吊销状态 |
| `mail_connections` | 邮箱连接元数据和预留的加密凭据字段 |
| `security_events` | 不含原始敏感信息的安全审计事件 |

PostgreSQL 不应成为第二个邮箱。邮件正文、附件、供应商搜索索引和供应商草稿不写入这些表。浏览器邮件缓存只保存在内存中，认证响应使用 `Cache-Control: no-store`。

数据库迁移由 `scripts/migrate.mjs` 显式执行，不在请求或应用启动期间自动建表。仓库只提供 schema 和数据访问层，并没有附带、创建或连接一个真实数据库。

## Neon 与 Sites

当前 Worker 侧使用 `@neondatabase/serverless` 的 HTTP driver，因此运行配置预期使用 Neon PostgreSQL 的 `DATABASE_URL`。这种方式适合当前的短查询和非交互式事务，也避免在 Worker 中依赖长连接。

`.openai/hosting.json` 目前不能声明 Cloudflare Hyperdrive。若未来需要 Hyperdrive 的连接池与现有 PostgreSQL 配合，需要在 Cloudflare 侧单独配置绑定，并替换 `src/server/db/neon.ts` 的访问方式；仅修改 Sites manifest 不会产生 Hyperdrive 绑定。

## 邮件 Provider 边界

共享的 `MailProvider` 是界面需要的稳定接口。当前客户端只使用 `MockMailProvider`。

真实服务端入口位于 `src/server/mail/provider-registry.ts`，该模块及其上下文类型都标记为 `server-only`。注册表静态列出 `gmail`、`outlook` 和 `zoho`，但当前三个条目均为空：

- 未知 Provider 抛出 `UnknownMailProviderError`
- 已知但未实现的 Provider 抛出 `MailProviderNotConfiguredError`
- 服务端不会因为配置缺失而退回 `MockMailProvider`
- 调用者只传递非敏感的 owner/account 标识，凭据必须由适配器在服务端自行读取

这道边界防止以后接入真实账号时把凭据或供应商客户端对象带进浏览器包，但它本身不是一个真实邮箱适配器。

## Provider 语义

Provider 能力应显式声明，不能由界面猜测。移动到垃圾箱、恢复和永久删除需要不同的方法。发送请求不能在超时后盲目重试；供应商返回未知结果时，应保留“状态待确认”，直到可以完成对账。

跨账号搜索必须由用户主动选择，因为同一个查询会发送给多个供应商。部分失败需要按账号保留并展示，不能用空结果掩盖错误。

## 邮件内容

HTML 邮件属于不可信输入。真实 Provider 上线前需要完成：

- 基于允许列表的服务端净化
- 移除脚本、表单、活动嵌入、危险协议和不安全 CSS
- 使用禁用脚本、独立 Origin 的渲染环境
- 默认关闭外部图片
- 通过不透明应用 ID 流式代理附件
- 禁止浏览器和 Service Worker 持久化私人邮件内容

## 目录职责

```text
app/                              页面、认证路由和同源 API
src/auth/                         可安全传给客户端的会话视图类型
src/server/auth/                  身份、OAuth 事务与会话数据访问
src/server/db/                    Worker 兼容的 PostgreSQL 访问层
src/server/security/              加密、Cookie、Origin 与 CSRF
src/server/mail/                  真实 Provider 的 server-only 边界
src/providers/mail/MailProvider   稳定的邮件领域接口
src/providers/mail/MockMailProvider
                                  当前客户端模拟实现
src/mocks/                        合成开发数据
db/migrations/                    显式执行的数据库迁移
worker/                           Cloudflare Worker 入口与运行时绑定
```

## 尚未完成

- 目标环境中的数据库、Secret 和 GitHub OAuth App 配置
- Gmail、Outlook.com、Zoho Mail 的 OAuth 连接流程与服务端适配器
- 把邮件读取和写操作从客户端 Mock 迁移到同源应用服务
- 邮箱凭据的实际写入、刷新、撤销和密钥轮换流程
- 邮件 HTML 隔离与附件代理
- 真实 OAuth、数据库故障和完整浏览器流程的端到端测试
- 生产部署、监控、备份和事故响应配置

因此，目前的认证代码可以作为受限工作台入口的基础，但整个项目还不能作为生产邮件客户端使用。
