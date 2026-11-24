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

// Every internal label a dump can print. One set feeds the quoted-key arm and both prose pairing
// arms, so a label cannot be handled in one arm and forgotten in another.
const INTERNAL_LABELS = 'confidence|category|priority|sentiment|escalate|model|provider|reasoning';
const INTERNAL_LABEL = `\\b(?:${INTERNAL_LABELS})\\s*:`;

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
  new RegExp(`["'](?:${INTERNAL_LABELS})["']\\s*:`, 'i'),
  /\bconfidence\s*:\s*(?:0?\.\d+|\d{1,3}\s*%)/i,
  // Prose labels still mean a dump, but only when they cannot be ordinary prose. `reasoning:` is a
  // label at the start of a line or beside another internal label; "I understand your reasoning:…"
  // is a sentence and stays safe.
  /(?:^|\n)\s*reasoning\s*:/i,
  new RegExp(`\\breasoning\\s*:[^\\n]{0,80}${INTERNAL_LABEL}`, 'i'),
  new RegExp(`${INTERNAL_LABEL}[^\\n]{0,80}\\breasoning\\s*:`, 'i'),
  /\bmodel\s*:\s*(?:[a-z0-9._-]+\/[a-z0-9._-]+|(?:gpt|gemini|claude|deepseek|llama)-[a-z0-9._-]+)/i,
  // A real company name is ordinary support prose ("contact your provider: Google"), so a gateway
  // name counts only beside a second internal label, which a metadata dump always has.
  new RegExp(
    `\\bprovider\\s*:\\s*(?:groq|openai|google|anthropic|portkey|openrouter|cerebras|together|mistral|cohere)\\b[^\\n]{0,80}${INTERNAL_LABEL}`,
    'i'
  ),
  new RegExp(
    `${INTERNAL_LABEL}[^\\n]{0,80}\\bprovider\\s*:\\s*(?:groq|openai|google|anthropic|portkey|openrouter|cerebras|together|mistral|cohere)\\b`,
    'i'
  ),
];

// The AI reply is shown to the customer as the support team's answer, so it must not assert that
// an irreversible action was taken or promise one: nothing in the pipeline performs refunds,
// unlocks, cancellations or deletions, and a model that says so is inventing a commitment the team
// never made. Forwarding the request ("passed this to billing") is fine.
//
// A refund *request* is not a refund: a following `request`, `inquiry`, `ticket` or `case` turns the
// promise into forwarding work, so those forms are excluded.
const REQUEST_NOUN = '(?!\\s+(?:request|inquiry|enquiry|ticket|case)\\b)';

// A passive deletion is a promise whichever object it names and whichever form it takes: "will be
// deleted", "would be deleted", "has already been deleted", "were all removed", "is being purged",
// "are going to be deleted", "got deleted". The adverb slot between the auxiliary and the participle
// is what a model writes when it restates a deletion casually. The one exception is the retention
// statement about the ticket's own lifecycle, which RETENTION_POLICY removes before the arms run.
const DELETION_VERB = String.raw`(?:deleted|removed|erased|purged)`;
const PASSIVE_ADVERB = String.raw`already|all|just|recently|now|finally|fully|both|permanently|automatically|immediately|completely`;
const DELETION_ADVERB = String.raw`${PASSIVE_ADVERB}|soon|shortly`;
const PASSIVE_DELETION = String.raw`\b(?:(?:will|shall|would)\s+(?:(?:${PASSIVE_ADVERB})\s+)?be|(?:has|have|had)\s+(?:(?:${PASSIVE_ADVERB})\s+)?been|(?:is|are|was|were)(?:\s+(?:${PASSIVE_ADVERB}))?(?:\s+(?:being|going\s+to\s+be))?|got|gets|get|(?:has|have|had)\s+(?:(?:${PASSIVE_ADVERB})\s+)?gotten|(?:will|shall|would)\s+get|(?:is|are|was|were)\s+getting)\s+(?:(?:${DELETION_ADVERB})\s+)?${DELETION_VERB}\b`;

