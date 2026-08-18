import "server-only";

import { z } from "zod";
import type { EncryptedSecretEnvelope, MailConnectionProvider } from "../auth/types";
import {
  decodeBase64Url,
  decryptAes256GcmText,
  encryptAes256Gcm,
  importAes256GcmKey,
} from "../security/crypto";
import type { MailCredentialBundle } from "./connection-types";
import type { AuthConfig } from "../config";

export const MAIL_TOKEN_KEY_VERSION = 1;

const credentialSchema = z.object({
  accessToken: z.string().min(1).max(32_768),
  refreshToken: z.string().min(1).max(32_768).nullable(),
  tokenType: z.literal("Bearer"),
  scopes: z.array(z.string().min(1).max(512)).max(64),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});

export interface MailCredentialContext {
  connectionId: string;
  ownerId: string;
  provider: MailConnectionProvider;
}

export class MailTokenVault {
  private constructor(
    private readonly currentKeyVersion: number,
    private readonly keys: ReadonlyMap<number, CryptoKey>,
  ) {}

  static async create(
    encodedKey: string,
    keyVersion = MAIL_TOKEN_KEY_VERSION,
    previousKeys: ReadonlyMap<number, string> = new Map(),
  ): Promise<MailTokenVault> {
    const keys = new Map<number, CryptoKey>();
    keys.set(keyVersion, await importAes256GcmKey(decodeBase64Url(encodedKey)));
    for (const [version, previousKey] of previousKeys) {
      if (keys.has(version)) throw new TypeError("Duplicate token key version");
      keys.set(
        version,
        await importAes256GcmKey(decodeBase64Url(previousKey)),
      );
    }
    return new MailTokenVault(keyVersion, keys);
  }

  static createFromConfig(config: AuthConfig): Promise<MailTokenVault> {
    return MailTokenVault.create(
      config.tokenEncryptionKey,
      config.tokenEncryptionKeyVersion ?? MAIL_TOKEN_KEY_VERSION,
      config.previousTokenEncryptionKeys ?? new Map(),
    );
  }

  async encrypt(
    credentials: MailCredentialBundle,
    context: MailCredentialContext,
    keyVersion = this.currentKeyVersion,
  ): Promise<EncryptedSecretEnvelope> {
    const parsed = credentialSchema.parse(credentials);
    return encryptAes256Gcm(
      requireKey(this.keys, keyVersion),
      JSON.stringify(parsed),
      mailCredentialAad(context, keyVersion),
      keyVersion,
    );
  }

  async decrypt(
    envelope: EncryptedSecretEnvelope,
    context: MailCredentialContext,
  ): Promise<MailCredentialBundle> {
    const plaintext = await decryptAes256GcmText(
      requireKey(this.keys, envelope.keyVersion),
      envelope,
      mailCredentialAad(context, envelope.keyVersion),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new TypeError("Stored mail credentials are not valid JSON");
    }
    return credentialSchema.parse(parsed);
  }
}

function requireKey(
  keys: ReadonlyMap<number, CryptoKey>,
  version: number,
): CryptoKey {
  const key = keys.get(version);
  if (!key) throw new TypeError("Token encryption key version is unavailable");
  return key;
}

export function mailCredentialAad(
  context: MailCredentialContext,
  keyVersion = MAIL_TOKEN_KEY_VERSION,
): string {
  return [
    "mail-connection",
    context.connectionId,
    context.ownerId,
    context.provider,
    String(keyVersion),
  ].join("|");
}

export function mailOAuthVerifierAad(
  transactionId: string,
  ownerId: string,
  provider: MailConnectionProvider,
  keyVersion = MAIL_TOKEN_KEY_VERSION,
): string {
  return [
    "mail-oauth-transaction",
    transactionId,
    ownerId,
    provider,
    String(keyVersion),
  ].join("|");
}
