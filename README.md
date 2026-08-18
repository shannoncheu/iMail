# iMail

iMail 是一个自托管的个人多邮箱工作台，把 Gmail、Outlook.com 和 Zoho Mail 放在同一套界面里处理。它通过各家的 OAuth 和官方 API 读写邮件，不接管投递，也不实现 SMTP、IMAP、POP3 或垃圾邮件过滤。

仓库中的真实邮件链路已经接通，包括三家适配器、同源 BFF、浏览器端 `ApiMailProvider`、账号连接与断开、分页、附件和 HTML 正文隔离。不过，这个仓库没有附带 Neon 数据库、OAuth Secret、生产域名或有效的 Sites `project_id`，也没有在真实生产凭据下完成端到端验证。这里的“已实现”指代码和自动测试已经覆盖，不等于线上环境已经可用。

## 功能现状

| 模块 | 当前实现 |
| --- | --- |
| 所有者登录 | GitHub OAuth；按不可变的 GitHub 数字用户 ID 白名单放行，不申请仓库权限 |
| 邮箱连接 | Gmail、Outlook.com、Zoho Mail 的 Authorization Code + PKCE；要求 refresh token |
| 多账号读取 | 账号、系统文件夹、邮件列表、搜索、详情和游标分页；“全部账号”最多 5 个连接、单页最多 25 封，单个 provider 故障会显示部分结果 |
| 写操作 | 发送、保存及重新编辑草稿、回复、转发、归档、移入/恢复垃圾箱、已读和星标 |
| 附件 | 写信时选择真实文件并转为 Base64；最多 10 个、单个及合计均不超过 5 MiB；下载走同源代理 |
| HTML 邮件 | 服务端允许列表净化、同源 `sandbox` iframe、CSP；外部图片默认关闭，用户明确开启后只允许 HTTPS 图片 |
| 浏览器边界 | UI 只访问 `/api/mail/*`；供应商 token、Client Secret 和原始 API 地址不进入客户端 |
| 会话与凭据 | PostgreSQL 保存会话摘要和加密后的邮箱凭据；支持 active/previous 两版 token 加密密钥 |
| 请求保护 | 精确 Origin、Fetch Metadata、CSRF、输入大小限制和持久化限流 |
| 账号断开 | Gmail、Zoho 先尝试上游撤销；失败会保留待撤销凭据并由维护任务重试；Outlook 当前只做本地断开 |
| 运维入口 | Cloudflare Cron `scheduled()` 和带 Bearer Secret 的备用维护端点；清理过期记录并补偿待撤销连接 |
| 生产状态 | 未配置真实 Neon、OAuth Secret、Sites 项目、Cron、监控，也没有三家邮箱的生产 E2E 记录 |

三家适配器实现的是同一组领域能力，供应商差异留在服务端：

| 能力 | Gmail | Outlook.com | Zoho Mail |
| --- | --- | --- | --- |
| OAuth 连接与自动刷新 | 已实现 | 已实现 | 已实现 |
| 文件夹、列表、搜索、分页 | 已实现 | 已实现；“已加星标”视图不支持同时搜索 | 已实现 |
| 会话正文与附件读取 | 已实现 | 已实现 | 已实现 |
| 发送、草稿、回复、转发 | 已实现 | 已实现 | 已实现 |
| 归档、垃圾箱、已读、星标 | 已实现 | 已实现 | 已实现 |
| 断开时上游撤销 | 撤销并支持后台重试 | 无单 refresh token 撤销端点，只清除本地凭据 | 撤销并支持后台重试 |
| 特别说明 | 保留 Gmail 标签语义 | 使用 Microsoft Graph；租户由配置决定 | Accounts 与 Mail API 必须属于同一受支持数据中心 |

## 运行方式

```text
浏览器
  -> Cloudflare Worker / vinext App Router
     -> GitHub 登录与应用会话
     -> /api/mail/* 同源 BFF
        -> MailService
           -> server-only Provider 注册表
              -> Gmail API / Microsoft Graph / Zoho Mail API
     -> Neon PostgreSQL
        -> 身份、会话、OAuth 临时事务、邮箱连接、草稿意图、15 分钟加密分页状态、限流和安全事件
```

浏览器端的 `createMailProvider(csrfToken)` 始终创建 `ApiMailProvider`。`MockMailProvider` 仍然显式导出，供自动测试和独立开发使用，但生产路径不会在配置失败时退回模拟数据。

数据库不长期保存邮件正文、附件或供应商搜索索引。服务端分页（包括单账号和“全部账号”视图）会把未消费的列表摘要和 provider cursor 加密后暂存 15 分钟，正文和附件字节不进入该状态。为了让关闭后的回复或转发草稿仍能按原语义发送，数据库只保存 owner、邮箱连接、供应商草稿 ID、动作类型和原邮件 ID 的绑定，不保存草稿正文；邮件内容仍按需从供应商读取，客户端查询缓存只存在于当前页面内存中。

