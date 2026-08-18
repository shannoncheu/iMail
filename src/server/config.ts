import "server-only";

import { z } from "zod";
import { getRuntimeString } from "./runtime-env";
import { decodeBase64Url } from "./security/crypto";
import type { MailConnectionProvider } from "./auth/types";

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(?:ql)?:\/\//i.test(value), {
    message: "DATABASE_URL must be a PostgreSQL URL",
  });

const rawConfigSchema = z.object({
  APP_URL: z.string().url(),
  DATABASE_URL: postgresUrl,
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(43),
  TOKEN_ENCRYPTION_KEY_VERSION: z
    .string()
    .regex(/^(?:[1-9]\d{0,3}|[12]\d{4}|3[01]\d{3}|32[0-6]\d{2}|327[0-5]\d|3276[0-7])$/u)
    .optional(),
  TOKEN_ENCRYPTION_KEY_PREVIOUS: z.string().min(43).optional(),
  TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: z
    .string()
    .regex(/^(?:[1-9]\d{0,3}|[12]\d{4}|3[01]\d{3}|32[0-6]\d{2}|327[0-5]\d|3276[0-7])$/u)
    .optional(),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(20),
  ALLOWED_GITHUB_IDS: z.string().min(1),
});

export interface AuthConfig {
  appUrl: URL;
  databaseUrl: string;
  sessionSecret: string;
  tokenEncryptionKey: string;
  tokenEncryptionKeyVersion: number;
  previousTokenEncryptionKeys: ReadonlyMap<number, string>;
  github: {
    clientId: string;
    clientSecret: string;
    allowedIds: ReadonlySet<string>;
    callbackUrl: string;
  };
}

export interface MailOAuthProviderConfig {
  provider: MailConnectionProvider;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  callbackUrl: string;
  scopes: readonly string[];
  scopeSeparator: " " | ",";
  authorizationParameters: Readonly<Record<string, string>>;
  apiBaseUrl: string;
}

export class ConfigurationError extends Error {
  constructor(message = "Authentication is not configured") {
    super(message);
    this.name = "ConfigurationError";
  }
}

function rawConfiguration() {
  return {
    APP_URL: getRuntimeString("APP_URL"),
    DATABASE_URL: getRuntimeString("DATABASE_URL"),
    SESSION_SECRET: getRuntimeString("SESSION_SECRET"),
    TOKEN_ENCRYPTION_KEY: getRuntimeString("TOKEN_ENCRYPTION_KEY"),
    TOKEN_ENCRYPTION_KEY_VERSION: getRuntimeString(
      "TOKEN_ENCRYPTION_KEY_VERSION",
    ),
    TOKEN_ENCRYPTION_KEY_PREVIOUS: getRuntimeString(
      "TOKEN_ENCRYPTION_KEY_PREVIOUS",
    ),
    TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: getRuntimeString(
      "TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION",
    ),
    GITHUB_CLIENT_ID: getRuntimeString("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: getRuntimeString("GITHUB_CLIENT_SECRET"),
    ALLOWED_GITHUB_IDS: getRuntimeString("ALLOWED_GITHUB_IDS"),
  };
}

export function getAuthConfig(): AuthConfig {
  const parsed = rawConfigSchema.safeParse(rawConfiguration());
  if (!parsed.success) throw new ConfigurationError();

  const appUrl = new URL(parsed.data.APP_URL);
  const isLocal = appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1";
  if (appUrl.protocol !== "https:" && !isLocal) {
    throw new ConfigurationError("APP_URL must use HTTPS outside localhost");
  }
  if (
    appUrl.pathname !== "/" ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.username ||
    appUrl.password
  ) {
    throw new ConfigurationError("APP_URL must be an origin without a path");
  }
  if (parsed.data.SESSION_SECRET === parsed.data.TOKEN_ENCRYPTION_KEY) {
    throw new ConfigurationError("Session and encryption keys must be different");
  }
  try {
    if (decodeBase64Url(parsed.data.TOKEN_ENCRYPTION_KEY).byteLength !== 32) {
      throw new Error("invalid key length");
    }
  } catch {
    throw new ConfigurationError(
      "TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as base64url",
    );
  }

  const tokenEncryptionKeyVersion = Number(
    parsed.data.TOKEN_ENCRYPTION_KEY_VERSION ?? "1",
  );
  const hasPreviousKey = Boolean(parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS);
  const hasPreviousVersion = Boolean(
    parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION,
  );
  if (hasPreviousKey !== hasPreviousVersion) {
    throw new ConfigurationError(
      "Previous token encryption key and version must be configured together",
    );
  }
  const previousTokenEncryptionKeys = new Map<number, string>();
  if (
    parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS &&
    parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION
  ) {
    const previousVersion = Number(
      parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION,
    );
    if (
      previousVersion === tokenEncryptionKeyVersion ||
      parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS ===
        parsed.data.TOKEN_ENCRYPTION_KEY ||
      parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS === parsed.data.SESSION_SECRET
    ) {
      throw new ConfigurationError(
        "Current and previous token encryption keys must be distinct",
      );
    }
    try {
      if (
        decodeBase64Url(parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS).byteLength !==
        32
      ) {
        throw new Error("invalid previous key length");
      }
    } catch {
      throw new ConfigurationError(
        "TOKEN_ENCRYPTION_KEY_PREVIOUS must be 32 random bytes encoded as base64url",
      );
    }
    previousTokenEncryptionKeys.set(
      previousVersion,
      parsed.data.TOKEN_ENCRYPTION_KEY_PREVIOUS,
    );
  }

  const allowedIds = new Set(
    parsed.data.ALLOWED_GITHUB_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (
    allowedIds.size === 0 ||
    Array.from(allowedIds).some((value) => !/^\d+$/.test(value))
  ) {
    throw new ConfigurationError("ALLOWED_GITHUB_IDS must contain numeric IDs");
  }

  return {
    appUrl,
    databaseUrl: parsed.data.DATABASE_URL,
    sessionSecret: parsed.data.SESSION_SECRET,
    tokenEncryptionKey: parsed.data.TOKEN_ENCRYPTION_KEY,
    tokenEncryptionKeyVersion,
    previousTokenEncryptionKeys,
    github: {
      clientId: parsed.data.GITHUB_CLIENT_ID,
      clientSecret: parsed.data.GITHUB_CLIENT_SECRET,
      allowedIds,
      callbackUrl: new URL("/api/auth/github/callback", appUrl).toString(),
    },
  };
}

export function isAuthConfigured(): boolean {
  try {
    getAuthConfig();
    return true;
  } catch {
    return false;
  }
}

const mailProviderSecrets = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(8),
});

