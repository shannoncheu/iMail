import "server-only";

import type {
  EncryptedSecretEnvelope,
  MailConnectionProvider,
  MailConnectionStatus,
  SafeMailConnection,
} from "../auth/types";

export interface MailCredentialBundle {
  accessToken: string;
  refreshToken: string | null;
  tokenType: "Bearer";
  scopes: string[];
  expiresAt: string | null;
}

export interface StoredMailConnection extends SafeMailConnection {
  credentials: EncryptedSecretEnvelope | null;
  accessExpiresAt: Date | null;
  tokenVersion: number;
  providerMetadata: Record<string, unknown>;
  lastErrorCode: string | null;
}

export interface MailOAuthTransaction {
  id: string;
  ownerId: string;
  sessionId: string;
  provider: MailConnectionProvider;
  stateDigest: string;
  browserBindingDigest: string;
  codeVerifierEnvelope: EncryptedSecretEnvelope;
  redirectUri: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateMailOAuthTransactionInput {
  id?: string;
  ownerId: string;
  sessionId: string;
  provider: MailConnectionProvider;
  stateDigest: string;
  browserBindingDigest: string;
  codeVerifierEnvelope: EncryptedSecretEnvelope;
  redirectUri: string;
  returnTo?: string;
  createdAt?: Date;
  expiresAt: Date;
}

export interface ConsumeMailOAuthTransactionInput {
  provider: MailConnectionProvider;
  stateDigest: string;
  browserBindingDigest: string;
  consumedAt?: Date;
}

export interface UpsertMailConnectionInput {
  id: string;
  ownerId: string;
  provider: MailConnectionProvider;
  providerAccountId: string;
  emailAddress: string;
  label: string;
  status?: Extract<MailConnectionStatus, "connected" | "error">;
  scopes: string[];
  credentials: EncryptedSecretEnvelope;
  accessExpiresAt?: Date | null;
  providerMetadata?: Record<string, unknown>;
  lastErrorCode?: string | null;
  /** Required when replacing an existing row; null only permits a fresh insert. */
  expectedTokenVersion?: number | null;
  connectedAt?: Date;
}

export interface UpdateMailCredentialsInput {
  id: string;
  ownerId: string;
  expectedTokenVersion: number;
  refreshLeaseId: string;
  credentials: EncryptedSecretEnvelope;
  scopes: string[];
  accessExpiresAt?: Date | null;
  providerMetadata?: Record<string, unknown>;
  refreshedAt?: Date;
}

export interface AcquireMailRefreshLeaseInput {
  id: string;
  ownerId: string;
  expectedTokenVersion: number;
  leaseId: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}
