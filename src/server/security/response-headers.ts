const baselineHeaders = [
  [
    "Content-Security-Policy",
    "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  ],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
] as const;

export function applySecurityHeaders(
  response: Response,
  requestUrl: string | URL,
): Response {
  let securedResponse = response;
  try {
    response.headers.set("X-Content-Type-Options", "nosniff");
  } catch {
    securedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  for (const [name, value] of baselineHeaders) {
    if (!securedResponse.headers.has(name)) {
      securedResponse.headers.set(name, value);
    }
  }
  if (new URL(requestUrl).protocol === "https:") {
    securedResponse.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000",
    );
  }
  return securedResponse;
}
