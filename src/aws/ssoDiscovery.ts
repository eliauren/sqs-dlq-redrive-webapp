import {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  AccountInfo,
  RoleInfo,
} from "@aws-sdk/client-sso";
import type { ConnectedSsoSession } from "./sessionStore";
import type { EnvironmentConfig } from "./credentials";

/**
 * Discover all accessible AWS accounts and roles using an active SSO
 * access token.  Each account+role combination is returned as an
 * EnvironmentConfig so it can be used directly by the rest of the app.
 */
export async function discoverSsoEnvironments(
  session: ConnectedSsoSession
): Promise<EnvironmentConfig[]> {
  const sso = new SSOClient({ region: session.ssoRegion });

  // 1. List all accounts accessible with the SSO token
  const accounts: AccountInfo[] = [];
  let nextToken: string | undefined;

  do {
    const res = await sso.send(
      new ListAccountsCommand({
        accessToken: session.accessToken,
        nextToken,
      })
    );
    accounts.push(...(res.accountList ?? []));
    nextToken = res.nextToken;
  } while (nextToken);

  // 2. For each account, list available roles
  const environments: EnvironmentConfig[] = [];

  for (const account of accounts) {
    if (!account.accountId) continue;

    const roles: RoleInfo[] = [];
    let roleNextToken: string | undefined;

    do {
      const res = await sso.send(
        new ListAccountRolesCommand({
          accessToken: session.accessToken,
          accountId: account.accountId,
          nextToken: roleNextToken,
        })
      );
      roles.push(...(res.roleList ?? []));
      roleNextToken = res.nextToken;
    } while (roleNextToken);

    for (const role of roles) {
      if (!role.roleName) continue;

      const accountName = account.accountName || account.accountId;
      environments.push({
        id: `${account.accountId}-${role.roleName}`,
        label: `${accountName} (${role.roleName})`,
        regions: [session.ssoRegion],
        ssoAccountId: account.accountId,
        ssoRoleName: role.roleName,
      });
    }
  }

  return environments;
}
