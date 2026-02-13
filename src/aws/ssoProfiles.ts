import fs from "fs";
import os from "os";
import path from "path";
import ini from "ini";

export interface SsoProfile {
  name: string;
  displayName: string;
  defaultRegion?: string;
  ssoStartUrl: string;
  ssoRegion: string;
  ssoAccountId: string;
  ssoRoleName: string;
  ssoSession: string;
}

/**
 * Load SSO-enabled profiles from ~/.aws/config.
 *
 * This supports the new AWS SSO layout where:
 * - SSO connection details live under `[sso-session NAME]`
 * - Profiles reference those via `sso_session = NAME` and specify
 *   `sso_account_id` and `sso_role_name`.
 */
export function loadSsoProfiles(): SsoProfile[] {
  const configPath = path.join(os.homedir(), ".aws", "config");

  if (!fs.existsSync(configPath)) {
    return [];
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = ini.parse(raw);

  // First collect SSO session definitions
  const sessions: Record<
    string,
    { ssoStartUrl: string; ssoRegion: string }
  > = {};

  for (const sectionName of Object.keys(parsed)) {
    const section = parsed[sectionName] as Record<string, string> | undefined;
    if (!section) continue;

    if (sectionName.startsWith("sso-session ")) {
      const sessionName = sectionName.replace(/^sso-session\s+/, "");
      if (section.sso_start_url && section.sso_region) {
        sessions[sessionName] = {
          ssoStartUrl: section.sso_start_url,
          ssoRegion: section.sso_region,
        };
      }
    }
  }

  const profiles: SsoProfile[] = [];

  // Then collect profiles that reference an SSO session
  for (const sectionName of Object.keys(parsed)) {
    const section = parsed[sectionName] as Record<string, string> | undefined;
    if (!section) continue;

    if (!sectionName.startsWith("profile ")) continue;

    const name = sectionName.replace(/^profile\s+/, "");

    const ssoSessionName = section.sso_session;
    const session = ssoSessionName ? sessions[ssoSessionName] : undefined;

    if (
      !session ||
      !section.sso_account_id ||
      !section.sso_role_name
    ) {
      // Not an SSO-enabled profile we can use
      continue;
    }

    profiles.push({
      name,
      displayName: name,
      defaultRegion: section.region,
      ssoStartUrl: session.ssoStartUrl,
      ssoRegion: session.ssoRegion,
      ssoAccountId: section.sso_account_id,
      ssoRoleName: section.sso_role_name,
      ssoSession: ssoSessionName,
    });
  }

  return profiles;
}

