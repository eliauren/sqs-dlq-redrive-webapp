import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SSO client before importing
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-sso", () => {
  class MockCmd { constructor(input?: any) { Object.assign(this, input ?? {}); } }
  return {
    SSOClient: class { send = mockSend; },
    ListAccountsCommand: MockCmd,
    ListAccountRolesCommand: MockCmd,
  };
});

import { discoverSsoEnvironments } from "../../src/aws/ssoDiscovery";
import type { ConnectedSsoSession } from "../../src/aws/sessionStore";

const SESSION: ConnectedSsoSession = {
  ssoSession: "my-sso",
  ssoRegion: "eu-west-1",
  accessToken: "token-abc",
  expiresAt: new Date(Date.now() + 3600_000),
};

describe("ssoDiscovery — discoverSsoEnvironments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty array when no accounts exist", async () => {
    mockSend.mockResolvedValueOnce({ accountList: [], nextToken: undefined });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs).toEqual([]);
  });

  it("should discover environments from accounts and roles", async () => {
    // ListAccounts
    mockSend.mockResolvedValueOnce({
      accountList: [
        { accountId: "111111111111", accountName: "Dev" },
        { accountId: "222222222222", accountName: "Prod" },
      ],
      nextToken: undefined,
    });

    // ListAccountRoles for Dev
    mockSend.mockResolvedValueOnce({
      roleList: [
        { roleName: "AdminRole" },
        { roleName: "ReadOnly" },
      ],
      nextToken: undefined,
    });

    // ListAccountRoles for Prod
    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "ViewOnly" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs).toHaveLength(3);
    expect(envs[0]).toEqual({
      id: "111111111111-AdminRole",
      label: "Dev (AdminRole)",
      regions: ["eu-west-1"],
      ssoAccountId: "111111111111",
      ssoRoleName: "AdminRole",
    });
    expect(envs[1].id).toBe("111111111111-ReadOnly");
    expect(envs[2]).toEqual({
      id: "222222222222-ViewOnly",
      label: "Prod (ViewOnly)",
      regions: ["eu-west-1"],
      ssoAccountId: "222222222222",
      ssoRoleName: "ViewOnly",
    });
  });

  it("should handle paginated account listing", async () => {
    // Page 1 of ListAccounts
    mockSend.mockResolvedValueOnce({
      accountList: [{ accountId: "111111111111", accountName: "Acc1" }],
      nextToken: "page2",
    });
    // Page 2 of ListAccounts
    mockSend.mockResolvedValueOnce({
      accountList: [{ accountId: "222222222222", accountName: "Acc2" }],
      nextToken: undefined,
    });

    // Roles for Acc1
    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });

    // Roles for Acc2
    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Dev" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs).toHaveLength(2);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("should handle paginated role listing", async () => {
    mockSend.mockResolvedValueOnce({
      accountList: [{ accountId: "111111111111", accountName: "Acc" }],
      nextToken: undefined,
    });

    // Page 1 of roles
    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Role1" }],
      nextToken: "rolesPage2",
    });
    // Page 2 of roles
    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Role2" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs).toHaveLength(2);
    expect(envs[0].ssoRoleName).toBe("Role1");
    expect(envs[1].ssoRoleName).toBe("Role2");
  });

  it("should skip accounts without accountId", async () => {
    mockSend.mockResolvedValueOnce({
      accountList: [
        { accountName: "NoId" }, // missing accountId
        { accountId: "111111111111", accountName: "Valid" },
      ],
      nextToken: undefined,
    });

    // Only called for Valid account
    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs).toHaveLength(1);
    expect(envs[0].label).toBe("Valid (Admin)");
  });

  it("should skip roles without roleName", async () => {
    mockSend.mockResolvedValueOnce({
      accountList: [{ accountId: "111111111111", accountName: "Acc" }],
      nextToken: undefined,
    });

    mockSend.mockResolvedValueOnce({
      roleList: [
        { roleName: undefined },
        { roleName: "ValidRole" },
      ],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs).toHaveLength(1);
    expect(envs[0].ssoRoleName).toBe("ValidRole");
  });

  it("should use accountId as label when accountName is missing", async () => {
    mockSend.mockResolvedValueOnce({
      accountList: [{ accountId: "999999999999" }], // no accountName
      nextToken: undefined,
    });

    mockSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(SESSION);

    expect(envs[0].label).toBe("999999999999 (Admin)");
  });
});
