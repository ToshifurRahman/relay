// Story 7.12.8 AI safety: the last check on text a customer can see.
//
// `customer_reply` is written by a model, so it is untrusted output. A compromised, injected or
// simply confused model can echo the system prompt, dump internal fields, paste a stack trace,
// leak a key, or emit HTML. The worker runs this guard before it persists the draft; a reply that
// fails is never stored and never served, and the ticket goes to `needs_attention` for ops.
//
// The reason codes are fixed strings. The offending text is never copied into the result, so the
// guard's output is safe to log and safe to write into a ticket event detail.

export const MAX_CUSTOMER_REPLY_LENGTH = 4000;

export type ReplyRejection =
  | 'empty'
  | 'too_long'
  | 'control_chars'
  | 'prompt_leak'
  | 'internal_fields'
  | 'unauthorized_promise'
  | 'secret'
  | 'stack_trace'
  | 'markup';

export type ReplyCheck = { safe: true } | { safe: false; reason: ReplyRejection };

// Phrases that only appear when a model talks about its own instructions rather than the ticket.
const PROMPT_LEAK = [
  /system prompt/i,
  /<\|[^|<>]*\|>/,
  /\[\/?INST\]/,
  /ignore (?:all )?(?:the )?(?:previous|prior|above) instructions/i,
  /\bdeveloper mode\b/i,
  /\b(?:system|assistant)\s*:/i,
  /you are (?:a|an|now)\b[^.]{0,60}\b(?:assistant|agent|ai|model)\b/i,
];

// Names that exist only inside the pipeline, or JSON that carries them.
const INTERNAL_FIELDS = [
  /\binternal[_ ]?note\b/i,
  /\brecommended[_ ]?team\b/i,
  /\bissue[_ ]?summary\b/i,
  /\bcustomer[_ ]?reply\b/i,
  /\bnext[_ ]?steps\b/i,
  /\breasoning\s*:/i,
  /\bconfidence\s*:\s*\d/i,
  /\bprovider\s*:/i,
  /\bmodel\s*:\s*\S+\/\S+/i,
];

// The AI reply is shown to the customer as the support team's answer, so it must not assert that
// an irreversible action was already taken: nothing in the pipeline performs refunds, unlocks,
// cancellations or deletions, and a model that claims one is inventing a commitment the team never
// made. Forwarding the request ("passed this to billing") is fine; "we have refunded it" is not.
const UNAUTHORIZED_PROMISE = [
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:refunded|reimbursed|credited|reversed|charged back)\b/i,
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:unlocked|restored|reactivated)\b/i,
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:cancell?ed|terminated|suspended|closed)\s+(?:your|the|this)\b/i,
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:deleted|erased|purged|removed)\s+(?:your|the|this)\b/i,
  /\byour\s+(?:refund|account|subscription|data)\s+(?:has\s+been|is\s+now)\s+(?:processed|issued|completed|cancell?ed|deleted|unlocked|restored)\b/i,
];

const SECRETS = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@\S+/i,
  /\brediss?:\/\/[^\s:@/]*:[^\s@/]+@\S+/i,
];

const STACK_TRACE = /\n\s+at\s+\S+\s*\([^)]*:\d+:\d+\)/;

const MARKUP = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /\bon[a-z]+\s*=\s*["']?[^"'>]*["']?/i,
  /javascript\s*:/i,
  /data:text\/html/i,
];

// A control character in customer-visible text is never legitimate: it hides content from a
// reader and can smuggle markup past a later renderer. Detected by code point so the source
// carries no literal control characters.
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const keepable = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 || (code >= 0x7f && code <= 0x9f)) && !keepable) return true;
  }
  return false;
}

export function checkCustomerReply(reply: string): ReplyCheck {
  if (typeof reply !== 'string' || reply.trim() === '') return { safe: false, reason: 'empty' };
  if (reply.length > MAX_CUSTOMER_REPLY_LENGTH) return { safe: false, reason: 'too_long' };
  if (hasControlChars(reply)) return { safe: false, reason: 'control_chars' };
  if (PROMPT_LEAK.some((re) => re.test(reply))) return { safe: false, reason: 'prompt_leak' };
  if (INTERNAL_FIELDS.some((re) => re.test(reply)))
    return { safe: false, reason: 'internal_fields' };
  if (UNAUTHORIZED_PROMISE.some((re) => re.test(reply)))
    return { safe: false, reason: 'unauthorized_promise' };
  if (SECRETS.some((re) => re.test(reply))) return { safe: false, reason: 'secret' };
  if (STACK_TRACE.test(reply)) return { safe: false, reason: 'stack_trace' };
  if (MARKUP.some((re) => re.test(reply))) return { safe: false, reason: 'markup' };
  return { safe: true };
}
