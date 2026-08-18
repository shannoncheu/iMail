import { noStoreHeaders, jsonNoStore } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id || id.length > 8_192) throw new TypeError("Invalid attachment ID");
    const { service } = await createMailApiContext(request);
    const attachment = await service.getAttachment(id);
    if (!attachment) return jsonNoStore({ error: "not_found" }, { status: 404 });
    if (attachment.data.byteLength > 25 * 1_024 * 1_024) {
      return jsonNoStore({ error: "attachment_too_large" }, { status: 413 });
    }
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/u.test(attachment.mimeType)
      ? attachment.mimeType
      : "application/octet-stream";
    const filename = attachment.filename.replace(/[\r\n]/gu, "").slice(0, 255);
    const headers = noStoreHeaders({
      "Content-Type": mimeType,
      "Content-Length": String(attachment.data.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    const body =
      attachment.data.byteOffset === 0 &&
      attachment.data.byteLength === attachment.data.buffer.byteLength
        ? (attachment.data.buffer as ArrayBuffer)
        : (attachment.data.slice().buffer as ArrayBuffer);
    return new Response(body, { headers });
  } catch (error) {
    return mailApiFailure(error);
  }
}
