import "server-only";

import { z } from "zod";

import { AuthRepository } from "../auth/repository";
import { authenticateRequest, type AuthenticatedSession } from "../auth/session";
import { getAuthConfig, type AuthConfig } from "../config";
import { jsonNoStore } from "../http";
import { validateCsrfProtectedMutation } from "../security/request-security";
import { consumeRequestRateLimit } from "../security/rate-limit";
import { MailConnectionRepository } from "./connection-repository";
import { MailDraftIntentRepository } from "./draft-intent-repository";
import { MailService } from "./mail-service";
import { MailPaginationRepository } from "./pagination-repository";
import { resolveServerMailProvider } from "./provider-registry";

export interface MailApiContext {
  config: AuthConfig;
  connections: MailConnectionRepository;
  service: MailService;
  session: AuthenticatedSession;
}

export class MailApiContextError extends Error {
  constructor(
    readonly response: Response,
  ) {
    super("Mail API request was rejected");
    this.name = "MailApiContextError";
  }
}

export async function createMailApiContext(
  request: Request,
  options: {
    mutation?: boolean;
    rateLimit?: { action: string; maximum: number; windowSeconds: number };
  } = {},
): Promise<MailApiContext> {
  let config: AuthConfig;
  try {
    config = getAuthConfig();
  } catch {
    throw new MailApiContextError(
      jsonNoStore({ error: "authentication_not_configured" }, { status: 503 }),
    );
  }
  try {
    const authRepository = new AuthRepository({ databaseUrl: config.databaseUrl });
    const session = await authenticateRequest({
      config,
      request,
      repository: authRepository,
    });
    if (!session) {
      throw new MailApiContextError(
        jsonNoStore({ error: "unauthorized" }, { status: 401 }),
      );
    }
    if (options.mutation) {
      const security = validateCsrfProtectedMutation(request, {
        appUrl: config.appUrl,
        expectedCsrfToken: session.csrfToken,
        requireFetchMetadata: true,
        requireJson: true,
      });
      if (!security.ok) {
        throw new MailApiContextError(
          jsonNoStore({ error: security.code }, { status: security.status }),
        );
      }
    }
    const connections = new MailConnectionRepository({
      databaseUrl: config.databaseUrl,
    });
    const pagination = new MailPaginationRepository({
      databaseUrl: config.databaseUrl,
    });
    const draftIntents = new MailDraftIntentRepository({
      databaseUrl: config.databaseUrl,
    });
    if (options.rateLimit) {
      const decision = await consumeRequestRateLimit({
        ...options.rateLimit,
        config,
        repository: connections,
        request,
      });
      if (!decision.allowed) {
        throw new MailApiContextError(
          jsonNoStore(
            { error: "rate_limited" },
            {
              status: 429,
              headers: { "Retry-After": String(decision.retryAfterSeconds) },
            },
          ),
        );
      }
    }
    return {
      config,
      connections,
      session,
      service: new MailService({
        config,
        ownerId: session.record.owner.id,
        repository: connections,
        paginationRepository: pagination,
        draftIntentRepository: draftIntents,
        resolveProvider: resolveServerMailProvider,
      }),
    };
  } catch (error) {
    if (error instanceof MailApiContextError) throw error;
    throw new MailApiContextError(
      jsonNoStore({ error: "mail_service_unavailable" }, { status: 503 }),
    );
  }
}

export function mailApiFailure(error: unknown): Response {
  if (error instanceof MailApiContextError) return error.response;
  if (error instanceof TypeError || error instanceof z.ZodError) {
    return jsonNoStore({ error: "invalid_request" }, { status: 400 });
  }
  return jsonNoStore({ error: "mail_service_unavailable" }, { status: 503 });
}
