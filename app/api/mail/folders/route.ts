import { jsonNoStore } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import { mailScopeQuerySchema } from "@/src/server/mail/api-schemas";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const { scope, accountId } = mailScopeQuerySchema.parse({
      scope: url.searchParams.get("scope") ?? "all",
      accountId: url.searchParams.get("accountId") ?? undefined,
    });
    const { service } = await createMailApiContext(request);
    return jsonNoStore({ folders: await service.getFolders(scope, accountId) });
  } catch (error) {
    return mailApiFailure(error);
  }
}
