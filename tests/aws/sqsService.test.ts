import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
const mockSqsSend = vi.fn();
const mockSsoSend = vi.fn();

vi.mock("@aws-sdk/client-sqs", () => {
  class MockCmd { constructor(input?: any) { Object.assign(this, input ?? {}); } }
  return {
    SQSClient: class { send = mockSqsSend; },
    ListQueuesCommand: MockCmd,
    ReceiveMessageCommand: MockCmd,
    SendMessageBatchCommand: MockCmd,
    DeleteMessageBatchCommand: MockCmd,
  };
});

vi.mock("@aws-sdk/client-sso", () => {
  class MockCmd { constructor(input?: any) { Object.assign(this, input ?? {}); } }
  return {
    SSOClient: class { send = mockSsoSend; },
    GetRoleCredentialsCommand: MockCmd,
  };
});

vi.mock("../../src/aws/envConfig", () => ({
  getEnvironment: vi.fn(),
}));

vi.mock("../../src/aws/sessionStore", () => ({
  getSsoSession: vi.fn(),
}));

import {
  listQueues,
  previewDlqMessages,
  redriveMessages,
} from "../../src/aws/sqsService";
import { getEnvironment } from "../../src/aws/envConfig";
import { getSsoSession } from "../../src/aws/sessionStore";

function setupMocks() {
  vi.mocked(getEnvironment).mockReturnValue({
    id: "env-1",
    label: "Dev (Admin)",
    regions: ["eu-west-1"],
    ssoAccountId: "111111111111",
    ssoRoleName: "AdminRole",
  });

  vi.mocked(getSsoSession).mockReturnValue({
    ssoSession: "my-sso",
    ssoRegion: "eu-west-1",
    accessToken: "token-abc",
    expiresAt: new Date(Date.now() + 3600_000),
  });

  // GetRoleCredentials
  mockSsoSend.mockResolvedValue({
    roleCredentials: {
      accessKeyId: "AKIA-FAKE",
      secretAccessKey: "secret-fake",
      sessionToken: "session-fake",
    },
  });
}

