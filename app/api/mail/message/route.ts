import { jsonNoStore } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id || id.length > 8_192) throw new TypeError("Invalid message ID");
    const { service } = await createMailApiContext(request);
    const message = await service.getMessage(id);
    return message
      ? jsonNoStore({ message })
      : jsonNoStore({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return mailApiFailure(error);
  }
}
