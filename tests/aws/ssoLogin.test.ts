import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
const mockOidcSend = vi.fn();

vi.mock("@aws-sdk/client-sso-oidc", () => {
  class MockCmd { constructor(input?: any) { Object.assign(this, input ?? {}); } }
  return {
    SSOOIDCClient: class { send = mockOidcSend; },
    RegisterClientCommand: MockCmd,
    StartDeviceAuthorizationCommand: MockCmd,
    CreateTokenCommand: MockCmd,
  };
});

vi.mock("../../src/aws/ssoProfiles", () => ({
  loadSsoProfiles: vi.fn(),
}));

vi.mock("../../src/aws/sessionStore", () => ({
  setSsoSession: vi.fn(),
}));

import { startLogin, pollForLogin } from "../../src/aws/ssoLogin";
import { loadSsoProfiles } from "../../src/aws/ssoProfiles";
import { setSsoSession } from "../../src/aws/sessionStore";

const PROFILE = {
  name: "dev",
  displayName: "dev",
  ssoStartUrl: "https://portal.awsapps.com/start",
  ssoRegion: "eu-west-1",
  ssoAccountId: "111111111111",
  ssoRoleName: "Admin",
  ssoSession: "my-sso",
};

describe("ssoLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // IMPORTANT: tests are ordered intentionally because ssoLogin.ts caches
  // the registered OIDC client at module level (`registeredClient`).
  // Tests before successful registration need RegisterClient mock calls;
  // tests after can skip it since the client is cached.

  describe("startLogin", () => {
    // --- These run BEFORE any successful registration (cache is null) ---

    it("should throw for unknown profile", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([]);

      await expect(startLogin("unknown")).rejects.toThrow(
        "Unknown SSO profile: unknown"
      );
    });

    it("should throw when RegisterClient returns incomplete response", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // RegisterClient returns incomplete → throws before caching
      mockOidcSend.mockResolvedValueOnce({
        clientId: null,
        clientSecret: null,
      });

      await expect(startLogin("dev")).rejects.toThrow(
        "Failed to register SSO OIDC client"
      );
    });

    // --- This test caches the registered client for all subsequent tests ---

    it("should register client and start device authorization", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // Call 1: RegisterClient (client not cached yet)
      // Call 2: StartDeviceAuthorization
      mockOidcSend
        .mockResolvedValueOnce({
          clientId: "cid-123",
          clientSecret: "csecret-456",
        })
        .mockResolvedValueOnce({
          deviceCode: "dev-code",
          verificationUriComplete: "https://verify.example.com/code",
          userCode: "ABCD-1234",
          interval: 5,
          expiresIn: 600,
        });

      const result = await startLogin("dev");

      expect(result.deviceCode).toBe("dev-code");
      expect(result.verificationUri).toBe("https://verify.example.com/code");
      expect(result.userCode).toBe("ABCD-1234");
      expect(result.intervalSeconds).toBe(5);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    // --- Client is now cached; only 1 mock call needed per test ---

    it("should throw when device auth response is incomplete", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // Only StartDeviceAuth (client is cached)
      mockOidcSend.mockResolvedValueOnce({
        deviceCode: "dc",
        // missing verificationUriComplete, userCode, etc.
      });

      await expect(startLogin("dev")).rejects.toThrow(
        "Incomplete device authorization response"
      );
    });
  });

  describe("pollForLogin", () => {
    // Client is cached from the startLogin tests above

    it("should throw for unknown profile", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([]);

      await expect(
        pollForLogin("unknown", "device-code", "sess-1")
      ).rejects.toThrow("Unknown SSO profile: unknown");
    });

    it("should return pending when authorization is still pending", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // Only CreateToken (client is cached)
      const pendingErr: any = new Error("Authorization pending");
      pendingErr.name = "AuthorizationPendingException";
      mockOidcSend.mockRejectedValueOnce(pendingErr);

      const result = await pollForLogin("dev", "device-code", "sess-1");

      expect(result).toEqual({ success: false, pending: true });
    });

    it("should complete login and store session", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // Only CreateToken (client is cached)
      mockOidcSend.mockResolvedValueOnce({
        accessToken: "access-tok-xyz",
        expiresIn: 28800,
      });

      const result = await pollForLogin("dev", "device-code", "sess-1");

      expect(result).toEqual({ success: true });
      expect(setSsoSession).toHaveBeenCalledWith("sess-1", {
        ssoSession: "my-sso",
        ssoRegion: "eu-west-1",
        accessToken: "access-tok-xyz",
        expiresAt: expect.any(Date),
      });
    });

    it("should throw when token response is incomplete", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // Only CreateToken (client is cached)
      mockOidcSend.mockResolvedValueOnce({
        accessToken: null,
        expiresIn: null,
      });

      await expect(
        pollForLogin("dev", "device-code", "sess-1")
      ).rejects.toThrow("Failed to obtain SSO access token");
    });

    it("should re-throw non-pending errors", async () => {
      vi.mocked(loadSsoProfiles).mockReturnValue([PROFILE as any]);

      // Only CreateToken (client is cached)
      mockOidcSend.mockRejectedValueOnce(new Error("Network error"));

      await expect(
        pollForLogin("dev", "device-code", "sess-1")
      ).rejects.toThrow("Network error");
    });
  });
});
