import type { FieldErrors } from './types';

// Story 7.12.3 (REL-06): a request that never answers must not leave the UI loading forever.
// On Render's free plan the service spins down and the first request after a cold start can hang
// for many seconds; a black-holed connection never answers at all. React Query only retries a
// request that rejects, so without this bound a hung fetch leaves the page on its skeleton with
// no error and no retry. 30s covers a cold start and still fails a dead connection. The timeout
// is reported as a 408, which `query-client.ts` retries.
export const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** Field-level messages from a 400, or null when the body has no `errors` map. */
  get fieldErrors(): FieldErrors | null {
    const errors = (this.body as { errors?: unknown } | null)?.errors;
    return errors && typeof errors === 'object' ? (errors as FieldErrors) : null;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Settles with `promise`, or rejects with the signal's reason as soon as it aborts. The body read
 * needs this: aborting the fetch after the headers have arrived does not reliably cancel a body
 * that is already streaming, so the read is raced against the same signal.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

function timeoutError(): ApiError {
  return new ApiError(408, null, 'The request timed out. Please try again.');
}

export interface RequestOptions extends RequestInit {
  /** Overrides REQUEST_TIMEOUT_MS. Tests use a short value. */
  timeoutMs?: number;
}

// Same-origin only: the Vite proxy covers dev and Express covers production, so there is no
// base URL. `credentials` is explicit so the ops cookie session (6.5) needs no change here.
export async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  // A caller's own signal still works: the timeout signal aborts the fetch, and the caller's
  // abort is chained onto it so either one cancels the request. A signal that is already aborted
  // never fires its listener, so it is checked first: the request is not sent at all.
  const callerSignal = rest.signal;
  if (callerSignal?.aborted) throw callerSignal.reason as Error;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(path, {
        ...rest,
        headers,
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch (err) {
      // A timeout aborts the fetch; report it as a 408 so callers and React Query treat it as a
      // retryable failure rather than a network error with no status.
      if (controller.signal.aborted && !callerSignal?.aborted) throw timeoutError();
      throw err;
    }

    // The timer stays armed through the body: a server can send its headers and then stall, and
    // clearing it here would leave the page loading forever.
    let body: unknown;
    try {
      body = await raceAbort(readBody(res), controller.signal);
    } catch (err) {
      if (controller.signal.aborted && !callerSignal?.aborted) throw timeoutError();
      throw err;
    }

    if (!res.ok) {
      const message = (body as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, body, typeof message === 'string' ? message : undefined);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
