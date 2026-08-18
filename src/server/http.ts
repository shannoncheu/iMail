import "server-only";

export function noStoreHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  return headers;
}

export function jsonNoStore(
  body: unknown,
  { status = 200, headers: initial }: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = noStoreHeaders(initial);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirectNoStore(
  location: string,
  { status = 303, headers: initial }: { status?: 302 | 303 | 307 | 308; headers?: HeadersInit } = {},
): Response {
  const headers = noStoreHeaders(initial);
  headers.set("Location", location);
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status, headers });
}
