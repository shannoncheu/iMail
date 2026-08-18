import { handleMaintenancePost } from "@/src/server/maintenance";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleMaintenancePost(request);
}
