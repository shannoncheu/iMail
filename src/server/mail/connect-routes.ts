import "server-only";

import { z } from "zod";
import { AuthRepository } from "../auth/repository";
import {
  authCookieContext,
  authenticateRequest,
  rotateOwnerSessionFromId,
} from "../auth/session";
import { createMailConnectionCompletionResponse } from "../auth/callback-response";
import type { MailConnectionProvider } from "../auth/types";
import { getAuthConfig, getMailOAuthConfig } from "../config";
import {
  jsonNoStore,
  readJsonBody,
  redirectNoStore,
  RequestBodyError,
} from "../http";
import {
  clearMailOAuthCookie,
  readMailOAuthCookie,
  serializeMailOAuthCookie,
} from "../security/cookies";
import { isAuthenticationCookieValue } from "../security/cookies";
import { consumeRequestRateLimit } from "../security/rate-limit";
import {
  requireSafeReturnPath,
  validateCsrfProtectedMutation,
} from "../security/request-security";
import { MailConnectionRepository } from "./connection-repository";
import {
  beginMailAuthorization,
  completeMailAuthorization,
  mailOAuthStateDigest,
} from "./oauth";

const startBodySchema = z.object({
  returnTo: z.string().max(2_048).optional(),
});

export async function handleMailConnectStart(
  provider: MailConnectionProvider,
  request: Request,
): Promise<Response> {
  let config;
  let providerConfig;
  try {
    config = getAuthConfig();
    providerConfig = getMailOAuthConfig(provider, config);
  } catch {
    return jsonNoStore({ error: "mail_provider_not_configured" }, { status: 503 });
  }

  try {
    const authRepository = new AuthRepository({ databaseUrl: config.databaseUrl });
    const session = await authenticateRequest({
      config,
      request,
      repository: authRepository,
    });
    if (!session) return jsonNoStore({ error: "unauthorized" }, { status: 401 });
    const requestSecurity = validateCsrfProtectedMutation(request, {
      appUrl: config.appUrl,
      expectedCsrfToken: session.csrfToken,
      requireFetchMetadata: true,
      requireJson: true,
    });
    if (!requestSecurity.ok) {
      return jsonNoStore(
        { error: requestSecurity.code },
        { status: requestSecurity.status },
      );
    }

    const repository = new MailConnectionRepository({
      databaseUrl: config.databaseUrl,
    });
    const rateLimit = await consumeRequestRateLimit({
      action: `mail_connect_${provider}`,
      config,
      maximum: 5,
      repository,
      request,
      windowSeconds: 10 * 60,
    });
    if (!rateLimit.allowed) {
      return jsonNoStore(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    const parsed = startBodySchema.parse(await readJsonBody(request, 4_096));
    const returnTo = requireSafeReturnPath(parsed.returnTo, {
      allowedPathPrefixes: ["/"],
      defaultPath: `/?mail_connected=${provider}`,
    });
    const started = await beginMailAuthorization({
      authConfig: config,
      providerConfig,
      repository,
      returnTo,
      session,
    });
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      serializeMailOAuthCookie(
        started.browserBinding,
        authCookieContext(config),
      ),
    );
    return jsonNoStore(
      { authorizationUrl: started.authorizationUrl.toString() },
      { headers },
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return jsonNoStore({ error: error.code }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return jsonNoStore({ error: "invalid_request" }, { status: 400 });
    }
    return jsonNoStore({ error: "mail_connect_unavailable" }, { status: 503 });
  }
}

export async function handleMailConnectCallback(
  provider: MailConnectionProvider,
  request: Request,
): Promise<Response> {
  let config;
  let providerConfig;
  try {
    config = getAuthConfig();
    providerConfig = getMailOAuthConfig(provider, config);
  } catch {
    return redirectNoStore("/?mail_error=not_configured");
  }
  const failure = (code: string) => {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      clearMailOAuthCookie(authCookieContext(config)),
    );
    return redirectNoStore(`/?mail_error=${encodeURIComponent(code)}`, {
      headers,
    });
  };

  try {
    const url = new URL(request.url);
    const expectedCallback = new URL(providerConfig.callbackUrl);
    if (
      url.origin !== expectedCallback.origin ||
      url.pathname !== expectedCallback.pathname
    ) {
      return failure("invalid_callback");
    }
    const stateValues = url.searchParams.getAll("state");
    const codeValues = url.searchParams.getAll("code");
    const errorValues = url.searchParams.getAll("error");
    if (stateValues.length !== 1 || errorValues.length > 1 || codeValues.length > 1) {
      return failure("invalid_callback");
    }
    const state = stateValues[0];
    const binder = readMailOAuthCookie(request, authCookieContext(config));
    if (
      !isAuthenticationCookieValue(state) ||
      !binder ||
      !isAuthenticationCookieValue(binder)
    ) {
      return failure("invalid_state");
    }
    const repository = new MailConnectionRepository({
      databaseUrl: config.databaseUrl,
    });
    const transaction = await repository.consumeOAuthTransaction({
      provider,
      stateDigest: await mailOAuthStateDigest(state),
      browserBindingDigest: await mailOAuthStateDigest(binder),
    });
    if (!transaction) return failure("invalid_state");
    if (errorValues[0]) return failure("provider_denied");
    const code = codeValues[0];
    if (!code || code.length > 4_096) return failure("invalid_code");

    const authRepository = new AuthRepository({ databaseUrl: config.databaseUrl });
    await completeMailAuthorization({
      authorizeTransaction: () =>
        authRepository.isOwnerSessionAuthorizedForGithubIds({
          sessionId: transaction.sessionId,
          ownerId: transaction.ownerId,
          allowedGithubIds: [...config.github.allowedIds],
        }),
      authConfig: config,
      code,
      providerConfig,
      repository,
      transaction,
    });
    const rotated = await rotateOwnerSessionFromId({
      config,
      previousSessionId: transaction.sessionId,
      repository: authRepository,
    });
    return createMailConnectionCompletionResponse({
      config,
      returnTo: transaction.returnTo,
      sessionToken: rotated.rawToken,
    });
  } catch {
    return failure("connection_failed");
  }
}
