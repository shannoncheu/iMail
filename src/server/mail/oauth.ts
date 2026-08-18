import "server-only";

import { z } from "zod";
import type { AuthConfig, MailOAuthProviderConfig } from "../config";
import type { AuthenticatedSession } from "../auth/session";
import { oauthEncryptionKey } from "../auth/oauth-transaction";
import type { MailConnectionProvider } from "../auth/types";
import { readLimitedResponseText } from "../http";
import {
  createPkcePair,
  encryptAes256Gcm,
  randomBase64Url,
  sha256,
  sha256Base64Url,
} from "../security/crypto";
import type { MailConnectionRepository } from "./connection-repository";
import type {
  MailCredentialBundle,
  MailOAuthTransaction,
  StoredMailConnection,
} from "./connection-types";
import {
  MAIL_TOKEN_KEY_VERSION,
  MailTokenVault,
  mailOAuthVerifierAad,
} from "./token-vault";
import { revokeRawMailToken } from "./revoke-connection";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(32_768),
  refresh_token: z.string().min(1).max(32_768).optional(),
  token_type: z.string().min(1).max(64),
  expires_in: z.coerce.number().int().positive().max(31_536_000).optional(),
  scope: z.string().max(16_384).optional(),
});

export interface MailAuthorizationStart {
  authorizationUrl: URL;
  browserBinding: string;
}

export interface ConnectedProviderProfile {
  providerAccountId: string;
  emailAddress: string;
  label: string;
  metadata: Record<string, unknown>;
}

interface ExchangedToken {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  expiresAt: Date | null;
}

export async function beginMailAuthorization({
  authConfig,
  providerConfig,
  repository,
  returnTo,
  session,
}: {
  authConfig: AuthConfig;
  providerConfig: MailOAuthProviderConfig;
  repository: Pick<MailConnectionRepository, "createOAuthTransaction">;
  returnTo: string;
  session: AuthenticatedSession;
}): Promise<MailAuthorizationStart> {
  const transactionId = crypto.randomUUID();
  const state = randomBase64Url(32);
  const browserBinding = randomBase64Url(32);
  const pkce = await createPkcePair();
  const keyVersion = authConfig.tokenEncryptionKeyVersion ?? MAIL_TOKEN_KEY_VERSION;
  const key = await oauthEncryptionKey(authConfig, keyVersion);
  const codeVerifierEnvelope = await encryptAes256Gcm(
    key,
    pkce.verifier,
    mailOAuthVerifierAad(
      transactionId,
      session.record.owner.id,
      providerConfig.provider,
      keyVersion,
    ),
    keyVersion,
  );

  await repository.createOAuthTransaction({
    id: transactionId,
    ownerId: session.record.owner.id,
    sessionId: session.record.session.id,
    provider: providerConfig.provider,
    stateDigest: await sha256Base64Url(state),
    browserBindingDigest: await sha256Base64Url(browserBinding),
    codeVerifierEnvelope,
    redirectUri: providerConfig.callbackUrl,
    returnTo,
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
  });

  const authorizationUrl = new URL(providerConfig.authorizationUrl);
  authorizationUrl.searchParams.set("client_id", providerConfig.clientId);
  authorizationUrl.searchParams.set("redirect_uri", providerConfig.callbackUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "scope",
    providerConfig.scopes.join(providerConfig.scopeSeparator),
  );
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", pkce.method);
  if (providerConfig.provider === "outlook") {
    authorizationUrl.searchParams.set("response_mode", "query");
  }
  for (const [name, value] of Object.entries(
    providerConfig.authorizationParameters,
  )) {
    authorizationUrl.searchParams.set(name, value);
  }
  return { authorizationUrl, browserBinding };
}

