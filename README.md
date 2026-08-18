# Private Communication Hub

Private Communication Hub is a self-hosted web interface for managing personal
mail accounts through provider APIs. It is not a mail server and does not
implement SMTP, IMAP, POP3, mail delivery, or spam filtering.

The repository is currently at the mock-interface milestone. Provider OAuth,
token storage, and production persistence are intentionally not implemented yet.

## Features

- Unified Gmail, Outlook.com, and Zoho Mail workspace
- Provider-neutral `MailProvider` boundary
- Three-pane desktop layout and single-pane mobile navigation
- Virtualized, paginated message list
- Thread reading with collapsed history and attachment presentation
- Compose, reply, forward, draft-state, and attachment interactions
- Account-scoped and explicit cross-account search
- Light, dark, and system themes
- Compact, comfortable, and relaxed desktop density
- Keyboard navigation and reduced-motion behavior
- Private-access login and session-management mock states
- Deterministic local mock provider with no external API requests

GitHub is reserved for login identity and allowlist checks. GitHub notifications,
repositories, and CI activity are outside the current product scope.

## Architecture

```text
Browser
  -> Next.js application / same-origin BFF
     -> application services and authorization
        -> MailProvider interface
           -> Gmail adapter
           -> Outlook adapter
           -> Zoho adapter
```

The UI imports the provider interface and factory, not provider SDKs or API
response types. The current factory returns `MockMailProvider`; later milestones
will select server-only adapters after an authenticated account is resolved.

PostgreSQL will store application state only: owner identities, encrypted OAuth
connections, sessions, OAuth transactions, settings, and security events. Mail
bodies, attachments, and provider search indexes are not application data sources
and must not be persisted.

See [Architecture](docs/ARCHITECTURE.md) and
[Design system](docs/DESIGN_SYSTEM.md) for the current technical decisions.

## Technology

- Next.js 16 and React 19
- TypeScript strict mode
- Tailwind CSS 4
- Motion
- Lucide React
- TanStack Query and TanStack Virtual
- Zod
- PostgreSQL and Prisma are planned for the authentication milestone

## Installation

Requirements:

- Node.js 22.13 or newer
- npm

```bash
git clone <repository-url>
cd private-communication-hub
cp .env.example .env.local
npm ci
npm run dev
```

Open the local URL printed by the development server. The mock interface does
not require OAuth credentials.

## Environment variables

Copy `.env.example` to `.env.local`. Do not commit the populated file.

Core variables:

| Variable | Purpose |
| --- | --- |
| `USE_MOCK_DATA` | Enables the deterministic mock provider in development |
| `APP_URL` | Canonical same-origin application URL |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Application session secret |
| `TOKEN_ENCRYPTION_KEY` | Server-side token-vault encryption key |
| `ALLOWED_EMAILS` | Bootstrap email allowlist; immutable provider IDs are preferred |
| `ALLOWED_GITHUB_IDS` | GitHub numeric identity allowlist |
| Provider client variables | OAuth client identifiers and secrets |

Production must fail to start if mock data is enabled. Secret values belong in
the deployment secret store, not in source control, images, or compose files.

## Development

```bash
npm run dev
npm run lint
npm run build
npm test
```

Development rules:

- Add provider behavior behind `MailProvider`.
- Treat all Server Action and Route Handler input as untrusted.
- Keep mock identities under the reserved `example.test` domain.
- Do not log mail bodies, attachments, OAuth values, or provider payloads.
- Keep GET requests free of side effects.
- Preserve keyboard, reduced-motion, and mobile alternatives for every action.

Commit messages should describe the change directly, for example:

```text
Build mock mail workspace
Add Gmail OAuth adapter
Fix token refresh coordination
Improve mobile thread navigation
```

## Deployment

The current mock milestone builds as a standard production Next.js application.
Production deployment for the complete application will require:

- HTTPS termination with Caddy or Nginx
- PostgreSQL on a private network
- Runtime secrets injected outside the image
- Exact OAuth callback URLs for every provider
- A non-root container and restricted runtime database role
- `Cache-Control: no-store` for authenticated mail and attachment responses

Docker, VPS, and reverse-proxy examples are scheduled for the deployment
milestone after real providers and authentication are complete.

## Security design

The security model is deny-by-default and owner-only.

- OAuth Authorization Code flow with PKCE and one-time state
- Separate identity sign-in from mail-provider authorization
- Immutable provider IDs as the long-term allowlist key
- Opaque server-side sessions with idle and absolute expiration
- `HttpOnly`, `Secure`, host-only session cookies
- Short-lived `SameSite=Lax` transaction cookie only for OAuth callbacks
- Session-bound CSRF token plus Origin and Host validation
- Refresh tokens encrypted with an AEAD scheme and never returned to the browser
- Mail HTML sanitized, isolated, and rendered with external images blocked
- Provider adapters and token handling restricted to server-only modules
- Static-only service-worker caching; private API responses are never cached

See [SECURITY.md](SECURITY.md) before reporting a vulnerability or deploying
the application.

## Roadmap

- [x] Architecture and security boundaries
- [x] UI design system
- [x] Interactive mock workspace
- [ ] Zoho OAuth and mail adapter
- [ ] Gmail OAuth and mail adapter
- [ ] Outlook.com delegated OAuth and mail adapter
- [ ] Owner authentication, PostgreSQL sessions, and token vault
- [ ] Security review and abuse-case tests
- [ ] Docker, VPS, Caddy, and Nginx deployment documentation
- [ ] PWA manifest and install surface

## Known limitations

- The current build uses in-memory mock data only.
- Login buttons demonstrate UI states and do not perform OAuth.
- Message changes reset after a page reload.
- HTML mail sanitization is not exercised because the mock reader uses plain text.
- Compose formatting buttons expose interface states but do not produce rich HTML.
- Provider capability differences are represented but not connected to live APIs.
- Full offline mail synchronization is intentionally out of scope.
