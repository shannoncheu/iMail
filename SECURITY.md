# 安全策略

## 适用范围

iMail 的安全边界按“单个或少量受信任所有者、自托管、浏览器只访问同源服务”设计。GitHub 用于确认谁能进入工作台；Gmail、Outlook 和 Zoho OAuth 用于连接邮箱，两类授权互不替代。

认证、三家邮件适配器、同源 BFF、令牌刷新、内容净化、附件代理、限流、断开补偿和维护任务已经写入代码并有自动测试。仓库没有真实 Neon、OAuth Secret、生产域名、Sites 项目或真实账号 E2E 结果，因此目前只能说明实现边界，不能说明某个线上实例已经安全上线。

## 已实现的边界

### 所有者身份与会话

- GitHub 授权请求不带仓库 scope。回调取得的 access token 只用于读取 `/user`，按不可变数字 ID 检查 `ALLOWED_GITHUB_IDS`，随后立即向 GitHub 撤销并丢弃。
- GitHub OAuth 使用 10 分钟的一次性事务、随机 `state`、PKCE S256 和浏览器绑定 Cookie。事务在 PostgreSQL 中原子消费，重复或过期回调失败关闭。
- 应用会话 Cookie 是不透明随机值；数据库只保存摘要、有效期、轮换关系和吊销时间。HTTPS 下使用 `Secure`、`HttpOnly`、`SameSite=Strict`。
- OAuth 绑定 Cookie 为短时值，使用 `HttpOnly` 和 `SameSite=Lax`，只为顶层跨站回调保留必要兼容性。
- GitHub 和邮箱回调地址都由可信的 `APP_URL` 固定生成。返回路径只接受站内绝对路径，拒绝协议相对地址和反斜杠变体。
- 邮箱 OAuth 成功后会轮换当前应用会话，旧会话进入吊销状态。

### 邮箱授权与凭据

- Gmail、Outlook、Zoho 均使用 Authorization Code + PKCE。邮箱 OAuth 事务同时绑定 owner、session、provider、`state` 摘要和浏览器绑定摘要，有效期为 10 分钟。
- PKCE verifier 与邮箱 access/refresh token 使用 AES-256-GCM 加密。附加认证数据包含事务或连接 ID、owner、provider 和密钥版本，密文不能挪到另一账号或另一用途解密。
- token、Client Secret 和供应商响应对象只存在于 server-only 模块。浏览器收到的是归一化账号和邮件对象，不会收到供应商凭据。
- Provider 工厂从 owner 绑定的已连接记录读取凭据，提前一分钟刷新即将过期的 access token；同一实例内合并并发刷新，不同 Worker isolate 再通过 45 秒数据库 lease 协调，`token_version` 和 lease ID 共同防止旧请求覆盖新 token。
- 新连接和 token 刷新只用 active 加密密钥写入；读取支持 active 和一版 previous key。旧连接在正常刷新时会重新用 active key 加密。
- 供应商缺失、连接不属于当前 owner、provider 不匹配、凭据缺失或 scope 不足时均失败关闭，不会回退到 `MockMailProvider`。

### 同源 BFF 与授权检查

- 浏览器端生产工厂固定使用 `ApiMailProvider`，请求限制在相对的 `/api/mail/*` 路径，并使用 `credentials: same-origin`、`cache: no-store` 和严格响应解析。
- 所有邮件 API 先验证应用会话。写操作额外校验精确 `Origin`、Fetch Metadata、JSON Content-Type 和当前会话 CSRF token。
- GitHub 登录发起端点还没有应用会话，因此不要求 CSRF token，但仍只接受同源 POST，并检查 Origin 和 Fetch Metadata。
- 邮件、会话、草稿和附件使用服务端签名的应用 ID。分页 cursor 是同类签名短句柄，实际的 provider 游标与服务端分页状态使用 token encryption key 加密后在 PostgreSQL 固定保留 15 分钟。回复或转发草稿的意图只在服务端按 owner、连接和原生草稿 ID 绑定，客户端只能拿到重新签名的来源 ID；数据库不保存草稿正文或附件。签名防止篡改；实际访问时仍会按当前 owner 查询连接并检查连接状态。
- 草稿、收件人、搜索、游标、批量 ID、正文和附件都有 schema、数量及大小限制。三家邮箱共用的搜索上限为 256 个字符；浏览器上传最多 10 个附件，单个和合计均不超过 5 MiB，正文最多 1,000,000 字符。
- “全部账号”最多聚合 5 个连接、单页最多 25 封；分页明文序列化前限制为 512 KiB，数据库只保存带 owner、查询指纹和固定 15 分钟期限的 AES-GCM envelope。推进使用 revision CAS，同一个当前 cursor 的并发消费会重放同一结果；会话推进后旧 revision 会被拒绝，不会静默跳过另一个账号的缓冲区。
- BFF 不把适配器异常或第三方原始错误直接返回浏览器；HTTP 和解析错误被归一化为有限的应用错误。

