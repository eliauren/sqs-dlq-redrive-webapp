import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import os from "os";

vi.mock("fs");
vi.mock("os");

// Must import after mocks are set up
import { loadSsoProfiles } from "../../src/aws/ssoProfiles";

const VALID_CONFIG = `
[sso-session my-sso]
sso_start_url = https://my-portal.awsapps.com/start
sso_region = eu-west-1

[profile dev]
sso_session = my-sso
sso_account_id = 111111111111
sso_role_name = AdminRole
region = eu-west-1

[profile prod]
sso_session = my-sso
sso_account_id = 222222222222
sso_role_name = ReadOnlyRole
`;

describe("ssoProfiles — loadSsoProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/testuser");
  });

  it("should return empty array when config file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const profiles = loadSsoProfiles();

    expect(profiles).toEqual([]);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("should parse valid SSO profiles from config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(VALID_CONFIG);

    const profiles = loadSsoProfiles();

    expect(profiles).toHaveLength(2);

    expect(profiles[0]).toEqual({
      name: "dev",
      displayName: "dev",
      defaultRegion: "eu-west-1",
      ssoStartUrl: "https://my-portal.awsapps.com/start",
      ssoRegion: "eu-west-1",
      ssoAccountId: "111111111111",
      ssoRoleName: "AdminRole",
      ssoSession: "my-sso",
    });

    expect(profiles[1]).toEqual({
      name: "prod",
      displayName: "prod",
      defaultRegion: undefined,
      ssoStartUrl: "https://my-portal.awsapps.com/start",
      ssoRegion: "eu-west-1",
      ssoAccountId: "222222222222",
      ssoRoleName: "ReadOnlyRole",
      ssoSession: "my-sso",
    });
  });

  it("should skip profiles without sso_session reference", () => {
    const config = `
[sso-session my-sso]
sso_start_url = https://example.com/start
sso_region = us-east-1

[profile no-sso]
region = us-east-1
output = json
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(config);

    const profiles = loadSsoProfiles();

    expect(profiles).toHaveLength(0);
  });

  it("should skip profiles missing sso_account_id or sso_role_name", () => {
    const config = `
[sso-session my-sso]
sso_start_url = https://example.com/start
sso_region = us-east-1

[profile incomplete]
sso_session = my-sso
sso_account_id = 111111111111
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(config);

    const profiles = loadSsoProfiles();

    expect(profiles).toHaveLength(0);
  });

  it("should skip sso-session sections missing start_url or region", () => {
    const config = `
[sso-session broken]
sso_start_url = https://example.com/start

[profile test]
sso_session = broken
sso_account_id = 111111111111
sso_role_name = Admin
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(config);

    const profiles = loadSsoProfiles();

    expect(profiles).toHaveLength(0);
  });

  it("should skip profiles referencing unknown sso-session", () => {
    const config = `
[sso-session existing]
sso_start_url = https://example.com/start
sso_region = us-east-1

[profile orphan]
sso_session = nonexistent
sso_account_id = 111111111111
sso_role_name = Admin
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(config);

    const profiles = loadSsoProfiles();

    expect(profiles).toHaveLength(0);
  });

  it("should ignore non-profile sections", () => {
    const config = `
[sso-session my-sso]
sso_start_url = https://example.com/start
sso_region = us-east-1

[default]
region = us-east-1

[profile valid]
sso_session = my-sso
sso_account_id = 111111111111
sso_role_name = Admin
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(config);

    const profiles = loadSsoProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("valid");
  });
});
