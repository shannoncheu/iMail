import "server-only";

import type { AuthenticatedPageSession } from "../../auth/viewer";
import type { AuthConfig } from "../config";
import { AuthRepository } from "./repository";
import type { AuthenticatedOwnerSession, OwnerSession } from "./types";
import {
  isAuthenticationCookieValue,
  readCookieValue,
  resolveAuthCookiePolicy,
  type AuthCookieContext,
} from "../security/cookies";
import {
  deriveHmacSha256Key,
  hmacSha256Base64Url,
  randomBase64Url,
} from "../security/crypto";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

export type SessionRepository = Pick<
  AuthRepository,
  | "createOwnerSession"
  | "findSessionByDigest"
  | "revokeSessionByDigest"
  | "rotateOwnerSessionById"
>;

export interface AuthenticatedSession extends AuthenticatedPageSession {
  rawToken: string;
  tokenDigest: string;
  record: AuthenticatedOwnerSession;
}

export function authCookieContext(config: AuthConfig): AuthCookieContext {
  return {
    appUrl: config.appUrl,
    production: config.appUrl.protocol === "https:",
  };
}

async function sessionDigest(config: AuthConfig, rawToken: string): Promise<string> {
  const key = await deriveHmacSha256Key(
    textEncoder.encode(config.sessionSecret),
    "session",
  );
  return hmacSha256Base64Url(key, rawToken);
}

async function csrfToken(config: AuthConfig, rawToken: string): Promise<string> {
  const key = await deriveHmacSha256Key(
    textEncoder.encode(config.sessionSecret),
    "csrf",
  );
  return hmacSha256Base64Url(key, rawToken);
}

function repositoryFor(config: AuthConfig): AuthRepository {
  return new AuthRepository({ databaseUrl: config.databaseUrl });
}

export async function createOwnerSession({
  config,
  identityId,
  ownerId,
  repository = repositoryFor(config),
}: {
  config: AuthConfig;
  identityId: string;
  ownerId: string;
  repository?: SessionRepository;
}): Promise<{ rawToken: string; session: OwnerSession }> {
  const rawToken = randomBase64Url(32);
  const tokenDigest = await sessionDigest(config, rawToken);
  const session = await repository.createOwnerSession({
    ownerId,
    identityId,
    tokenDigest,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  if (!session) {
    throw new Error("Owner session could not be created");
  }
  return { rawToken, session };
}

export async function authenticateCookieHeader({
  config,
  cookieHeader,
  repository = repositoryFor(config),
}: {
  config: AuthConfig;
  cookieHeader: string | null;
  repository?: SessionRepository;
}): Promise<AuthenticatedSession | null> {
  const policy = resolveAuthCookiePolicy(authCookieContext(config));
  const rawToken = readCookieValue(cookieHeader, policy.sessionCookieName);
  if (!rawToken || !isAuthenticationCookieValue(rawToken)) return null;

  const tokenDigest = await sessionDigest(config, rawToken);
  const record = await repository.findSessionByDigest(tokenDigest);
  if (!record) return null;

  const githubIdentity = record.identities.find(
    (identity) =>
      identity.id === record.session.identityId &&
      identity.provider === "github" &&
      config.github.allowedIds.has(identity.providerSubject),
  );
  if (!githubIdentity) {
    await repository.revokeSessionByDigest(tokenDigest);
    return null;
  }

  const login = githubIdentity.providerUsername ?? githubIdentity.providerSubject;
  return {
    rawToken,
    tokenDigest,
    record,
    csrfToken: await csrfToken(config, rawToken),
    viewer: {
      id: record.owner.id,
      githubId: githubIdentity.providerSubject,
      login,
      displayName: record.owner.displayName || login,
      avatarUrl: githubIdentity.avatarUrl,
    },
  };
}

export async function rotateOwnerSessionFromId({
  config,
  previousSessionId,
  repository = repositoryFor(config),
}: {
  config: AuthConfig;
  previousSessionId: string;
  repository?: SessionRepository;
}): Promise<{ rawToken: string; session: OwnerSession }> {
  const rawToken = randomBase64Url(32);
  const tokenDigest = await sessionDigest(config, rawToken);
  const session = await repository.rotateOwnerSessionById({
    previousSessionId,
    allowedGithubIds: [...config.github.allowedIds],
    tokenDigest,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  if (!session) throw new Error("Owner session could not be rotated");
  return { rawToken, session };
}

export async function authenticateRequest({
  config,
  request,
  repository,
}: {
  config: AuthConfig;
  request: Request;
  repository?: SessionRepository;
}): Promise<AuthenticatedSession | null> {
  return authenticateCookieHeader({
    config,
    cookieHeader: request.headers.get("cookie"),
    repository,
  });
}

export async function revokeAuthenticatedSession({
  config,
  repository,
  session,
}: {
  config: AuthConfig;
  repository?: SessionRepository;
  session: AuthenticatedSession;
}): Promise<boolean> {
  const source = repository ?? repositoryFor(config);
  return source.revokeSessionByDigest(session.tokenDigest);
}
