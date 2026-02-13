export interface RawMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  [key: string]: unknown;
}

export interface FilteredMessage {
  raw: RawMessage;
  parsedBody?: unknown;
  attributeValue?: unknown;
  parseError?: string;
}

function getByPath(obj: any, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as any)[part];
  }
  return current;
}

export function filterByAttributePath(
  messages: RawMessage[],
  attributePath: string,
  expectedValue: string,
  exclude: boolean = false
): FilteredMessage[] {
  const results: FilteredMessage[] = [];

  for (const msg of messages) {
    if (!msg.Body) {
      continue;
    }

    let parsed: unknown;
    let parseError: string | undefined;
    try {
      parsed = JSON.parse(msg.Body);
    } catch (err) {
      parseError = (err as Error).message;
    }

    if (parseError) {
      results.push({
        raw: msg,
        parseError,
      });
      continue;
    }

    const value = getByPath(parsed as any, attributePath);
    if (value === undefined) {
      if (exclude) {
        // Attribute not found — include when excluding matches
        results.push({
          raw: msg,
          parsedBody: parsed,
          attributeValue: undefined,
        });
      }
      continue;
    }

    const matches = String(value) === expectedValue;

    if (exclude ? !matches : matches) {
      results.push({
        raw: msg,
        parsedBody: parsed,
        attributeValue: value,
      });
    }
  }

  return results;
}

