# iMail

iMail 是一个面向个人使用的多账号邮件工作台。目前仓库已经加入 GitHub 身份登录、PostgreSQL 会话和 OAuth 临时事务的基础代码，但邮件内容仍来自浏览器里的模拟数据。

先把边界说清楚：这份代码不会自动连接数据库，也不包含任何可用的 OAuth 密钥。完成环境变量配置并执行数据库迁移后，GitHub 登录链路才会工作。Gmail、Outlook.com 和 Zoho Mail 的真实授权与邮件适配器尚未实现，因此现在仍不能读取或发送真实邮件。

iMail 不是邮件服务器，也不实现 SMTP、IMAP、POP3、投递或垃圾邮件过滤。

## 当前状态

| 部分 | 现状 |
| --- | --- |
| 身份登录 | 通过 GitHub OAuth 验证唯一的所有者身份，按 GitHub 不可变数字用户 ID 白名单放行 |
| 会话 | 使用 PostgreSQL 保存会话摘要、有效期和吊销状态；浏览器只保存不透明的 HttpOnly Cookie |
| OAuth 临时事务 | `state`、PKCE 和一次性事务保存在 PostgreSQL 中，登录回调消费后即失效 |
| 邮件数据 | 仍由浏览器内的 `MockMailProvider` 提供，刷新页面后恢复 |
| 真实邮箱接入 | Gmail、Outlook.com、Zoho Mail 的服务端注册位已经预留，但适配器均未配置，调用时会明确失败 |
| 部署 | 仓库只提供代码和构建配置，不代表已经配置数据库、密钥或线上环境 |

GitHub 只承担登录身份验证。授权请求不申请仓库权限；回调取得的 access token 只用于调用 GitHub `/user` 读取数字用户 ID 和展示信息，完成校验后立即吊销并丢弃，不写入数据库。

## 可以体验的内容

- Gmail、Outlook.com 和 Zoho Mail 三种来源的模拟账号与邮件
- 桌面三栏布局和移动端单栏导航
- 收件箱、已加星标、已发送、草稿、归档和垃圾箱界面
- 邮件列表虚拟滚动、搜索和来源筛选
- 会话阅读、回复、转发和附件展示
- 写信、保存草稿、归档、删除、已读和星标等交互
- 浅色、深色和跟随系统主题
- 三种桌面信息密度、键盘操作和减少动态效果设置

邮件操作目前都是演示行为：

| 界面操作 | 当前实际行为 |
| --- | --- |
| 切换账号或邮件来源 | 筛选本地模拟数据 |
| 搜索和读取邮件 | 在浏览器内查询静态数据 |
| 归档、删除、标记已读或加星 | 修改 `MockMailProvider` 的内存状态，刷新页面后恢复 |
| 发送、回复、转发和保存草稿 | 在当前浏览器会话中修改模拟邮件，不会发出真实邮件 |
| 连接邮箱账号 | 真实 Provider 尚未实现，不会回退到模拟 Provider |

## 代码结构

当前有两条互相独立的运行路径：

```text
身份与会话
浏览器
  -> Cloudflare Worker / vinext App Router
     -> 同源认证路由
        -> GitHub OAuth（只验证身份）
        -> Neon PostgreSQL（会话、OAuth 临时事务）

邮件界面
CommunicationHub（客户端组件）
  -> TanStack Query
     -> MockMailProvider
        -> src/mocks/mail.ts
```

真实邮件接入必须走服务端边界：

```text
浏览器
  -> 同源 BFF
     -> 鉴权与应用服务
        -> server-only Provider 注册表
           -> Gmail / Outlook / Zoho 适配器（尚未实现）
```

`worker/index.ts` 是 Worker 入口，并把运行时绑定放进当前请求的服务端上下文。普通请求交给 vinext；`/_vinext/image` 由 Cloudflare 的资源和图片绑定处理。项目使用 Next.js App Router 的目录和组件模型，但构建链路是 vinext、Vite、Cloudflare Worker 和 OpenAI Sites，不是标准的 `next build` / `next start` 自托管方案。

主要代码位置：

