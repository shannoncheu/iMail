import "server-only";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_APPLICATIONS_URL = "https://api.github.com/applications";

export interface GitHubOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface GitHubIdentity {
  id: string;
  login: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export class GitHubOAuthError extends Error {
  readonly code = "GITHUB_OAUTH_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

export function buildGitHubAuthorizationUrl({
  clientId,
  callbackUrl,
  state,
  codeChallenge,
}: {
  clientId: string;
  callbackUrl: string;
  state: string;
  codeChallenge: string;
}): URL {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

function optionalString(value: unknown, maximumLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new GitHubOAuthError("GitHub returned an invalid user profile");
  }
  const normalized = value.trim();
  return normalized || null;
}

async function revokeGitHubAccessToken(
  config: GitHubOAuthClientConfig,
  accessToken: string,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
  const response = await fetchImplementation(
    `${GITHUB_APPLICATIONS_URL}/${encodeURIComponent(config.clientId)}/token`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        "User-Agent": "iMail",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
      redirect: "error",
    },
  );
  if (response.status !== 204) {
    throw new GitHubOAuthError("GitHub access token could not be revoked");
  }
}

export async function exchangeGitHubCodeForIdentity({
  config,
  code,
  codeVerifier,
  fetchImplementation = fetch,
}: {
  config: GitHubOAuthClientConfig;
  code: string;
  codeVerifier: string;
  fetchImplementation?: typeof fetch;
}): Promise<GitHubIdentity> {
  if (!code || code.length > 512) {
    throw new GitHubOAuthError("GitHub returned an invalid authorization code");
  }

  const tokenResponse = await fetchImplementation(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "iMail",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: codeVerifier,
    }),
    redirect: "error",
  });

  if (!tokenResponse.ok) {
    throw new GitHubOAuthError("GitHub rejected the authorization code");
  }

  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  const accessToken = tokenPayload.access_token;
  const tokenType = tokenPayload.token_type;
  const grantedScope = tokenPayload.scope;
  if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 512) {
    throw new GitHubOAuthError("GitHub did not return an identity-only access token");
  }

  try {
    if (
      typeof tokenType !== "string" ||
      tokenType.toLowerCase() !== "bearer" ||
      typeof grantedScope !== "string" ||
      grantedScope !== ""
    ) {
      throw new GitHubOAuthError("GitHub did not return an identity-only access token");
    }

    const userResponse = await fetchImplementation(GITHUB_USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "iMail",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
    });

    if (!userResponse.ok) {
      throw new GitHubOAuthError("GitHub could not verify the user identity");
    }

    const user = (await userResponse.json()) as Record<string, unknown>;
    if (
      typeof user.id !== "number" ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      typeof user.login !== "string" ||
      !/^[A-Za-z0-9-]{1,39}$/u.test(user.login)
    ) {
      throw new GitHubOAuthError("GitHub returned an invalid user identity");
    }

    const login = user.login;
    return {
      id: String(user.id),
      login,
      displayName: optionalString(user.name, 200) ?? login,
      email: optionalString(user.email, 320),
      avatarUrl: optionalString(user.avatar_url, 2_048),
    };
  } finally {
    await revokeGitHubAccessToken(config, accessToken, fetchImplementation);
  }
}
