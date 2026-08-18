import { constantTimeEqual } from "./crypto";

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const defaultCsrfHeaderName = "x-csrf-token";
const returnPathMaximumLength = 2_048;

export type RequestSecurityFailureCode =
  | "invalid_target_origin"
  | "method_not_allowed"
  | "missing_origin"
  | "invalid_origin"
  | "cross_site_request"
  | "missing_csrf_token"
  | "invalid_csrf_token"
  | "unsupported_content_type";

export type RequestSecurityResult =
  | { ok: true }
  | {
      code: RequestSecurityFailureCode;
      ok: false;
      status: 403 | 405 | 415;
    };

export interface SameOriginMutationOptions {
  appUrl: string | URL;
  allowRefererFallback?: boolean;
  requireFetchMetadata?: boolean;
  requireJson?: boolean;
}

export interface CsrfProtectedMutationOptions extends SameOriginMutationOptions {
  csrfHeaderName?: string;
  expectedCsrfToken: string;
}

export interface ReturnPathOptions {
  allowedPathPrefixes?: readonly string[];
  defaultPath?: string;
}

export class RequestSecurityError extends Error {
  readonly code: RequestSecurityFailureCode;
  readonly status: 403 | 405 | 415;

  constructor(result: Exclude<RequestSecurityResult, { ok: true }>) {
    super(result.code);
    this.name = "RequestSecurityError";
    this.code = result.code;
    this.status = result.status;
  }
}

function failure(
  code: RequestSecurityFailureCode,
  status: 403 | 405 | 415 = 403,
): RequestSecurityResult {
  return { code, ok: false, status };
}

function parseOriginOnly(value: string | URL): URL | null {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return null;
  }

  return url;
}

function sourceOrigin(request: Request, allowRefererFallback: boolean): string | null {
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin === "null" || origin.includes(",") || origin.includes(" ")) {
      return null;
    }
    return parseOriginOnly(origin)?.origin ?? null;
  }

  if (!allowRefererFallback) {
    return null;
  }

  const referer = request.headers.get("referer");
  if (!referer) {
    return null;
  }

  try {
    const url = new URL(referer);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function normalizedContentType(request: Request): string {
  return (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export function validateSameOriginMutation(
  request: Request,
  options: SameOriginMutationOptions,
): RequestSecurityResult {
  const appUrl = parseOriginOnly(options.appUrl);
  if (!appUrl) {
    throw new TypeError("appUrl must contain a valid HTTP(S) origin only");
  }

  if (!mutationMethods.has(request.method.toUpperCase())) {
    return failure("method_not_allowed", 405);
  }

  let targetOrigin: string;
  try {
    targetOrigin = new URL(request.url).origin;
  } catch {
    return failure("invalid_target_origin");
  }
  if (targetOrigin !== appUrl.origin) {
    return failure("invalid_target_origin");
  }

  const origin = sourceOrigin(request, options.allowRefererFallback ?? false);
  if (!origin) {
    return failure("missing_origin");
  }
  if (origin !== appUrl.origin) {
    return failure("invalid_origin");
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    return failure("cross_site_request");
  }
  if (!fetchSite && options.requireFetchMetadata) {
    return failure("cross_site_request");
  }

  if ((options.requireJson ?? true) && normalizedContentType(request) !== "application/json") {
    return failure("unsupported_content_type", 415);
  }

  return { ok: true };
}

export function validateCsrfProtectedMutation(
  request: Request,
  options: CsrfProtectedMutationOptions,
): RequestSecurityResult {
  const sameOriginResult = validateSameOriginMutation(request, options);
  if (!sameOriginResult.ok) {
    return sameOriginResult;
  }

  if (!options.expectedCsrfToken) {
    throw new TypeError("expectedCsrfToken must not be empty");
  }

  const headerName = options.csrfHeaderName ?? defaultCsrfHeaderName;
  const submittedToken = request.headers.get(headerName);
  if (!submittedToken) {
    return failure("missing_csrf_token");
  }
  if (!constantTimeEqual(submittedToken, options.expectedCsrfToken)) {
    return failure("invalid_csrf_token");
  }

  return { ok: true };
}

export function assertSameOriginMutation(
  request: Request,
  options: SameOriginMutationOptions,
): void {
  const result = validateSameOriginMutation(request, options);
  if (!result.ok) {
    throw new RequestSecurityError(result);
  }
}

export function assertCsrfProtectedMutation(
  request: Request,
  options: CsrfProtectedMutationOptions,
): void {
  const result = validateCsrfProtectedMutation(request, options);
  if (!result.ok) {
    throw new RequestSecurityError(result);
  }
}

function normalizeAllowedPrefix(prefix: string): string {
  if (!prefix.startsWith("/") || prefix.startsWith("//") || prefix.includes("?")) {
    throw new TypeError("Allowed return path prefixes must be absolute paths without a query");
  }

  const url = new URL(prefix, "https://return.invalid");
  if (url.origin !== "https://return.invalid" || url.hash || url.search) {
    throw new TypeError("Invalid allowed return path prefix");
  }
  return url.pathname;
}

function matchesAllowedPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") {
    return true;
  }
  if (pathname === prefix) {
    return true;
  }
  return prefix.endsWith("/")
    ? pathname.startsWith(prefix)
    : pathname.startsWith(`${prefix}/`);
}

export function requireSafeReturnPath(
  value: string | null | undefined,
  options: ReturnPathOptions = {},
): string {
  const defaultPath = options.defaultPath ?? "/";
  const candidate = value ?? defaultPath;
  if (!candidate || candidate.length > returnPathMaximumLength) {
    throw new TypeError("Invalid return path");
  }
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    candidate.includes("#") ||
    /[\u0000-\u001F\u007F]/u.test(candidate)
  ) {
    throw new TypeError("Invalid return path");
  }

  const rawPath = candidate.split("?", 1)[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw new TypeError("Invalid return path encoding");
  }
  if (
    decodedPath.startsWith("//") ||
    decodedPath.includes("\\") ||
    /[\u0000-\u001F\u007F]/u.test(decodedPath) ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("Invalid return path");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, "https://return.invalid");
  } catch {
    throw new TypeError("Invalid return path");
  }
  if (parsed.origin !== "https://return.invalid" || parsed.hash) {
    throw new TypeError("Invalid return path");
  }

  const allowedPrefixes = (options.allowedPathPrefixes ?? ["/"]).map(normalizeAllowedPrefix);
  if (
    allowedPrefixes.length === 0 ||
    !allowedPrefixes.some((prefix) => matchesAllowedPrefix(parsed.pathname, prefix))
  ) {
    throw new TypeError("Return path is not allowed");
  }

  return `${parsed.pathname}${parsed.search}`;
}
