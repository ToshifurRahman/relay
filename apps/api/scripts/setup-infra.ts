import { CreateTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';

import { type Config, type RawEnv, scriptConfig } from '../src/lib/config.js';
import { buildSqsClientConfig as buildSqsClientConfigShared } from '../src/lib/queue.js';
import { smokeQueueName } from './queue-names.js';

// The local stack uses the placeholder credentials in lib/config.ts. Real AWS must never see
// them: without an endpoint the SDK would sign production requests with "test".
const LOCAL_PLACEHOLDER = 'test';

const KEYS = [
  'SQS_QUEUE_NAME',
  'SQS_DLQ_NAME',
  'SQS_ENDPOINT',
  'SNS_ENDPOINT',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AI_TIMEOUT_MS',
] as const;

export type SetupConfig = Pick<Config, (typeof KEYS)[number]>;

// Story 7.12.3 (REL-01): the queue's visibility timeout must cover the worker's worst-case
// processing time for one message, or SQS redelivers a message that is still being worked on.
// Each redelivery increments ApproximateReceiveCount, so a slow-but-successful ticket could be
// marked failed by a second receive while the first worker is still running it, duplicating AI
// calls and ticket events. Worst case for one receive: triage (primary + backup) then draft
// (primary + backup), each bounded by AI_TIMEOUT_MS = 2 stages x 2 providers x AI_TIMEOUT_MS.
// The default AI_TIMEOUT_MS is 30s, so the worst case is 120s; 300s leaves room for the DB
// writes and event recording around the calls. AI_TIMEOUT_MS is operator-configurable, so the
// timeout is derived from it rather than fixed: above 75s a fixed 300s would be too short.
export const MIN_VISIBILITY_TIMEOUT_S = 300;
/** SQS's own maximum for VisibilityTimeout. */
export const MAX_VISIBILITY_TIMEOUT_S = 12 * 60 * 60;
/** Headroom over the worst case for the database writes and event recording around the calls. */
const VISIBILITY_MARGIN = 2.5;

export function worstCaseProcessingMs(aiTimeoutMs: number): number {
  return 2 * 2 * aiTimeoutMs;
}

/** The visibility timeout for a given AI timeout: the 300s floor, scaled up when it must be. */
export function visibilityTimeoutSeconds(aiTimeoutMs: number): number {
  const derived = Math.ceil((worstCaseProcessingMs(aiTimeoutMs) * VISIBILITY_MARGIN) / 1000);
  return Math.min(MAX_VISIBILITY_TIMEOUT_S, Math.max(MIN_VISIBILITY_TIMEOUT_S, derived));
}

/**
 * The derived timeout before clamping. Setup refuses a configuration that needs more than SQS
 * allows, rather than silently clamping to a value that is still too short for the worst case.
 */
function requiredVisibilityTimeoutSeconds(aiTimeoutMs: number): number {
  return Math.ceil((worstCaseProcessingMs(aiTimeoutMs) * VISIBILITY_MARGIN) / 1000);
}

/** An empty endpoint counts as unset, so `SQS_ENDPOINT=` means real AWS. */
export function hasEndpoint(endpoint: string | undefined): endpoint is string {
  return typeof endpoint === 'string' && endpoint.trim() !== '';
}

/**
 * Reads only the variables this script uses. The schema already requires the AWS keys when
 * SQS_ENDPOINT is unset; here the local placeholder is refused too, so a copy-pasted local
 * .env cannot point this script at production.
 */
export function resolveSetupConfig(env?: RawEnv): SetupConfig {
  const config = scriptConfig(KEYS, {}, env);
  if (!hasEndpoint(config.SQS_ENDPOINT)) {
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const) {
      if (config[name] === LOCAL_PLACEHOLDER) {
        throw new Error(
          `${name} must be a real credential when SQS_ENDPOINT is unset; refusing the local placeholder`
        );
      }
    }
  }
  // A configuration whose worst case needs more than SQS allows cannot be made safe by clamping:
  // the queue would still redeliver a message that is being worked on (REL-01). Refuse it here,
  // where the operator can see the number, instead of at the first slow ticket.
  const required = requiredVisibilityTimeoutSeconds(config.AI_TIMEOUT_MS);
  if (required > MAX_VISIBILITY_TIMEOUT_S) {
    throw new Error(
      `AI_TIMEOUT_MS=${config.AI_TIMEOUT_MS} needs a visibility timeout of ${required}s, above the SQS maximum of ${MAX_VISIBILITY_TIMEOUT_S}s; lower AI_TIMEOUT_MS`
    );
  }
  return config;
}

