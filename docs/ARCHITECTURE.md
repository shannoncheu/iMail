# iMail 架构

## 系统定位

iMail 是第三方邮箱的操作界面，不是邮件服务器。Gmail、Outlook.com 和 Zoho Mail 仍然是邮件的权威存储；iMail 不实现 SMTP、IMAP、POP3、投递、反垃圾或长期邮件归档。

当前仓库已经包含完整的代码路径：GitHub 所有者登录、应用会话、三家邮箱 OAuth、加密凭据、同源邮件 BFF、三个真实适配器、浏览器端 `ApiMailProvider`、分页、写操作、附件、HTML 净化、断开补偿、限流和维护任务。`MockMailProvider` 只作为显式测试实现保留，生产工厂不会自动回退。

“代码路径完整”与“生产环境已打通”是两件事。仓库没有真实 Neon、OAuth Secret、生产域名、有效的 Sites `project_id` 或真实账号 E2E 记录。

## 运行时总览

```text
浏览器
  |
  |  HTTPS，同源 Cookie + CSRF
  v
Cloudflare Worker
  -> runWithRuntimeEnv(env)
  -> vinext App Router
      |
      +-> app/page.tsx
      |    -> GitHub 身份与应用会话门禁
      |    -> CommunicationHub
      |
      +-> /api/auth/*
      |    -> AuthRepository
      |
      +-> /api/mail/*
      |    -> MailApiContext
      |       -> MailService
      |          -> server-only Provider Registry
      |             -> Production Provider Factory
      |                -> GmailMailProvider -> Gmail API
      |                -> OutlookMailProvider -> Microsoft Graph
      |                -> ZohoMailProvider -> Zoho Mail API
      |
      +-> /api/internal/maintenance
      |
      +-> Neon PostgreSQL HTTP driver

Cloudflare Cron
  -> worker.scheduled()
     -> cleanup + pending provider revocation retry
```

`worker/index.ts` 是部署入口。它把当前请求的 Worker bindings 放进请求作用域，普通请求交给 vinext，图片优化走 Cloudflare 图片绑定，最后统一补充安全响应头。Cron Trigger 走同一个 Worker 的 `scheduled()`，不经过浏览器会话。

## 浏览器端

`app/communication-hub.tsx` 使用 TanStack Query 管理账号、文件夹和邮件页。`src/providers/mail/index.ts` 的生产工厂接收当前会话的 CSRF token，并创建 `ApiMailProvider`：

```text
CommunicationHub
  -> ApiMailProvider
     -> GET/POST /api/mail/*
        -> 归一化 MailAccount / MailThread / OperationResult
```

`ApiMailProvider` 不知道 Google、Microsoft 或 Zoho token，也不会导入任何服务端适配器。它只接受相对的同源邮件 API 路径，给写请求附加 CSRF token，并在运行时校验响应结构。服务端返回的正文和附件 URL 也必须位于 `/api/mail/*`，跨源 URL 会被客户端拒绝。

列表使用 `getMessagesPage` 和服务端游标加载更多，已加载页面保存在当前 React Query 内存缓存中。写信附件在浏览器读取为 Base64 后随 JSON 发给 BFF；当前不是直传或分块上传。文件数量、单文件大小和总大小都在读取前检查，服务端再做一遍独立校验。

## 所有者身份与应用会话

GitHub 登录与邮箱账号授权是两套独立流程。

GitHub 登录步骤：

1. 浏览器同源 POST `/api/auth/github/start`。
2. 服务端校验 Origin、Fetch Metadata、请求体和持久化限流。
3. 生成随机 `state`、PKCE S256 和浏览器绑定值；事务有效期 10 分钟。
4. `state` 与浏览器绑定只存摘要，PKCE verifier 用 AES-256-GCM 加密后写入 `oauth_transactions`。
5. 回调原子消费事务，交换 code，并用临时 access token 读取 GitHub `/user`。
6. 不可变数字用户 ID 必须命中 `ALLOWED_GITHUB_IDS`。通过后立即撤销 GitHub token，再创建应用会话。

应用会话的原始 token 只在 HttpOnly Cookie 中出现，PostgreSQL 保存摘要。`app/page.tsx` 在服务端读取 Cookie：配置缺失时展示“未配置”，数据库或认证不可用时失败关闭，只有有效会话能得到 `CommunicationHub` 和派生的 CSRF token。

