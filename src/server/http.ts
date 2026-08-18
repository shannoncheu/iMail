import "server-only";

const textDecoder = new TextDecoder();

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

export class RequestBodyError extends Error {
  constructor(
    readonly code: "body_too_large" | "invalid_json" | "body_unavailable",
    readonly status: 400 | 413,
  ) {
    super(code);
    this.name = "RequestBodyError";
  }
}

export async function readJsonBody(
  request: Request,
  maximumBytes = 16_384,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestBodyError("body_too_large", 413);
  }
  try {
    return JSON.parse(await readLimitedRequestText(request.body, maximumBytes));
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("invalid_json", 400);
  }
}

async function readLimitedRequestText(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("maximumBytes must be a positive integer");
  }
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("body_too_large");
        throw new RequestBodyError("body_too_large", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("body_unavailable", 400);
  } finally {
    reader.releaseLock();
  }
}

export async function readLimitedResponseText(
  response: Response,
  maximumBytes = 1_048_576,
): Promise<string> {
  return textDecoder.decode(await readLimitedStream(response.body, maximumBytes));
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("maximumBytes must be a positive integer");
  }
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("body_too_large");
        throw new RequestBodyError("body_too_large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("body_unavailable", 400);
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
