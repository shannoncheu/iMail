import { jsonNoStore } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import {
  folderSchema,
  mailScopeQuerySchema,
  mailSearchSchema,
} from "@/src/server/mail/api-schemas";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const { scope, accountId } = mailScopeQuerySchema.parse({
      scope: url.searchParams.get("scope") ?? "all",
      accountId: url.searchParams.get("accountId") ?? undefined,
    });
    const folder = folderSchema.parse(url.searchParams.get("folder") ?? "inbox");
    const searchValue = url.searchParams.get("search");
    const search =
      searchValue === null ? undefined : mailSearchSchema.parse(searchValue) || undefined;
    const cursor = url.searchParams.get("cursor")?.slice(0, 24_000) || undefined;
    const requestedPageSize = Number(url.searchParams.get("pageSize") ?? 50);
    if (!Number.isSafeInteger(requestedPageSize)) throw new TypeError("Invalid page size");
    const { service } = await createMailApiContext(request);
    const page = await service.getMessagesPage({
      scope,
      accountId,
      folder,
      search,
      cursor,
      pageSize: Math.min(100, Math.max(1, requestedPageSize)),
    });
    return jsonNoStore(page);
  } catch (error) {
    return mailApiFailure(error);
  }
}
