import { getAuthConfig } from "@/src/server/config";
import { AuthRepository } from "@/src/server/auth/repository";
import {
  authCookieContext,
  authenticateRequest,
} from "@/src/server/auth/session";
import { jsonNoStore, noStoreHeaders } from "@/src/server/http";
import { clearSessionCookie } from "@/src/server/security/cookies";
import { validateCsrfProtectedMutation } from "@/src/server/security/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = getAuthConfig();
  } catch {
    return jsonNoStore({ error: "authentication_not_configured" }, { status: 503 });
  }

  const repository = new AuthRepository({ databaseUrl: config.databaseUrl });
  let session;
  try {
    session = await authenticateRequest({ config, request, repository });
  } catch {
    return jsonNoStore({ error: "session_unavailable" }, { status: 503 });
  }
  if (!session) {
    return jsonNoStore(
      { error: "unauthorized" },
      {
        status: 401,
        headers: { "Set-Cookie": clearSessionCookie(authCookieContext(config)) },
      },
    );
  }

  const requestCheck = validateCsrfProtectedMutation(request, {
    appUrl: config.appUrl,
    expectedCsrfToken: session.csrfToken,
    requireFetchMetadata: true,
  });
  if (!requestCheck.ok) {
    return jsonNoStore({ error: requestCheck.code }, { status: requestCheck.status });
  }

  try {
    await repository.revokeSessionByDigest(session.tokenDigest);
  } catch {
    return jsonNoStore({ error: "logout_failed" }, { status: 503 });
  }

  const headers = noStoreHeaders({
    "Set-Cookie": clearSessionCookie(authCookieContext(config)),
  });
  return new Response(null, { status: 204, headers });
}
