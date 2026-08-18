import { getAuthConfig } from "@/src/server/config";
import { AuthRepository } from "@/src/server/auth/repository";
import { buildGitHubAuthorizationUrl } from "@/src/server/auth/github";
import {
  OAUTH_TRANSACTION_KEY_VERSION,
  oauthEncryptionKey,
  oauthVerifierAad,
} from "@/src/server/auth/oauth-transaction";
import { authCookieContext } from "@/src/server/auth/session";
import { redirectNoStore, jsonNoStore } from "@/src/server/http";
import { serializeOAuthCookie } from "@/src/server/security/cookies";
import {
  createPkcePair,
  encryptAes256Gcm,
  randomBase64Url,
  sha256Base64Url,
} from "@/src/server/security/crypto";
import {
  requireSafeReturnPath,
  validateSameOriginMutation,
} from "@/src/server/security/request-security";

export const dynamic = "force-dynamic";

const maximumFormBodyBytes = 4_096;

class RequestBodyTooLargeError extends Error {}

async function readFormBody(request: Request): Promise<URLSearchParams> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumFormBodyBytes
    ) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (!request.body) return new URLSearchParams();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalLength += value.byteLength;
    if (totalLength > maximumFormBodyBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return new URLSearchParams(body);
}

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = getAuthConfig();
  } catch {
    return jsonNoStore({ error: "authentication_not_configured" }, { status: 503 });
  }

  const requestCheck = validateSameOriginMutation(request, {
    appUrl: config.appUrl,
    requireFetchMetadata: true,
    requireJson: false,
  });
  if (!requestCheck.ok) {
    return jsonNoStore({ error: requestCheck.code }, { status: requestCheck.status });
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    return jsonNoStore({ error: "unsupported_content_type" }, { status: 415 });
  }

  let returnTo: string;
  try {
    const form = await readFormBody(request);
    const returnToValues = form.getAll("returnTo");
    if (returnToValues.length > 1) throw new TypeError("Duplicate returnTo");
    const submittedReturnTo = returnToValues[0];
    returnTo = requireSafeReturnPath(
      submittedReturnTo,
      { allowedPathPrefixes: ["/"] },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonNoStore({ error: "request_too_large" }, { status: 413 });
    }
    return jsonNoStore({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const repository = new AuthRepository({ databaseUrl: config.databaseUrl });
    const transactionId = crypto.randomUUID();
    const state = randomBase64Url(32);
    const browserBinding = randomBase64Url(32);
    const pkce = await createPkcePair();
    const key = await oauthEncryptionKey(config);
    const codeVerifierEnvelope = await encryptAes256Gcm(
      key,
      pkce.verifier,
      oauthVerifierAad(transactionId),
      OAUTH_TRANSACTION_KEY_VERSION,
    );

    await repository.createOAuthTransaction({
      id: transactionId,
      provider: "github",
      stateDigest: await sha256Base64Url(state),
      browserBindingDigest: await sha256Base64Url(browserBinding),
      codeVerifierEnvelope,
      redirectUri: config.github.callbackUrl,
      returnTo,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    });

    const authorizationUrl = buildGitHubAuthorizationUrl({
      clientId: config.github.clientId,
      callbackUrl: config.github.callbackUrl,
      state,
      codeChallenge: pkce.challenge,
    });
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      serializeOAuthCookie(browserBinding, authCookieContext(config)),
    );
    return redirectNoStore(authorizationUrl.toString(), { headers });
  } catch {
    return redirectNoStore("/?auth_error=service_unavailable");
  }
}
