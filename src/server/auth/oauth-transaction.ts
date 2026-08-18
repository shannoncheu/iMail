import "server-only";

import type { AuthConfig } from "../config";
import {
  decodeBase64Url,
  importAes256GcmKey,
} from "../security/crypto";

export const OAUTH_TRANSACTION_KEY_VERSION = 1;

export function oauthVerifierAad(
  transactionId: string,
  provider = "github",
  keyVersion = OAUTH_TRANSACTION_KEY_VERSION,
): string {
  return `oauth-transaction|${transactionId}|${provider}|${keyVersion}`;
}

export async function oauthEncryptionKey(
  config: AuthConfig,
  keyVersion = config.tokenEncryptionKeyVersion ?? OAUTH_TRANSACTION_KEY_VERSION,
): Promise<CryptoKey> {
  const currentVersion =
    config.tokenEncryptionKeyVersion ?? OAUTH_TRANSACTION_KEY_VERSION;
  const encodedKey =
    keyVersion === currentVersion
      ? config.tokenEncryptionKey
      : config.previousTokenEncryptionKeys?.get(keyVersion);
  if (!encodedKey) throw new Error("Token encryption key version is unavailable");
  const rawKey = decodeBase64Url(encodedKey);
  return importAes256GcmKey(rawKey);
}
