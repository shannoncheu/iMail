# iMail 生产部署手册

本文按当前仓库的实际实现编写，目标环境是 OpenAI Sites 上的 Cloudflare Worker，数据库使用 Neon PostgreSQL。它是一份上线操作手册，不是部署结果报告：仓库没有附带真实 OAuth 凭据、Neon 数据库或生产域名，也没有在真实邮箱账号上完成端到端验证。

## 先看结论

生产环境至少由四部分组成：

```text
浏览器
  -> APP_URL 对应的 Sites / Cloudflare Worker
       -> Neon PostgreSQL
       -> GitHub OAuth（所有者登录）
       -> Google / Microsoft / Zoho OAuth（邮箱授权）
       -> Gmail API / Microsoft Graph / Zoho Mail API
```

上线前必须遵守以下约束：

- `APP_URL` 是最终公开 HTTPS Origin，例如 `https://mail.example.com`，不能带路径、查询参数、片段或账号密码。除 `localhost` 外，HTTP 会被程序拒绝。
- GitHub 登录和三个真实 Mail Provider 都需要各自的 OAuth Client ID 与 Client Secret。缺少相应密钥时，连接入口会失败关闭，不会偷偷回退到模拟数据。
- `.openai/hosting.json` 只描述 Sites 项目标识以及可选的 D1、R2 逻辑绑定。它**不能表达外部 PostgreSQL**，也不能代替 `DATABASE_URL`。当前项目的 D1、R2 都应保持 `null`。
- `DATABASE_URL`、OAuth Client Secret、`SESSION_SECRET`、当前/上一版 `TOKEN_ENCRYPTION_KEY` 和 `MAINTENANCE_SECRET` 都不能提交到 Git。`.dev.vars` 只用于本机，生产值应写入 Sites/Worker 的 Secret 管理。
- 建议给开发、预发布、生产分别创建数据库分支和 OAuth 应用，避免回调地址、测试账号和生产令牌混用。
- 当前仓库仍有生产环境待办和实现边界，见“当前实现限制”。完成真实配置、审核与联调前，不应把它当作已经上线的邮件客户端。

## 1. 准备域名与回调地址

先确定生产域名，再创建 OAuth 应用。所有回调地址都由 `APP_URL` 在服务端固定生成；改域名后，Sites Secret 和四个 OAuth 应用必须一起更新。

假设：

```text
APP_URL=https://mail.example.com
```

需要登记的地址如下：

| 用途 | 回调地址 |
| --- | --- |
| GitHub 所有者登录 | `https://mail.example.com/api/auth/github/callback` |
| Gmail 连接 | `https://mail.example.com/api/mail/connect/gmail/callback` |
| Outlook 连接 | `https://mail.example.com/api/mail/connect/outlook/callback` |
| Zoho Mail 连接 | `https://mail.example.com/api/mail/connect/zoho/callback` |

回调地址要逐字符一致，包括协议、主机、端口和路径。生产与预发布使用不同域名时，优先为每个环境创建独立 OAuth 应用。GitHub OAuth App 只配置一个 Authorization callback URL，更应分开创建。

如果 Sites 项目启用了额外的私有访问门禁，要先确认 OAuth 回调导航不会被门禁截断。邮箱供应商必须能把用户浏览器送回上述路径；只在内部预览地址完成构建不等于生产 OAuth 可用。

## 2. 创建 Neon PostgreSQL

### 2.1 建项目和环境

1. 在 Neon 创建生产 Project，选择合适的数据驻留区域和 PostgreSQL 版本。
2. 创建独立的生产 Branch、Database 和最小权限 Role。预发布使用另一条 Branch 或另一 Project。
3. 在 Neon 控制台设置符合恢复目标的 Restore window，并确认套餐保留时长。
4. 从 **Connect** 面板分别保存：
   - 供 Worker 运行的连接串；
   - 供迁移、`pg_dump` 和 `pg_restore` 使用的 direct、非 pooled 连接串。
5. 连接串必须启用 TLS，保留 Neon 给出的 `sslmode=require` 等参数。

