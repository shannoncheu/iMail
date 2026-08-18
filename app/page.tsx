import { headers } from "next/headers";
import CommunicationHub from "./communication-hub";
import { LoginView } from "./login-view";
import { getAuthConfig } from "@/src/server/config";
import { authenticateCookieHeader } from "@/src/server/auth/session";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams: Promise<{ auth_error?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const requestedError = Array.isArray(params.auth_error)
    ? params.auth_error[0]
    : params.auth_error;

  let config;
  try {
    config = getAuthConfig();
  } catch {
    return <LoginView configured={false} errorCode={requestedError} />;
  }

  const requestHeaders = await headers();
  let session;
  try {
    session = await authenticateCookieHeader({
      config,
      cookieHeader: requestHeaders.get("cookie"),
    });
  } catch {
    return <LoginView configured errorCode="service_unavailable" />;
  }

  if (session) {
    return (
      <CommunicationHub viewer={session.viewer} csrfToken={session.csrfToken} />
    );
  }

  return <LoginView configured errorCode={requestedError} />;
}
