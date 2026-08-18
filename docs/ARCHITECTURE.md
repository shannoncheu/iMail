# Architecture

## Scope

Private Communication Hub is a modular Next.js application that presents mail
owned by third-party providers. It does not become the authoritative store for
messages and does not implement mail transport protocols.

Supported mail sources:

- Zoho Mail
- Gmail for individual delegated users
- Outlook.com for individual Microsoft consumer accounts

GitHub is an optional login identity. Notification and repository features are
not part of the product.

## Runtime boundaries

```text
Browser
  -> same-origin Next.js boundary
     -> authorization and application services
        -> provider port
           -> provider adapter
              -> third-party API
```

The browser receives normalized domain objects only. It never receives access
tokens, refresh tokens, OAuth client secrets, raw provider responses, or
provider SDK objects.

Application services own authorization, validation, idempotency, request
coordination, provider capability checks, and partial-failure reporting. An
adapter only translates between a provider API and the domain contract.

## Suggested source layout

```text
app/                         application routes and UI shell
src/
  application/              authenticated use cases
  domain/                   provider-neutral models
  providers/
    mail/
      MailProvider.ts       stable UI-facing port
      MockMailProvider.ts   deterministic development adapter
      GmailProvider.ts      planned server-only adapter
      OutlookProvider.ts    planned server-only adapter
      ZohoMailProvider.ts   planned server-only adapter
  security/                 sessions, CSRF, token vault, HTML isolation
  mocks/                    synthetic development data
```

## Data ownership

PostgreSQL may contain:

- one internal owner and immutable provider identities
- encrypted provider connections
- opaque session digests and expiration state
- one-time OAuth transactions
- user settings and security events

PostgreSQL must not become a second mailbox. Message bodies, attachments,
provider search indexes, and provider drafts are excluded. Browser mail caches
remain in memory and authenticated responses use `Cache-Control: no-store`.

## OAuth

Identity sign-in and provider connection are separate operations.

1. Create a short-lived server-side transaction.
2. Generate high-entropy state and a PKCE S256 challenge.
3. Redirect to the provider's exact registered authorization endpoint.
4. Validate transaction binding, state, issuer, callback path, TTL, and PKCE.
5. Exchange the code on the server.
6. Resolve an immutable provider identity.
7. Enforce the owner allowlist before storing tokens or creating a session.
8. Rotate the application session identifier.

The main session cookie can use `SameSite=Strict`. The short-lived OAuth
transaction cookie must use `SameSite=Lax` because the callback is a cross-site
top-level navigation.

## Provider semantics

Provider capabilities are explicit rather than inferred in the UI. Destructive
operations use separate methods for moving to trash, restoring, and permanent
deletion. Send operations are not blindly retried: a timeout produces an
unknown state until the provider can be reconciled.

Cross-account search is user-selected because it transmits the same query to
multiple providers. Partial failures remain visible per provider.

## Mail content

HTML mail is attacker-controlled content. The production reader requires:

- allowlist-based server-side sanitization
- removal of scripts, forms, active embeds, dangerous protocols, and unsafe CSS
- a scriptless, origin-isolated rendering context
- external images disabled by default
- attachment streaming through opaque application IDs
- no browser or service-worker persistence of private content

