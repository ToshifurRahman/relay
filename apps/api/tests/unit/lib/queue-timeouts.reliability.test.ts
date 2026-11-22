/**
 * Story 7.12.3 (REL-02): every SQS call must be bounded. The SDK's own defaults disable both
 * timeouts (requestTimeout 0, connectionTimeout 0), so a black-holed endpoint would hang the
 * worker's poll loop and the submission path's enqueue forever, with no error and no backoff.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSqsClientConfig,
  SQS_CONNECTION_TIMEOUT_MS,
  SQS_REQUEST_TIMEOUT_MS,
} from '../../../src/lib/queue.js';

const CONFIG = {
  SQS_ENDPOINT: 'http://localhost:4566',
  AWS_REGION: 'ap-south-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

describe('SQS client timeouts', () => {
  it('bounds the request and the connection phase', () => {
    const config = buildSqsClientConfig(CONFIG);
    expect(config.requestHandler).toMatchObject({
      requestTimeout: SQS_REQUEST_TIMEOUT_MS,
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
    });
  });

  it('keeps both timeouts finite and short enough to fail fast', () => {
    expect(Number.isFinite(SQS_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(Number.isFinite(SQS_CONNECTION_TIMEOUT_MS)).toBe(true);
    expect(SQS_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SQS_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SQS_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('keeps the endpoint, region and credentials it is given', () => {
    expect(buildSqsClientConfig(CONFIG)).toMatchObject({
      endpoint: 'http://localhost:4566',
      region: 'ap-south-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('omits the endpoint for real AWS', () => {
    const config = buildSqsClientConfig({ ...CONFIG, SQS_ENDPOINT: undefined });
    expect(config).not.toHaveProperty('endpoint');
  });
});
