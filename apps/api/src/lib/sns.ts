import { SNSClient, type SNSClientConfig } from '@aws-sdk/client-sns';

import { getConfig } from './config.js';

export interface SnsTarget {
  client: SNSClient;
  topicArn: string;
}

// Short timeouts and a single retry: alerts are best-effort, and a hung call should give up
// quickly instead of piling up in the background of a busy worker.
export const SNS_REQUEST_TIMEOUT_MS = 5000;
export const SNS_CONNECTION_TIMEOUT_MS = 2000;
export const SNS_MAX_ATTEMPTS = 2;

export interface SnsClientSettings {
  SNS_ENDPOINT?: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

/**
 * The one place an SNS client's settings are built, so the alerter and the tests cannot drift
 * apart on timeouts. Exported for the silent-server test, which drives a real client.
 */
export function buildSnsClientConfig(settings: SnsClientSettings): SNSClientConfig {
  return {
    endpoint: settings.SNS_ENDPOINT,
    region: settings.AWS_REGION,
    credentials: {
      accessKeyId: settings.AWS_ACCESS_KEY_ID,
      secretAccessKey: settings.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: SNS_MAX_ATTEMPTS,
    requestHandler: {
      requestTimeout: SNS_REQUEST_TIMEOUT_MS,
      connectionTimeout: SNS_CONNECTION_TIMEOUT_MS,
      // Without this the handler only logs a warning when the timeout passes and the call keeps
      // waiting, so the "5s bound" would be a comment rather than a bound.
      throwOnRequestTimeout: true,
    },
  };
}

let target: SnsTarget | null | undefined;

// Ops alerts are optional. Without SNS_TOPIC_ARN (local dev, CI, or after the AWS free plan
// ends) this returns null and callers skip the alert. SNS_ENDPOINT points at LocalStack; when
// unset the SDK talks to real AWS. Built on first use so importing this module never throws.
export function getSnsClient(): SnsTarget | null {
  if (target !== undefined) return target;

  const config = getConfig();
  const topicArn = config.SNS_TOPIC_ARN;
  if (!topicArn) {
    target = null;
    return target;
  }

  const client = new SNSClient(
    buildSnsClientConfig({
      SNS_ENDPOINT: config.SNS_ENDPOINT,
      AWS_REGION: config.AWS_REGION,
      AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
    })
  );
  target = { client, topicArn };
  return target;
}
