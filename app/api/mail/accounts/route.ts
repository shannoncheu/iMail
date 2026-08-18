import { getAuthConfig } from "@/src/server/config";
import { AuthRepository } from "@/src/server/auth/repository";
import { authenticateRequest } from "@/src/server/auth/session";
import { jsonNoStore } from "@/src/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = getAuthConfig();
  } catch {
    return jsonNoStore({ error: "authentication_not_configured" }, { status: 503 });
  }

  try {
    const repository = new AuthRepository({ databaseUrl: config.databaseUrl });
    const session = await authenticateRequest({ config, request, repository });
    if (!session) {
      return jsonNoStore({ error: "unauthorized" }, { status: 401 });
    }

    const accounts = await repository.listSafeMailConnections(
      session.record.owner.id,
    );
    return jsonNoStore({ accounts });
  } catch {
    return jsonNoStore({ error: "mail_accounts_unavailable" }, { status: 503 });
  }
}
