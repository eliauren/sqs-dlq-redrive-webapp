import { describe, it, expect } from "vitest";
import {
  filterByAttributePath,
  type RawMessage,
} from "../../src/filtering/jsonFilter";

function makeMessage(body: string, id?: string): RawMessage {
  return {
    MessageId: id ?? "msg-1",
    ReceiptHandle: "rh-1",
    Body: body,
  };
}

describe("filterByAttributePath", () => {
  describe("basic matching", () => {
    it("should match messages where attribute equals expected value", () => {
      const messages = [
        makeMessage(JSON.stringify({ status: "error", code: 500 }), "m1"),
        makeMessage(JSON.stringify({ status: "ok", code: 200 }), "m2"),
        makeMessage(JSON.stringify({ status: "error", code: 502 }), "m3"),
      ];

      const result = filterByAttributePath(messages, "status", "error");

      expect(result).toHaveLength(2);
      expect(result[0].raw.MessageId).toBe("m1");
      expect(result[1].raw.MessageId).toBe("m3");
      expect(result[0].attributeValue).toBe("error");
    });

    it("should return empty array when no messages match", () => {
      const messages = [
        makeMessage(JSON.stringify({ status: "ok" })),
      ];

      const result = filterByAttributePath(messages, "status", "error");

      expect(result).toHaveLength(0);
    });
  });

  describe("nested path resolution", () => {
    it("should resolve dot-separated nested paths", () => {
      const messages = [
        makeMessage(
          JSON.stringify({ event: { type: "ORDER_CREATED", source: "api" } })
        ),
      ];

      const result = filterByAttributePath(
        messages,
        "event.type",
        "ORDER_CREATED"
      );

      expect(result).toHaveLength(1);
      expect(result[0].attributeValue).toBe("ORDER_CREATED");
    });

    it("should resolve deeply nested paths", () => {
      const messages = [
        makeMessage(
          JSON.stringify({ a: { b: { c: { d: "found" } } } })
        ),
      ];

      const result = filterByAttributePath(messages, "a.b.c.d", "found");

      expect(result).toHaveLength(1);
      expect(result[0].attributeValue).toBe("found");
    });

    it("should exclude messages where nested path does not exist", () => {
      const messages = [
        makeMessage(JSON.stringify({ event: { type: "X" } })),
      ];

      const result = filterByAttributePath(
        messages,
        "event.nonexistent",
        "X"
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("exclude mode", () => {
    it("should exclude matching messages when exclude=true", () => {
      const messages = [
        makeMessage(JSON.stringify({ status: "error" }), "m1"),
        makeMessage(JSON.stringify({ status: "ok" }), "m2"),
        makeMessage(JSON.stringify({ status: "error" }), "m3"),
      ];

      const result = filterByAttributePath(
        messages,
        "status",
        "error",
        true
      );

      expect(result).toHaveLength(1);
      expect(result[0].raw.MessageId).toBe("m2");
    });

    it("should include messages where attribute is missing when exclude=true", () => {
      const messages = [
        makeMessage(JSON.stringify({ other: "field" }), "m1"),
      ];

      const result = filterByAttributePath(
        messages,
        "status",
        "error",
        true
      );

      expect(result).toHaveLength(1);
      expect(result[0].attributeValue).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("should skip messages with no Body", () => {
      const messages: RawMessage[] = [
        { MessageId: "m1", ReceiptHandle: "rh" },
      ];

      const result = filterByAttributePath(messages, "status", "error");

      expect(result).toHaveLength(0);
    });

    it("should report parse errors for invalid JSON", () => {
      const messages = [makeMessage("not-valid-json")];

      const result = filterByAttributePath(messages, "status", "error");

      expect(result).toHaveLength(1);
      expect(result[0].parseError).toBeDefined();
      expect(result[0].parsedBody).toBeUndefined();
    });

    it("should coerce numeric values to string for comparison", () => {
      const messages = [
        makeMessage(JSON.stringify({ code: 500 })),
      ];

      const result = filterByAttributePath(messages, "code", "500");

      expect(result).toHaveLength(1);
      expect(result[0].attributeValue).toBe(500);
    });

    it("should handle empty messages array", () => {
      const result = filterByAttributePath([], "status", "error");
      expect(result).toHaveLength(0);
    });

    it("should handle empty attribute path", () => {
      const messages = [makeMessage(JSON.stringify({ status: "error" }))];

      const result = filterByAttributePath(messages, "", "error");

      expect(result).toHaveLength(0);
    });
  });
});
