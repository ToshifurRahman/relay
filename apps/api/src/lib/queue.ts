import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';

import { getConfig } from './config.js';

// The SDK's own defaults disable both timeouts (0 = wait forever), so a black-holed endpoint
// would hang the worker's poll loop and the submission path's enqueue with no error and no
// backoff. The request budget covers a long poll (20s) plus the round trip; the connection
// budget fails a dead host quickly so the worker's own backoff takes over.
export const SQS_REQUEST_TIMEOUT_MS = 25_000;
export const SQS_CONNECTION_TIMEOUT_MS = 3_000;

export interface SqsClientSettings {
  SQS_ENDPOINT?: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

/**
 * The one place an SQS client's settings are built, so the worker, the API and the setup script
 * cannot drift apart on timeouts. No `endpoint` property at all for real AWS, which makes the
 * SDK use the regional endpoint.
 */
export function buildSqsClientConfig(settings: SqsClientSettings): SQSClientConfig {
  return {
    ...(settings.SQS_ENDPOINT ? { endpoint: settings.SQS_ENDPOINT } : {}),
    region: settings.AWS_REGION,
    credentials: {
      accessKeyId: settings.AWS_ACCESS_KEY_ID,
      secretAccessKey: settings.AWS_SECRET_ACCESS_KEY,
    },
    requestHandler: {
      requestTimeout: SQS_REQUEST_TIMEOUT_MS,
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
    },
  };
}

export interface QueueMessage {
  ticketId: string;
  referenceNumber: string;
  receiptHandle: string;
  attemptNumber: number;
}

export interface ReceiveMessagesOptions {
  maxMessages?: number;
  waitTimeSeconds?: number;
  signal?: AbortSignal;
}

function isQueueMissing(err: unknown): boolean {
  const e = err as { name?: string; Code?: string } | null;
  return e?.name === 'QueueDoesNotExist' || e?.Code === 'AWS.SimpleQueueService.NonExistentQueue';
}

function normalizeMaxMessages(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10;
  return Math.min(10, Math.max(1, Math.floor(value)));
}

function normalizeWaitTimeSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(20, Math.max(0, Math.floor(value)));
}

export class QueueService {
  private queueUrl: string | null = null;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string
  ) {}

  private async getQueueUrl(signal?: AbortSignal): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
      abortSignal: signal,
    });
    if (!result.QueueUrl) throw new Error(`Queue not found: ${this.queueName}`);
    this.queueUrl = result.QueueUrl;
    return this.queueUrl;
  }

  // The queue can vanish (LocalStack recreated, queue deleted) after its URL was cached. Drop the
  // cache and resolve again once; if the queue is still missing the error reaches the caller, which
  // owns the backoff.
  private async withQueueUrl<T>(
    call: (queueUrl: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    try {
      return await call(await this.getQueueUrl(signal));
    } catch (err) {
      if (!isQueueMissing(err)) throw err;
      this.queueUrl = null;
      return call(await this.getQueueUrl(signal));
    }
  }

  async enqueue(ticketId: string, referenceNumber: string): Promise<void> {
    await this.withQueueUrl((queueUrl) =>
      this.client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ ticketId, referenceNumber }),
        })
      )
    );
  }

  async receive(options: ReceiveMessagesOptions = {}): Promise<QueueMessage[]> {
    const maxMessages = normalizeMaxMessages(options.maxMessages);
    const waitTimeSeconds = normalizeWaitTimeSeconds(options.waitTimeSeconds);
    const result = await this.withQueueUrl(
      (queueUrl) =>
        this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: maxMessages,
            WaitTimeSeconds: waitTimeSeconds,
            MessageSystemAttributeNames: [MessageSystemAttributeName.ApproximateReceiveCount],
          }),
          { abortSignal: options.signal }
        ),
      options.signal
    );
    return (result.Messages ?? []).map((m) => ({
      ...(JSON.parse(m.Body!) as Pick<QueueMessage, 'ticketId' | 'referenceNumber'>),
      receiptHandle: m.ReceiptHandle!,
      attemptNumber: Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
    }));
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.withQueueUrl((queueUrl) =>
      this.client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle })
      )
    );
  }
}

let queueService: QueueService | undefined;
function service(): QueueService {
  if (!queueService) {
    const config = getConfig();
    queueService = new QueueService(
      new SQSClient(
        buildSqsClientConfig({
          SQS_ENDPOINT: config.SQS_ENDPOINT,
          AWS_REGION: config.AWS_REGION,
          AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
        })
      ),
      config.SQS_QUEUE_NAME
    );
  }
  return queueService;
}

export const enqueueTicket = (ticketId: string, referenceNumber: string): Promise<void> =>
  service().enqueue(ticketId, referenceNumber);

export const receiveMessages = (options?: ReceiveMessagesOptions): Promise<QueueMessage[]> =>
  service().receive(options);

export const deleteMessage = (receiptHandle: string): Promise<void> =>
  service().delete(receiptHandle);
