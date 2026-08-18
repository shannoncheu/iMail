import { handleMailConnectStart } from "@/src/server/mail/connect-routes";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleMailConnectStart("zoho", request);
}
