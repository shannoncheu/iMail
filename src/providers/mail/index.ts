import type { MailProvider } from "./MailProvider";
import { MockMailProvider } from "./MockMailProvider";

let mockProvider: MailProvider | null = null;

export function createMailProvider(): MailProvider {
  mockProvider ??= new MockMailProvider();
  return mockProvider;
}

export type {
  MailAccount,
  MailAttachment,
  MailDraft,
  MailFolder,
  MailFolderId,
  MailProvider,
  MailThread,
  MessageLocation,
  ProviderSource,
  ThreadMessage,
} from "./MailProvider";
