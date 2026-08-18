import { ChevronRight, LockKeyhole } from "lucide-react";

const errorMessages: Record<string, string> = {
  access_denied: "This GitHub account is not allowed to use this workspace.",
  oauth_failed: "GitHub sign-in could not be completed. Please try again.",
  transaction_expired: "The sign-in request expired. Please start again.",
  service_unavailable: "Authentication is temporarily unavailable. Please try again later.",
};

export function LoginView({
  configured,
  errorCode,
}: {
  configured: boolean;
  errorCode?: string;
}) {
  const errorMessage = errorCode ? errorMessages[errorCode] : undefined;

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark large" aria-hidden="true">
            <span />
            <i />
          </span>
          <span>iMail</span>
        </div>
        <div className="login-copy">
          <span className="private-badge">
            <LockKeyhole size={13} /> Owner-only workspace
          </span>
          <h1 id="login-title">All your mail. One calm workspace.</h1>
          <p>
            Connect Gmail, Outlook, and Zoho after signing in with the approved
            GitHub identity. There is no public registration.
          </p>
        </div>
        {errorMessage ? (
          <p className="compose-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <form action="/api/auth/github/start" method="post" className="login-options">
          <input type="hidden" name="returnTo" value="/" />
          <button type="submit" disabled={!configured}>
            <span className="github-mark">GH</span>
            Continue with GitHub
            <ChevronRight size={16} />
          </button>
        </form>
        <p className="login-footnote">
          {configured
            ? "GitHub is used only to verify the owner identity. Repository access is not requested."
            : "Authentication is not configured on this deployment."}
        </p>
      </section>
    </main>
  );
}

