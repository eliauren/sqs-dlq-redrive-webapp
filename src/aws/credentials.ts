export interface EnvironmentConfig {
  id: string;
  label: string;
  regions: string[];
  /** SSO account ID for dynamically discovered environments */
  ssoAccountId?: string;
  /** SSO role name for dynamically discovered environments */
  ssoRoleName?: string;
}

