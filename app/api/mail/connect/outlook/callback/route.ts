import { handleMailConnectCallback } from "@/src/server/mail/connect-routes";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleMailConnectCallback("outlook", request);
}
