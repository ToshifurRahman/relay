/**
 * Story 7.12.3 (REL-02), fix round 1: a configured `requestTimeout` alone does not bound a call.
 * `@smithy/node-http-handler` only logs a warning when the timeout passes unless the handler is
 * built with `throwOnRequestTimeout: true`; the request keeps waiting. So the config shape is not
 * evidence: these tests drive the real `SQSClient` and `SNSClient` against a server that accepts
 * the connection and never answers, and require a rejection.
 *
 * The short timeout is the only thing the tests override. `throwOnRequestTimeout` is taken from
 * the production builder, so removing it from `lib/queue.ts` or `lib/sns.ts` turns these red.
 */
import net from 'node:net';

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSqsClientConfig } from '../../../src/lib/queue.js';
import { buildSnsClientConfig } from '../../../src/lib/sns.js';

const SHORT_TIMEOUT_MS = 300;
// Generous next to the 300ms timeout, short enough that a hang fails the test instead of the run.
const GIVE_UP_MS = 2_000;

interface SilentServer {
  url: string;
  close: () => Promise<void>;
}

/** Accepts the connection and never writes a byte: the black-holed endpoint the finding names. */
function silentServer(): Promise<SilentServer> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Resolves with the rejection, or with the string 'still-hanging' when nothing settles in time. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<'still-hanging'>((resolve) => {
    timer = setTimeout(() => resolve('still-hanging'), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        (err: unknown) => err
      ),
      giveUp,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const servers: SilentServer[] = [];
const clients: Array<{ destroy: () => void }> = [];

async function startServer(): Promise<SilentServer> {
  const server = await silentServer();
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
});

describe('SQS against a silent server', () => {
  it('rejects instead of hanging when the endpoint accepts and never answers', async () => {
    const server = await startServer();
    const config = buildSqsClientConfig({
      SQS_ENDPOINT: server.url,
      AWS_REGION: 'ap-south-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });
    const handler = config.requestHandler as {
      requestTimeout: number;
      connectionTimeout: number;
      throwOnRequestTimeout?: boolean;
    };
    const client = new SQSClient({
      ...config,
      // One attempt: this test is about the timeout throwing, not about the retry budget.
      maxAttempts: 1,
      requestHandler: { ...handler, requestTimeout: SHORT_TIMEOUT_MS },
    });
    clients.push(client);

    const outcome = await settleWithin(
      client.send(new GetQueueUrlCommand({ QueueName: 'tickets' })),
      GIVE_UP_MS
    );

    expect(outcome, 'the SQS call never settled: requestTimeout did not throw').toBeInstanceOf(
      Error
    );
    expect((outcome as Error).name).toBe('TimeoutError');
  }, 15_000);
});

describe('SNS against a silent server', () => {
  it('rejects instead of hanging when the endpoint accepts and never answers', async () => {
    const server = await startServer();
    const config = buildSnsClientConfig({
      SNS_ENDPOINT: server.url,
      AWS_REGION: 'ap-south-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });
    const handler = config.requestHandler as {
      requestTimeout: number;
      connectionTimeout: number;
      throwOnRequestTimeout?: boolean;
    };
    const client = new SNSClient({
      ...config,
      maxAttempts: 1,
      requestHandler: { ...handler, requestTimeout: SHORT_TIMEOUT_MS },
    });
    clients.push(client);

    const outcome = await settleWithin(
      client.send(
        new PublishCommand({
          TopicArn: 'arn:aws:sns:ap-south-1:000000000000:ticket-needs-attention',
          Subject: 'test',
          Message: 'test',
        })
      ),
      GIVE_UP_MS
    );

    expect(outcome, 'the SNS call never settled: requestTimeout did not throw').toBeInstanceOf(
      Error
    );
    expect((outcome as Error).name).toBe('TimeoutError');
  }, 15_000);
});
