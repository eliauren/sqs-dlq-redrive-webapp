import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock AWS service modules before importing the app
vi.mock("../../src/aws/ssoProfiles", () => ({
  loadSsoProfiles: vi.fn(),
}));

vi.mock("../../src/aws/ssoLogin", () => ({
  startLogin: vi.fn(),
  pollForLogin: vi.fn(),
}));

vi.mock("../../src/aws/ssoDiscovery", () => ({
  discoverSsoEnvironments: vi.fn(),
}));

vi.mock("../../src/aws/sqsService", () => ({
  listQueues: vi.fn(),
  previewDlqMessages: vi.fn(),
  redriveMessages: vi.fn(),
}));

vi.mock("../../src/aws/sessionStore", () => ({
  getSsoSession: vi.fn(),
}));

vi.mock("../../src/aws/envConfig", () => ({
  getEnvironment: vi.fn(),
  registerDynamicEnvironments: vi.fn(),
}));

// Set test env before importing app
process.env.NODE_ENV = "test";

import { app } from "../../src/server";
import { loadSsoProfiles } from "../../src/aws/ssoProfiles";
import { startLogin, pollForLogin } from "../../src/aws/ssoLogin";
import { getSsoSession } from "../../src/aws/sessionStore";
import { getEnvironment } from "../../src/aws/envConfig";
import { listQueues, previewDlqMessages, redriveMessages } from "../../src/aws/sqsService";

describe("API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return status ok", async () => {
      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.uptime).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe("GET /api/sso-profiles", () => {
    it("should return list of SSO profiles", async () => {
      const mockProfiles = [
        { name: "dev", displayName: "Dev", ssoStartUrl: "https://sso.example.com" },
      ];
      vi.mocked(loadSsoProfiles).mockReturnValue(mockProfiles as any);

      const res = await request(app).get("/api/sso-profiles");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockProfiles);
    });

    it("should return 500 when profiles fail to load", async () => {
      vi.mocked(loadSsoProfiles).mockImplementation(() => {
        throw new Error("Config not found");
      });

      const res = await request(app).get("/api/sso-profiles");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Config not found");
    });
  });

  describe("POST /api/sso/login/start", () => {
    it("should return 400 when profileName is missing", async () => {
      const res = await request(app).post("/api/sso/login/start").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("profileName");
    });

    it("should start login flow successfully", async () => {
      const mockResult = {
        deviceCode: "dev-code",
        verificationUri: "https://verify.example.com",
        userCode: "ABCD-1234",
        intervalSeconds: 5,
        expiresAt: new Date().toISOString(),
      };
      vi.mocked(startLogin).mockResolvedValue(mockResult as any);

      const res = await request(app)
        .post("/api/sso/login/start")
        .send({ profileName: "dev" });

      expect(res.status).toBe(200);
      expect(res.body.deviceCode).toBe("dev-code");
    });
  });

  describe("POST /api/sso/login/poll", () => {
    it("should return 400 when required fields are missing", async () => {
      const res = await request(app)
        .post("/api/sso/login/poll")
        .send({ profileName: "dev" });

      expect(res.status).toBe(400);
    });

    it("should poll login successfully", async () => {
      vi.mocked(pollForLogin).mockResolvedValue({ success: true });

      const res = await request(app).post("/api/sso/login/poll").send({
        profileName: "dev",
        deviceCode: "code",
        sessionId: "sess-1",
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("GET /api/sso/environments", () => {
    it("should return 400 when sessionId is missing", async () => {
      const res = await request(app).get("/api/sso/environments");

      expect(res.status).toBe(400);
    });

    it("should return 401 when no active SSO session", async () => {
      vi.mocked(getSsoSession).mockReturnValue(undefined);

      const res = await request(app)
        .get("/api/sso/environments")
        .query({ sessionId: "sess-1" });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/queues", () => {
    it("should return 400 when required params are missing", async () => {
      const res = await request(app).get("/api/queues");

      expect(res.status).toBe(400);
    });

    it("should return 400 when region is not allowed", async () => {
      vi.mocked(getEnvironment).mockReturnValue({
        id: "env-1",
        label: "Dev",
        regions: ["eu-west-1"],
      });

      const res = await request(app)
        .get("/api/queues")
        .query({ envId: "env-1", region: "us-east-1", sessionId: "sess-1" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Region not allowed");
    });

    it("should list queues successfully", async () => {
      vi.mocked(getEnvironment).mockReturnValue({
        id: "env-1",
        label: "Dev",
        regions: ["eu-west-1"],
      });
      vi.mocked(listQueues).mockResolvedValue([
        "https://sqs.eu-west-1.amazonaws.com/111/my-queue-dlq",
      ]);

      const res = await request(app)
        .get("/api/queues")
        .query({ envId: "env-1", region: "eu-west-1", sessionId: "sess-1" });

      expect(res.status).toBe(200);
      expect(res.body.queues).toHaveLength(1);
    });
  });

  describe("POST /api/preview", () => {
    it("should return 400 when required fields are missing", async () => {
      const res = await request(app).post("/api/preview").send({});

      expect(res.status).toBe(400);
    });

    it("should preview messages without filter", async () => {
      vi.mocked(getEnvironment).mockReturnValue({
        id: "env-1",
        label: "Dev",
        regions: ["eu-west-1"],
      });
      vi.mocked(previewDlqMessages).mockResolvedValue([
        {
          MessageId: "m1",
          ReceiptHandle: "rh1",
          Body: '{"status":"error"}',
        },
      ] as any);

      const res = await request(app).post("/api/preview").send({
        envId: "env-1",
        region: "eu-west-1",
        dlqUrl: "https://sqs.eu-west-1.amazonaws.com/111/dlq",
        sessionId: "sess-1",
      });

      expect(res.status).toBe(200);
      expect(res.body.totalFetched).toBe(1);
      expect(res.body.messages).toHaveLength(1);
    });
  });

  describe("POST /api/redrive", () => {
    it("should return 400 when required fields are missing", async () => {
      const res = await request(app).post("/api/redrive").send({});

      expect(res.status).toBe(400);
    });

    it("should redrive messages successfully", async () => {
      vi.mocked(getEnvironment).mockReturnValue({
        id: "env-1",
        label: "Dev",
        regions: ["eu-west-1"],
      });
      vi.mocked(redriveMessages).mockResolvedValue({
        sent: 2,
        sendFailed: 0,
        deleted: 2,
        deleteFailed: 0,
      });

      const res = await request(app).post("/api/redrive").send({
        envId: "env-1",
        region: "eu-west-1",
        dlqUrl: "https://sqs.eu-west-1.amazonaws.com/111/dlq",
        targetUrl: "https://sqs.eu-west-1.amazonaws.com/111/target",
        sessionId: "sess-1",
        messages: [
          { messageId: "m1", receiptHandle: "rh1", body: '{"a":1}' },
          { messageId: "m2", receiptHandle: "rh2", body: '{"a":2}' },
        ],
        deleteAfterSend: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(2);
      expect(res.body.deleted).toBe(2);
    });
  });
});
