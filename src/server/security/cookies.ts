export const SESSION_COOKIE_NAME = "__Host-imail-session";
export const OAUTH_COOKIE_NAME = "__Host-imail-oauth";
export const MAIL_OAUTH_COOKIE_NAME = "__Host-imail-mail-oauth";
export const LOCAL_SESSION_COOKIE_NAME = "imail-session";
export const LOCAL_OAUTH_COOKIE_NAME = "imail-oauth";
export const LOCAL_MAIL_OAUTH_COOKIE_NAME = "imail-mail-oauth";

const DEFAULT_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const DEFAULT_OAUTH_MAX_AGE_SECONDS = 10 * 60;
const expiredCookieDate = "Thu, 01 Jan 1970 00:00:00 GMT";

export interface AuthCookieContext {
  appUrl: string | URL;
  production: boolean;
}

export interface AuthCookiePolicy {
  mailOAuthCookieName: string;
  oauthCookieName: string;
  secure: boolean;
  sessionCookieName: string;
}

function parseAppUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new TypeError("appUrl must contain an origin only");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("appUrl must use HTTP or HTTPS");
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isAuthenticationCookieValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,512}$/u.test(value);
}

function assertCookieValue(value: string): void {
  if (!isAuthenticationCookieValue(value)) {
    throw new TypeError("Authentication cookie values must be unpadded base64url tokens");
  }
}

function assertMaxAge(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Cookie Max-Age must be a positive integer");
  }
}

function serializeCookie(
  name: string,
  value: string,
  sameSite: "Strict" | "Lax",
  secure: boolean,
  maxAge: number,
): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    secure ? "Secure" : null,
    `SameSite=${sameSite}`,
  ];

  return attributes.filter((attribute): attribute is string => attribute !== null).join("; ");
}

function serializeExpiredCookie(
  name: string,
  sameSite: "Strict" | "Lax",
  secure: boolean,
): string {
  const attributes = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    `Expires=${expiredCookieDate}`,
    "HttpOnly",
    secure ? "Secure" : null,
    `SameSite=${sameSite}`,
  ];

  return attributes.filter((attribute): attribute is string => attribute !== null).join("; ");
}

export function resolveAuthCookiePolicy(context: AuthCookieContext): AuthCookiePolicy {
  const appUrl = parseAppUrl(context.appUrl);
  const secure = appUrl.protocol === "https:";

  if (context.production && !secure) {
    throw new TypeError("Production authentication cookies require HTTPS");
  }
  if (!secure && !isLoopbackHost(appUrl.hostname)) {
    throw new TypeError("Insecure authentication cookies are allowed only on localhost");
  }

  return secure
      ? {
        mailOAuthCookieName: MAIL_OAUTH_COOKIE_NAME,
        oauthCookieName: OAUTH_COOKIE_NAME,
        secure: true,
        sessionCookieName: SESSION_COOKIE_NAME,
      }
      : {
        mailOAuthCookieName: LOCAL_MAIL_OAUTH_COOKIE_NAME,
        oauthCookieName: LOCAL_OAUTH_COOKIE_NAME,
        secure: false,
        sessionCookieName: LOCAL_SESSION_COOKIE_NAME,
      };
}

export function serializeSessionCookie(
  value: string,
  context: AuthCookieContext,
  maxAgeSeconds = DEFAULT_SESSION_MAX_AGE_SECONDS,
): string {
  assertCookieValue(value);
  assertMaxAge(maxAgeSeconds);
  const policy = resolveAuthCookiePolicy(context);
  return serializeCookie(
    policy.sessionCookieName,
    value,
    "Strict",
    policy.secure,
    maxAgeSeconds,
  );
}

export function serializeOAuthCookie(
  value: string,
  context: AuthCookieContext,
  maxAgeSeconds = DEFAULT_OAUTH_MAX_AGE_SECONDS,
): string {
  assertCookieValue(value);
  assertMaxAge(maxAgeSeconds);
  const policy = resolveAuthCookiePolicy(context);
  return serializeCookie(
    policy.oauthCookieName,
    value,
    "Lax",
    policy.secure,
    maxAgeSeconds,
  );
}

export function clearSessionCookie(context: AuthCookieContext): string {
  const policy = resolveAuthCookiePolicy(context);
  return serializeExpiredCookie(
    policy.sessionCookieName,
    "Strict",
    policy.secure,
  );
}

export function clearOAuthCookie(context: AuthCookieContext): string {
  const policy = resolveAuthCookiePolicy(context);
  return serializeExpiredCookie(policy.oauthCookieName, "Lax", policy.secure);
}

export function serializeMailOAuthCookie(
  value: string,
  context: AuthCookieContext,
  maxAgeSeconds = DEFAULT_OAUTH_MAX_AGE_SECONDS,
): string {
  assertCookieValue(value);
  assertMaxAge(maxAgeSeconds);
  const policy = resolveAuthCookiePolicy(context);
  return serializeCookie(
    policy.mailOAuthCookieName,
    value,
    "Lax",
    policy.secure,
    maxAgeSeconds,
  );
}

export function clearMailOAuthCookie(context: AuthCookieContext): string {
  const policy = resolveAuthCookiePolicy(context);
  return serializeExpiredCookie(
    policy.mailOAuthCookieName,
    "Lax",
    policy.secure,
  );
}

export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  let result: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }

    if (result !== null) {
      return null;
    }
    result = part.slice(separator + 1).trim();
  }

  return result;
}

export function readSessionCookie(
  request: Request,
  context: AuthCookieContext,
): string | null {
  const { sessionCookieName } = resolveAuthCookiePolicy(context);
  const value = readCookieValue(request.headers.get("cookie"), sessionCookieName);
  return value && isAuthenticationCookieValue(value) ? value : null;
}

export function readOAuthCookie(
  request: Request,
  context: AuthCookieContext,
): string | null {
  const { oauthCookieName } = resolveAuthCookiePolicy(context);
  const value = readCookieValue(request.headers.get("cookie"), oauthCookieName);
  return value && isAuthenticationCookieValue(value) ? value : null;
}

export function readMailOAuthCookie(
  request: Request,
  context: AuthCookieContext,
): string | null {
  const { mailOAuthCookieName } = resolveAuthCookiePolicy(context);
  const value = readCookieValue(
    request.headers.get("cookie"),
    mailOAuthCookieName,
  );
  return value && isAuthenticationCookieValue(value) ? value : null;
}
