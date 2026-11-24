import { getConfig } from './config.js';
import { hitWithin } from './counters.js';
import { logger } from './logger.js';

// The LLM spend kill switch and daily ceiling (story 7.12.7). Every provider call, primary or
// backup, in both stages passes assertLlmSpendAllowed() first, so the counted unit is one LLM
// request, matching the 12-calls-per-ticket bound in docs/abuse-protection.md.
//
// Three states, so the switch is unambiguous:
//   LLM_DAILY_CAP unset -> no ceiling. A local run and CI reach no Redis for this.
//   LLM_DAILY_CAP=0     -> kill switch: every call is refused before it reaches a provider.
//   LLM_DAILY_CAP=N>0   -> at most N calls in the UTC day, then refused.
// It MUST stay fail-closed: a Redis that cannot answer refuses the call rather than letting
// spend through, the same rule the submission and email guards follow.
const KEY_PREFIX = 'llm:day:';

/** Raised when LLM spend is switched off, the day's budget is spent, or the counter fails. */
export class LlmSpendCapReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmSpendCapReached';
  }
}

// The window runs to the next UTC midnight plus an hour, so a key whose expiry is set late still
// covers its own day and can never leak into the next one (the key name carries the date).
const WINDOW_SECONDS = 86400 + 3600;

const dayKey = (now: Date) => `${KEY_PREFIX}${now.toISOString().slice(0, 10)}`;

/** True when any LLM spend limit is configured, including the 0 kill switch. */
export function isLlmSpendCapped(): boolean {
  return getConfig().LLM_DAILY_CAP !== undefined;
}

/**
 * Counts one LLM call against the UTC day and throws LlmSpendCapReached when the cap is spent.
 * With the cap at 0 the call is refused before Redis is reached: that is the kill switch. The
 * message is a fixed code: no ticket text, model output or provider text ever reaches it.
 */
export async function assertLlmSpendAllowed(now: Date = new Date()): Promise<void> {
  const cap = getConfig().LLM_DAILY_CAP;
  if (cap === undefined) return;

  if (cap === 0) {
    logger.warn('LLM spend is switched off (LLM_DAILY_CAP=0); refusing the provider call');
    throw new LlmSpendCapReached('LLM spend is switched off (LLM_DAILY_CAP=0)');
  }

  let count: number;
  try {
    count = await hitWithin(dayKey(now), WINDOW_SECONDS);
  } catch (err) {
    logger.error({ err }, 'LLM spend counter unavailable');
    throw new LlmSpendCapReached('LLM daily spend cap could not be checked');
  }

  if (count > cap) {
    logger.warn({ count, cap }, 'LLM daily spend cap reached');
    throw new LlmSpendCapReached(`LLM daily spend cap reached (${cap} calls)`);
  }
}