`SESSION_SECRET` 用不同用途标签派生会话摘要、CSRF、限流 subject、邮件公共 ID 签名等 HMAC key，避免同一结果跨用途复用。

## 邮箱 OAuth

三个邮箱入口共用 `src/server/mail/connect-routes.ts` 与 `oauth.ts`，供应商差异来自 `getMailOAuthConfig()`。

连接开始：

1. 浏览器 POST `/api/mail/connect/{provider}/start`。
2. 服务端要求有效应用会话、精确同源、Fetch Metadata、JSON 和 CSRF；每家 provider 每 10 分钟最多发起 5 次。
3. 生成随机 `state`、浏览器绑定值和 PKCE，创建 10 分钟的 `mail_oauth_transactions` 记录。
4. verifier 按当前 token key version 加密；数据库保存 `state`/binder 摘要、固定 callback 和站内 `returnTo`。
5. 服务端返回供应商 authorization URL，浏览器再跳转。

回调完成：

1. 校验回调 URL 的 Origin、路径和查询参数数量。
2. 用 provider、`state` 摘要和 Cookie binder 摘要原子删除并读取事务；同时检查原应用会话仍有效。
3. 用事务记录的 key version 解密 verifier，交换 authorization code。
4. 获取供应商账号 ID 和邮箱地址，确认需要的 API scope，并要求存在 refresh token；重新连接时可沿用数据库中已有的 refresh token。
5. access/refresh token 组成凭据包，用 `MailTokenVault` 加密后 upsert 到 `mail_connections`。
6. 轮换发起授权的应用会话，清除邮箱 OAuth 绑定 Cookie，并返回站内页面。

Gmail 使用 Google OAuth 和 Gmail API；Outlook 使用 Microsoft identity platform 与 Graph，tenant 可配置；Zoho 的 Accounts 与 Mail API Origin 必须分别命中代码中的 HTTPS 数据中心允许列表。

## Provider 边界

`src/providers/mail/MailProvider.ts` 定义稳定领域接口，覆盖：

- 账号与文件夹；
- 列表、搜索、分页和会话读取；
- 发送、草稿、回复和转发；
- 归档、垃圾箱恢复、原位置恢复、已读和星标；
- 可选的附件内容与原始正文读取。

这个接口有两类实现：

- 浏览器使用 `ApiMailProvider`，实现是同源 HTTP；
- 服务端使用 Gmail、Outlook、Zoho 适配器，实现是供应商 API。

`provider-registry.ts` 标记为 `server-only`，静态注册三家 production factory。未知 provider、对应 OAuth 配置缺失、跨 owner 连接、已断开连接或不可解密凭据都会明确失败，Mock 不参与解析。

`MailService` 是 BFF 与适配器之间的应用层：

- 按当前 owner 选择连接并按 provider 分组；
- 把应用签名 ID 还原为供应商原生 ID；
- 防止回复、转发或草稿跨账号使用；
- 聚合多账号文件夹和分页结果；
- 为正文和附件生成同源 URL；
- 对批量写操作保留逐 ID 的成功、失败和原位置，供 UI 撤销。

批量状态修改按账号分组，一个账号失败不会抹掉其他账号的结果。“全部账号”读取最多同时覆盖 5 个连接，单页最多 25 封；首屏某个 provider 不可用时，响应会带 `partial/accountErrors`，健康账号的邮件仍可使用。客户端只显示失败账号数量，不把内部错误或账号 ID 暴露给用户。

## Token 刷新与并发

production factory 每次从 owner 绑定的连接记录创建适配器。凭据解密后交给 `ConnectionAccessTokenController`：

1. access token 距过期不足 60 秒，或适配器收到受信任 API Origin 的 `401` 时请求刷新。
2. 同一 controller 中的并发调用共享一个 refresh Promise。
3. 刷新前按连接 ID 和旧 `token_version` 原子取得 45 秒数据库 lease。另一个 Worker isolate 取不到 lease 时不会再向供应商交换 token，而是等待并读取获胜版本。
4. lease 持有者交换 token，新凭据先用 active token key 加密，再以旧 `token_version` 和 lease ID 为条件更新数据库；成功更新会递增版本并清除 lease。
5. 条件更新失败时，当前请求重新读取、验证并使用获胜版本，不覆盖较新的 token。异常路径也会尝试释放仍属于自己的 lease，过期 lease 可被后续请求接管。
6. Gmail、Outlook、Zoho 适配器只获得一个取 token 的回调，不获得数据库或密钥对象。