export async function completeMailAuthorization({
  authorizeTransaction,
  authConfig,
  code,
  fetcher = fetch,
  providerConfig,
  repository,
  transaction,
}: {
  authorizeTransaction: () => Promise<boolean>;
  authConfig: AuthConfig;
  code: string;
  fetcher?: typeof fetch;
  providerConfig: MailOAuthProviderConfig;
  repository: Pick<
    MailConnectionRepository,
    "findByProviderAccount" | "upsertConnection"
  >;
  transaction: MailOAuthTransaction;
}): Promise<StoredMailConnection> {
  if (
    transaction.provider !== providerConfig.provider ||
    transaction.redirectUri !== providerConfig.callbackUrl
  ) {
    throw new Error("Mail OAuth transaction does not match provider config");
  }
  const key = await oauthEncryptionKey(
    authConfig,
    transaction.codeVerifierEnvelope.keyVersion,
  );
  const { decryptAes256GcmText } = await import("../security/crypto");
  const verifier = await decryptAes256GcmText(
    key,
    transaction.codeVerifierEnvelope,
    mailOAuthVerifierAad(
      transaction.id,
      transaction.ownerId,
      transaction.provider,
      transaction.codeVerifierEnvelope.keyVersion,
    ),
  );
  const token = await exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    fetcher,
    providerConfig,
  });
  try {
    if (!(await authorizeTransaction())) {
      throw new Error("Mail OAuth session is no longer authorized");
    }
  } catch (error) {
    await revokeRawMailToken({
      providerConfig,
      token: token.refreshToken ?? token.accessToken,
      tokenType: token.refreshToken ? "refresh_token" : "access_token",
      fetcher,
    });
    throw error;
  }
  const profile = await fetchProviderProfile({
    accessToken: token.accessToken,
    fetcher,
    providerConfig,
  });
  const existing = await repository.findByProviderAccount(
    transaction.ownerId,
    providerConfig.provider,
    profile.providerAccountId,
  );
  if (
    existing?.status === "error" &&
    (existing.lastErrorCode === "revocation_pending" ||
      existing.lastErrorCode === "revocation_in_progress")
  ) {
    await revokeRawMailToken({
      providerConfig,
      token: token.refreshToken ?? token.accessToken,
      tokenType: token.refreshToken ? "refresh_token" : "access_token",
      fetcher,
    });
    throw new Error("Mail connection revocation is still pending");
  }
  const connectionId =
    existing?.id ??
    (await deterministicConnectionId(
      transaction.ownerId,
      providerConfig.provider,
      profile.providerAccountId,
    ));
  const vault = await MailTokenVault.createFromConfig(authConfig);
  let refreshToken = token.refreshToken;
  if (!refreshToken && existing?.credentials) {
    refreshToken = (
      await vault.decrypt(existing.credentials, {
        connectionId: existing.id,
        ownerId: existing.ownerId,
        provider: existing.provider,
      })
    ).refreshToken;
  }
  if (!refreshToken) {
    throw new Error("Mail provider did not issue a refresh token");
  }
  const credentialBundle: MailCredentialBundle = {
    accessToken: token.accessToken,
    refreshToken,
    tokenType: "Bearer",
    scopes: token.scopes,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  };
  const credentials = await vault.encrypt(credentialBundle, {
    connectionId,
    ownerId: transaction.ownerId,
    provider: providerConfig.provider,
  });
  try {
    return await repository.upsertConnection({
      id: connectionId,
      ownerId: transaction.ownerId,
      provider: providerConfig.provider,
      providerAccountId: profile.providerAccountId,
      emailAddress: profile.emailAddress,
      label: profile.label,
      scopes: token.scopes,
      credentials,
      accessExpiresAt: token.expiresAt,
      providerMetadata: profile.metadata,
      expectedTokenVersion: existing?.tokenVersion ?? null,
    });
  } catch (error) {
    await revokeRawMailToken({
      providerConfig,
      token: token.refreshToken ?? token.accessToken,
      tokenType: token.refreshToken ? "refresh_token" : "access_token",
      fetcher,
    });
    throw error;
  }
}

export async function exchangeRefreshToken({
  fetcher = fetch,
  providerConfig,
  refreshToken,
}: {
  fetcher?: typeof fetch;
  providerConfig: MailOAuthProviderConfig;
  refreshToken: string;
}): Promise<ExchangedToken> {
  const form = new URLSearchParams({
    client_id: providerConfig.clientId,
    client_secret: providerConfig.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (providerConfig.provider === "outlook") {
    form.set("scope", providerConfig.scopes.join(" "));
  }
  const token = await requestToken(providerConfig, form, fetcher);
  return { ...token, refreshToken: token.refreshToken ?? refreshToken };
}

async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  fetcher,
  providerConfig,
}: {
  code: string;
  codeVerifier: string;
  fetcher: typeof fetch;
  providerConfig: MailOAuthProviderConfig;
}): Promise<ExchangedToken> {
  return requestToken(
    providerConfig,
    new URLSearchParams({
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: providerConfig.callbackUrl,
    }),
    fetcher,
  );
}

