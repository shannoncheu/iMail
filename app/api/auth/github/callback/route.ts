import { getAuthConfig, type AuthConfig } from "@/src/server/config";
import { createLoginCompletionResponse } from "@/src/server/auth/callback-response";
import { exchangeGitHubCodeForIdentity } from "@/src/server/auth/github";
import {
  oauthEncryptionKey,
  oauthVerifierAad,
} from "@/src/server/auth/oauth-transaction";
import { AuthRepository } from "@/src/server/auth/repository";
import {
  authCookieContext,
  createOwnerSession,
} from "@/src/server/auth/session";
import { jsonNoStore, redirectNoStore } from "@/src/server/http";
import {
  clearOAuthCookie,
  isAuthenticationCookieValue,
  readOAuthCookie,
  serializeSessionCookie,
} from "@/src/server/security/cookies";
import {
  decryptAes256GcmText,
  sha256Base64Url,
} from "@/src/server/security/crypto";
import { requireSafeReturnPath } from "@/src/server/security/request-security";

export const dynamic = "force-dynamic";

function callbackRedirect(
  config: AuthConfig,
  path: string,
  sessionToken?: string,
): Response {
  const headers = new Headers();
  headers.append("Set-Cookie", clearOAuthCookie(authCookieContext(config)));
  if (sessionToken) {
    headers.append(
      "Set-Cookie",
      serializeSessionCookie(sessionToken, authCookieContext(config)),
    );
  }
  return redirectNoStore(path, { headers });
}

function authError(config: AuthConfig, code: string): Response {
  return callbackRedirect(config, `/?auth_error=${encodeURIComponent(code)}`);
}

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = getAuthConfig();
  } catch {
    return jsonNoStore({ error: "authentication_not_configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  if (
    url.origin !== config.appUrl.origin ||
    url.pathname !== "/api/auth/github/callback"
  ) {
    return authError(config, "oauth_failed");
  }

  const state = url.searchParams.get("state");
  const browserBinding = readOAuthCookie(request, authCookieContext(config));
  if (
    !state ||
    !browserBinding ||
    !isAuthenticationCookieValue(state) ||
    !isAuthenticationCookieValue(browserBinding)
  ) {
    return authError(config, "oauth_failed");
  }

  try {
    const repository = new AuthRepository({ databaseUrl: config.databaseUrl });
    const transaction = await repository.consumeOAuthTransaction({
      provider: "github",
      stateDigest: await sha256Base64Url(state),
      browserBindingDigest: await sha256Base64Url(browserBinding),
    });
    if (!transaction) return authError(config, "transaction_expired");
    if (transaction.redirectUri !== config.github.callbackUrl) {
      return authError(config, "oauth_failed");
    }
    const returnTo = requireSafeReturnPath(transaction.returnTo, {
      allowedPathPrefixes: ["/"],
    });

    if (url.searchParams.get("error")) {
      return authError(config, "access_denied");
    }
    const code = url.searchParams.get("code");
    if (!code) return authError(config, "oauth_failed");

    const key = await oauthEncryptionKey(config);
    const verifier = await decryptAes256GcmText(
      key,
      transaction.codeVerifierEnvelope,
      oauthVerifierAad(
        transaction.id,
        transaction.provider,
        transaction.codeVerifierEnvelope.keyVersion,
      ),
    );
    const identity = await exchangeGitHubCodeForIdentity({
      config: config.github,
      code,
      codeVerifier: verifier,
    });

    if (!config.github.allowedIds.has(identity.id)) {
      await repository
        .recordSecurityEvent({
          eventType: "auth.github.denied",
          severity: "warning",
          metadata: { providerSubject: identity.id },
        })
        .catch(() => undefined);
      return authError(config, "access_denied");
    }

    const { owner, identity: ownerIdentity } = await repository.upsertOwnerIdentity({
      provider: "github",
      providerSubject: identity.id,
      providerUsername: identity.login,
      displayName: identity.displayName,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
    });
    const { rawToken } = await createOwnerSession({
      config,
      identityId: ownerIdentity.id,
      ownerId: owner.id,
      repository,
    });
    return createLoginCompletionResponse({
      config,
      returnTo,
      sessionToken: rawToken,
    });
  } catch {
    return authError(config, "oauth_failed");
  }
}
