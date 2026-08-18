import { jsonNoStore, readJsonBody, RequestBodyError } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import { mutateSchema } from "@/src/server/mail/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { service } = await createMailApiContext(request, {
      mutation: true,
      rateLimit: { action: "mail_mutate", maximum: 300, windowSeconds: 600 },
    });
    const body = mutateSchema.parse(await readJsonBody(request, 128 * 1_024));
    const result =
      body.action === "archive"
        ? await service.archiveMessages(body.ids)
        : body.action === "trash"
          ? await service.moveToTrash(body.ids)
          : body.action === "restoreTrash"
            ? await service.restoreFromTrash(body.ids)
            : body.action === "restore"
              ? await service.restoreMessages(body.locations)
              : body.action === "read"
                ? await service.markRead(body.ids, body.read)
                : body.action === "star"
                  ? await service.setStarred(body.id, body.starred)
                  : (() => {
                      throw new TypeError("Unsupported mail mutation");
                    })();
    return jsonNoStore(result);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return jsonNoStore({ error: error.code }, { status: error.status });
    }
    return mailApiFailure(error);
  }
}
