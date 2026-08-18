import { jsonNoStore, readJsonBody, RequestBodyError } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import { draftSchema } from "@/src/server/mail/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { service } = await createMailApiContext(request, {
      mutation: true,
      rateLimit: { action: "mail_draft", maximum: 600, windowSeconds: 600 },
    });
    const draft = draftSchema.parse(await readJsonBody(request, 9 * 1_024 * 1_024));
    return jsonNoStore(await service.saveDraft(draft));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return jsonNoStore({ error: error.code }, { status: error.status });
    }
    return mailApiFailure(error);
  }
}
