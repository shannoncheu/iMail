import { noStoreHeaders, jsonNoStore } from "@/src/server/http";
import { createMailApiContext, mailApiFailure } from "@/src/server/mail/api-context";
import { sanitizeMailHtml } from "@/src/server/mail/html-sanitizer";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const allowExternalImages = url.searchParams.get("externalImages") === "1";
    if (!id || id.length > 8_192) throw new TypeError("Invalid message ID");
    const { service } = await createMailApiContext(request);
    const content = await service.getRawMessageContent(id);
    if (!content) return jsonNoStore({ error: "not_found" }, { status: 404 });
    const safeContent =
      content.contentType === "text/html"
        ? sanitizeMailHtml(content.content, { allowExternalImages })
        : `<pre>${escapeHtml(content.content)}</pre>`;
    const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>html{font:14px/1.55 system-ui,sans-serif}body{margin:0;padding:16px;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{padding:4px;vertical-align:top}pre{white-space:pre-wrap}blockquote{margin-left:0;padding-left:12px;border-left:3px solid #999}</style></head><body>${safeContent}</body></html>`;
    if (new TextEncoder().encode(document).byteLength > 5 * 1_024 * 1_024) {
      return jsonNoStore({ error: "message_content_too_large" }, { status: 413 });
    }
    const headers = noStoreHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'none'",
        "connect-src 'none'",
        `img-src data:${allowExternalImages ? " https:" : ""}`,
        "style-src 'unsafe-inline'",
        "font-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
        "sandbox",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    return new Response(document, { headers });
  } catch (error) {
    return mailApiFailure(error);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