const UNAUTHORIZED_PROMISE = [
  // Past / perfect: the action is presented as already done.
  /\b(?:I|we)(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:refunded|reimbursed|credited|reversed|charged back)\b/i,
  /\b(?:I|we)(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:unlocked|restored|reactivated)\b/i,
  /\b(?:I|we)(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:cancell?ed|terminated|suspended|closed)\s+(?:your|the|this)\b/i,
  /\b(?:I|we)(?:['\u2019]ve| have| had)?\s+(?:now\s+)?(?:deleted|erased|purged|removed)\s+(?:your|the|this)\b/i,
  /\byour\s+(?:refund|account|subscription|data)\s+(?:has\s+been|is\s+now)\s+(?:processed|issued|completed|cancell?ed|deleted|unlocked|restored)\b/i,
  // Future / active: the same unauthorised commitment, stated in advance.
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:refund|reimburse|credit)\b/i,
  new RegExp(
    `\\b(?:I|we)(?:['\\u2019](?:ll|m|re)| will| am| are)\\s+(?:now\\s+)?(?:issu\\w*|process\\w*|send\\w*|prepar\\w*|approv\\w*|releas\\w*)\\s+(?:a|the|your)\\s+(?:full\\s+)?(?:refund|credit|reimbursement|cancellation)\\b${REQUEST_NOUN}`,
    'i'
  ),
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:unlock|restore|reactivate)\s+(?:your|the|this)\b/i,
  /\b(?:I|we)(?:['\u2019](?:ll|m|re)| will| am| are)\s+(?:now\s+)?(?:cancell?|terminate|suspend|close|delete|erase|purge|remove)\s+(?:your|the|this)\s+(?:account|subscription|service|data|order|profile)\b/i,
  new RegExp(
    `\\byou(?:['\\u2019]ll| will)\\s+(?:receive|get)\\s+(?:a\\s+|your\\s+)?(?:full\\s+)?(?:refund|credit|reimbursement)\\b${REQUEST_NOUN}`,
    'i'
  ),
  /\byour\s+(?:refund|credit|reimbursement|account|subscription)\s+(?:will|shall)\s+be\s+(?:processed|issued|paid|completed|refunded|credited|unlocked|restored|cancell?ed|deleted|closed)\b/i,
  // A passive deletion is a promise whichever object it names. The one exception is the retention
  // statement about the ticket's own lifecycle, which RETENTION_POLICY removes before this runs.
  new RegExp(PASSIVE_DELETION, 'i'),
  /\b(?:will|shall)\s+be\s+(?:refunded|credited|reimbursed|unlocked|restored|cancell?ed|closed)\b/i,
];

// Privacy copy tells a customer that the ticket itself is removed under a retention policy or after
// a retention window. That is policy, not a commitment to delete an account, a message or a file, so
// exactly that clause is exempted from the passive deletion arm. The match stops at the qualifier,
// never crosses a comma, semicolon or full stop, the gap before the verb cannot span a second
// passive deletion, and the tail before the qualifier is an allowlist of locative phrases only, so a
// comma-free compound ("... will be deleted and your account will be deleted after 30 days") or a
// promise clause ("... will be deleted so I refunded the charge after 30 days") leaves the promise
// visible to the arms.
const RETENTION_WINDOW = String.raw`\s+(?:after|within|in)\s+\d+\s+(?:days?|weeks?|months?|years?)\b`;
const RETENTION_POLICY_LABEL = String.raw`(?:per|under|pursuant\s+to|in\s+line\s+with)\s+(?:our|the|its)\s+(?:\d+[-\s]?day\s+)?retention\s+polic(?:y|ies)\b`;
const RETENTION_ADVERB = String.raw`permanently|fully|securely|automatically`;
const RETENTION_TAIL = String.raw`(?:(?:\s+(?:${RETENTION_ADVERB}))?(?:\s+(?:from|in|at|within)\s+(?:our|the|its)\s+[a-z][a-z-]{1,19}|\s+(?:${RETENTION_ADVERB}))){0,2}`;
const RETENTION_SUBJECT = String.raw`\b(?:your|the)\s+ticket\b(?:(?!${PASSIVE_DELETION})[^.!?\n,;]){0,80}?\b(?:will|shall)\s+be\s+${DELETION_VERB}\b`;

const RETENTION_POLICY = new RegExp(
  `${RETENTION_POLICY_LABEL}[,\\s]*${RETENTION_SUBJECT}|${RETENTION_SUBJECT}${RETENTION_TAIL}(?:${RETENTION_WINDOW}|\\s+${RETENTION_POLICY_LABEL})`,
  'gi'
);

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
  if (UNAUTHORIZED_PROMISE.some((re) => re.test(reply.replace(RETENTION_POLICY, ' '))))
    return { safe: false, reason: 'unauthorized_promise' };
  if (SECRETS.some((re) => re.test(reply))) return { safe: false, reason: 'secret' };
  if (STACK_TRACE.test(reply)) return { safe: false, reason: 'stack_trace' };
  if (MARKUP.some((re) => re.test(reply))) return { safe: false, reason: 'markup' };
  return { safe: true };
}
