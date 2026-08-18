import { getConfiguredMailProviders } from "@/src/server/config";
import { jsonNoStore } from "@/src/server/http";
import {
  createMailApiContext,
  mailApiFailure,
} from "@/src/server/mail/api-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { service } = await createMailApiContext(request);
    return jsonNoStore({
      accounts: await service.getAccounts(),
      availableProviders: getConfiguredMailProviders(),
    });
  } catch (error) {
    return mailApiFailure(error);
  }
}
