import "server-only";

import { jsonNoStore } from "./http";
import { getAuthConfig, type AuthConfig } from "./config";
import { MailConnectionRepository } from "./mail/connection-repository";
import { revokeMailConnectionCredentials } from "./mail/revoke-connection";
import { getRuntimeString } from "./runtime-env";
import { constantTimeEqual } from "./security/crypto";

const dummyMaintenanceSecret = "0".repeat(64);
const bearerSecretPattern = /^[\x21-\x2b\x2d-\x7e]{32,1024}$/u;

type ExpiredCleanupResult = Awaited<
  ReturnType<MailConnectionRepository["cleanupExpired"]>
>;
export type MaintenanceCleanupResult = ExpiredCleanupResult & {
  providerRevocations: {
    attempted: number;
    completed: number;
    pending: number;
  };
};

type CleanupRepository = Pick<MailConnectionRepository, "cleanupExpired"> &
  Partial<
    Pick<
      MailConnectionRepository,
      | "claimRevocationPending"
      | "releaseRevocationClaim"
      | "finalizeRevocationClaim"
    >
  >;

export interface MaintenanceCleanupOptions {
  databaseUrl: string;
  now?: Date;
  repository?: CleanupRepository;
  config?: AuthConfig;
  revokeCredentials?: typeof revokeMailConnectionCredentials;
}

export interface MaintenanceRouteDependencies {
  getRuntimeValue?: (name: "DATABASE_URL" | "MAINTENANCE_SECRET") =>
    | string
    | undefined;
  now?: () => Date;
  runCleanup?: (
    options: Omit<MaintenanceCleanupOptions, "repository">,
  ) => Promise<MaintenanceCleanupResult>;
}

/** Shared by the authenticated route and the Worker's Cron Trigger. */
export async function runMaintenanceCleanup({
  databaseUrl,
  now = new Date(),
  repository,
  config,
  revokeCredentials = revokeMailConnectionCredentials,
}: MaintenanceCleanupOptions): Promise<MaintenanceCleanupResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Maintenance time must be a valid date");
  }

  const cleanupRepository =
    repository ?? new MailConnectionRepository({ databaseUrl });
  const cleaned = await cleanupRepository.cleanupExpired(now);
  const providerRevocations = { attempted: 0, completed: 0, pending: 0 };
  if (
    cleanupRepository.claimRevocationPending &&
    cleanupRepository.releaseRevocationClaim &&
    cleanupRepository.finalizeRevocationClaim
  ) {
    const authConfig = config ?? getAuthConfig();
    const pending = await cleanupRepository.claimRevocationPending(25);
    for (const connection of pending) {
      providerRevocations.attempted += 1;
      const status = await revokeCredentials({
        config: authConfig,
        connection,
      });
      if (
        status !== "failed" &&
        (await cleanupRepository.finalizeRevocationClaim(
          connection.ownerId,
          connection.id,
          connection.tokenVersion,
        ))
      ) {
        providerRevocations.completed += 1;
      } else {
        if (status === "failed") {
          await cleanupRepository.releaseRevocationClaim(
            connection.ownerId,
            connection.id,
            connection.tokenVersion,
          );
        }
        providerRevocations.pending += 1;
      }
    }
  }
  return { ...cleaned, providerRevocations };
}

function bearerSecret(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s,\u0000-\u001f\u007f]{1,1024})$/iu.exec(
    authorization,
  );
  return match?.[1] ?? "";
}

function unauthorized(): Response {
  return jsonNoStore(
    { error: "unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="maintenance"' },
    },
  );
}

export async function handleMaintenancePost(
  request: Request,
  dependencies: MaintenanceRouteDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonNoStore(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const getRuntimeValue = dependencies.getRuntimeValue ?? getRuntimeString;
  const configuredSecret = getRuntimeValue("MAINTENANCE_SECRET") ?? "";
  const secretIsConfigured = bearerSecretPattern.test(configuredSecret);
  const submittedSecret = bearerSecret(request);
  const secretMatches = constantTimeEqual(
    submittedSecret,
    secretIsConfigured ? configuredSecret : dummyMaintenanceSecret,
  );

  if (!secretIsConfigured || !secretMatches) {
    return unauthorized();
  }

  const databaseUrl = getRuntimeValue("DATABASE_URL")?.trim();
  if (!databaseUrl) {
    return jsonNoStore(
      { error: "maintenance_unavailable" },
      { status: 503 },
    );
  }

  const now = dependencies.now?.() ?? new Date();
  const runCleanup = dependencies.runCleanup ?? runMaintenanceCleanup;
  try {
    const cleaned = await runCleanup({ databaseUrl, now });
    return jsonNoStore({ ok: true, cleaned });
  } catch {
    return jsonNoStore(
      { error: "maintenance_unavailable" },
      { status: 503 },
    );
  }
}
