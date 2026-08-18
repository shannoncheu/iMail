import "server-only";

import {
  ConfigurationError,
  getAuthConfig,
  getMailOAuthConfig,
  type AuthConfig,
  type MailOAuthProviderConfig,
} from "../config";
import type { MailConnectionProvider } from "../auth/types";
import type { MailProvider } from "../../providers/mail/MailProvider";
import { GmailMailProvider } from "./gmail/GmailMailProvider";
import { OutlookMailProvider } from "./outlook-provider";
import { ZohoMailProvider } from "./zoho/ZohoMailProvider";
import { MailConnectionRepository } from "./connection-repository";
import type {
  MailCredentialBundle,
  StoredMailConnection,
} from "./connection-types";
import { exchangeRefreshToken } from "./oauth";
import { MailTokenVault } from "./token-vault";
import type {
  ServerMailAccessTokenProvider,
  ServerMailAccessTokenRequest,
  ServerMailProviderContext,
  ServerMailProviderFactory,
} from "./types";

const REFRESH_EARLY_MS = 60_000;
const REFRESH_WINNER_POLL_DELAYS_MS = [
  100, 200, 400, 800,
  ...Array.from({ length: 15 }, () => 1_000),
] as const;

type MailConnectionRepositoryPort = Pick<
  MailConnectionRepository,
  | "findById"
  | "acquireRefreshLease"
  | "releaseRefreshLease"
  | "updateCredentials"
>;

type MailTokenVaultPort = Pick<MailTokenVault, "decrypt" | "encrypt">;

export interface MailProviderFactoryDependencies {
  authConfig?: AuthConfig;
  providerConfig?: MailOAuthProviderConfig;
  repository?: MailConnectionRepositoryPort;
  tokenVault?: MailTokenVaultPort;
  exchangeRefresh?: typeof exchangeRefreshToken;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

export class MailConnectionUnavailableError extends Error {
  readonly code = "MAIL_CONNECTION_UNAVAILABLE";

  constructor() {
    super("Mail connection is unavailable");
    this.name = "MailConnectionUnavailableError";
  }
}

export class MailAccessTokenRefreshError extends Error {
  readonly code = "MAIL_ACCESS_TOKEN_REFRESH_FAILED";

  constructor() {
    super("Mail access token could not be refreshed");
    this.name = "MailAccessTokenRefreshError";
  }
}

interface TokenState {
  connection: StoredMailConnection;
  credentials: MailCredentialBundle;
}

interface ResolvedFactoryRuntime {
  providerConfig: MailOAuthProviderConfig;
  repository: MailConnectionRepositoryPort;
  tokenVault: MailTokenVaultPort;
  exchangeRefresh: typeof exchangeRefreshToken;
  fetchImplementation: typeof fetch;
  now: () => Date;
}

class ConnectionAccessTokenController {
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly expectedProvider: MailConnectionProvider,
    private readonly context: Readonly<ServerMailProviderContext>,
    private readonly runtime: ResolvedFactoryRuntime,
    private state: TokenState,
  ) {}

