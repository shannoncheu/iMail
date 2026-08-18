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

export async function oauthEncryptionKey(config: AuthConfig): Promise<CryptoKey> {
  const rawKey = decodeBase64Url(config.tokenEncryptionKey);
  return importAes256GcmKey(rawKey);
}