该设计用数据库 lease 协调不同 isolate 的刷新竞争，但它不是通用分布式任务队列。供应商若在刷新时轮换 refresh token，最终一致性依赖 lease、`token_version` 条件更新和获胜记录可用。

## 同源邮件 API

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/mail/accounts` | GET | 已连接账号和当前已配置的 provider |
| `/api/mail/folders?scope=` | GET | 单 provider 或全部账号的归一化文件夹 |
| `/api/mail/messages` | GET | 文件夹、搜索、`cursor`、`pageSize` 分页 |
| `/api/mail/message?id=` | GET | 读取单个会话 |
| `/api/mail/draft?id=` | GET | 读取已有草稿并恢复编辑字段和附件元数据 |
| `/api/mail/content?id=` | GET | 读取原始正文、服务端净化并返回沙箱文档 |
| `/api/mail/attachment?id=` | GET | 按签名 ID 代理下载附件 |
| `/api/mail/send` | POST | 发送新邮件 |
| `/api/mail/drafts` | POST | 新建或更新草稿 |
| `/api/mail/reply` | POST | 回复指定会话 |
| `/api/mail/forward` | POST | 转发指定会话 |
| `/api/mail/mutate` | POST | 归档、垃圾箱、恢复、已读、星标 |
| `/api/mail/connect/{provider}/start` | POST | 创建邮箱 OAuth 事务 |
| `/api/mail/connect/{provider}/callback` | GET | 消费 OAuth 回调并保存连接 |
| `/api/mail/disconnect` | POST | 上游撤销或进入待撤销补偿，再使连接不可用 |

所有 GET 都要求应用会话。所有 POST 邮件写操作还要求 CSRF 和同源校验，并根据动作使用数据库限流。路由限制 JSON 体积，`zod` schema 再限制字段长度、收件人数、批量 ID 和附件数量。

邮件 API 的成功和错误响应默认 `no-store`。适配器异常不会把 token、第三方响应体或数据库信息传给客户端。

## 应用 ID 与分页游标

浏览器不直接提交裸的 provider message ID。`public-id.ts` 把连接 UUID、资源类型、原生 ID，以及附件所属 message ID 编码成 payload，再用从 `SESSION_SECRET` 派生的 HMAC 签名。

签名提供完整性，不提供保密性。服务端解码后仍会：

- 按当前 owner 查询连接；
- 检查连接仍为 `connected` 且有凭据；
- 限制允许的资源类型；
- 对回复、转发和草稿验证连接一致。

服务端分页不会把 provider 长游标和未消费邮件直接塞进 URL。无论单账号还是“全部账号”视图，服务端都会为当前 owner 建立固定 15 分钟的分页会话，把查询指纹、冻结的连接集合、各家原生 cursor、未消费摘要、稳定排序边界和上一页重放结果序列化后，用 active token encryption key 做 AES-256-GCM 加密，再存入 `mail_pagination_sessions`。浏览器只收到包含随机 session ID、revision 和查询指纹的短签名句柄。“全部账号”额外执行多路归并，并限制为最多 5 个连接、单页最多 25 封。

每一页通过各账号缓冲区做稳定的 k 路归并，顺序键为机器时间、连接 ID 和原生邮件 ID；未消费摘要留在加密状态中，不会为了翻页重新抓取同一实时 provider 页。推进使用 revision CAS；同一个当前 cursor 并发消费或在下一页尚未推进前立即重试时，失败方读取胜出版本并返回相同缓存页。会话继续推进后，更早的 cursor 会作为过期 revision 拒绝，客户端应只保留最新 cursor。cursor 不能跨 owner、连接集合、文件夹、搜索或 page size 使用，15 分钟会话过期后必须从第一页重新查询。供应商自己的 cursor 若不提供快照语义，外部邮箱在翻页期间发生新增或删除仍受该供应商 API 的一致性边界影响。

轮换 `SESSION_SECRET` 后，旧资源 ID 和分页句柄会失效；轮换 token encryption key 时，15 分钟内的分页状态可以通过 previous key 读取，新的分页会话只使用 active key。

## 邮件正文和附件

Provider 列表对象只携带正文摘要、签名 message ID 和同源 `contentUrl`。打开正文时，`/api/mail/content` 再向对应 provider 读取原始 HTML 或纯文本。

HTML 处理顺序：

```text
供应商原始正文
  -> attribute-free 元素允许列表
  -> 删除脚本、CSS、表单、链接、嵌入和原始属性
  -> 默认移除远程图片
  -> 包装为带 CSP sandbox 的同源 HTML
  -> 客户端 sandbox="" iframe