| 路径 | 内容 |
| --- | --- |
| [`app/communication-hub.tsx`](app/communication-hub.tsx) | 邮件工作台界面与模拟交互 |
| [`app/login-view.tsx`](app/login-view.tsx) | 未登录或认证未配置时的入口 |
| [`src/server/auth/`](src/server/auth/) | 所有者身份、OAuth 临时事务和会话数据访问 |
| [`src/server/security/`](src/server/security/) | PKCE、加密、Cookie、Origin 和 CSRF 校验 |
| [`src/server/db/neon.ts`](src/server/db/neon.ts) | Neon PostgreSQL HTTP 查询入口 |
| [`db/migrations/0001_auth_foundation.sql`](db/migrations/0001_auth_foundation.sql) | 认证、会话、连接和安全事件表结构 |
| [`src/server/mail/provider-registry.ts`](src/server/mail/provider-registry.ts) | 仅服务端可导入的真实邮件 Provider 注册边界 |
| [`src/providers/mail/MockMailProvider.ts`](src/providers/mail/MockMailProvider.ts) | 当前唯一可用的邮件 Provider，数据只在内存中 |
| [`worker/index.ts`](worker/index.ts) | Cloudflare Worker 入口 |
| [`vite.config.ts`](vite.config.ts) | vinext、Vite、Sites 和 Cloudflare 构建配置 |

更完整的边界说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 本地运行

只运行构建、测试或查看“认证未配置”页面时，需要：

- Node.js 22.13 或更高版本
- npm
- Linux 或 WSL2

要走通 GitHub 登录，还需要：

- 一个 Neon PostgreSQL 数据库
- 一个 GitHub OAuth App

仓库现有的 npm 脚本使用 Bash 和 GNU 工具。`build` 依赖 GNU `timeout`；`install:ci` 还依赖 `flock`、`curl`、`sha256sum` 和 Linux 的 `/proc`。原生 Windows PowerShell/CMD 目前不在支持范围内，`install:ci` 也不能直接在 macOS 上运行。

### 1. 安装依赖

```bash
git clone https://github.com/shannoncheu/iMail.git
cd iMail
npm ci
```

### 2. 准备 GitHub OAuth App

在 GitHub OAuth App 中填写：

- Homepage URL：与 `APP_URL` 完全一致
- Authorization callback URL：`APP_URL` 后加 `/api/auth/github/callback`

例如本地开发使用：

```text
Homepage URL: http://localhost:3000
Authorization callback URL: http://localhost:3000/api/auth/github/callback
```

登录只读取公开身份，不需要配置 OAuth scope。建议为 iMail 单独创建 OAuth App，不要复用曾申请过 `repo` 等权限的应用；回调一旦发现非空 scope，会吊销该 token 并拒绝登录。`ALLOWED_GITHUB_IDS` 必须填写 GitHub 的数字用户 ID，不要填写用户名；用户名可以修改，数字 ID 才是访问控制依据。

### 3. 配置环境变量

本地开发先把 [`.env.example`](.env.example) 复制为 `.dev.vars`；这个文件已被 Git 忽略，Cloudflare 本地运行和迁移脚本都会读取它。线上环境则使用 Worker Secret。至少需要：

```dotenv
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://...
SESSION_SECRET=至少 32 个字符的随机值
TOKEN_ENCRYPTION_KEY=32 个随机字节的 base64url 编码
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_IDS=12345678
```

`SESSION_SECRET` 和 `TOKEN_ENCRYPTION_KEY` 必须使用不同的随机值。生产环境应通过部署平台的 Secret Store 注入，不要把真实值提交到仓库。

### 4. 执行迁移并启动

```bash
npm run db:migrate
npm run dev
```

迁移不会在应用启动时自动执行。它会创建 `owners`、`owner_identities`、`oauth_transactions`、`sessions`、`mail_connections` 和 `security_events` 等表。

当前 Worker 数据库访问使用 `@neondatabase/serverless` 的 Neon HTTP driver，因此 `DATABASE_URL` 应来自 Neon PostgreSQL。OpenAI Sites 的 `.openai/hosting.json` 目前只能声明它支持的资源，不能在其中配置 Cloudflare Hyperdrive；如果以后改用 Hyperdrive，需要另外调整 Cloudflare 绑定和数据库访问层。

