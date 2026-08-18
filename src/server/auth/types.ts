export const AUTH_PROVIDERS = [
  "github",
  "google",
  "microsoft",
  "zoho",
] as const;

export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const MAIL_CONNECTION_PROVIDERS = [
  "gmail",
  "outlook",
  "zoho",
] as const;

export type MailConnectionProvider =
  (typeof MAIL_CONNECTION_PROVIDERS)[number];

export type MailConnectionStatus =
  | "pending"
  | "connected"
  | "error"
  | "disconnected"
  | "revoked";

export type SecurityEventSeverity =
  | "info"
  | "warning"
  | "error"
  | "critical";

export interface Owner {
  id: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
  lastAuthenticatedAt: Date | null;
  disabledAt: Date | null;
}

export interface OwnerIdentity {
  id: string;
  ownerId: string;
  provider: AuthProvider;
  providerSubject: string;
  providerUsername: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt: Date;
}

export interface OAuthTransaction {
  id: string;
  provider: AuthProvider;
  stateDigest: string;
  browserBindingDigest: string;
  codeVerifierEnvelope: EncryptedSecretEnvelope;
  redirectUri: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface EncryptedSecretEnvelope {
  algorithm: "A256GCM";
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

export interface OwnerSession {
  id: string;
  ownerId: string;
  identityId: string;
  rotatedFromSessionId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface AuthenticatedOwnerSession {
  session: OwnerSession;
  owner: Owner;
  identities: OwnerIdentity[];
}

export interface SafeMailConnection {
  id: string;
  ownerId: string;
  provider: MailConnectionProvider;
  providerAccountId: string;
  emailAddress: string;
  label: string;
  status: MailConnectionStatus;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  connectedAt: Date | null;
  lastRefreshedAt: Date | null;
  disconnectedAt: Date | null;
}

export interface SecurityEvent {
  id: string;
  ownerId: string | null;
  eventType: string;
  severity: SecurityEventSeverity;
  requestId: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export interface CreateOAuthTransactionInput {
  id?: string;
  provider: AuthProvider;
  stateDigest: string;
  browserBindingDigest: string;
  codeVerifierEnvelope: EncryptedSecretEnvelope;
  redirectUri: string;
  returnTo?: string;
  createdAt?: Date;
  expiresAt: Date;
}

export interface ConsumeOAuthTransactionInput {
  provider: AuthProvider;
  stateDigest: string;
  browserBindingDigest: string;
  consumedAt?: Date;
}

export interface UpsertOwnerIdentityInput {
  ownerId?: string;
  identityId?: string;
  provider: AuthProvider;
  providerSubject: string;
  providerUsername?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  displayName: string;
  verifiedAt?: Date;
}

export interface CreateOwnerSessionInput {
  id?: string;
  ownerId: string;
  identityId: string;
  tokenDigest: string;
  createdAt?: Date;
  expiresAt: Date;
  ipHash?: string | null;
  userAgentHash?: string | null;
}

export interface RotateOwnerSessionInput
  extends Omit<CreateOwnerSessionInput, "ownerId" | "identityId"> {
  previousTokenDigest: string;
}

export interface RotateOwnerSessionByIdInput
  extends Omit<CreateOwnerSessionInput, "ownerId" | "identityId"> {
  previousSessionId: string;
  allowedGithubIds: readonly string[];
}

export interface RecordSecurityEventInput {
  id?: string;
  ownerId?: string | null;
  eventType: string;
  severity?: SecurityEventSeverity;
  requestId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}
