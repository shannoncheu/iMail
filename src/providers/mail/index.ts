import type { MailProvider } from "./MailProvider";
import { ApiMailProvider } from "./ApiMailProvider";
import { MockMailProvider } from "./MockMailProvider";

export function createMailProvider(csrfToken: string): MailProvider {
  return new ApiMailProvider({ csrfToken });
}

export { ApiMailProvider, MockMailProvider };

export type {
  MailAccount,
  MailAttachment,
  MailAttachmentContent,
  MailDraft,
  MailFolder,
  MailFolderId,
  MailProvider,
  MailMessageContent,
  MailMessagePage,
  MailParticipant,
  MailThread,
  MessageLocation,
  ProviderSource,
  ThreadMessage,
} from "./MailProvider";
