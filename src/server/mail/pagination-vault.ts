import "server-only";

import type { EncryptedSecretEnvelope } from "../auth/types";
import type { AuthConfig } from "../config";
import {
  decodeBase64Url,
  decryptAes256GcmText,
  encryptAes256Gcm,
  importAes256GcmKey,
} from "../security/crypto";

const maximumPaginationStateBytes = 512 * 1_024;

export interface MailPaginationVaultContext {
  sessionId: string;
  ownerId: string;
  queryFingerprint: string;
}

export class MailPaginationVault {
  private constructor(
    private readonly currentKeyVersion: number,
    private readonly keys: ReadonlyMap<number, CryptoKey>,
  ) {}

  static async createFromConfig(config: AuthConfig): Promise<MailPaginationVault> {
    const currentVersion = config.tokenEncryptionKeyVersion ?? 1;
    const keys = new Map<number, CryptoKey>();
    keys.set(
      currentVersion,
      await importAes256GcmKey(decodeBase64Url(config.tokenEncryptionKey)),
    );
    for (const [version, encodedKey] of config.previousTokenEncryptionKeys ?? []) {
      if (keys.has(version)) throw new TypeError("Duplicate pagination key version");
      keys.set(
        version,
        await importAes256GcmKey(decodeBase64Url(encodedKey)),
      );
    }
    return new MailPaginationVault(currentVersion, keys);
  }

  async encrypt(
    value: unknown,
    context: MailPaginationVaultContext,
  ): Promise<EncryptedSecretEnvelope> {
    const plaintext = JSON.stringify(value);
    if (new TextEncoder().encode(plaintext).byteLength > maximumPaginationStateBytes) {
      throw new RangeError("Mail pagination state is too large");
    }
    return encryptAes256Gcm(
      requireKey(this.keys, this.currentKeyVersion),
      plaintext,
      paginationAad(context, this.currentKeyVersion),
      this.currentKeyVersion,
    );
  }

  async decrypt(
    envelope: EncryptedSecretEnvelope,
    context: MailPaginationVaultContext,
  ): Promise<unknown> {
    const plaintext = await decryptAes256GcmText(
      requireKey(this.keys, envelope.keyVersion),
      envelope,
      paginationAad(context, envelope.keyVersion),
    );
    if (new TextEncoder().encode(plaintext).byteLength > maximumPaginationStateBytes) {
      throw new RangeError("Mail pagination state is too large");
    }
    try {
      return JSON.parse(plaintext);
    } catch {
      throw new TypeError("Mail pagination state is invalid JSON");
    }
  }
}

function requireKey(
  keys: ReadonlyMap<number, CryptoKey>,
  version: number,
): CryptoKey {
  const key = keys.get(version);
  if (!key) throw new TypeError("Pagination encryption key version is unavailable");
  return key;
}

function paginationAad(
  context: MailPaginationVaultContext,
  keyVersion: number,
): string {
  return [
    "mail-pagination",
    context.sessionId,
    context.ownerId,
    context.queryFingerprint,
    String(keyVersion),
  ].join("|");
}
