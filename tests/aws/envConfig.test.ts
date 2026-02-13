import { describe, it, expect, beforeEach } from "vitest";
import {
  registerDynamicEnvironments,
  getDynamicEnvironments,
  getEnvironment,
} from "../../src/aws/envConfig";
import type { EnvironmentConfig } from "../../src/aws/credentials";

const SESSION_ID = "test-session-123";

const envs: EnvironmentConfig[] = [
  {
    id: "111111111111-AdminRole",
    label: "Dev Account (AdminRole)",
    regions: ["eu-west-1", "us-east-1"],
    ssoAccountId: "111111111111",
    ssoRoleName: "AdminRole",
  },
  {
    id: "222222222222-ReadOnly",
    label: "Prod Account (ReadOnly)",
    regions: ["eu-west-1"],
    ssoAccountId: "222222222222",
    ssoRoleName: "ReadOnly",
  },
];

describe("envConfig", () => {
  beforeEach(() => {
    // Reset state by registering an empty set first
    registerDynamicEnvironments(SESSION_ID, []);
  });

  describe("registerDynamicEnvironments / getDynamicEnvironments", () => {
    it("should store and retrieve environments by session id", () => {
      registerDynamicEnvironments(SESSION_ID, envs);

      const result = getDynamicEnvironments(SESSION_ID);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("111111111111-AdminRole");
    });

    it("should return empty array for unknown session", () => {
      const result = getDynamicEnvironments("unknown-session");
      expect(result).toEqual([]);
    });

    it("should overwrite previous environments for the same session", () => {
      registerDynamicEnvironments(SESSION_ID, envs);
      registerDynamicEnvironments(SESSION_ID, [envs[0]]);

      const result = getDynamicEnvironments(SESSION_ID);

      expect(result).toHaveLength(1);
    });
  });

  describe("getEnvironment", () => {
    it("should find environment by id", () => {
      registerDynamicEnvironments(SESSION_ID, envs);

      const env = getEnvironment("222222222222-ReadOnly", SESSION_ID);

      expect(env.label).toBe("Prod Account (ReadOnly)");
      expect(env.ssoAccountId).toBe("222222222222");
    });

    it("should throw for unknown environment id", () => {
      registerDynamicEnvironments(SESSION_ID, envs);

      expect(() => getEnvironment("unknown-env", SESSION_ID)).toThrow(
        "Unknown environment id: unknown-env"
      );
    });

    it("should throw when session has no environments", () => {
      expect(() => getEnvironment("some-env", "empty-session")).toThrow(
        "Unknown environment id: some-env"
      );
    });
  });
});
