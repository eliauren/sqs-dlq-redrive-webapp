import {
  SQSClient,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  DeleteMessageBatchCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { getEnvironment } from "./envConfig";
import { getSsoSession } from "./sessionStore";
import { SSOClient, GetRoleCredentialsCommand } from "@aws-sdk/client-sso";

export interface PreviewOptions {
  maxMessages: number;
  waitTimeSeconds?: number;
  visibilityTimeout?: number;
}

async function createSqsClient(
  envId: string,
  region: string,
  sessionId: string
): Promise<SQSClient> {
  const env = getEnvironment(envId, sessionId);
  const session = getSsoSession(sessionId);
  if (!session) {
    throw new Error("No active SSO session for this client");
  }

  if (!env.ssoAccountId || !env.ssoRoleName) {
    throw new Error("Environment is missing SSO account info");
  }

  const sso = new SSOClient({ region: session.ssoRegion });

  const roleCredsRes = await sso.send(
    new GetRoleCredentialsCommand({
      accessToken: session.accessToken,
      accountId: env.ssoAccountId,
      roleName: env.ssoRoleName,
    })
  );

  const rc = roleCredsRes.roleCredentials;
  if (!rc || !rc.accessKeyId || !rc.secretAccessKey) {
    throw new Error("Failed to get role credentials from SSO for environment");
  }

  return new SQSClient({
    region,
    credentials: {
      accessKeyId: rc.accessKeyId,
      secretAccessKey: rc.secretAccessKey,
      sessionToken: rc.sessionToken,
    },
  });
}

export async function listQueues(
  envId: string,
  region: string,
  sessionId: string
): Promise<string[]> {
  const client = await createSqsClient(envId, region, sessionId);
  const res = await client.send(new ListQueuesCommand({}));
  return res.QueueUrls ?? [];
}

/**
 * Receive messages from a queue, deduplicating by MessageId.
 * Stops when the requested count is reached, the queue is empty,
 * or an entire batch returns only already-seen messages (which
 * means the visibility timeout has expired and we're looping).
 */
async function receiveDeduplicated(
  client: SQSClient,
  queueUrl: string,
  options: PreviewOptions
): Promise<Message[]> {
  const maxMessages = Math.max(1, Math.min(options.maxMessages, 5000));
  const seen = new Set<string>();
  const messages: Message[] = [];

  while (messages.length < maxMessages) {
    const batchSize = Math.min(10, maxMessages - messages.length);
    const res = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: batchSize,
        WaitTimeSeconds: options.waitTimeSeconds ?? 1,
        VisibilityTimeout: options.visibilityTimeout,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      })
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) {
      break;
    }

    let newInBatch = 0;
    for (const msg of batch) {
      const id = msg.MessageId ?? "";
      if (!seen.has(id)) {
        seen.add(id);
        messages.push(msg);
        newInBatch++;
      }
    }

    // If every message in the batch was a duplicate we've already
    // seen, the visibility timeout has expired and we're cycling.
    if (newInBatch === 0) {
      break;
    }
  }

  return messages;
}

export async function previewDlqMessages(
  envId: string,
  region: string,
  sessionId: string,
  dlqUrl: string,
  options: PreviewOptions
): Promise<Message[]> {
  const client = await createSqsClient(envId, region, sessionId);
  return receiveDeduplicated(client, dlqUrl, options);
}

export interface RedriveInputMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  messageAttributes?: Message["MessageAttributes"];
}

export interface RedriveResultSummary {
  sent: number;
  sendFailed: number;
  deleted: number;
  deleteFailed: number;
}

export async function redriveMessages(
  envId: string,
  region: string,
  sessionId: string,
  dlqUrl: string,
  targetUrl: string,
  messages: RedriveInputMessage[],
  deleteAfterSend: boolean
): Promise<RedriveResultSummary> {
  const client = await createSqsClient(envId, region, sessionId);

  let sent = 0;
  let sendFailed = 0;
  let deleted = 0;
  let deleteFailed = 0;

  for (let i = 0; i < messages.length; i += 10) {
    const batch = messages.slice(i, i + 10);

    const sendRes = await client.send(
      new SendMessageBatchCommand({
        QueueUrl: targetUrl,
        Entries: batch.map((m, idx) => ({
          Id: `${i + idx}-${m.messageId}`,
          MessageBody: m.body,
          MessageAttributes: m.messageAttributes,
        })),
      })
    );

    const failedSendIds = new Set((sendRes.Failed ?? []).map((f) => f.Id));
    const successfulBatch = batch.filter(
      (_m, idx) => !failedSendIds.has(`${i + idx}-${_m.messageId}`)
    );

    sent += successfulBatch.length;
    sendFailed += batch.length - successfulBatch.length;

    if (deleteAfterSend && successfulBatch.length > 0) {
      const deleteRes = await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: dlqUrl,
          Entries: successfulBatch.map((m, idx) => ({
            Id: `${i + idx}-${m.messageId}`,
            ReceiptHandle: m.receiptHandle,
          })),
        })
      );
      const failedDeleteCount = (deleteRes.Failed ?? []).length;
      deleteFailed += failedDeleteCount;
      deleted += successfulBatch.length - failedDeleteCount;
    }
  }

  return { sent, sendFailed, deleted, deleteFailed };
}