仓库本身没有连接任何真实数据库，也没有保存任何真实密钥。仅修改 `.env.example` 不会建立连接。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 和本地 Cloudflare 开发环境 |
| `npm run db:migrate` | 使用 `DATABASE_URL` 执行认证基础迁移 |
| `npm run lint` | 运行 ESLint |
| `npm run build` | 执行 vinext 构建并检查 Sites Worker 产物 |
| `npm test` | 构建后运行安全边界、Provider 行为和 Worker HTML 测试 |
| `npm run install:ci` | 在 Sites/Linux 环境中按锁文件安装依赖 |

测试覆盖 PKCE 与加密辅助函数、Cookie 策略、Origin/Fetch Metadata/CSRF 校验、服务端 Provider 边界、Mock Provider 行为和构建后 Worker HTML 冒烟检查。测试不会替你验证真实 GitHub OAuth App、真实 Neon 数据库或任何邮箱供应商账号。

## 环境变量

| 变量 | 当前用途 |
| --- | --- |
| `APP_URL` | 固定应用 Origin，并生成精确的 GitHub 回调地址 |
| `DATABASE_URL` | Neon PostgreSQL 连接地址；认证与会话代码使用 |
| `SESSION_SECRET` | 派生会话摘要和 CSRF 校验值 |
| `TOKEN_ENCRYPTION_KEY` | 加密 OAuth 临时事务中的敏感字段；要求 32 字节 base64url |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | GitHub 身份登录 |
| `ALLOWED_GITHUB_IDS` | 允许登录的 GitHub 不可变数字用户 ID，逗号分隔；空值时拒绝登录 |
| `USE_MOCK_DATA` | 已预留；邮件界面当前仍固定使用 Mock Provider |
| `GOOGLE_*`、`MICROSOFT_*`、`ZOHO_*` | 为后续真实邮箱 OAuth 预留，当前未使用 |
| 其他 `ALLOWED_*` | 为后续身份来源预留，当前未使用 |

## 已落地的安全边界

- 登录发起请求必须是同源 POST，并检查 `Origin` 和 Fetch Metadata。
- OAuth 使用短时一次性事务、随机 `state` 和 PKCE S256；回调地址由可信的 `APP_URL` 固定生成。
- 所有者白名单使用 GitHub 数字用户 ID，并在白名单为空或不匹配时拒绝登录。
- GitHub access token 不持久化，仅用于读取 `/user`，随后通过 GitHub API 吊销并丢弃。
- 会话 Cookie 为不透明随机值，数据库只保存摘要；HTTPS 下使用 `Secure`、`HttpOnly`、`SameSite=Strict`。
- 修改状态的认证请求同时校验精确 Origin、Fetch Metadata 和 CSRF token。
- Worker 为页面和 API 统一补充防嵌入、MIME 嗅探、权限策略和 Referrer 响应头；HTTPS 响应包含 HSTS。
- 真实邮件 Provider 注册表只能在服务端导入；未知或尚未配置的 Provider 会直接报错，不会静默切换到模拟数据。

这些措施不等于项目已经可以安全处理真实邮箱。邮件 HTML 隔离、附件代理、供应商令牌刷新与并发控制、真实 Provider 的权限范围和端到端安全测试仍未完成。

## 后续工作

- [x] 邮件工作台界面和模拟数据
- [x] 与供应商无关的 `MailProvider` 接口
- [x] GitHub 所有者身份登录和数字 ID 白名单
- [x] PostgreSQL 会话、OAuth 临时事务和安全事件迁移
- [x] Origin、Fetch Metadata、CSRF 和 Cookie 安全策略
- [x] 真实邮件 Provider 的 server-only 注册边界
- [ ] 在目标环境配置并迁移真实数据库与密钥
- [ ] Gmail OAuth 与邮件适配器
- [ ] Outlook.com OAuth 与邮件适配器
- [ ] Zoho Mail OAuth 与邮件适配器
- [ ] 把邮件查询与写操作迁移到同源服务端应用层
- [ ] 邮件 HTML 隔离、附件代理和完整安全测试
- [ ] 登录入口的边缘限流与过期认证记录清理任务
- [ ] 生产部署、监控、备份与密钥轮换文档

在真实 Provider 和邮件内容安全边界完成之前，请只用模拟邮件验证界面与交互，不要把它当作可用的私人邮箱入口。

安全问题请参考 [`SECURITY.md`](SECURITY.md)。