  readonly getAccessToken: ServerMailAccessTokenProvider = async (
    request: Readonly<ServerMailAccessTokenRequest> = {},
  ) => {
    if (!request.forceRefresh && !this.mustRefresh(this.state)) {
      return requireAccessToken(this.state.credentials.accessToken);
    }

    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.refreshCurrentToken();
    this.refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = null;
    }
  };

  private mustRefresh(state: TokenState): boolean {
    const expirations: number[] = [];
    if (state.connection.accessExpiresAt) {
      expirations.push(state.connection.accessExpiresAt.getTime());
    }
    if (state.credentials.expiresAt) {
      const parsed = Date.parse(state.credentials.expiresAt);
      if (Number.isFinite(parsed)) expirations.push(parsed);
    }
    if (expirations.length === 0) return false;
    return Math.min(...expirations) <= this.now().getTime() + REFRESH_EARLY_MS;
  }

  private async refreshCurrentToken(): Promise<string> {
    const snapshot = this.state;
    const refreshToken = snapshot.credentials.refreshToken;
    if (!refreshToken) throw new MailAccessTokenRefreshError();

    const leaseId = crypto.randomUUID();
    const leased = await this.runtime.repository.acquireRefreshLease({
      id: snapshot.connection.id,
      ownerId: snapshot.connection.ownerId,
      expectedTokenVersion: snapshot.connection.tokenVersion,
      leaseId,
    });
    if (!leased) {
      return this.useRefreshWinner(snapshot.connection.tokenVersion, true);
    }

    try {
      let exchanged: Awaited<ReturnType<typeof exchangeRefreshToken>>;
      try {
        exchanged = await this.runtime.exchangeRefresh({
          fetcher: this.runtime.fetchImplementation,
          providerConfig: this.runtime.providerConfig,
          refreshToken,
        });
      } catch {
        throw new MailAccessTokenRefreshError();
      }

      const credentials: MailCredentialBundle = {
        accessToken: requireAccessToken(exchanged.accessToken),
        refreshToken: exchanged.refreshToken ?? refreshToken,
        tokenType: "Bearer",
        scopes: [...exchanged.scopes],
        expiresAt: exchanged.expiresAt?.toISOString() ?? null,
      };
      validateRequiredScopes(credentials, this.runtime.providerConfig);

      let encrypted;
      try {
        encrypted = await this.runtime.tokenVault.encrypt(
          credentials,
          credentialContext(snapshot.connection),
        );
      } catch {
        throw new MailAccessTokenRefreshError();
      }

      const updated = await this.runtime.repository.updateCredentials({
        id: snapshot.connection.id,
        ownerId: snapshot.connection.ownerId,
        expectedTokenVersion: snapshot.connection.tokenVersion,
        refreshLeaseId: leaseId,
        credentials: encrypted,
        scopes: credentials.scopes,
        accessExpiresAt: exchanged.expiresAt,
        providerMetadata: snapshot.connection.providerMetadata,
        refreshedAt: this.now(),
      });

      if (updated) {
        assertConnectedConnection(
          updated,
          this.expectedProvider,
          this.context,
        );
        this.state = { connection: updated, credentials };
        return credentials.accessToken;
      }

      return this.useRefreshWinner(snapshot.connection.tokenVersion, true);
    } finally {
      await this.runtime.repository
        .releaseRefreshLease({
          id: snapshot.connection.id,
          ownerId: snapshot.connection.ownerId,
          expectedTokenVersion: snapshot.connection.tokenVersion,
          leaseId,
        })
        .catch(() => false);
    }
  }

  private async useRefreshWinner(
    previousTokenVersion: number,
    waitForInFlightRefresh: boolean,
  ): Promise<string> {
    let winner: StoredMailConnection | null = null;
    const delays = waitForInFlightRefresh
      ? [0, ...REFRESH_WINNER_POLL_DELAYS_MS]
      : [0];
    for (const delay of delays) {
      if (delay > 0) await wait(delay);
      winner = await this.runtime.repository.findById(
        this.context.ownerId,
        this.context.accountId,
      );
      assertConnectedConnection(winner, this.expectedProvider, this.context);
      if (winner.tokenVersion !== previousTokenVersion) break;
    }
    if (!winner || winner.tokenVersion === previousTokenVersion) {
      throw new MailAccessTokenRefreshError();
    }
    const winnerCredentials = await decryptCredentials(
      this.runtime.tokenVault,
      winner,
      this.runtime.providerConfig,
    );
    const winnerState = { connection: winner, credentials: winnerCredentials };
    if (this.mustRefresh(winnerState)) {
      throw new MailAccessTokenRefreshError();
    }
    this.state = winnerState;
    return requireAccessToken(winnerCredentials.accessToken);
  }

  private now(): Date {
    const value = this.runtime.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError("Mail provider clock returned an invalid date");
    }
    return value;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function createProductionMailProvider(
  provider: MailConnectionProvider,
  context: Readonly<ServerMailProviderContext>,
  dependencies: Readonly<MailProviderFactoryDependencies> = {},
): Promise<MailProvider> {
  validateContext(context);
  const runtime = await resolveRuntime(provider, dependencies);
  const connection = await runtime.repository.findById(
    context.ownerId,
    context.accountId,
  );
  assertConnectedConnection(connection, provider, context);
  const credentials = await decryptCredentials(
    runtime.tokenVault,
    connection,
    runtime.providerConfig,
  );
  const tokens = new ConnectionAccessTokenController(
    provider,
    context,
    runtime,
    { connection, credentials },
  );

  if (provider === "gmail") {
    const gmailProvider: GmailMailProvider = new GmailMailProvider({
      accountId: connection.id,
      accessToken: ({ forceRefresh }) =>
        tokens.getAccessToken({ forceRefresh }),
      accountLabel: connection.label,
      emailAddress: connection.emailAddress,
      fetchImplementation: runtime.fetchImplementation,
      attachmentResolver: (attachment) =>
        attachment.sourceMessageId
          ? gmailProvider.getAttachment(
              attachment.sourceMessageId,
              attachment.id,
            )
          : Promise.resolve(null),
      now: runtime.now,
    });
    return gmailProvider;
  }

  if (provider === "outlook") {
    return new OutlookMailProvider({
      accountId: connection.id,
      getAccessToken: () => tokens.getAccessToken(),
      account: {
        address: connection.emailAddress,
        label: connection.label,
        providerAccountId: connection.providerAccountId,
      },
      fetch: createOutlookRetryFetch(
        runtime.fetchImplementation,
        runtime.providerConfig.apiBaseUrl,
        tokens.getAccessToken,
      ),
      graphBaseUrl: runtime.providerConfig.apiBaseUrl,
    });
  }

  const apiOrigin = new URL(runtime.providerConfig.apiBaseUrl).origin;
  return new ZohoMailProvider({
    accountId: connection.id,
    providerAccountId: connection.providerAccountId,
    accessToken: ({ forceRefresh }) =>
      tokens.getAccessToken({ forceRefresh }),
    apiOrigin,
    fetchImplementation: runtime.fetchImplementation,
    now: runtime.now,
  });
}