详细的数据流、路由和表结构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 快速开始

### 运行环境

- Node.js 22.13 或更高版本
- npm
- Neon PostgreSQL
- GitHub OAuth App
- 至少一家邮箱供应商的 OAuth Client
- Bash 和 GNU 工具；完整构建流程建议使用 Linux 或 WSL2

项目使用 vinext、Vite 和 Cloudflare Worker 构建，不是标准的 `next build` 自托管项目。

### 1. 安装

```bash
git clone https://github.com/shannoncheu/iMail.git
cd iMail
npm ci
```

### 2. 准备本地配置

```bash
cp .env.example .dev.vars
```

至少填写以下核心变量：

```dotenv
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://...
SESSION_SECRET=至少32个字符的独立随机值
TOKEN_ENCRYPTION_KEY=32个随机字节的base64url编码
TOKEN_ENCRYPTION_KEY_VERSION=1
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_IDS=12345678
```

`ALLOWED_GITHUB_IDS` 填 GitHub 数字用户 ID，不是用户名。`SESSION_SECRET` 和 `TOKEN_ENCRYPTION_KEY` 必须使用不同的随机值。

再按需要配置邮箱：

| 邮箱 | 必需变量 |
| --- | --- |
| Gmail | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` |
| Outlook.com | `MICROSOFT_CLIENT_ID`、`MICROSOFT_CLIENT_SECRET`、可选的 `MICROSOFT_TENANT` |
| Zoho Mail | `ZOHO_CLIENT_ID`、`ZOHO_CLIENT_SECRET`、与数据中心匹配的两个 Zoho Base URL |

四个 OAuth 回调地址、供应商权限和 Zoho 数据中心配置容易出错，完整步骤以 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 为准。

### 3. 迁移数据库并启动

```bash
npm run db:migrate
npm run dev
```

迁移必须显式执行，应用启动时不会自动建表。登录后进入 Settings → Accounts，选择 Gmail、Outlook 或 Zoho 发起连接。没有配置对应 OAuth Client 时，连接端点会明确返回未配置错误。

本地 GitHub 与邮箱 OAuth App 的回调 Origin 必须和 `APP_URL` 完全一致。生产环境还需要 HTTPS 域名、Sites 项目、Secret、Cron、监控和备份，请不要直接照搬本地配置上线。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动本地 Vite/Cloudflare 开发环境 |
| `npm run db:migrate` | 对 `DATABASE_URL` 执行尚未应用的迁移 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm test` | 构建后运行认证、邮件适配器、BFF、安全和维护任务测试 |
| `npm run build` | 构建并校验 Sites Worker 产物 |
| `npm run validate:artifact` | 单独检查发布产物结构 |

自动测试使用模拟的数据库查询和供应商 HTTP 响应，不会连接真实 Neon、GitHub 或邮箱账号。

## 主要目录

| 路径 | 职责 |
| --- | --- |
| [`app/communication-hub.tsx`](app/communication-hub.tsx) | 邮件工作台、OAuth 账号管理、分页、正文与附件交互 |
| [`app/api/mail/`](app/api/mail/) | 浏览器访问的同源邮件 BFF |
| [`src/providers/mail/`](src/providers/mail/) | 稳定的 `MailProvider` 接口、`ApiMailProvider` 和显式 Mock |
| [`src/server/mail/`](src/server/mail/) | OAuth、应用服务、Provider 工厂、三家适配器、内容净化和凭据管理 |
| [`src/server/auth/`](src/server/auth/) | GitHub 身份、应用会话和 OAuth 临时事务 |
| [`src/server/security/`](src/server/security/) | 加密、Cookie、CSRF、同源校验、限流和响应头 |
| [`db/migrations/`](db/migrations/) | PostgreSQL 迁移 |
| [`worker/index.ts`](worker/index.ts) | Worker 请求入口与 Cron `scheduled()` |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Neon、OAuth、Sites、Cron、轮换、回滚和上线检查 |

## 上线前仍要完成

当前代码不能替代真实环境验收。至少还要完成：

- 创建并迁移真实 Neon 数据库；
- 创建四个 OAuth 应用并把 Secret 注入部署平台；
- 为 `.openai/hosting.json` 填入真实 Sites `project_id`，配置域名和 HTTPS；
- 用专用测试账号走通 GitHub 登录和三家邮箱的连接、刷新、读写、附件、HTML 与断开流程；
- 配置 Cron、监控、告警、备份，并演练恢复和密钥轮换；
- 确认 Google restricted scope 的验证状态满足实际发布范围。

安全边界和剩余验证项见 [`SECURITY.md`](SECURITY.md)。部署时按 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 操作，不要把构建通过或单元测试通过写成“已经生产上线”。
