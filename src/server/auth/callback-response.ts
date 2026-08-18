import "server-only";

import type { AuthConfig } from "../config";
import { noStoreHeaders } from "../http";
import {
  clearOAuthCookie,
  serializeSessionCookie,
} from "../security/cookies";
import { authCookieContext } from "./session";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function createLoginCompletionResponse({
  config,
  returnTo,
  sessionToken,
}: {
  config: AuthConfig;
  returnTo: string;
  sessionToken: string;
}): Response {
  const destination = escapeHtml(returnTo);
  const headers = noStoreHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  headers.append("Set-Cookie", clearOAuthCookie(authCookieContext(config)));
  headers.append(
    "Set-Cookie",
    serializeSessionCookie(sessionToken, authCookieContext(config)),
  );

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${destination}"><title>Sign-in complete</title></head><body><p>Sign-in complete. <a href="${destination}">Continue to iMail</a>.</p></body></html>`,
    { status: 200, headers },
  );
}