```

用户明确开启外部图片后，客户端给正文 URL 增加 `externalImages=1`。服务端只保留不含凭据的 HTTPS 图片 URL，并同步放宽该正文响应的 `img-src`；脚本、连接、表单和子框架仍被禁止。这个开关不消除邮件跟踪风险。

附件列表只返回元数据和同源 `downloadUrl`。下载路由再次验证签名 ID、owner 和连接，向 provider 取内容后强制下载；统一响应上限为 25 MiB，各 provider 还会执行自己的更严格限制。写信附件在浏览器 Base64 编码，最多 10 个、单个和总计最多 5 MiB；BFF 按流统计请求字节并在越界时立即取消，避免大 JSON 在 Worker 内存中形成过多副本。

PostgreSQL 不长期保存正文或附件。为了保证服务端翻页不越过已经取回但尚未返回的结果，`mail_pagination_sessions` 会临时保存 AES-GCM 加密的列表摘要和 provider cursor，固定 15 分钟后由维护任务删除；单账号与组合视图都使用该状态，它不保存正文或附件字节。客户端也没有持久化邮件缓存或 Service Worker 邮件存储。

## PostgreSQL 数据模型

迁移由 `scripts/migrate.mjs` 显式执行，并在 `schema_migrations` 记录文件名；应用启动和请求处理不会自动建表。

| 表 | 内容 |
| --- | --- |
| `schema_migrations` | 已成功应用的迁移文件 |
| `owners` | 内部 owner、禁用状态、最近认证时间 |
| `owner_identities` | GitHub subject 与 owner 的映射 |
| `oauth_transactions` | GitHub OAuth 的短时 state/PKCE 事务 |
| `sessions` | 会话摘要、轮换关系、过期和吊销状态 |
| `mail_connections` | provider 账号、邮箱、scope、加密凭据、token version、刷新 lease、状态和错误码 |
| `mail_oauth_transactions` | 三家邮箱 OAuth 的短时 state/PKCE/browser-binding 事务 |
| `mail_pagination_sessions` | owner 绑定、固定 15 分钟、AES-GCM 加密的服务端分页状态与 revision CAS |
| `mail_draft_intents` | owner、连接和原生草稿绑定的 reply/forward 来源；不保存正文或附件 |
| `rate_limit_buckets` | HMAC 化 subject 的固定窗口计数 |
| `security_events` | 不应包含原始敏感内容的安全事件 |

`0001_auth_foundation.sql` 建立身份、会话、连接和安全事件基础；`0002_mail_runtime.sql` 增加邮箱 token 并发字段、邮箱 OAuth 事务和限流表；`0003_mail_pagination_sessions.sql` 增加只保存密文的短期分页会话；`0004_mail_draft_intents.sql` 增加 owner 与连接绑定的回复/转发草稿意图。连接唯一键是 `(owner_id, provider, provider_account_id)`，重新授权会更新原记录并递增 `token_version`。

数据库使用 `@neondatabase/serverless` 的 HTTP driver。`.openai/hosting.json` 的 D1/R2 字段不会创建或描述 Neon，运行时仍必须单独注入 `DATABASE_URL`。

## 密钥版本

`TOKEN_ENCRYPTION_KEY_VERSION` 标记 active key。配置可以同时提供一组 previous key/version：

- 新的 GitHub/邮箱 OAuth verifier 和邮箱凭据只用 active key；
- 解密按密文 envelope 记录的版本选择 active 或 previous；
- token 自然刷新会把旧版邮箱凭据重新加密为 active version；
- 新分页会话只用 active key，已有会话在固定 15 分钟内可用 previous key 解密；
- 旧 OAuth 事务和分页会话等待过期并由维护任务清除；
- 只有数据库中旧版记录归零后才能删除 previous key。

代码只支持一个 previous slot。`SESSION_SECRET` 没有相同的双版本机制，轮换会强制旧会话、公共邮件 ID、cursor 和限流 bucket 全部失效。操作步骤和核对 SQL 见 `docs/DEPLOYMENT.md`。

## 断开与补偿

`POST /api/mail/disconnect` 不会先删除凭据再假设撤销成功：

- Gmail 和 Zoho 先调用上游撤销；上游返回成功后，连接标为 `disconnected` 并清空凭据密文。
- 上游结果不明确时，连接标为 `error`，`last_error_code=revocation_pending`，不再出现在已连接账号中，但保留密文供重试；接口返回 `202`，UI 明确提示后台待处理和手工撤销路径。
- Outlook delegated flow 没有按单个 refresh token 撤销的端点，当前直接清除本地凭据，账号侧同意由用户在 Microsoft 管理界面撤销。

`runMaintenanceCleanup()` 每轮最多读取 25 条待撤销记录，重试成功后才清除密文。持续失败会保留到下一轮，不会把模糊的 provider 错误当作撤销成功。

## 维护任务

Cloudflare Cron 调用 `worker.scheduled()`，备用方案是带 `MAINTENANCE_SECRET` 的 `POST /api/internal/maintenance`。两条路径共用同一个 cleanup：

- 删除过期 GitHub 和邮箱 OAuth 事务；
- 删除过期的加密分页会话；
- 删除过期会话，以及已吊销超过 7 天的会话；
- 删除过期限流 bucket；
- 删除超过 90 天的安全事件；
- 重试待撤销 provider token。

Cron 表达式、Secret、监控和告警属于部署平台状态，不在仓库中自动创建。当前 `.openai/hosting.json` 的 `project_id` 仍为空。

## 失败语义与当前限制

- 核心认证配置缺失时，页面显示未配置，受保护 API 返回失败；单个邮箱 OAuth 配置缺失只关闭该 provider 的连接入口。
- BFF 对客户端隐藏内部异常；诊断依赖服务端受控日志和监控，不能通过把供应商原始响应返回浏览器解决。
- 发送、回复、转发遇到网络超时后，供应商端是否已执行可能不确定。适配器没有对这些非幂等操作做无限自动重试。
- 多账号批量修改保留部分成功；多账号首屏读取提供显式部分结果，已经参与排序的账号在中途不可用时会返回可证明有序的短页，后续 cursor 等待该账号恢复，避免静默跳过邮件。
- 附件下载按流累计并在 provider 边界处限量，成功后仍会在 Worker 中组装不超过路由上限的响应，因此必须在目标平台继续做内存和延迟压测。
- 代码测试使用注入的 HTTP 和数据库替身；没有真实 Neon、GitHub、Google、Microsoft、Zoho 或 Sites E2E 证据。

## 目录职责

```text
app/
  page.tsx                         服务端会话门禁
  communication-hub.tsx           浏览器邮件工作台
  api/auth/                        GitHub 登录与退出
  api/mail/                        同源邮件 BFF
  api/internal/maintenance/        备用维护入口

src/providers/mail/
  MailProvider.ts                  稳定领域接口
  ApiMailProvider.ts               浏览器 BFF 实现
  MockMailProvider.ts              显式测试实现

src/server/auth/                   owner、身份、会话、GitHub OAuth
src/server/mail/
  mail-service.ts                  owner 绑定、ID 转换、聚合与写操作
  provider-registry.ts             server-only 静态注册表
  provider-factory.ts              凭据解密、刷新协调、适配器构造
  gmail/                            Gmail API 适配器
  outlook-provider.ts              Microsoft Graph 适配器
  zoho/                             Zoho Mail API 适配器
  html-sanitizer.ts                邮件 HTML 允许列表
  token-vault.ts                   邮箱凭据 AES-GCM keyring

src/server/security/               加密、Cookie、同源、CSRF、限流、响应头
src/server/db/                     Neon HTTP 查询入口
db/migrations/                     显式 PostgreSQL 迁移
worker/index.ts                    Worker fetch 与 scheduled 入口
```

生产资源准备、OAuth 控制台配置、Cron、监控、备份、轮换和回滚以 [`DEPLOYMENT.md`](DEPLOYMENT.md) 为准。该手册描述应执行的流程，不代表仓库作者已经替部署者完成这些外部步骤。