### 不可信邮件内容

- 原始 HTML 在服务端经过 attribute-free 允许列表净化。脚本、样式元素、模板、表单、链接、元数据、活动嵌入和原始属性不会进入结果；可读文本尽量保留。
- 净化后的正文由同源 `/api/mail/content` 返回，并同时受到响应 CSP 的 `sandbox`、禁脚本、禁连接、禁表单、禁对象、禁子框架等限制；客户端 iframe 也使用空权限的 `sandbox=""` 和 `no-referrer`。
- 外部图片默认移除。只有用户明确开启后，净化器才保留无账号密码、长度受限的 HTTPS 图片 URL，并添加 lazy loading 与 no-referrer。开启远程图片仍可能向发件方暴露访问时间和客户端网络地址，界面会提示这项风险。
- 内嵌 `data:image` 只接受 PNG、JPEG、GIF、WebP 的 Base64 形式；其他协议和凭据化 URL 被拒绝。
- 附件通过签名应用 ID 和同源下载路由取得，强制 `Content-Disposition: attachment`、`nosniff`、下载专用 CSP，并清理文件名。上游响应按流累计并在越界时取消；统一路由硬上限为 25 MiB，Gmail 进一步限制为 10 MiB。成功响应仍会在 Worker 内存中组装，因此上线前仍需压测。
- 邮件正文和附件不写入 PostgreSQL。JSON、正文和附件响应使用 `no-store`；客户端查询缓存只存在于页面内存中。

### 限流、断开与维护

- GitHub 登录发起、三家邮箱连接、发送、草稿、回复、转发、状态修改和断开均有数据库持久化限流。bucket 的 subject 是由 `SESSION_SECRET` 派生密钥对来源地址和 User-Agent 计算的 HMAC，不保存原始 IP 或 User-Agent。
- Gmail 和 Zoho 断开时先尝试供应商撤销。若上游结果不明确，本地记录改为不可用但暂时保留加密凭据，`last_error_code` 标记为 `revocation_pending`，避免误把失败当作已经撤销。
- 维护任务每轮最多重试 25 条待撤销连接。上游撤销返回成功后才清除本地密文。Outlook 当前没有按单个 delegated refresh token 撤销的端点，断开时只删除本地凭据；彻底撤权需要在 Microsoft 账号或租户管理界面操作。
- Worker 已提供 Cloudflare Cron `scheduled()`；备用的 `/api/internal/maintenance` 只接受格式受限的 Bearer Secret，并使用恒定时间比较。
- 维护任务清理过期的两类 OAuth 事务、15 分钟分页会话、过期或长期已吊销会话、限流 bucket 和超过 90 天的安全事件。日志只写固定事件名和计数，不拼接异常、邮箱地址或凭据。

### 响应头

- Worker 为普通响应补充防嵌入、`nosniff`、Referrer Policy、Permissions Policy；HTTPS 响应增加一年 HSTS。
- 正文路由显式使用 `SAMEORIGIN` 和 `frame-ancestors 'self'`，以便只在工作台自己的沙箱 iframe 中显示；其他页面保持 `DENY`/`frame-ancestors 'none'`。
- 附件和正文路由各自设置更严格的 CSP 与 Cross-Origin-Resource-Policy，Worker 不覆盖路由已经给出的更具体策略。

