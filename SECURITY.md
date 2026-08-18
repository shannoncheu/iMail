# 安全策略

## 当前状态

仓库已经包含 GitHub 所有者身份登录、PostgreSQL 会话、OAuth 一次性事务和请求防护的基础代码，但没有配置或连接任何真实数据库、OAuth App、密钥或线上环境。数据库迁移也不会随应用启动自动执行。

邮件界面仍使用浏览器内的 `MockMailProvider`。Gmail、Outlook.com 和 Zoho Mail 的真实授权、令牌刷新、邮件 API 适配器、HTML 隔离和附件代理尚未实现，因此当前版本不应处理真实邮箱数据。

## 已实现的认证边界

- GitHub 登录只用于确认所有者身份，不申请仓库 scope。
- 访问控制使用 GitHub 不可变的数字用户 ID；`ALLOWED_GITHUB_IDS` 为空、格式错误或不匹配时一律拒绝登录。
- OAuth 发起请求使用随机 `state`、PKCE S256 和短时服务端事务；回调地址从可信的 `APP_URL` 固定生成。
- GitHub access token 只用于请求 `/user`，完成身份校验后通过 GitHub API 吊销并丢弃，不写入数据库或日志。
- 主会话使用不透明随机 Cookie。数据库保存 token 摘要、有效期、轮换关系和吊销状态，不保存原始 Cookie 值。
- HTTPS 环境下会话 Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Strict`；短时 OAuth 绑定 Cookie 使用 `SameSite=Lax` 以允许顶层回调。
- 修改状态的请求校验精确 `Origin`、Fetch Metadata 和 CSRF token。登录发起请求虽然还没有会话，也必须通过同源 POST 校验。
- OAuth 临时敏感字段使用 AES-256-GCM 和附加认证数据封装；会话摘要和 CSRF 值使用相互隔离的派生用途。
- 真实邮件 Provider 注册表标记为 `server-only`。未知 Provider 和尚未配置的 Provider 都会明确失败，不会回退到 Mock。

上述边界只有在正确配置环境变量、执行迁移并使用 HTTPS 部署后才会生效。代码存在不代表生产环境已经就绪。

## 数据库与密钥

认证基础迁移位于 `db/migrations/0001_auth_foundation.sql`，需要运维人员显式执行。当前实现通过 `@neondatabase/serverless` 的 Neon HTTP driver 访问 PostgreSQL；仓库没有内置数据库实例或凭据。

`.openai/hosting.json` 不能配置 Cloudflare Hyperdrive。若以后改用 Hyperdrive，必须单独建立 Cloudflare 绑定、调整数据库访问层并重新验证连接与事务行为，不能只修改 Sites manifest。

仓库不得包含：

- OAuth client secret
- access token 或 refresh token
- 会话密钥、CSRF 密钥或加密密钥
- 数据库密码
- 真实所有者身份、邮箱账号或白名单
- 生产域名和回调地址
- 真实邮件正文或附件

本地值放在被 Git 忽略的环境文件中；生产值通过部署平台的 Secret Store 注入。任何密钥一旦进入 Git 历史，应立即吊销并轮换，仅删除最新提交中的文件并不够。

`SESSION_SECRET` 与 `TOKEN_ENCRYPTION_KEY` 必须分别生成，不能复用。`TOKEN_ENCRYPTION_KEY` 需要 32 个随机字节的 base64url 编码。修改 `APP_URL` 时也要同步更新 GitHub OAuth App 中的精确回调地址。

## 上线前检查

在允许真实用户或真实邮箱数据进入系统之前，至少需要确认：

- 目标数据库已经备份并成功执行受审查的迁移
- 所有 Secret 都由部署平台注入，日志与错误响应不包含密钥、令牌或邮件内容
- `APP_URL` 使用 HTTPS，代理不会改写或伪造用于同源判断的请求信息
- `ALLOWED_GITHUB_IDS` 只包含经人工核对的数字用户 ID
- GitHub OAuth App 没有申请不必要的 scope，回调地址完全匹配
- GitHub 登录发起端点已在 Cloudflare 边缘配置限流，并定期清理过期 OAuth 事务与会话
- 登录允许列表、OAuth 事务绑定、过期处理、会话轮换、吊销、CSRF 和退出登录有端到端测试
- 数据库不可用、GitHub API 失败和重复回调都按拒绝访问处理
- Gmail、Outlook 和 Zoho 的每个适配器分别完成最小权限、令牌加密、刷新协调和撤销测试
- 邮件 HTML 完成服务端净化和独立来源隔离，外部图片默认关闭
- 附件通过不透明应用 ID 代理，文件名、类型和响应头经过校验
- 监控、审计事件、备份恢复、密钥轮换和事故响应流程已经演练

## 报告安全问题

若仓库启用了 GitHub Private Vulnerability Reporting，请通过该渠道私下报告。不要在公开 Issue 中披露令牌处理、会话、HTML 渲染或访问控制漏洞。

报告应包含受影响的提交、复现步骤、预期影响，以及是否可能暴露真实凭据或邮件数据。请勿附上仍然有效的 Secret。