/**
 * No endpoint property at all for real AWS, which makes the SDK use the regional endpoint.
 * Delegates to the shared builder so the setup script and the runtime cannot drift apart on
 * timeouts (story 7.12.3, REL-02).
 */
export function buildSqsClientConfig(config: SetupConfig): SQSClientConfig {
  return buildSqsClientConfigShared({
    SQS_ENDPOINT: hasEndpoint(config.SQS_ENDPOINT) ? config.SQS_ENDPOINT : undefined,
    AWS_REGION: config.AWS_REGION,
    AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
  });
}

async function setup(): Promise<void> {
  const config = resolveSetupConfig();
  const queueName = config.SQS_QUEUE_NAME;
  const dlqName = config.SQS_DLQ_NAME;
  const credentials = {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  };

  const client = new SQSClient(buildSqsClientConfig(config));

  // Create DLQ first
  const dlqResult = await client.send(new CreateQueueCommand({ QueueName: dlqName }));
  if (!dlqResult.QueueUrl) throw new Error('Failed to create DLQ');
  console.log(`DLQ created: ${dlqResult.QueueUrl}`);

  // Get DLQ ARN
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqResult.QueueUrl,
      AttributeNames: ['QueueArn'],
    })
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('Failed to retrieve DLQ ARN');
  console.log(`DLQ ARN: ${dlqArn}`);

  // Create main queue
  const mainResult = await client.send(new CreateQueueCommand({ QueueName: queueName }));
  if (!mainResult.QueueUrl) throw new Error('Failed to create main queue');
  console.log(`main queue created: ${mainResult.QueueUrl}`);

  // A dedicated queue for smoke:infra: the worker polls only the main queue, so the probe can
  // never be consumed and deleted as an unknown ticket.
  const smokeResult = await client.send(
    new CreateQueueCommand({ QueueName: smokeQueueName(queueName) })
  );
  if (!smokeResult.QueueUrl) throw new Error('Failed to create smoke queue');
  console.log(`smoke queue created: ${smokeResult.QueueUrl}`);

  // Apply redrive policy and the visibility timeout. The timeout is set here, not left at the
  // SQS default of 30s, because 30s is shorter than one message's worst-case processing time
  // (REL-01): a slow ticket would be redelivered while still in flight. It is derived from the
  // configured AI_TIMEOUT_MS, so raising that cannot silently outgrow the queue's timeout.
  const visibilityTimeoutS = visibilityTimeoutSeconds(config.AI_TIMEOUT_MS);
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: mainResult.QueueUrl,
      Attributes: {
        VisibilityTimeout: String(visibilityTimeoutS),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '10',
        }),
      },
    })
  );
  console.log(
    `redrive policy applied (visibility timeout ${visibilityTimeoutS}s for AI_TIMEOUT_MS ${config.AI_TIMEOUT_MS})`
  );
  console.log(`setup complete: main queue ${mainResult.QueueUrl}, DLQ ${dlqResult.QueueUrl}`);

  // SNS topic for ops email alerts (story 5.7). Only against a local endpoint: in AWS the topic
  // and its email subscription are created by hand (story 7.8), never by this script.
  if (hasEndpoint(config.SNS_ENDPOINT)) {
    const sns = new SNSClient({
      endpoint: config.SNS_ENDPOINT,
      region: config.AWS_REGION,
      credentials,
    });
    const topic = await sns.send(new CreateTopicCommand({ Name: 'ticket-needs-attention' }));
    if (!topic.TopicArn) throw new Error('Failed to create SNS topic');
    console.log(
      `SNS topic created: ${topic.TopicArn} (set SNS_TOPIC_ARN to this to turn on ops alerts)`
    );
  } else {
    console.log('SNS_ENDPOINT not set, skipping the ops alert topic');
  }
}

if (import.meta.main) await setup();