## 数据与 Secret

PostgreSQL 会保存所有者身份、邮箱地址、供应商账号 ID、已授权 scope、连接状态、过期时间和少量 provider metadata。这些连接元数据不是匿名数据。服务端分页（包括单账号和组合视图）还会临时保存 AES-GCM 加密的列表摘要、排序状态和 provider cursor，固定 15 分钟后过期；数据库不会保存邮件正文、附件字节、原始 MIME 或长期供应商搜索索引。

以下值不得进入 Git、构建产物、Issue、日志或聊天记录：

- `DATABASE_URL`；
- `SESSION_SECRET`、`TOKEN_ENCRYPTION_KEY`、`MAINTENANCE_SECRET`；
- GitHub、Google、Microsoft、Zoho Client Secret；
- OAuth code、state、access token、refresh token；
- 会话 Cookie、CSRF token；
- 真实邮件正文、收件人或附件。

本地 Secret 放在被 Git 忽略的 `.dev.vars`，生产值由 Sites/Worker Secret 管理注入。任何 Secret 一旦进入 Git 历史，必须在上游吊销并轮换，仅删除当前文件不够。

### 密钥轮换的实际语义

| 项目 | 当前行为 |
| --- | --- |
| `TOKEN_ENCRYPTION_KEY` | 支持 active + previous 两版；新写入只用 active，按密文版本选择读取密钥 |
| `SESSION_SECRET` | 没有双版本窗口；轮换会使旧会话、邮件签名 ID 和旧页面失效，也会重置限流派生空间 |
| OAuth Client Secret | 由各供应商控制台轮换；代码不保存旧值，也不自动协调供应商侧双 Secret |
| `MAINTENANCE_SECRET` | 当前只接受一个值；轮换外部调度器时需要安排短暂切换窗口 |

active 和 previous token key 必须使用不同版本号和不同值。系统只保留一个 previous slot，旧版邮箱凭据、OAuth verifier 和 15 分钟分页密文全部迁移、过期并清理后，才能开始下一次轮换。完整操作与核对 SQL 见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 仍需在真实生产环境验证

以下工作没有被仓库代码或自动测试证明完成：

1. Neon 生产数据库、迁移、最小权限 Role、备份和隔离恢复演练。
2. 最终 HTTPS 域名、真实 Sites `project_id`、四个 OAuth 回调以及部署平台 Secret 注入。
3. GitHub allowlist 和三家专用测试邮箱的完整浏览器 E2E，包括首次授权、刷新竞争、分页、所有写操作、附件和断开。
4. Google restricted scope 的 consent screen、测试用户、OAuth Verification 和可能适用的安全评估。
5. 用恶意 HTML 样本复核允许列表、iframe、CSP 和响应头在目标浏览器及 Worker 上的最终组合；确认远程图片开关不会被缓存或代理绕过。
6. 附件的内存与延迟压力。当前实现会在按流限量后组装最多 25 MiB 的成功响应，生产前仍应按平台内存限制压测；若目标套餐余量不足，应进一步降低上限或改为端到端流式代理。
7. Cloudflare 提供的来源地址头、限流聚合效果、Cron Trigger、待撤销队列告警和维护任务最近成功时间。
8. 日志脱敏、5xx 和 provider refresh 告警、Neon 监控、事故响应、代码回滚、数据库恢复及各类密钥轮换演练。
9. Outlook 本地断开后的账号侧撤权流程，以及 Gmail/Zoho 持续撤销失败时的人工处置流程。

在这些项目完成并留下可复核记录前，不应把该仓库描述为已经通过生产安全验收。

## 报告安全问题

若仓库启用了 GitHub Private Vulnerability Reporting，请通过该渠道私下报告。不要在公开 Issue 中披露访问控制、令牌、会话、HTML 渲染或附件代理漏洞。

报告请包含受影响的提交、复现步骤、预期影响和可能涉及的数据类型。不要附上仍然有效的 Secret、Cookie、token 或真实私人邮件。
