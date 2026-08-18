import { jsonNoStore } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id || id.length > 8_192) throw new TypeError("Invalid draft ID");
    const { service } = await createMailApiContext(request);
    const draft = await service.getDraft(id);
    return draft
      ? jsonNoStore({ draft })
      : jsonNoStore({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return mailApiFailure(error);
  }
}
