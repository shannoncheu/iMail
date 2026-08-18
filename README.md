# iMail

iMail 是一个邮件工作台的界面原型，用来验证多账号邮件的列表、阅读、搜索和写信流程。

先说明当前状态：仓库里没有 Gmail、Outlook.com 或 Zoho Mail 的真实接入，也没有可用的登录、OAuth、会话和数据库。页面中的邮件来自浏览器内的 `MockMailProvider`，所有操作都只影响当前页面里的内存数据。

因此，这个版本不能用来访问真实邮箱，也不能承担访问控制。它不是邮件服务器，没有实现 SMTP、IMAP、POP3、投递或垃圾邮件过滤。

## 当前可以体验的内容

- Gmail、Outlook.com 和 Zoho Mail 三种来源的模拟账号与邮件
- 桌面三栏布局和移动端单栏导航
- 收件箱、已加星标、已发送、草稿、归档和垃圾箱界面
- 邮件列表虚拟滚动、搜索和来源筛选
- 会话阅读、回复、转发和附件展示
- 写信、保存草稿、归档、删除、已读和星标等交互
- 浅色、深色和跟随系统主题
- 三种桌面信息密度、键盘操作和减少动态效果设置

这些功能目前都是演示行为：

| 界面操作 | 当前实际行为 |
| --- | --- |
| 切换账号或邮件来源 | 筛选本地模拟数据 |
| 搜索和读取邮件 | 在浏览器内查询静态数据 |
| 归档、删除、标记已读或加星 | 修改 `MockMailProvider` 的内存状态，刷新页面后恢复 |
| 发送、回复、转发和保存草稿 | 在当前浏览器会话中新增或更新模拟邮件与草稿；不会发出真实邮件，刷新后恢复 |
| 登录、账号连接和会话管理 | 只展示界面状态，不会进行身份认证 |

## 当前运行方式

```text
浏览器
  -> Cloudflare Worker
     -> vinext App Router
        -> CommunicationHub（客户端组件）
           -> TanStack Query
              -> MockMailProvider（单例）
                 -> src/mocks/mail.ts
```

`worker/index.ts` 是当前 Worker 入口。普通请求交给 vinext，`/_vinext/image` 由 Cloudflare 的资源和图片绑定处理。`vite.config.ts` 组合了 vinext、Vite、Cloudflare Vite 插件和 OpenAI Sites 的打包插件。

项目使用了 Next.js 的 App Router 目录和 React 组件，但当前产物不是通过标准的 `next build` / `next start` 链路生成。构建脚本面向 OpenAI Sites 和 Cloudflare Worker 产物，不应把它当成一套已经完成的通用 Next.js 自托管方案。

主要代码位置：

| 路径 | 内容 |
| --- | --- |
| [`app/communication-hub.tsx`](app/communication-hub.tsx) | 邮件工作台的界面、查询和交互状态 |
| [`src/providers/mail/MailProvider.ts`](src/providers/mail/MailProvider.ts) | 与供应商无关的邮件数据类型和接口 |
| [`src/providers/mail/MockMailProvider.ts`](src/providers/mail/MockMailProvider.ts) | 当前唯一启用的 Provider，数据只保存在内存中 |
| [`src/mocks/mail.ts`](src/mocks/mail.ts) | 模拟账号和邮件 |
| [`worker/index.ts`](worker/index.ts) | Cloudflare Worker 入口 |
| [`vite.config.ts`](vite.config.ts) | vinext、Vite、Sites 和 Cloudflare 构建配置 |

## 本地运行

需要：

- Node.js 22.13 或更高版本
- npm
- Linux 或 WSL2

仓库现有的 npm 脚本使用 Bash 和 GNU 工具。`build` 依赖 GNU `timeout`；`install:ci` 还依赖 `flock`、`curl`、`sha256sum` 和 Linux 的 `/proc`。原生 Windows PowerShell/CMD 目前不在支持范围内，`install:ci` 也不能直接在 macOS 上运行。

```bash
git clone https://github.com/shannoncheu/iMail.git
cd iMail
npm ci
npm run dev
```

打开终端打印的本地地址即可。当前 Mock 界面不需要 OAuth 密钥，也不需要数据库。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 和本地 Cloudflare 开发环境 |
| `npm run lint` | 运行 ESLint |
| `npm run build` | 执行 vinext 构建并检查 Sites Worker 产物 |
| `npm test` | 先构建，再运行 Provider 行为测试和 Worker HTML 冒烟测试 |
| `npm run install:ci` | 在 Sites/Linux 环境中按锁文件安装依赖 |

目前的测试覆盖 Mock Provider 的发送、草稿更新、回复、移动恢复与失败结果，以及构建后 Worker 的 HTML 冒烟检查。界面交互、OAuth 和安全边界还没有自动化测试。

## 环境变量

`.env.example` 主要记录下一阶段准备使用的配置。当前代码不会根据这些变量切换到真实服务：`createMailProvider()` 始终返回 `MockMailProvider`，`USE_MOCK_DATA` 也尚未参与运行时判断。

| 变量 | 状态与用途 |
| --- | --- |
| `USE_MOCK_DATA` | 已预留，当前未读取 |
| `APP_URL` | 计划用于同源应用地址和回调校验 |
| `DATABASE_URL` | 计划用于 PostgreSQL，当前没有数据库代码 |
| `SESSION_SECRET`、`TOKEN_ENCRYPTION_KEY` | 计划用于服务端会话和令牌加密 |
| `ALLOWED_*` | 计划用于所有者身份白名单 |
| `GOOGLE_*`、`MICROSOFT_*`、`ZOHO_*` | 计划用于各邮箱供应商的 OAuth |
| `GITHUB_*` | 计划只用于登录身份，不用于仓库或通知功能 |

现在不必填写真实密钥。以后接入真实服务时，密钥应放在部署平台的 Secret Store 中，不应提交到仓库或写进镜像。

## 后续架构

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`SECURITY.md`](SECURITY.md) 描述的是目标设计，不是当前已经落地的能力。计划中的边界是：

```text
浏览器
  -> 同源 BFF
     -> 身份验证、授权和应用服务
        -> MailProvider 接口
           -> Gmail / Outlook / Zoho 服务端适配器
              -> 供应商 API
```

真实 Provider 必须运行在服务端。浏览器不应接触访问令牌、刷新令牌、OAuth 客户端密钥、供应商 SDK 对象或原始响应。

PostgreSQL 计划只保存应用自身的数据，例如所有者身份、加密后的账号连接、会话、OAuth 临时事务、设置和安全事件。邮件正文、附件和供应商搜索索引仍由邮箱供应商保管，不把 iMail 变成第二个邮箱存储。

计划中的工作包括：

- [x] 邮件工作台界面和模拟数据
- [x] 与供应商无关的 `MailProvider` 接口
- [ ] 同源 BFF 与服务端应用层
- [ ] 所有者身份认证、PostgreSQL 会话和令牌保险库
- [ ] Gmail OAuth 与邮件适配器
- [ ] Outlook.com OAuth 与邮件适配器
- [ ] Zoho Mail OAuth 与邮件适配器
- [ ] 邮件 HTML 隔离、附件代理和安全测试
- [ ] 面向真实部署的容器、反向代理和运维文档

在认证、真实 Provider 和服务端安全边界完成之前，请只把本仓库用于本地界面开发和交互验证，不要部署成私人邮箱入口。

安全问题请参考 [`SECURITY.md`](SECURITY.md)。
