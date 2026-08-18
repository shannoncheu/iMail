export interface AuthenticatedViewer {
  id: string;
  githubId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthenticatedPageSession {
  viewer: AuthenticatedViewer;
  csrfToken: string;
}