export function createProductionMailProviderFactory(
  provider: MailConnectionProvider,
): ServerMailProviderFactory {
  return (context) => createProductionMailProvider(provider, context);
}

async function resolveRuntime(
  provider: MailConnectionProvider,
  dependencies: Readonly<MailProviderFactoryDependencies>,
): Promise<ResolvedFactoryRuntime> {
  const authConfig = dependencies.authConfig ?? getAuthConfig();
  const providerConfig =
    dependencies.providerConfig ?? getMailOAuthConfig(provider, authConfig);
  if (providerConfig.provider !== provider) {
    throw new ConfigurationError("Mail provider configuration does not match");
  }
  const repository =
    dependencies.repository ??
    new MailConnectionRepository({ databaseUrl: authConfig.databaseUrl });
  const tokenVault =
    dependencies.tokenVault ??
    (await MailTokenVault.createFromConfig(authConfig));
  return {
    providerConfig,
    repository,
    tokenVault,
    exchangeRefresh: dependencies.exchangeRefresh ?? exchangeRefreshToken,
    fetchImplementation: dependencies.fetchImplementation ?? fetch,
    now: dependencies.now ?? (() => new Date()),
  };
}

function validateContext(context: Readonly<ServerMailProviderContext>): void {
  for (const value of [context.accountId, context.ownerId]) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      /[\r\n\u0000]/u.test(value)
    ) {
      throw new MailConnectionUnavailableError();
    }
  }
}

function assertConnectedConnection(
  connection: StoredMailConnection | null,
  provider: MailConnectionProvider,
  context: Readonly<ServerMailProviderContext>,
): asserts connection is StoredMailConnection & { credentials: NonNullable<StoredMailConnection["credentials"]> } {
  if (
    !connection ||
    connection.id !== context.accountId ||
    connection.ownerId !== context.ownerId ||
    connection.provider !== provider ||
    connection.status !== "connected" ||
    !connection.credentials ||
    connection.disconnectedAt !== null
  ) {
    throw new MailConnectionUnavailableError();
  }
}

async function decryptCredentials(
  vault: MailTokenVaultPort,
  connection: StoredMailConnection & { credentials: NonNullable<StoredMailConnection["credentials"]> },
  providerConfig: MailOAuthProviderConfig,
): Promise<MailCredentialBundle> {
  let credentials: MailCredentialBundle;
  try {
    credentials = await vault.decrypt(
      connection.credentials,
      credentialContext(connection),
    );
    requireAccessToken(credentials.accessToken);
    validateRequiredScopes(credentials, providerConfig);
  } catch (error) {
    if (error instanceof MailConnectionUnavailableError) throw error;
    throw new MailConnectionUnavailableError();
  }
  return credentials;
}

function validateRequiredScopes(
  credentials: MailCredentialBundle,
  providerConfig: MailOAuthProviderConfig,
): void {
  const identityScopes = new Set([
    "openid",
    "profile",
    "email",
    "offline_access",
  ]);
  const granted = new Set(credentials.scopes);
  const missing = providerConfig.scopes.some(
    (scope) => !identityScopes.has(scope) && !granted.has(scope),
  );
  if (missing) throw new MailConnectionUnavailableError();
}

function requireAccessToken(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 32_768 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new MailConnectionUnavailableError();
  }
  return value;
}

function credentialContext(connection: StoredMailConnection) {
  return {
    connectionId: connection.id,
    ownerId: connection.ownerId,
    provider: connection.provider,
  };
}

function createOutlookRetryFetch(
  fetchImplementation: typeof fetch,
  apiBaseUrl: string,
  getAccessToken: ServerMailAccessTokenProvider,
): typeof fetch {
  const apiBase = new URL(apiBaseUrl);
  const apiPath = apiBase.pathname.replace(/\/+$/u, "");

  const retryingFetch: typeof fetch = async (input, init) => {
    const retryInput = input instanceof Request ? input.clone() : input;
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    let response = await fetchImplementation(input, init);
    if (
      response.status !== 401 ||
      url.origin !== apiBase.origin ||
      (url.pathname !== apiPath && !url.pathname.startsWith(`${apiPath}/`))
    ) {
      return response;
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (!/^Bearer\s+/iu.test(headers.get("Authorization") ?? "")) {
      return response;
    }

    try {
      await response.body?.cancel();
    } catch {
      // A consumed error body does not prevent one authenticated retry.
    }
    headers.set(
      "Authorization",
      `Bearer ${await getAccessToken({ forceRefresh: true })}`,
    );
    response = await fetchImplementation(retryInput, { ...init, headers });
    return response;
  };
  return retryingFetch;
}
