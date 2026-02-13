export interface ConnectedSsoSession {
  // Name of the sso-session from ~/.aws/config 
  ssoSession: string;
  // Region where the SSO OIDC/SSO APIs should be called.
  ssoRegion: string;
  // SSO access token obtained via the device flow.
  accessToken: string;
  // When the access token expires.
  expiresAt?: Date;
}

// Very simple in-memory store keyed by a client-provided session id.
// In a real deployment you would likely replace this with a more
// durable/session-aware mechanism.
const store = new Map<string, ConnectedSsoSession>();

export function setSsoSession(
  sessionId: string,
  session: ConnectedSsoSession
): void {
  store.set(sessionId, session);
}

export function getSsoSession(
  sessionId: string
): ConnectedSsoSession | undefined {
  const value = store.get(sessionId);
  if (!value) return undefined;

  if (value.expiresAt && value.expiresAt.getTime() <= Date.now()) {
    store.delete(sessionId);
    return undefined;
  }

  return value;
}


