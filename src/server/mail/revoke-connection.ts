import "server-only";

import type { AuthConfig, MailOAuthProviderConfig } from "../config";
import { getMailOAuthConfig } from "../config";
import { readLimitedResponseText } from "../http";
import type { StoredMailConnection } from "./connection-types";
import { MailTokenVault } from "./token-vault";

export type ProviderRevocationStatus =
  | "revoked"
  | "already_revoked"
  | "unsupported"
  | "failed";

/**
 * Best-effort upstream revocation performed immediately before local secrets
 * are destroyed. Outlook/Entra does not expose an OAuth refresh-token
 * revocation endpoint for this delegated flow, so local deletion is the only
 * operation available there.
 */
export async function revokeMailConnectionCredentials({
  config,
  connection,
  fetcher = fetch,
}: {
  config: AuthConfig;
  connection: StoredMailConnection;
  fetcher?: typeof fetch;
}): Promise<ProviderRevocationStatus> {
  if (!connection.credentials || connection.status === "disconnected") {
    return "already_revoked";
  }
  if (
    connection.status !== "connected" &&
    !(
      connection.status === "error" &&
      (connection.lastErrorCode === "revocation_pending" ||
        connection.lastErrorCode === "revocation_in_progress")
    )
  ) {
    return "failed";
  }
  if (connection.provider === "outlook") return "unsupported";

  try {
    const vault = await MailTokenVault.createFromConfig(config);
    const credentials = await vault.decrypt(connection.credentials, {
      connectionId: connection.id,
      ownerId: connection.ownerId,
      provider: connection.provider,
    });
    const token = credentials.refreshToken ?? credentials.accessToken;
    const providerConfig = getMailOAuthConfig(connection.provider, config);
    return revokeRawMailToken({
      providerConfig,
      token,
      tokenType: credentials.refreshToken ? "refresh_token" : "access_token",
      fetcher,
    });
  } catch {
    return "failed";
  }
}

/** Revokes a just-issued token that could not be committed to the database. */
export async function revokeRawMailToken({
  providerConfig,
  token,
  tokenType = "refresh_token",
  fetcher = fetch,
}: {
  providerConfig: MailOAuthProviderConfig;
  token: string;
  tokenType?: "refresh_token" | "access_token";
  fetcher?: typeof fetch;
}): Promise<ProviderRevocationStatus> {
  if (providerConfig.provider === "outlook") return "unsupported";
  try {
    if (providerConfig.provider === "zoho") {
      return revokeZohoToken({ providerConfig, token, tokenType, fetcher });
    }
    const endpoint = new URL("https://oauth2.googleapis.com/revoke");
    const body = new URLSearchParams({ token });
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The status is authoritative and the body contains no useful data.
      }
      return "revoked";
    }
    try {
      const error = JSON.parse(await readLimitedResponseText(response, 4_096));
      if (
        typeof error === "object" &&
        error !== null &&
        !Array.isArray(error) &&
        error.error === "invalid_token"
      ) {
        return "already_revoked";
      }
    } catch {
      // An unrecognized or oversized error is not proof of revocation.
    }
    return "failed";
  } catch {
    return "failed";
  }
}

async function revokeZohoToken({
  providerConfig,
  token,
  tokenType,
  fetcher,
}: {
  providerConfig: MailOAuthProviderConfig;
  token: string;
  tokenType: "refresh_token" | "access_token";
  fetcher: typeof fetch;
}): Promise<ProviderRevocationStatus> {
  const mailEndpoint = zohoMailRevocationEndpoint(providerConfig.tokenUrl, token);
  const legacyResponse = await fetcher(mailEndpoint, {
    method: "POST",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (legacyResponse.ok) {
    await cancelResponse(legacyResponse);
    return "revoked";
  }
  if (legacyResponse.status === 400) {
    await cancelResponse(legacyResponse);
    return "already_revoked";
  }
  if (![404, 405].includes(legacyResponse.status)) {
    await cancelResponse(legacyResponse);
    return "failed";
  }
  await cancelResponse(legacyResponse);

  const currentEndpoint = zohoCurrentRevocationEndpoint(providerConfig.tokenUrl);
  const response = await fetcher(currentEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: zohoClientAuthorization(
        providerConfig.clientId,
        providerConfig.clientSecret,
      ),
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({ token, token_type: tokenType }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await cancelResponse(response);
  return response.ok ? "revoked" : "failed";
}

function zohoMailRevocationEndpoint(tokenUrl: string, token: string): URL {
  const url = new URL(tokenUrl);
  if (!url.pathname.endsWith("/oauth/v2/token")) {
    throw new TypeError("Zoho token endpoint is invalid");
  }
  url.pathname = `${url.pathname}/revoke`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", token);
  return url;
}

function zohoCurrentRevocationEndpoint(tokenUrl: string): URL {
  const url = new URL(tokenUrl);
  if (!url.pathname.endsWith("/oauth/v2/token")) {
    throw new TypeError("Zoho token endpoint is invalid");
  }
  url.pathname = "/oauth/v2/revoke/token";
  url.search = "";
  url.hash = "";
  return url;
}

function zohoClientAuthorization(clientId: string, clientSecret: string): string {
  if (
    clientId.includes(":") ||
    !/^[\x20-\x7e]+$/u.test(clientId) ||
    !/^[\x20-\x7e]+$/u.test(clientSecret)
  ) {
    throw new TypeError("Zoho client credentials are invalid");
  }
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response bodies from fixed provider origins are never logged or trusted.
  }
}