Neon 的 pooled 主机名通常包含 `-pooler`，适合大量短连接；迁移和 `pg_dump` 应使用不含 `-pooler` 的 direct 连接。Neon 明确建议不要通过连接池执行 `pg_dump`，也建议多数 schema migration 工具使用 direct 连接。参见 [Neon 连接池说明](https://neon.com/docs/connect/connection-pooling) 和 [Neon pg_dump/pg_restore 迁移说明](https://neon.com/docs/import/migrate-from-neon)。

### 2.2 执行迁移

项目不会在请求启动时自动建表。每次发布都要从准备部署的同一个提交显式执行：

```bash
npm run install:ci
DATABASE_URL='postgresql://…direct…' npm run db:migrate
```

PowerShell 可使用：

```powershell
$env:DATABASE_URL = 'postgresql://…direct…'
npm run db:migrate
Remove-Item Env:DATABASE_URL
```

也可以把本机迁移连接串临时写入未跟踪的 `.dev.vars`：

```dotenv
DATABASE_URL=postgresql://…direct…
```

然后运行 `npm run db:migrate`。不要把 `.dev.vars` 加入版本控制，也不要把连接串粘贴到工单、日志或构建输出。

迁移程序会：

- 创建 `schema_migrations`；
- 按文件名顺序读取 `db/migrations/*.sql`；
- 在 Serializable 事务中执行尚未登记的迁移；
- 成功后写入迁移名，重复运行不会再次执行同一文件。

迁移完成后，用只读 SQL 核对版本：

```sql
SELECT name, applied_at
FROM schema_migrations
ORDER BY name;
```

本版本应包含 `0001` 到 `0004`。`0004_mail_draft_intents.sql` 只保存回复/转发草稿与原邮件的服务端绑定，不保存草稿正文或附件；漏执行该迁移时，回复或转发窗口可以编辑，但关闭保存会明确失败。

不要手工向 `schema_migrations` 插入记录。失败时保留原始错误，先确认执行的 Git commit、数据库 Branch 和 direct URL，再处理 SQL 问题。

### 2.3 备份与恢复

Neon 的 Restore window 用于短期时间点恢复；生产环境还应保留独立备份。建议：

- 每次数据库迁移前创建 Neon Branch、快照或确认可恢复时间点；
- 按数据恢复目标定期执行 custom-format 外部备份；
- 对备份文件加密，放入受控对象存储，设置保留期和删除审计；
- 至少每季度把备份恢复到隔离的 Neon Branch，并实际查询关键表；只生成文件、不演练恢复不算可用备份。

使用 direct URL 生成备份：

```bash
pg_dump --format=custom --verbose \
  --file=imail-YYYYMMDD-HHMM.dump \
  'postgresql://…source-direct…'

pg_restore --list imail-YYYYMMDD-HHMM.dump
```

恢复时先创建空的隔离数据库，不要直接覆盖生产库：

```bash
pg_restore --verbose --no-owner --no-privileges \
  --dbname='postgresql://…recovery-direct…' \
  imail-YYYYMMDD-HHMM.dump
```

恢复完成后核对 `schema_migrations`、所有者、会话和邮箱连接数量，并从隔离版本执行只读冒烟测试。只有在确认恢复库一致后，才通过变更审批把 `DATABASE_URL` 切到恢复库并重新部署。Neon Restore window 的配置见 [Neon 项目管理文档](https://neon.com/docs/manage/projects)。

## 3. 生成应用密钥

在受控终端生成三组互不相同的随机值，生成后立即存入密码管理器或 Secret 管理，不要放进 README、聊天记录或仓库文件。

```bash
# SESSION_SECRET：48 个随机字节
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(48).toString('base64url'))"

# TOKEN_ENCRYPTION_KEY：必须恰好是 32 个随机字节的 base64url
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"

# MAINTENANCE_SECRET：外部调度器调用维护 POST 时使用
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(48).toString('base64url'))"
```

首次部署设置 `TOKEN_ENCRYPTION_KEY_VERSION=1`，并把 `TOKEN_ENCRYPTION_KEY_PREVIOUS`、`TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION` 留空。程序会拒绝少于 32 个字符的 `SESSION_SECRET`，也会拒绝不是 32 字节 base64url 的 token encryption key。session、当前 key、上一版 key 三个值必须互不相同；当前和上一版还要使用不同版本号，上一版 key/version 必须同时配置或同时留空。

`TOKEN_ENCRYPTION_KEY` 用于 AES-256-GCM 加密 OAuth 临时 verifier 和邮箱令牌。程序写入时只使用 active version，读取时可以同时识别 active 和 previous 两版；轮换时不要只替换 key value，详细步骤见“令牌与密钥轮换”。

## 4. 创建 GitHub OAuth App

GitHub 只用于确认 iMail 所有者身份，不读取仓库，也不承担邮件功能。当前授权请求不带 scope，登录完成后程序读取 `/user` 的不可变数字 ID，并立即吊销临时 GitHub access token。

1. 在 GitHub **Settings → Developer settings → OAuth Apps** 创建 OAuth App。
2. Homepage URL 填 `APP_URL`。
3. Authorization callback URL 填：

   ```text
   https://mail.example.com/api/auth/github/callback
   ```

4. 保存 Client ID，生成 Client Secret，分别配置为 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`。
5. 查询允许登录用户的数字 ID，而不是用户名：

   ```bash
   curl --fail --silent \
     -H 'Accept: application/vnd.github+json' \
     -H 'X-GitHub-Api-Version: 2022-11-28' \
     https://api.github.com/users/USERNAME
   ```

   把响应中的数字 `id` 写入 `ALLOWED_GITHUB_IDS`；多个 ID 用英文逗号分隔。空列表、用户名或非数字值都会导致认证失败关闭。

6. 不要启用 Device Flow，也不要额外申请仓库、组织或邮箱 scope。

GitHub 的配置步骤与回调限制见 [创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)；用户端点见 [REST Users API](https://docs.github.com/en/rest/users)。

## 5. 创建 Google OAuth Client

1. 在 Google Cloud 为生产环境创建或选择 Project。
2. 启用 Gmail API。
3. 配置 OAuth consent screen、应用域名、隐私政策、支持邮箱和测试用户。
4. 创建 **Web application** 类型的 OAuth 2.0 Client。
5. Authorized redirect URI 填：

   ```text
   https://mail.example.com/api/mail/connect/gmail/callback
   ```

6. 把凭据配置为 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。
7. consent screen 必须声明当前代码实际请求的全部 scope：

   ```text
   openid
   email
   profile
   https://www.googleapis.com/auth/gmail.modify
   ```

授权请求使用 Authorization Code + PKCE，并设置 `access_type=offline` 和 `prompt=consent`。首次授权后必须拿到 refresh token；拿不到时连接会被拒绝。

`gmail.modify` 是 Google 标记的 restricted scope。如果应用面向 consent screen 测试用户之外发布，需要在上线计划中预留 OAuth Verification；当服务器存储或传输 restricted scope 数据时，Google 还可能要求安全评估。不要把“测试用户能授权”当作生产审核已经通过。以 [Gmail scope 官方清单](https://developers.google.com/workspace/gmail/api/auth/scopes)、[服务端授权流程](https://developers.google.com/workspace/gmail/api/auth/web-server) 和 [Google OAuth 上线合规要求](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) 为准。

## 6. 创建 Microsoft Entra 应用

1. 在 Microsoft Entra admin center 创建 App registration。
2. Supported account types 要和 `MICROSOFT_TENANT` 对齐：
   - 当前默认值 `consumers`：仅个人 Microsoft 账号；
   - `organizations`：组织账号；
   - `common`：组织和个人账号；
   - 租户 GUID：单一组织租户。
3. 在 **Authentication → Add a platform → Web** 添加：

   ```text
   https://mail.example.com/api/mail/connect/outlook/callback
   ```

4. 在 **API permissions → Microsoft Graph → Delegated permissions** 添加：

   ```text
   User.Read
   Mail.ReadWrite
   Mail.Send
   ```

   程序还会请求 `openid profile email offline_access`，其中 `offline_access` 用于 refresh token。组织租户是否需要管理员同意取决于租户策略，应在目标租户中实际确认。

5. 创建 Client Secret，把 Application (client) ID 和 Secret **Value** 分别配置为 `MICROSOFT_CLIENT_ID`、`MICROSOFT_CLIENT_SECRET`。不要误填 Secret ID。
6. 配置 `MICROSOFT_TENANT`。个人 Outlook.com 场景保持 `consumers`。

当前实现只支持 Client Secret，尚不支持证书凭据。注册与回调配置见 [Microsoft 应用注册](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) 和 [添加 Redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)；授权流程与 PKCE 见 [OAuth 2.0 Authorization Code Flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)；权限含义见 [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)。

## 7. 创建 Zoho OAuth Client

1. 登录与邮箱账号相同数据中心的 Zoho API Console。
2. 创建 **Server-based Application**。
3. Homepage URL 填 `APP_URL`，Authorized Redirect URI 填：

   ```text
   https://mail.example.com/api/mail/connect/zoho/callback
   ```

4. 把凭据配置为 `ZOHO_CLIENT_ID`、`ZOHO_CLIENT_SECRET`。
5. 当前程序申请以下逗号分隔的 scope：

   ```text
   ZohoMail.accounts.READ
   ZohoMail.folders.READ
   ZohoMail.messages.ALL
   ZohoMail.attachments.ALL
   ```

6. 授权请求使用 `access_type=offline` 和 `prompt=consent`。必须收到 refresh token。
7. 根据邮箱登录后的实际区域配置 Accounts 与 Mail API Origin。当前代码可接受的组合是：

| 区域 | `ZOHO_ACCOUNTS_BASE_URL` | `ZOHO_MAIL_API_BASE_URL` |
| --- | --- | --- |
| 美国 | `https://accounts.zoho.com` | `https://mail.zoho.com` |
| 欧洲 | `https://accounts.zoho.eu` | `https://mail.zoho.eu` |
| 印度 | `https://accounts.zoho.in` | `https://mail.zoho.in` |
| 澳大利亚 | `https://accounts.zoho.com.au` | `https://mail.zoho.com.au` |
| 日本 | `https://accounts.zoho.jp` | `https://mail.zoho.jp` |
| 加拿大 | `https://accounts.zohocloud.ca` | `https://mail.zohocloud.ca` |
| 中国 | `https://accounts.zoho.com.cn` | `https://mail.zoho.com.cn` |
| 阿联酋 | `https://accounts.zoho.ae` | `https://mail.zoho.ae` |
| 沙特阿拉伯 | `https://accounts.zoho.sa` | `https://mail.zoho.sa` |

不要混用两个数据中心。Zoho Mail API 请求使用 `Authorization: Zoho-oauthtoken …`，不是普通的 `Bearer …` 前缀；适配器已经按 Zoho Mail 的要求发送。

当前配置层与 Zoho 适配器都只接受表中的固定 HTTPS Origin，包含加拿大 `zohocloud.ca`、中国 `.com.cn` 和阿联酋 `.ae`；不要为兼容未知地址而放开任意 Origin。区域 Mail API 地址见 [Zoho Mail API Getting Started](https://www.zoho.com/mail/help/api/getting-started-with-api.html)，Accounts 多数据中心流程见 [Zoho OAuth Multi-DC](https://www.zoho.com/accounts/protocol/oauth/multi-dc/client-authorization.html)，注册、offline access 和请求头格式见 [Zoho OAuth 2.0 User Guide](https://www.zoho.com/mail/help/api/using-oauth-2.html)。

## 8. 配置 Sites / Cloudflare Worker

### 8.1 Hosting manifest

`.openai/hosting.json` 应保持类似：

```json
{
  "d1": null,
  "project_id": "由 Sites 分配的项目 ID",
  "r2": null
}
```

这个文件会在构建时复制到 `dist/.openai/hosting.json`。它可以提交，但其中不能出现以下内容：

- Neon URL、账号或密码；
- OAuth Client Secret；
- 会话密钥或令牌加密密钥；
- 任意 access token、refresh token 或邮件内容。

外部 Neon PostgreSQL 通过运行时 `DATABASE_URL` 连接；`.openai/hosting.json` **不会创建、绑定或描述 PostgreSQL**。将 `d1` 填上名称也不会得到 Neon 连接。

### 8.2 运行时变量与 Secret

在 Sites 项目的运行时配置中建立下列值。若项目在 Cloudflare 控制台中暴露底层 Worker 配置，也应使用 Worker 的 **Variables and Secrets**，敏感项选择 encrypted secret；不要写入源码或普通配置文件。Cloudflare 的官方说明见 [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) 和 [Workers 安全实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

| 名称 | 生产要求 | 是否敏感 |
| --- | --- | --- |
| `APP_URL` | 最终 HTTPS Origin | 否 |
| `DATABASE_URL` | Neon 生产连接串 | 是 |
| `SESSION_SECRET` | 至少 32 字符的独立随机值 | 是 |
| `TOKEN_ENCRYPTION_KEY` | 32 随机字节的 base64url | 是 |
| `TOKEN_ENCRYPTION_KEY_VERSION` | active key 的正整数版本；首次为 `1`，不得超过 PostgreSQL `SMALLINT` 上限 `32767` | 配置 |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | 轮换窗口内保留的上一版 32 字节 key；平时留空 | 是 |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION` | 与上一版 key 配套的版本号；平时留空 | 配置 |
| `ALLOWED_GITHUB_IDS` | 逗号分隔的 GitHub 数字 ID | 配置 |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID | 配置 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | 是 |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | 配置 |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | 是 |
| `MICROSOFT_CLIENT_ID` | Entra Application ID | 配置 |
| `MICROSOFT_CLIENT_SECRET` | Entra Secret Value | 是 |
| `MICROSOFT_TENANT` | 默认 `consumers` | 配置 |
| `ZOHO_CLIENT_ID` | Zoho Client ID | 配置 |
| `ZOHO_CLIENT_SECRET` | Zoho Client Secret | 是 |
| `ZOHO_ACCOUNTS_BASE_URL` | 与数据中心匹配 | 配置 |
| `ZOHO_MAIL_API_BASE_URL` | 与数据中心匹配 | 配置 |
| `MAINTENANCE_SECRET` | 外部调度器调用维护 POST 时使用；至少 32 个可打印非空白字符 | 是 |


修改 Secret 通常会产生新 Worker 版本。先在预发布环境验证，再推广到生产；Cloudflare 也提醒 `wrangler secret put` 会直接创建并部署新版本，因此 Sites 项目应优先使用自身的版本/Secret 流程，不要在不清楚项目映射时对底层 Worker 运行任意 Wrangler 命令。

## 9. 构建、验证与发布

### 9.1 构建环境

要求：

- Node.js `>=22.13.0`；
- npm lockfile 对应的依赖；
- Bash；
- GNU `timeout`、`flock`、`curl`、`sha256sum` 等脚本依赖。

仓库的构建脚本不是原生 PowerShell 脚本。Windows 上应使用 WSL、Git Bash 或与 CI 相同的 Linux 构建环境。

从待发布 commit 的干净工作树执行：

```bash
npm run install:ci
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:artifact
```

`npm run build` 已包含构建超时与 artifact 校验。最后至少应存在：

```text
dist/server/index.js
dist/.openai/hosting.json
```

校验程序会动态导入 Worker bundle，并确认默认导出包含 `fetch(request, env, ctx)`。构建成功只说明 artifact 结构正确，不代表 Neon、OAuth 或真实 Mail Provider 已联通。

仓库还提供 `.github/workflows/ci.yml`：每个 Pull Request 以及推送到 `main` 的提交都会在 Ubuntu、Node.js `22.13.0` 上执行 `npm ci`、类型检查、Lint 和 `npm test`。`npm test` 会先构建并校验 Worker artifact，再运行测试。工作流存在不等于分支已经受保护；仓库管理员还要在 `main` 的规则中把 `verify` 设为合并前必过检查，并禁止绕过。设置方法见 [GitHub 受保护分支与必需状态检查](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。

### 9.2 发布顺序

建议固定为以下顺序：

1. 标记待发布 Git commit，确认工作树和依赖锁文件。
2. 在预发布环境跑类型检查、Lint、全部测试和构建。
3. 创建迁移前数据库恢复点或备份。
4. 用该 commit 的 `db/migrations` 对生产数据库执行 `npm run db:migrate`。
5. 在 Sites 中确认生产 Secret 完整，`APP_URL` 与 OAuth 回调一致。
6. 让 Sites 使用**同一 commit 的已验证源码**打包；保存一个可追踪的版本，版本说明写 Git SHA 和迁移号。
7. 若平台支持私有预览或版本预览，先部署该版本并检查首页、静态资源和不含写操作的 API。
8. 将验证过的版本推广到生产，等待平台显示部署成功。
9. 完成“上线后冒烟”，观察至少一个正常流量窗口的错误率和数据库指标。

不要把本机 `dist` 与另一 commit 的源码、迁移混在一起发布。发布记录至少保存 Git SHA、Sites/Worker version ID、执行的迁移、操作者、时间和回滚目标版本。

### 9.3 上线后冒烟

在不发送、删除或移动真实邮件的前提下检查：

1. `APP_URL` 证书、重定向和安全响应头正常。
2. 未登录访问受保护页面会进入登录流程。
3. 不在 `ALLOWED_GITHUB_IDS` 的账号不能进入工作台；允许账号能登录并正常退出。
4. `/api/mail/accounts` 未登录返回 `401`，登录后返回不含任何 token/secret 的安全账号视图。
5. 分别连接一个专用测试 Gmail、Outlook.com、Zoho 账号，确认回调、refresh token、文件夹与只读邮件列表。列表和搜索只应返回摘要元数据；选中邮件后才请求详情和附件元数据，展开单封邮件时再通过该邮件自己的 `contentUrl` 懒加载正文。Outlook 的“已加星标”视图不支持同时搜索，界面应清空并禁用搜索框，不能把全邮箱搜索后截取一页星标结果冒充完整结果。再连接两个同类测试账号，确认单账号筛选互不混淆，“全部账号”每页不超过 25 封，某一个 provider 故障时界面明确显示部分结果和 Retry。
6. 在专用测试邮箱中验证新建、关闭时保存草稿、重新打开已有草稿、保留或移除已有附件、再次保存、发送、回复、转发、已读、星标、移动和附件。回复和转发窗口还要分别执行“关闭保存 → Drafts 重新打开 → 发送”，确认仍走原会话的 reply/forward 语义，而不是降级成普通新邮件。`Drafts` 中不适用的归档、已读、星标、垃圾箱、回复和转发仍应保持禁用；“继续编辑”必须恢复原账号、To/Cc/Bcc、主题、正文、附件和动作意图。不要拿个人主邮箱作为首轮生产验证账号。
7. 打开一封同时含危险标签、事件属性、链接、HTTPS 外图、HTTP/JavaScript 图片和安全 base64 `data:image` 的测试邮件：确认 `script`、`style`、`meta`、`link`、表单、可执行嵌入和任意事件属性被移除；普通链接只保留可读文字；安全 `data:image` 可以保留；外部图片默认不发起请求，用户对当前会话显式“Load once”后，客户端才以 `externalImages=1` 请求正文，并只允许经过校验的 HTTPS 图片，HTTP、含凭据 URL 和 JavaScript URL 始终被拒绝。
8. 检查正文响应同时保留 `Content-Security-Policy: … frame-ancestors 'self'; sandbox` 与 `X-Frame-Options: SAMEORIGIN`，附件响应使用 `Content-Disposition: attachment` 和 `nosniff`。不要为了修复显示问题放宽成可执行脚本或任意嵌入。
9. 检查 Workers Logs 和 Neon 指标中没有异常 5xx、连接耗尽或敏感字段。

这些步骤是上线时应执行的流程；本文没有声称它们已经在真实环境执行。

当前邮件正文链路已经在服务端执行小型允许列表净化，再放入 `sandbox=""` 的同源 iframe。普通格式标签不保留 provider 属性；图片是受控例外，只保留校验后的 `src`、截断后的 `alt` 以及固定的 `loading`、`referrerpolicy`。路由同时限制脚本、网络连接、表单、对象、媒体、字体和 frame，默认 CSP 只允许 `data:` 图片；显式单次允许外图时才把 `https:` 加入 `img-src`。Worker 会保留正文路由显式设置的 `SAMEORIGIN`，不会再用全局 `DENY` 覆盖。附件通过同源代理强制下载，不把 provider token 或原始附件地址交给浏览器。这些是已经实现的防线，生产部署仍要按上面的恶意样本做浏览器验证。

### 9.4 邮件读取与容量边界

普通列表、搜索和会话详情不内嵌完整正文。服务端给每封消息生成同源 `contentUrl`，阅读器只在消息展开时加载该 URL；正文完成 provider 侧限量读取、服务端净化后，生成的 HTML 文档还要通过统一的 `5 MiB` 上限。这样能避免打开文件夹时一次性把整页正文放进 Worker 内存，但不代表超大邮件一定可显示：超过相应边界时应返回受控错误，而不是放宽限制。

当前容量约束如下，调整任一项时要同时更新代码、测试、本文和告警：

| 链路 | 当前边界 |
| --- | --- |
| 写信、回复、转发、草稿 | JSON 请求流最多 `9 MiB`；正文最多 `1,000,000` 字符；最多 10 个附件，上传附件解码后的合计原始字节最多 `5 MiB` |
| 同源附件下载路由 | 最终统一拒绝超过 `25 MiB` 的响应，并固定 `Content-Disposition: attachment`、`nosniff`；provider 自身可以有更低上限 |
| Gmail | 常规 JSON `4 MiB`，单封消息 JSON `8 MiB`，解码后的正文累计 `5 MiB`，下载附件 `10 MiB`；JSON、正文分片和附件响应都按流累计并在越界时取消 |
| Outlook / Microsoft Graph | 列表 JSON `4 MiB`；单封详情、正文和附件元数据的响应 `8 MiB`；解码后的正文 `5 MiB`；下载附件 `25 MiB`。列表严格按 message 展示，不把同一 conversation 跨页合并成不稳定的伪会话。这些响应均按流累计。小于 `3 MiB` 的附件直接上传，达到 `3 MiB` 后改用 upload session；非最终分片固定为 `10 × 320 KiB = 3,276,800` 字节（`3.125 MiB`），最后一片可以不按 `320 KiB` 对齐 |
| Zoho Mail | 常规 JSON `2 MiB`；正文 JSON 外层响应最多约 `20 MiB + 64 KiB`，其中解码后的正文最多 `10 MiB`；附件最多 `25 MiB`。JSON、正文和附件都按流累计，实际字节越界时立即取消；`Content-Length` 只用于提前拒绝 |

Outlook provider 虽支持 Graph 更大的上传协议，但浏览器到 BFF 的 `5 MiB` 合计限制会先收口，所以当前产品不能从 UI 上传 150 MiB 文件。`320 KiB` 是 Graph upload session 对非最终 range 的对齐要求，不是本项目允许上传的单文件大小。相关协议见 [Microsoft Graph 大附件上传](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)。

服务端分页（包括单账号和“全部账号”视图）会把未消费摘要、provider cursor 和排序状态用 `TOKEN_ENCRYPTION_KEY` 做 AES-256-GCM 加密，保存在固定 15 分钟的 `mail_pagination_sessions`；浏览器 URL 只有签名短句柄。“全部账号”最多覆盖 5 个连接，单页最多 25 封。revision CAS 让同一当前 cursor 的并发请求，或在后续页尚未推进前的立即重试，返回同一页；会话推进后更早的 cursor 会被拒绝，客户端应只保留最新 cursor。分页会话过期、连接集合改变，或切换文件夹、搜索词、page size 后，客户端必须重新从第一页查询。供应商 cursor 本身若不是快照，邮箱在翻页期间发生新增或删除仍应按该供应商的语义验收，不要把跨供应商列表当成数据库快照。

## 10. 定时清理

`worker/index.ts` 已实现 Cloudflare Cron 所需的 `scheduled()`，并通过 `ctx.waitUntil()` 直接调用 `MailConnectionRepository.cleanupExpired()`。一次任务会删除：

- 已过期的邮箱 OAuth transaction；
- 已过期的 GitHub 身份 OAuth transaction；
- 已过期的 15 分钟加密分页会话；
- 已过期的 session，以及吊销超过 7 天的 session；
- 已过期的 rate-limit bucket；
- 超过 90 天的 security event。

同一次维护还会取出最多 25 条 `revocation_pending` 邮箱连接，重试 Gmail 或 Zoho 的上游令牌撤销。只有上游返回已撤销或已失效后，才清除本地加密凭据；失败记录继续保留，等待下次维护。结果中的 `providerRevocations.attempted`、`completed`、`pending` 可用于监控积压。

首选 Cloudflare Cron：

1. 确认生产 Worker 已配置完整核心认证变量和 `DATABASE_URL`；待撤销连接还需要对应 Google 或 Zoho OAuth Client 配置。Cron 路径不需要 `MAINTENANCE_SECRET`。
2. 在 Sites 项目或对应 Cloudflare Worker 的 Trigger 设置中新增 `17 3 * * *`，即每天 `03:17 UTC`。
3. 保存 Trigger 后重新确认活动部署仍是目标 version。
4. 等待首次执行，检查 Cron Events、Workers Logs 和数据库中待清理记录。新增或修改 Trigger 最多可能需要约 15 分钟传播。

成功时 Worker 会写一条不含凭据的结构化日志，`event` 为 `imail.maintenance.completed`，并附清理计数与 `providerRevocations`；失败只写 `imail.maintenance.failed`，不会把异常或数据库信息拼进日志。用这两个事件建立最近成功时间和持续 pending 告警。

Cloudflare Cron 使用 UTC；表达式和业务时区要在变更记录中同时写明。官方要求及查看方式见 [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。`.openai/hosting.json` 不包含 Cron 表达式，不能用修改 D1/R2 字段代替平台 Trigger 配置。

平台不能使用 Cron Trigger 时，可以由外部调度器调用：

```http
POST /api/internal/maintenance HTTP/1.1
Host: mail.example.com
Authorization: Bearer <MAINTENANCE_SECRET>
```

该路由不使用浏览器会话或 CSRF，只接受 Bearer Secret，并使用恒定时间比较；Secret 缺失、过短、格式错误或不匹配时返回 `401`，数据库或清理失败时只返回不泄露细节的 `503`。成功响应包含各类删除数量以及 `providerRevocations` 三项计数。Secret 不能放在 URL、请求体、日志或调度器名称中。

Cron Trigger 与外部调度器选一个作为主路径，避免无意义的重叠执行。无论选哪种方式，都要对最近成功时间、持续时长和失败建立告警；日志不得包含 OAuth state、session token、邮箱地址或凭据密文。

### 10.1 Refresh 与撤销的并发保护

多个 Worker 请求可能同时发现 access token 即将过期。当前实现会先在 `mail_connections` 上按 `owner_id`、连接 ID、`token_version` 和状态申请一把 45 秒数据库 lease；只有拿到对应 `refresh_lease_id` 的请求可以向 provider 刷新并写回凭据。写回时再次比较旧 `token_version` 和 lease ID，成功后递增版本并清除 lease；没有抢到 lease 的请求短暂轮询数据库，读取胜出请求写入的新版本。lease 过期后可以被接管，释放动作也带版本和 lease ID 条件，不会清掉另一请求的新 lease。这是数据库级的 compare-and-swap，并不依赖单个 Worker 实例里的 Promise 去保证全局互斥。

断开与撤销也使用 `token_version` compare-and-swap。用户发起断开时，只能把读取到的那个 connected 版本改为 disconnected 或 `revocation_pending`；维护任务最终清密文时，还必须匹配待撤销状态、错误码和预期版本。若期间发生了重连、刷新或另一项状态变化，条件更新不会命中，API 返回冲突或任务保留记录供下一轮重新判断，避免迟到的撤销结果删除更新后的凭据。排障时可以记录连接 ID 的不可逆摘要、旧/新 `token_version`、lease 是否过期和操作结果，不能记录密文或 token。

## 11. 监控与告警

### Worker

在发布前启用 Workers Logs/Traces，并为生产设置合适的采样率。Cloudflare 的日志能力见 [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)；版本发布说明见 [Versions & Deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)。

至少监控：

- 总请求量、5xx 比例、异常数和 p95/p99 延迟；
- 登录与邮箱 OAuth 的成功/失败计数，按错误码和 provider 聚合；
- `401`、`403`、`429` 的突增；
- 上游 Gmail、Graph、Zoho 的超时、限流和 refresh 失败；
- refresh lease 获取失败后长时间没有胜出版本、45 秒 lease 频繁过期，以及凭据写回的版本/lease CAS 冲突；
- 数据库请求失败、迁移版本不一致；
- Cron 的 `imail.maintenance.completed` / `imail.maintenance.failed`、最近成功时间、清理数量与持续时长；
- 待撤销连接的 `attempted`、`completed`、`pending`，尤其是连续多个周期不归零的 pending；
- 断开或维护最终清理出现的 `connection_changed` / revocation CAS 冲突；
- 当前 Worker version ID，便于把错误与发布关联。

建议先用低流量基线定阈值。可作为初始告警的例子：连续 5 分钟 5xx 超过 1% 且不少于 5 次、任一 provider 连续 refresh 失败、Cron 超过 26 小时未成功、Neon 连接数长期接近上限。上线后按实际流量修正，避免既不报警也持续误报。

日志禁止包含：

- `Authorization`、Cookie、CSRF token；
- OAuth code、state、access token、refresh token、Client Secret；
- `DATABASE_URL`；
- 邮件主题、正文、收件人、原始 MIME 和附件内容；
- 未经脱敏的第三方错误响应。

### Neon

在 Neon Monitoring 中观察 compute、活动连接、数据库大小、查询延迟和缓存命中率，并订阅 [Neon Status](https://neon.com/docs/introduction/status)。Compute 与连接排查见 [Neon compute 管理](https://neon.com/docs/manage/endpoints/) 和 [连接错误说明](https://neon.com/docs/connect/connection-errors)。

合成探测只检查首页和安全的只读路径。不要用定时发送邮件来充当健康检查，也不要让探测器持有真实邮箱 refresh token。

## 12. 回滚

### 仅回滚代码

1. 先判断新迁移是否向后兼容旧代码。
2. 在 Sites/Cloudflare Deployments 选择上一个已知稳定 version，记录当前故障 version 和回滚原因。
3. 回滚后重新执行未登录、登录、账号列表和 provider 只读冒烟。
4. 持续观察错误率与 Neon 指标。

Cloudflare 回滚会恢复 Worker 代码和该版本的绑定状态，但不会自动回滚外部 Neon 数据。官方也明确提醒，旧代码可能与已经变化的数据结构不兼容，参见 [Cloudflare Worker Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

### 涉及数据库

当前迁移没有 down migration。后续 schema 变更应采用 expand/contract：先增加兼容字段或表，双版本可读写后再清理旧结构。不要把破坏性 schema 变更和代码切换放在一个不可逆步骤里。

如果必须恢复数据：

1. 停止会继续扩大损坏的写操作；
2. 从故障前时间点创建隔离 Branch，或把外部 dump 恢复到新数据库；
3. 检查迁移版本、行数和关键约束；
4. 用候选 Worker version 做只读验证；
5. 经审批后更新 `DATABASE_URL` 并部署相容代码；
6. 保留原生产 Branch，直到事故复盘和数据对账完成。

除非已经确认恢复范围和数据损失，不要直接对生产 Branch 做覆盖式 `pg_restore`。

## 13. 令牌与密钥轮换

建立负责人、到期日和轮换记录，不要等泄露后才第一次演练。

### OAuth Client Secret

GitHub、Google、Microsoft、Zoho 的 Client Secret 按各自控制台能力轮换：

1. 在 provider 创建新 Secret，旧 Secret 暂时保留；
2. 更新预发布 Secret，走一遍授权码交换和 refresh；
3. 更新生产 Secret并发布新版本；
4. 验证新连接和已有 refresh token 的刷新；
5. 删除或吊销旧 Secret；
6. 在变更记录中写 Secret 标识和吊销时间，绝不记录 Secret Value。

Microsoft 建议在凭据过期前主动续期，见 [Microsoft 应用凭据管理](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)。若 provider 不允许重叠 Secret，安排短维护窗口并准备立即回退。

### `SESSION_SECRET`

当前没有双 Secret 验证窗口。更换后，旧 session 摘要不再匹配，公开邮箱 ID 会变化，限流 bucket 也会换一组派生键。应按“强制所有用户重新登录，并让旧页面重新加载账号 ID”安排：先通知、更新 Secret、部署、验证新登录，再清理过期会话。限流计数会在切换时重新开始，轮换窗口应额外观察滥用流量。对于单所有者应用，影响通常可控，但仍要记录时间。

### `TOKEN_ENCRYPTION_KEY`

这是风险最高的一项。当前实现支持一个 active key 和一个 previous key：OAuth verifier 会按密文 envelope 的 `keyVersion` 选择密钥，MailTokenVault 能读取两版，但所有新写入只使用 active version；邮箱 access token 自然刷新时，credentials 会用 active key 重新加密。

以下示例从版本 `1` 滚动到 `2`：

1. 生成新的 32 字节 base64url key，并从 Secret 管理器安全取出当前版本 `1` 的 key。新 active version 使用更高的正整数，通常在旧版本上加一，范围保持在 `1..32767`；不要复用版本号，也不要在终端历史或部署日志中打印旧值。
2. 在同一个待发布版本中一次性设置：

   ```dotenv
   TOKEN_ENCRYPTION_KEY=<new-key>
   TOKEN_ENCRYPTION_KEY_VERSION=2
   TOKEN_ENCRYPTION_KEY_PREVIOUS=<old-key>
   TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION=1
   ```

3. 部署并立即验证 GitHub 登录、三家邮箱读取、组合分页和 token refresh。新 OAuth transaction、新/刷新的邮箱凭据与新建分页会话应写成版本 `2`，版本 `1` 仍可读取。
4. 保持 previous 配置，让已连接邮箱在正常 access-token 刷新时逐步重加密。定期检查：

   ```sql
   SELECT credentials_key_version, count(*)
   FROM mail_connections
   WHERE credentials_ciphertext IS NOT NULL
   GROUP BY credentials_key_version
   ORDER BY credentials_key_version;
   ```

   只要版本 `1` 仍有记录，就不能删除 previous key。长期不活跃的连接可以逐一重新授权；不要直接改数据库版本号或密文。
5. 从新版本部署完成起至少等待 15 分钟，让旧 GitHub/mail OAuth transaction 与固定 15 分钟的分页会话全部过期，再运行一次维护任务。随后核对旧 verifier 和分页密文已清空：

   ```sql
   SELECT
     (SELECT count(*) FROM oauth_transactions
       WHERE code_verifier_key_version = 1) AS github_oauth_v1,
     (SELECT count(*) FROM mail_oauth_transactions
       WHERE code_verifier_key_version = 1) AS mail_oauth_v1,
     (SELECT count(*) FROM mail_pagination_sessions
       WHERE state_key_version = 1) AS pagination_v1;
   ```

6. 只有在 `mail_connections`、`oauth_transactions`、`mail_oauth_transactions`、`mail_pagination_sessions` 的旧版本计数全部为零，而且 `providerRevocations.pending=0` 后，才能删除 `TOKEN_ENCRYPTION_KEY_PREVIOUS` 与 `TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION`，保留 active key/version 并再次部署。
7. 再验证登录、连接、读信和一次 provider refresh，把轮换时间、旧/新版本号和查询结果写入变更记录；不要记录 key value。

系统只保留一个 previous slot，所以一次轮换必须完全收口后才能开始下一次。若旧 key 已泄露，应立即按安全事件处理：加快凭据刷新/重新授权，撤销 provider token，观察 pending 队列，并尽快达到移除 previous key 的条件；双版本窗口解决可用性问题，不会消除旧 key 已泄露的风险。

### 数据库与维护密钥

- Neon 数据库凭据：创建/重置 Role 凭据，更新预发布和生产 `DATABASE_URL`，验证后撤销旧凭据。备份、迁移和运行时 URL 分别管理。
- `MAINTENANCE_SECRET`：仅外部维护 POST 使用，Cloudflare `scheduled()` 不读取它。当前端点只接受一个 Secret，轮换时暂停外部调度器，更新 Sites Secret 并部署，再更新调度器凭据、手工验证一次后恢复计划；若不能接受这个短暂窗口，先实现新旧双值过渡。
- Provider refresh token：断开路由会先对 Gmail、Zoho 发起上游撤销。成功后才销毁本地密文；失败时改为 `revocation_pending`、返回 `202`，UI 会提示本地已断开且后台待重试。维护任务每轮最多重试 25 条，成功后再清密文。连续多个周期仍为 pending 时，到 provider 的 Connected Apps 页面手工撤销并记录结果。Outlook 在当前 delegated flow 下没有按单个 refresh token 撤销的端点，只做本地断开；需要彻底撤权时在 Microsoft 账号或租户的应用授权页面处理。

## 14. 常见故障

| 现象 | 优先检查 |
| --- | --- |
| 页面或 API 返回 `authentication_not_configured` / 503 | `APP_URL`、`DATABASE_URL`、`SESSION_SECRET`、当前 token key/version、GitHub 凭据、`ALLOWED_GITHUB_IDS` 是否完整；token key 是否正好 32 字节 base64url；previous key/version 是否成对、与 active 不同 |
| GitHub 登录被拒 | allowlist 是否写数字 `id`；OAuth callback 是否完全一致；Client Secret 是否过期；账号是否真的在目标 App 授权 |
| OAuth 回调提示 redirect mismatch | `APP_URL` 是否最终域名；provider 控制台是否含精确 callback；是否把预发布 Client 用到了生产 |
| OAuth state/浏览器绑定失败 | 回调是否被代理改域、Cookie 是否被访问门禁或浏览器策略拦截、流程是否超过 10 分钟、是否重复打开旧回调 |
| Provider 没有返回 refresh token | Google/Zoho 是否使用 offline access 和 consent；Microsoft 是否请求 `offline_access`；旧授权是否需要撤销后重连 |
| Gmail 显示未验证或 access blocked | consent screen 测试用户、Gmail API、restricted scope verification、应用域名和发布状态 |
| Microsoft `AADSTS50011` | Web Redirect URI、协议/域名/路径是否逐字符一致 |
| Microsoft 个人账号无法登录 | App supported account types 与 `MICROSOFT_TENANT=consumers` 是否匹配 |
| Microsoft 读得到资料但不能操作邮件 | Delegated `Mail.ReadWrite`、`Mail.Send` 是否授权，组织租户是否要求 admin consent |
| Zoho `invalid_client` 或 API 401 | Client 所在数据中心、Accounts Origin、Mail API Origin 是否一致；是否误用了 `Bearer` 请求头；refresh token 是否被撤销 |
| Neon 连接超时或过多 | URL/TLS、Branch/compute 状态、pooled 与 direct 是否用对、连接和 Neon 状态页 |
| 迁移重复或缺表 | 查询 `schema_migrations`；确认运行的是目标 Git SHA；不要手工补迁移记录 |
| 构建找不到 GNU 工具 | 改用 Linux/WSL/Git Bash，确认 Node `>=22.13.0`，先执行 `npm run install:ci` |
| 账号连接成功但 UI 没有真实邮件 | 检查 `/api/mail/accounts`、provider registry、对应 OAuth Secret、连接状态和上游错误；OAuth 成功本身不代表邮件读取请求成功 |
| 列表能显示，展开正文或下载附件失败 | 检查 `contentUrl` / `downloadUrl`、provider 上游状态和容量边界；Gmail 正文为 5 MiB、Zoho 正文为 10 MiB，净化后 HTML 为 5 MiB，附件下载统一不超过 25 MiB且 Gmail 更低 |
| 并发请求反复 refresh 失败 | 查看同一连接的 `token_version`、`refresh_lease_id` 和过期时间；确认数据库时钟、45 秒 lease 是否能到期、胜出请求是否成功写回，不要手工清 lease 后继续使用旧凭据 |
| 断开提示上游撤销排队 | 检查后续维护结果的 `providerRevocations`；确认对应 Google/Zoho Client 配置和网络正常，长期 pending 时在 provider 控制台手工撤权 |
| 断开返回 `connection_changed` / 409 | 连接在撤销期间被刷新、重连或由另一请求更新，CAS 为保护新版本而拒绝旧操作；重新加载账号状态后再决定是否断开 |
| Drafts 中的归档、已读、星标、垃圾箱、回复或转发不可用 | 这些动作对草稿不适用，UI 会保持禁用；使用阅读器中的“继续编辑”恢复草稿并发送或再次保存 |
| Cron 从未运行 | Trigger 是否加在当前生产 Worker、表达式是否按 UTC、活动版本是否含 `scheduled()`、`DATABASE_URL` 是否存在；再查 Cron Events 与 Workers Logs |
| 外部维护请求返回 401/503 | Bearer 格式和 `MAINTENANCE_SECRET` 是否一致且不少于 32 字符；503 再检查 `DATABASE_URL` 与 Neon 状态，响应不会返回内部错误细节 |

排障时只记录 request ID、provider、内部错误码、HTTP 状态、Worker version 和时间。不要为了方便把第三方原始响应、数据库 URL 或 token 打进日志。

## 15. 上线检查表

### 域名与身份

- [ ] `APP_URL` 是最终公开 HTTPS Origin，无额外路径。
- [ ] DNS、TLS、Sites 自定义域名已稳定。
- [ ] 四个 OAuth callback 与本文表格逐字符一致。
- [ ] GitHub App 不申请额外 scope，`ALLOWED_GITHUB_IDS` 只含审核过的数字 ID。
- [ ] Google restricted scope 的测试/验证状态符合实际发布范围。
- [ ] Microsoft account type、tenant 和 delegated permissions 对齐。
- [ ] Zoho Client、Accounts 和 Mail API 位于同一受支持数据中心。

### 数据库与 Secret

- [ ] Neon 生产/预发布分离，Restore window 已设置。
- [ ] `DATABASE_URL` 只在 Secret 管理中，迁移/备份使用 direct URL。
- [ ] 迁移前恢复点已创建，`schema_migrations` 已核对。
- [ ] 外部备份已生成、加密、校验，并至少做过一次隔离恢复演练。
- [ ] `SESSION_SECRET` 与 `TOKEN_ENCRYPTION_KEY` 不同且格式正确。
- [ ] `TOKEN_ENCRYPTION_KEY_VERSION` 已登记；非轮换期 previous 两项都为空，轮换期 previous key/version 成对且旧版本计数仍受监控。
- [ ] 所有 OAuth Client Secret 和 `MAINTENANCE_SECRET` 未进入 Git、日志或构建产物。
- [ ] `.openai/hosting.json` 只有 Sites 项目与 D1/R2 逻辑字段，没有 PostgreSQL 或 Secret。

### 代码与发布

- [ ] provider registry 已注册 Gmail、Outlook、Zoho 的生产 factory。
- [ ] 同源 BFF 已覆盖 UI 使用的邮件读取和写操作，浏览器不接触 provider token。
- [ ] 列表/搜索只取摘要，详情只取元数据和附件，单封正文通过 `contentUrl` 懒加载；三家 provider 与同源正文/附件路由的容量边界均已做越界验证。
- [ ] 已实现的 HTML 允许列表净化、sandbox iframe、CSP/SAMEORIGIN、默认隐藏外图、显式单次 HTTPS 外图以及安全 `data:image` 和附件代理，均已用恶意样本完成浏览器安全复核。
- [ ] `.github/workflows/ci.yml` 在 Pull Request 和 `main` push 上成功，分支规则已把 `verify` 设为必需检查。
- [ ] `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 全部通过。
- [ ] 发布 artifact 来自同一 Git SHA，`dist/server/index.js` 和 manifest 校验通过。
- [ ] 发布记录包含 Git SHA、Worker/Sites version、迁移号和回滚版本。
- [ ] 专用测试邮箱完成三家 provider 的真实 E2E；结果和已知限制有记录。
- [ ] 三家账号断开均已验证；Gmail、Zoho 的上游撤销状态和 Outlook 的手工撤权流程有记录。
- [ ] Drafts 已完成“继续编辑”、跨请求再次保存、已有附件保留/移除和发送验收；没有把不适用的草稿归档/已读/星标/垃圾箱/回复/转发记为可用。

### 运维

- [ ] Workers Logs/Traces、Neon Monitoring 和告警已启用，日志脱敏已检查。
- [ ] 生产 Cron Trigger 已创建，UTC 表达式、首次成功事件和失败告警均已核对；不用 Cron 时，外部维护 POST 已用专用 Secret 验证。
- [ ] Cron 使用 UTC，最近成功时间有告警。
- [ ] `providerRevocations.pending` 已归零或每条都有明确人工处置记录，告警能发现持续积压。
- [ ] refresh lease 超时、胜出版本等待、凭据写回 CAS 和 revocation CAS 冲突都有可观测指标或结构化错误计数。
- [ ] 代码回滚和数据库恢复演练均已完成。
- [ ] OAuth Client Secret、session、token encryption、数据库凭据的轮换手册和负责人已确定。
- [ ] 没有把构建成功、模拟数据测试或 OAuth 测试模式误写成“已生产部署”。

## 当前实现限制

截至本文对应的仓库状态，以下代码边界和真实环境工作仍需在上线前处理或验证：

1. Microsoft Graph 不支持当前查询模型下可靠地组合“已加星标”和全文搜索；选择单个 Outlook 账号的 Starred 视图时，客户端会禁用搜索。普通文件夹搜索和 Starred 列表不受影响。
2. Outlook 只能本地断开，撤销账号侧同意需要在 Microsoft 账号或租户管理界面另行操作；Gmail、Zoho 虽有持久化重试闭环，持续失败仍需要人工撤权。
3. `MAINTENANCE_SECRET` 没有双值过渡；无法接受短暂调度暂停时，需要先扩展为新旧双 Secret 验证。
4. Microsoft 只支持 Client Secret，不支持官方更推荐的证书凭据。
5. `.openai/hosting.json` 的 `project_id` 仍需由真实 Sites 项目填写；生产 Secret、域名、Cron Trigger、监控和 Neon 均不在仓库中自动创建。
6. 还没有证据表明 Google OAuth verification 已完成，或三家邮箱、Neon、Sites 在真实生产凭据下通过完整 E2E。

其中第 1、3、4 项是明确的实现边界，第 5、6 项只能在真实平台和真实账号中完成。把 Secret 填齐是部署前提，但不能代替 OAuth 审核、监控配置、恢复演练和端到端验收。
