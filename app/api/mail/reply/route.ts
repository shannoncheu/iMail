import { z } from "zod";
import { jsonNoStore, readJsonBody, RequestBodyError } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import { draftSchema } from "@/src/server/mail/api-schemas";

export const dynamic = "force-dynamic";
const schema = z.object({ id: z.string().min(1).max(8_192), draft: draftSchema });

export async function POST(request: Request): Promise<Response> {
  try {
    const { service } = await createMailApiContext(request, {
      mutation: true,
      rateLimit: { action: "mail_reply", maximum: 60, windowSeconds: 600 },
    });
    const body = schema.parse(await readJsonBody(request, 9 * 1_024 * 1_024));
    return jsonNoStore(await service.replyMessage(body.id, body.draft));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return jsonNoStore({ error: error.code }, { status: error.status });
    }
    return mailApiFailure(error);
  }
}
