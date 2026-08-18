import "server-only";

import type {
  MailProvider,
  ProviderSource,
} from "../../providers/mail/MailProvider";

/**
 * Non-secret identifiers a server adapter can use to load its own account
 * connection. Credentials deliberately stay behind the adapter boundary.
 */
export interface ServerMailProviderContext {
  accountId: string;
  ownerId: string;
}

export type ServerMailProviderFactory = (
  context: Readonly<ServerMailProviderContext>,
) => MailProvider | Promise<MailProvider>;

export type ServerMailProviderRegistry = Readonly<
  Record<ProviderSource, ServerMailProviderFactory | null>
>;
