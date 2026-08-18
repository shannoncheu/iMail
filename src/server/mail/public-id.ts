import "server-only";

import type { AuthConfig } from "../config";
import {
  constantTimeEqual,
  decodeBase64Url,
  deriveHmacSha256Key,
  encodeBase64Url,
  hmacSha256Base64Url,
} from "../security/crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MailPublicId {
  connectionId: string;
  nativeId: string;
  messageId?: string;
  sizeBytes?: number;
  type: "thread" | "message" | "attachment" | "draft" | "cursor";
}

export async function encodeMailPublicId(
  config: AuthConfig,
  value: MailPublicId,
): Promise<string> {
  validateMailPublicId(value);
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        v: 1,
        c: value.connectionId,
        t: value.type,
        n: value.nativeId,
        ...(value.messageId ? { m: value.messageId } : {}),
        ...(value.sizeBytes !== undefined ? { z: value.sizeBytes } : {}),
      }),
    ),
  );
  const signature = await sign(config, payload);
  return `${payload}.${signature}`;
}

export async function decodeMailPublicId(
  config: AuthConfig,
  encoded: string,
): Promise<MailPublicId | null> {
  if (encoded.length > 24_000) return null;
  const parts = encoded.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = await sign(config, payload);
  if (!constantTimeEqual(signature, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decodeBase64Url(payload)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  const value: MailPublicId = {
    connectionId: typeof record.c === "string" ? record.c : "",
    type: record.t as MailPublicId["type"],
    nativeId: typeof record.n === "string" ? record.n : "",
    ...(typeof record.m === "string" ? { messageId: record.m } : {}),
    ...(typeof record.z === "number" ? { sizeBytes: record.z } : {}),
  };
  try {
    validateMailPublicId(value);
    return value;
  } catch {
    return null;
  }
}

async function sign(config: AuthConfig, payload: string): Promise<string> {
  const key = await deriveHmacSha256Key(
    encoder.encode(config.sessionSecret),
    "mail-public-id",
  );
  return hmacSha256Base64Url(key, payload);
}

function validateMailPublicId(value: MailPublicId): void {
  if (!/^[0-9a-f-]{36}$/iu.test(value.connectionId)) {
    throw new TypeError("Mail connection ID is invalid");
  }
  if (!["thread", "message", "attachment", "draft", "cursor"].includes(value.type)) {
    throw new TypeError("Mail resource type is invalid");
  }
  const maximumNativeIdLength = value.type === "cursor" ? 16_384 : 4_096;
  if (!value.nativeId || value.nativeId.length > maximumNativeIdLength) {
    throw new TypeError("Native mail ID is invalid");
  }
  if (value.type === "attachment" && (!value.messageId || value.messageId.length > 4_096)) {
    throw new TypeError("Attachment message ID is invalid");
  }
  if (
    value.sizeBytes !== undefined &&
    (value.type !== "attachment" ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 0 ||
      value.sizeBytes > 150 * 1_024 * 1_024)
  ) {
    throw new TypeError("Attachment size is invalid");
  }
}