const zohoAccountsOrigins = new Set([
  "https://accounts.zoho.com",
  "https://accounts.zoho.eu",
  "https://accounts.zoho.in",
  "https://accounts.zoho.com.au",
  "https://accounts.zoho.jp",
  "https://accounts.zohocloud.ca",
  "https://accounts.zoho.com.cn",
  "https://accounts.zoho.ae",
  "https://accounts.zoho.sa",
]);

const zohoMailApiOrigins = new Set([
  "https://mail.zoho.com",
  "https://mail.zoho.eu",
  "https://mail.zoho.in",
  "https://mail.zoho.com.au",
  "https://mail.zoho.jp",
  "https://mail.zohocloud.ca",
  "https://mail.zoho.com.cn",
  "https://mail.zoho.ae",
  "https://mail.zoho.sa",
]);

export function getMailOAuthConfig(
  provider: MailConnectionProvider,
  authConfig = getAuthConfig(),
): MailOAuthProviderConfig {
  const callbackUrl = new URL(
    `/api/mail/connect/${provider}/callback`,
    authConfig.appUrl,
  ).toString();

  if (provider === "gmail") {
    const parsed = mailProviderSecrets.safeParse({
      clientId: getRuntimeString("GOOGLE_CLIENT_ID"),
      clientSecret: getRuntimeString("GOOGLE_CLIENT_SECRET"),
    });
    if (!parsed.success) throw new ConfigurationError("Gmail OAuth is not configured");
    return {
      provider,
      ...parsed.data,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      callbackUrl,
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      scopeSeparator: " ",
      authorizationParameters: {
        access_type: "offline",
        prompt: "consent",
      },
      apiBaseUrl: "https://gmail.googleapis.com/gmail/v1",
    };
  }

  if (provider === "outlook") {
    const parsed = mailProviderSecrets.safeParse({
      clientId: getRuntimeString("MICROSOFT_CLIENT_ID"),
      clientSecret: getRuntimeString("MICROSOFT_CLIENT_SECRET"),
    });
    if (!parsed.success) {
      throw new ConfigurationError("Outlook OAuth is not configured");
    }
    const tenant = getRuntimeString("MICROSOFT_TENANT")?.trim() || "consumers";
    if (!/^(consumers|common|organizations|[0-9a-f-]{36})$/i.test(tenant)) {
      throw new ConfigurationError("MICROSOFT_TENANT is invalid");
    }
    const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
    return {
      provider,
      ...parsed.data,
      authorizationUrl: `${authority}/authorize`,
      tokenUrl: `${authority}/token`,
      callbackUrl,
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
        "Mail.Send",
      ],
      scopeSeparator: " ",
      authorizationParameters: { prompt: "select_account" },
      apiBaseUrl: "https://graph.microsoft.com/v1.0",
    };
  }

  const parsed = mailProviderSecrets.safeParse({
    clientId: getRuntimeString("ZOHO_CLIENT_ID"),
    clientSecret: getRuntimeString("ZOHO_CLIENT_SECRET"),
  });
  if (!parsed.success) throw new ConfigurationError("Zoho OAuth is not configured");
  const accountsOrigin = normalizedAllowedOrigin(
    getRuntimeString("ZOHO_ACCOUNTS_BASE_URL") || "https://accounts.zoho.com",
    zohoAccountsOrigins,
    "ZOHO_ACCOUNTS_BASE_URL",
  );
  const mailApiOrigin = normalizedAllowedOrigin(
    getRuntimeString("ZOHO_MAIL_API_BASE_URL") || "https://mail.zoho.com",
    zohoMailApiOrigins,
    "ZOHO_MAIL_API_BASE_URL",
  );
  return {
    provider,
    ...parsed.data,
    authorizationUrl: `${accountsOrigin}/oauth/v2/auth`,
    tokenUrl: `${accountsOrigin}/oauth/v2/token`,
    callbackUrl,
    scopes: [
      "ZohoMail.accounts.READ",
      "ZohoMail.folders.READ",
      "ZohoMail.messages.ALL",
      "ZohoMail.attachments.ALL",
    ],
    scopeSeparator: ",",
    authorizationParameters: {
      access_type: "offline",
      prompt: "consent",
    },
    apiBaseUrl: `${mailApiOrigin}/api`,
  };
}

export function getConfiguredMailProviders(): MailConnectionProvider[] {
  return (["gmail", "outlook", "zoho"] as const).filter((provider) => {
    try {
      getMailOAuthConfig(provider);
      return true;
    } catch {
      return false;
    }
  });
}

function normalizedAllowedOrigin(
  value: string,
  allowed: ReadonlySet<string>,
  field: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${field} is invalid`);
  }
  if (url.pathname !== "/" || url.search || url.hash || !allowed.has(url.origin)) {
    throw new ConfigurationError(`${field} is not an allowed Zoho data center`);
  }
  return url.origin;
}
