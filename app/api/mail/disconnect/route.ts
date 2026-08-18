import { z } from "zod";
import { jsonNoStore, readJsonBody, RequestBodyError } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import { revokeMailConnectionCredentials } from "@/src/server/mail/revoke-connection";

export const dynamic = "force-dynamic";
const schema = z.object({ accountId: z.string().uuid() });

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await createMailApiContext(request, {
      mutation: true,
      rateLimit: { action: "mail_disconnect", maximum: 10, windowSeconds: 600 },
    });
    const { accountId } = schema.parse(await readJsonBody(request, 8_192));
    const connection = await context.connections.findById(
      context.session.record.owner.id,
      accountId,
    );
    if (!connection) return jsonNoStore({ error: "not_found" }, { status: 404 });
    const claimed = await context.connections.claimConnectionForRevocation(
      context.session.record.owner.id,
      accountId,
      connection.tokenVersion,
    );
    if (!claimed) {
      return jsonNoStore({ error: "connection_changed" }, { status: 409 });
    }
    const providerRevocation = await revokeMailConnectionCredentials({
      config: context.config,
      connection: claimed,
    });
    const disconnected =
      providerRevocation === "failed"
        ? await context.connections.releaseRevocationClaim(
            context.session.record.owner.id,
            accountId,
            claimed.tokenVersion,
          )
        : await context.connections.finalizeRevocationClaim(
            context.session.record.owner.id,
            accountId,
            claimed.tokenVersion,
          );
    return disconnected
      ? jsonNoStore(
          {
            disconnected: true,
            providerRevocation:
              providerRevocation === "failed" ? "pending" : providerRevocation,
          },
          { status: providerRevocation === "failed" ? 202 : 200 },
        )
      : jsonNoStore({ error: "connection_changed" }, { status: 409 });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return jsonNoStore({ error: error.code }, { status: error.status });
    }
    return mailApiFailure(error);
  }
}