async function requestToken(
  providerConfig: MailOAuthProviderConfig,
  form: URLSearchParams,
  fetcher: typeof fetch,
): Promise<ExchangedToken> {
  const response = await fetcher(providerConfig.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJsonResponse(response, 128 * 1_024);
  if (!response.ok) throw new Error("Mail OAuth token exchange failed");
  const parsed = tokenResponseSchema.parse(body);
  if (parsed.token_type.toLowerCase() !== "bearer") {
    throw new Error("Mail OAuth token type is not Bearer");
  }
  const scopes = validateGrantedScopes(parsed.scope, providerConfig);
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    scopes,
    expiresAt: parsed.expires_in
      ? new Date(Date.now() + parsed.expires_in * 1_000)
      : null,
  };
}

async function fetchProviderProfile({
  accessToken,
  fetcher,
  providerConfig,
}: {
  accessToken: string;
  fetcher: typeof fetch;
  providerConfig: MailOAuthProviderConfig;
}): Promise<ConnectedProviderProfile> {
  const headers = {
    Accept: "application/json",
    Authorization:
      providerConfig.provider === "zoho"
        ? `Zoho-oauthtoken ${accessToken}`
        : `Bearer ${accessToken}`,
  };
  if (providerConfig.provider === "gmail") {
    const response = await fetcher(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    const body = await readJsonResponse(response, 128 * 1_024);
    if (!response.ok) throw new Error("Gmail account profile request failed");
    const parsed = z
      .object({
        sub: z.string().min(1).max(512),
        email: z.string().email(),
        email_verified: z.boolean().optional(),
        name: z.string().max(200).optional(),
        picture: z.string().url().max(2_048).optional(),
      })
      .parse(body);
    if (parsed.email_verified === false) {
      throw new Error("Gmail account email is not verified");
    }
    return {
      providerAccountId: parsed.sub,
      emailAddress: parsed.email,
      label: parsed.name || parsed.email,
      metadata: { picture: parsed.picture ?? null },
    };
  }

  if (providerConfig.provider === "outlook") {
    const profileUrl = new URL("/v1.0/me", providerConfig.apiBaseUrl);
    profileUrl.searchParams.set("$select", "id,displayName,mail,userPrincipalName");
    const response = await fetcher(profileUrl, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJsonResponse(response, 128 * 1_024);
    if (!response.ok) throw new Error("Outlook account profile request failed");
    const parsed = z
      .object({
        id: z.string().min(1).max(512),
        displayName: z.string().min(1).max(200),
        mail: z.string().email().nullable().optional(),
        userPrincipalName: z.string().email(),
      })
      .parse(body);
    const email = parsed.mail || parsed.userPrincipalName;
    return {
      providerAccountId: parsed.id,
      emailAddress: email,
      label: parsed.displayName || email,
      metadata: {},
    };
  }

  const accountsUrl = new URL("/api/accounts", providerConfig.apiBaseUrl);
  const response = await fetcher(accountsUrl, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJsonResponse(response, 256 * 1_024);
  if (!response.ok) throw new Error("Zoho account profile request failed");
  const parsed = z
    .object({
      data: z
        .array(
          z.object({
            accountId: z.union([z.string(), z.number()]).transform(String),
            primaryEmailAddress: z.string().email(),
            displayName: z.string().max(200).optional(),
          }),
        )
        .min(1),
    })
    .parse(body);
  const account = parsed.data[0];
  return {
    providerAccountId: account.accountId,
    emailAddress: account.primaryEmailAddress,
    label: account.displayName || account.primaryEmailAddress,
    metadata: {},
  };
}

function validateGrantedScopes(
  returnedScope: string | undefined,
  providerConfig: MailOAuthProviderConfig,
): string[] {
  if (!returnedScope) return [...providerConfig.scopes];
  const granted = Array.from(
    new Set(returnedScope.split(/[\s,]+/u).map((scope) => scope.trim()).filter(Boolean)),
  );
  const expected = new Set(providerConfig.scopes);
  if (granted.some((scope) => !expected.has(scope))) {
    throw new Error("Mail provider granted an unexpected OAuth scope");
  }
  const requiredApiScopes = providerConfig.scopes.filter(
    (scope) => !["openid", "profile", "email", "offline_access"].includes(scope),
  );
  if (requiredApiScopes.some((scope) => !granted.includes(scope))) {
    throw new Error("Mail provider did not grant all required OAuth scopes");
  }
  return granted;
}

async function readJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const text = await readLimitedResponseText(response, maximumBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Mail provider returned invalid JSON");
  }
}

async function deterministicConnectionId(
  ownerId: string,
  provider: MailConnectionProvider,
  providerAccountId: string,
): Promise<string> {
  const digest = await sha256(`${ownerId}|${provider}|${providerAccountId}`);
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function mailOAuthStateDigest(state: string): Promise<string> {
  return sha256Base64Url(state);
}
