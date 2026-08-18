import "server-only";

import type { AuthConfig } from "../config";
import type { MailConnectionRepository } from "../mail/connection-repository";
import {
  deriveHmacSha256Key,
  hmacSha256Base64Url,
} from "./crypto";
import type { RateLimitDecision } from "../mail/connection-types";

const encoder = new TextEncoder();

export async function consumeRequestRateLimit({
  action,
  config,
  maximum,
  repository,
  request,
  windowSeconds,
}: {
  action: string;
  config: AuthConfig;
  maximum: number;
  repository: Pick<MailConnectionRepository, "consumeRateLimit">;
  request: Request;
  windowSeconds: number;
}): Promise<RateLimitDecision> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new TypeError("maximum must be a positive integer");
  }
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
    throw new TypeError("windowSeconds must be a positive integer");
  }
  const now = new Date();
  const windowMilliseconds = windowSeconds * 1_000;
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds,
  );
  const expiresAt = new Date(windowStartedAt.getTime() + windowMilliseconds);
  const key = await deriveHmacSha256Key(
    encoder.encode(config.sessionSecret),
    "rate-limit",
  );
  const sourceAddress =
    request.headers.get("cf-connecting-ip")?.trim() ||
    (config.appUrl.hostname === "localhost" ? "local-development" : "unknown");
  const userAgent = request.headers.get("user-agent")?.slice(0, 512) ?? "unknown";
  const subjectDigest = await hmacSha256Base64Url(
    key,
    `${sourceAddress}|${userAgent}`,
  );
  const bucketKey = await hmacSha256Base64Url(
    key,
    `${action}|${subjectDigest}|${windowStartedAt.toISOString()}`,
  );
  return repository.consumeRateLimit({
    bucketKey,
    action,
    subjectDigest,
    maximum,
    windowStartedAt,
    expiresAt,
    now,
  });
}
