const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type CryptoInput = string | Uint8Array;

export interface AesGcmEnvelope {
  algorithm: "A256GCM";
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

function toBytes(value: CryptoInput): Uint8Array {
  return typeof value === "string" ? textEncoder.encode(value) : Uint8Array.from(value);
}

function toBufferSource(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid unpadded base64url value");
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("Invalid unpadded base64url value");
  }

  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(decoded) !== value) {
    throw new TypeError("Non-canonical base64url value");
  }

  return decoded;
}

export function randomBytes(byteLength = 32): Uint8Array {
  assertPositiveInteger(byteLength, "byteLength");
  if (byteLength > 65_536) {
    throw new RangeError("byteLength cannot exceed 65536 bytes");
  }

  return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function randomBase64Url(byteLength = 32): string {
  return encodeBase64Url(randomBytes(byteLength));
}

export async function sha256(value: CryptoInput): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toBufferSource(toBytes(value)));
  return new Uint8Array(digest);
}

export async function sha256Base64Url(value: CryptoInput): Promise<string> {
  return encodeBase64Url(await sha256(value));
}

export async function importHmacSha256Key(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength < 32) {
    throw new TypeError("HMAC-SHA-256 keys must contain at least 32 bytes");
  }

  return crypto.subtle.importKey(
    "raw",
    toBufferSource(rawKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function deriveHmacSha256Key(
  masterKey: Uint8Array,
  purpose: string,
): Promise<CryptoKey> {
  if (masterKey.byteLength < 32) {
    throw new TypeError("The master key must contain at least 32 bytes");
  }
  if (!purpose || purpose.length > 128) {
    throw new TypeError("A non-empty purpose of at most 128 characters is required");
  }

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBufferSource(new Uint8Array(32)),
      info: toBufferSource(textEncoder.encode(`imail:${purpose}`)),
    },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

export async function hmacSha256(
  key: CryptoKey,
  value: CryptoInput,
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toBufferSource(toBytes(value)),
  );
  return new Uint8Array(signature);
}

export async function hmacSha256Base64Url(
  key: CryptoKey,
  value: CryptoInput,
): Promise<string> {
  return encodeBase64Url(await hmacSha256(key, value));
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
    throw new TypeError("PKCE verifier must be 43-128 unreserved ASCII characters");
  }

  return sha256Base64Url(verifier);
}

export async function createPkcePair(): Promise<{
  challenge: string;
  method: "S256";
  verifier: string;
}> {
  const verifier = randomBase64Url(32);
  return {
    challenge: await pkceS256Challenge(verifier),
    method: "S256",
    verifier,
  };
}

export async function importAes256GcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== 32) {
    throw new TypeError("AES-256-GCM keys must contain exactly 32 bytes");
  }

  return crypto.subtle.importKey(
    "raw",
    toBufferSource(rawKey),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptAes256Gcm(
  key: CryptoKey,
  plaintext: CryptoInput,
  aad: CryptoInput,
  keyVersion = 1,
): Promise<AesGcmEnvelope> {
  assertPositiveInteger(keyVersion, "keyVersion");
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(iv),
      additionalData: toBufferSource(toBytes(aad)),
      tagLength: 128,
    },
    key,
    toBufferSource(toBytes(plaintext)),
  );

  return {
    algorithm: "A256GCM",
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    iv: encodeBase64Url(iv),
    keyVersion,
  };
}

export async function decryptAes256Gcm(
  key: CryptoKey,
  envelope: AesGcmEnvelope,
  aad: CryptoInput,
): Promise<Uint8Array> {
  if (envelope.algorithm !== "A256GCM") {
    throw new TypeError("Unsupported encryption algorithm");
  }
  assertPositiveInteger(envelope.keyVersion, "keyVersion");

  const iv = decodeBase64Url(envelope.iv);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  if (iv.byteLength !== 12) {
    throw new TypeError("AES-GCM IV must contain exactly 12 bytes");
  }
  if (ciphertext.byteLength < 16) {
    throw new TypeError("AES-GCM ciphertext must include a 128-bit authentication tag");
  }

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(iv),
      additionalData: toBufferSource(toBytes(aad)),
      tagLength: 128,
    },
    key,
    toBufferSource(ciphertext),
  );

  return new Uint8Array(plaintext);
}

export async function decryptAes256GcmText(
  key: CryptoKey,
  envelope: AesGcmEnvelope,
  aad: CryptoInput,
): Promise<string> {
  return textDecoder.decode(await decryptAes256Gcm(key, envelope, aad));
}

export function constantTimeEqual(left: CryptoInput, right: CryptoInput): boolean {
  const leftBytes = toBytes(left);
  const rightBytes = toBytes(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}
