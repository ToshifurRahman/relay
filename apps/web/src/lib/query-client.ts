import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api';

// A 4xx will not fix itself, with two exceptions: a 408 is this client's own timeout (a cold
// start or a stalled connection, both worth another try) and a 429 is a rate limit that clears.
const RETRYABLE_4XX = new Set([408, 429]);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // Only retry network errors, 5xx, a timeout and a rate limit.
        retry: (failureCount, error) =>
          !(
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            !RETRYABLE_4XX.has(error.status)
          ) && failureCount < 2,
      },
    },
  });
}