describe("sqsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  describe("createSqsClient (tested through public functions)", () => {
    it("should throw when no SSO session exists", async () => {
      vi.mocked(getSsoSession).mockReturnValue(undefined);

      await expect(listQueues("env-1", "eu-west-1", "sess-1")).rejects.toThrow(
        "No active SSO session"
      );
    });

    it("should throw when environment is missing SSO account info", async () => {
      vi.mocked(getEnvironment).mockReturnValue({
        id: "env-1",
        label: "Dev",
        regions: ["eu-west-1"],
        // missing ssoAccountId, ssoRoleName
      });

      await expect(listQueues("env-1", "eu-west-1", "sess-1")).rejects.toThrow(
        "Environment is missing SSO account info"
      );
    });

    it("should throw when role credentials are incomplete", async () => {
      mockSsoSend.mockResolvedValueOnce({
        roleCredentials: { accessKeyId: null, secretAccessKey: null },
      });

      await expect(listQueues("env-1", "eu-west-1", "sess-1")).rejects.toThrow(
        "Failed to get role credentials"
      );
    });
  });

  describe("listQueues", () => {
    it("should return queue URLs", async () => {
      mockSqsSend.mockResolvedValueOnce({
        QueueUrls: [
          "https://sqs.eu-west-1.amazonaws.com/111/queue-1",
          "https://sqs.eu-west-1.amazonaws.com/111/queue-2",
        ],
      });

      const queues = await listQueues("env-1", "eu-west-1", "sess-1");

      expect(queues).toHaveLength(2);
      expect(queues[0]).toContain("queue-1");
    });

    it("should return empty array when no queues exist", async () => {
      mockSqsSend.mockResolvedValueOnce({ QueueUrls: undefined });

      const queues = await listQueues("env-1", "eu-west-1", "sess-1");

      expect(queues).toEqual([]);
    });
  });

  describe("previewDlqMessages", () => {
    it("should receive and deduplicate messages", async () => {
      // First batch returns 2 messages
      mockSqsSend.mockResolvedValueOnce({
        Messages: [
          { MessageId: "m1", Body: '{"a":1}' },
          { MessageId: "m2", Body: '{"a":2}' },
        ],
      });
      // Second batch returns empty (queue drained)
      mockSqsSend.mockResolvedValueOnce({ Messages: [] });

      const messages = await previewDlqMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs.eu-west-1.amazonaws.com/111/dlq",
        { maxMessages: 10 }
      );

      expect(messages).toHaveLength(2);
    });

    it("should stop when all messages in a batch are duplicates", async () => {
      const msg = { MessageId: "m1", Body: '{"a":1}' };

      // First batch
      mockSqsSend.mockResolvedValueOnce({ Messages: [msg] });
      // Second batch returns same message (visibility timeout expired)
      mockSqsSend.mockResolvedValueOnce({ Messages: [msg] });

      const messages = await previewDlqMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs.eu-west-1.amazonaws.com/111/dlq",
        { maxMessages: 10 }
      );

      expect(messages).toHaveLength(1);
    });

    it("should stop at maxMessages limit", async () => {
      // Return 10 messages per batch
      const batch = Array.from({ length: 10 }, (_, i) => ({
        MessageId: `m${i}`,
        Body: `{"i":${i}}`,
      }));
      mockSqsSend.mockResolvedValueOnce({ Messages: batch.slice(0, 3) });

      const messages = await previewDlqMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs.eu-west-1.amazonaws.com/111/dlq",
        { maxMessages: 3 }
      );

      expect(messages).toHaveLength(3);
    });

    it("should clamp maxMessages to valid range", async () => {
      mockSqsSend.mockResolvedValueOnce({ Messages: [] });

      // maxMessages = 0 should be clamped to 1
      await previewDlqMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs.eu-west-1.amazonaws.com/111/dlq",
        { maxMessages: 0 }
      );

      // Should still make at least one call
      expect(mockSqsSend).toHaveBeenCalled();
    });
  });

  describe("redriveMessages", () => {
    const makeMessages = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        messageId: `m${i}`,
        receiptHandle: `rh${i}`,
        body: `{"idx":${i}}`,
      }));

    it("should send messages to target queue", async () => {
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }],
        Failed: [],
      });

      const result = await redriveMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs/dlq",
        "https://sqs/target",
        makeMessages(1),
        false
      );

      expect(result.sent).toBe(1);
      expect(result.sendFailed).toBe(0);
      expect(result.deleted).toBe(0);
    });

    it("should send and delete when deleteAfterSend is true", async () => {
      // SendMessageBatch
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }, { Id: "1-m1" }],
        Failed: [],
      });
      // DeleteMessageBatch
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }, { Id: "1-m1" }],
        Failed: [],
      });

      const result = await redriveMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs/dlq",
        "https://sqs/target",
        makeMessages(2),
        true
      );

      expect(result.sent).toBe(2);
      expect(result.deleted).toBe(2);
      expect(result.sendFailed).toBe(0);
      expect(result.deleteFailed).toBe(0);
    });

    it("should handle partial send failures", async () => {
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }],
        Failed: [{ Id: "1-m1" }],
      });
      // Delete only the successful one
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }],
        Failed: [],
      });

      const result = await redriveMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs/dlq",
        "https://sqs/target",
        makeMessages(2),
        true
      );

      expect(result.sent).toBe(1);
      expect(result.sendFailed).toBe(1);
      expect(result.deleted).toBe(1);
    });

    it("should handle partial delete failures", async () => {
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }, { Id: "1-m1" }],
        Failed: [],
      });
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "0-m0" }],
        Failed: [{ Id: "1-m1" }],
      });

      const result = await redriveMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs/dlq",
        "https://sqs/target",
        makeMessages(2),
        true
      );

      expect(result.sent).toBe(2);
      expect(result.deleted).toBe(1);
      expect(result.deleteFailed).toBe(1);
    });

    it("should batch messages in groups of 10", async () => {
      // Batch 1: 10 messages
      mockSqsSend.mockResolvedValueOnce({
        Successful: Array.from({ length: 10 }, (_, i) => ({ Id: `${i}-m${i}` })),
        Failed: [],
      });
      // Batch 2: 2 messages
      mockSqsSend.mockResolvedValueOnce({
        Successful: [{ Id: "10-m10" }, { Id: "11-m11" }],
        Failed: [],
      });

      const result = await redriveMessages(
        "env-1",
        "eu-west-1",
        "sess-1",
        "https://sqs/dlq",
        "https://sqs/target",
        makeMessages(12),
        false
      );

      expect(result.sent).toBe(12);
      // 2 SendMessageBatch calls (no deletes)
      expect(mockSqsSend).toHaveBeenCalledTimes(2);
    });
  });
});
