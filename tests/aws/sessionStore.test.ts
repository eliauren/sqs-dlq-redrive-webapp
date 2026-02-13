import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  setSsoSession,
  getSsoSession,
  type ConnectedSsoSession,
} from "../../src/aws/sessionStore";

describe("sessionStore", () => {
  const SESSION_ID = "sess-abc";

  const session: ConnectedSsoSession = {
    ssoSession: "my-sso",
    ssoRegion: "eu-west-1",
    accessToken: "token-xyz",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should store and retrieve a session", () => {
    setSsoSession(SESSION_ID, session);
    const result = getSsoSession(SESSION_ID);

    expect(result).toBeDefined();
    expect(result!.accessToken).toBe("token-xyz");
    expect(result!.ssoRegion).toBe("eu-west-1");
  });

  it("should return undefined for unknown session id", () => {
    const result = getSsoSession("non-existent");
    expect(result).toBeUndefined();
  });

  it("should return undefined and delete expired sessions", () => {
    const expiringSoon: ConnectedSsoSession = {
      ...session,
      expiresAt: new Date(Date.now() + 1000), // 1 second from now
    };

    setSsoSession(SESSION_ID, expiringSoon);

    // Advance time past expiration
    vi.advanceTimersByTime(2000);

    const result = getSsoSession(SESSION_ID);
    expect(result).toBeUndefined();
  });

  it("should return session when not yet expired", () => {
    setSsoSession(SESSION_ID, session);

    // Advance time but stay within TTL
    vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes

    const result = getSsoSession(SESSION_ID);
    expect(result).toBeDefined();
    expect(result!.accessToken).toBe("token-xyz");
  });

  it("should overwrite existing session", () => {
    setSsoSession(SESSION_ID, session);

    const updatedSession: ConnectedSsoSession = {
      ...session,
      accessToken: "new-token",
    };
    setSsoSession(SESSION_ID, updatedSession);

    const result = getSsoSession(SESSION_ID);
    expect(result!.accessToken).toBe("new-token");
  });
});
