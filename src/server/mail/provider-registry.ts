import "server-only";

import type {
  MailProvider,
  ProviderSource,
} from "../../providers/mail/MailProvider";
import type {
  ServerMailProviderContext,
  ServerMailProviderRegistry,
} from "./types";

const providerRegistry: ServerMailProviderRegistry = Object.freeze({
  gmail: null,
  outlook: null,
  zoho: null,
});

export class UnknownMailProviderError extends Error {
  readonly code = "UNKNOWN_MAIL_PROVIDER";

  constructor(readonly provider: string) {
    super(`Unknown mail provider: ${provider}`);
    this.name = "UnknownMailProviderError";
  }
}

export class MailProviderNotConfiguredError extends Error {
  readonly code = "MAIL_PROVIDER_NOT_CONFIGURED";

  constructor(readonly provider: ProviderSource) {
    super(`Mail provider is not configured: ${provider}`);
    this.name = "MailProviderNotConfiguredError";
  }
}

function isProviderSource(provider: string): provider is ProviderSource {
  return Object.prototype.hasOwnProperty.call(providerRegistry, provider);
}

/**
 * Resolves a provider without ever passing credentials through the caller.
 * Every provider is registered statically so unsupported and unfinished
 * integrations fail closed instead of falling back to mock data.
 */
export async function resolveServerMailProvider(
  provider: string,
  context: Readonly<ServerMailProviderContext>,
): Promise<MailProvider> {
  if (!isProviderSource(provider)) {
    throw new UnknownMailProviderError(provider);
  }

  const factory = providerRegistry[provider];
  if (factory === null) {
    throw new MailProviderNotConfiguredError(provider);
  }

  return factory(context);
}
