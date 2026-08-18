# Security policy

## Current status

This repository is in the mock-interface phase. It contains no working OAuth
flow, provider credentials, token storage, or production authentication.

Do not deploy the current mock login as an access-control mechanism.

## Reporting

Report security issues privately through GitHub private vulnerability reporting
when it is enabled for the repository. Do not disclose token-handling, session,
HTML rendering, or access-control vulnerabilities in a public issue.

Include the affected commit, reproduction steps, expected impact, and whether
any real credentials or private mail data were exposed. Do not include active
secrets in the report.

## Repository hygiene

The repository must never contain:

- OAuth client secrets
- access or refresh tokens
- session or encryption keys
- database passwords
- real owner emails or provider usernames
- production domains or callback URLs
- mail bodies or attachments from real accounts

Use `.env.local` for local values and a deployment secret store in production.
Rotate any secret immediately if it appears in Git history; removing the file
from the latest commit is not sufficient.

## Production gate

Real provider integration must not ship until the application has tests for
allowlist enforcement, OAuth transaction binding, CSRF, session rotation, token
encryption, refresh coordination, mail HTML isolation, attachment handling, and
redacted logging.

