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
// Bare `system:`/`assistant:` is deliberately absent: "The system: a quick restart clears this" is
// ordinary support prose. A real role spoof uses a chat-template token, which is still caught.
const PROMPT_LEAK = [
  /system prompt/i,
  /<\|[^|<>]*\|>/,
  /\[\/?INST\]/,
  /ignore (?:all )?(?:the )?(?:previous|prior|above) instructions/i,
  /\bdeveloper mode\b/i,
  /you are (?:a|an|now)\b[^.]{0,60}\b(?:assistant|agent|ai|model)\b/i,
];

// Pipeline field names and the JSON keys that carry them, matched as identifiers or quoted keys.
// Bare prose must pass: "Here are the next steps" and "contact your provider: Acme" are ordinary
// support language, while `next_steps`, `nextSteps` and `"provider":` are a dump of internal state.
const INTERNAL_FIELDS = [
  /\binternal_note\b/i,
  /\binternalNote\b/,
  /\brecommended_team\b/i,
  /\brecommendedTeam\b/,
  /\bissue_summary\b/i,
  /\bissueSummary\b/,
  /\bcustomer_reply\b/i,
  /\bcustomerReply\b/,
  /\bnext_steps\b/i,
  /\bnextSteps\b/,
  /["'](?:reasoning|confidence|provider|model|category|priority|sentiment|escalate)["']\s*:/i,
  /\bconfidence\s*:\s*(?:0?\.\d+|\d{1,3}\s*%)/i,
];

// The AI reply is shown to the customer as the support team's answer, so it must not assert that
// an irreversible action was taken or promise one: nothing in the pipeline performs refunds,
// unlocks, cancellations or deletions, and a model that says so is inventing a commitment the team
// never made. Forwarding the request ("passed this to billing") is fine.
const UNAUTHORIZED_PROMISE = [
  // Past / perfect: the action is presented as already done.
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:refunded|reimbursed|credited|reversed|charged back)\b/i,
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:unlocked|restored|reactivated)\b/i,
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:cancell?ed|terminated|suspended|closed)\s+(?:your|the|this)\b/i,
  /\bwe(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:deleted|erased|purged|removed)\s+(?:your|the|this)\b/i,
  /\byour\s+(?:refund|account|subscription|data)\s+(?:has\s+been|is\s+now)\s+(?:processed|issued|completed|cancell?ed|deleted|unlocked|restored)\b/i,
  // Future / active: the same unauthorised commitment, stated in advance.
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:refund|reimburse|credit)\b/i,
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:issu\w*|process\w*|send\w*|approv\w*|prepar\w*|releas\w*)\s+(?:a|the|your)\s+(?:full\s+)?(?:refund|credit|reimbursement)\b/i,
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:unlock|restore|reactivate)\s+(?:your|the|this)\b/i,
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:cancell?|terminate|suspend|close|delete|erase|purge|remove)\s+(?:your|the|this)\s+(?:account|subscription|service|data|order|profile)\b/i,
  /\byou(?:['\u2019]ll| will)\s+(?:receive|get)\s+(?:a\s+|your\s+)?(?:full\s+)?(?:refund|credit|reimbursement)\b/i,
  /\byour\s+(?:refund|credit|reimbursement|account|subscription)\s+(?:will|shall)\s+be\s+(?:processed|issued|paid|completed|refunded|credited|unlocked|restored|cancell?ed|deleted|closed)\b/i,
  /\b(?:will|shall)\s+be\s+(?:refunded|credited|reimbursed|unlocked|restored|cancell?ed|deleted|closed)\b/i,
];

const SECRETS = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@\S+/i,
  /\brediss?:\/\/[^\s:@/]*:[^\s@/]+@\S+/i,
];

const STACK_TRACE = /\n\s+at\s+\S+\s*\([^)]*:\d+:\d+\)/;

// An event handler only means anything inside a tag, and names are an explicit list so that an
// ordinary word such as "one = two" is not mistaken for an `on*=` attribute.
const HTML_EVENT_HANDLER =
  /<\s*[a-z][a-z0-9]*\b[^<>]*\bon(?:click|dblclick|error|load|mouseover|mouseenter|mousemove|mouseout|focus|blur|submit|change|input|keydown|keyup|keypress|touchstart|touchend|animationstart|transitionend|toggle|pointerover|pointerdown|wheel|scroll|copy|paste|cut|drag|drop)\s*=/i;

const MARKUP = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /<\s*svg\b/i,
  HTML_EVENT_HANDLER,
  /javascript\s*:/i,
  /data:text\/html/i,
  // A reply is rendered as text, so a markdown link is never a real link: `[label](url)` can only
  // disguise where it points. Plain URLs stay readable and are allowed.
  /!?\[[^\]\n]{1,200}\]\(\s*(?:https?:\/\/|\/\/|www\.|\/)[^)\s]*\s*\)/i,
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
