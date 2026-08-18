import "server-only";

import { z } from "zod";
import { getRuntimeString } from "./runtime-env";
import { decodeBase64Url } from "./security/crypto";

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
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(20),
  ALLOWED_GITHUB_IDS: z.string().min(1),
});

export interface AuthConfig {
  appUrl: URL;
  databaseUrl: string;
  sessionSecret: string;
  tokenEncryptionKey: string;
  github: {
    clientId: string;
    clientSecret: string;
    allowedIds: ReadonlySet<string>;
    callbackUrl: string;
  };
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
