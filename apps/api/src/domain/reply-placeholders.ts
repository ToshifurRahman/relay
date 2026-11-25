// Draft models copy email templates and end replies with `[Your Name]`, `[Company Name]` and
// similar fill-in-the-blank slots. A customer must never see one, so the worker strips them from
// `customer_reply` before the safety guard runs. A signature block made only of placeholders
// becomes the team sign-off; an inline slot ("Dear [Customer Name],") is removed in place.
//
// Only brackets that name a person, role or contact detail count, so ordinary bracketed prose
// such as "Open Settings [Billing]" is left alone.

// The one sign-off the draft prompt asks for and the stripper falls back to.
export const REPLY_SIGN_OFF = 'The Relay support team';

const SLOT_WORDS =
  'name|position|title|role|company|organi[sz]ation|department|contact|information|phone|email|signature';
const SLOT = `\\[[^\\[\\]\\n]{0,40}\\b(?:${SLOT_WORDS})\\b[^\\[\\]\\n]{0,40}\\]`;

const SLOT_ANYWHERE = new RegExp(SLOT, 'i');
const SLOT_WITH_SPACE = new RegExp(`[ \\t]*${SLOT}`, 'gi');
const SLOT_ALL = new RegExp(SLOT, 'gi');
// What may remain on a line that held only placeholders: spacing and separators.
const ONLY_SEPARATORS = /^[\s,.;:|\-–—]*$/;
// "Best regards," / "Thanks," : a short line ending in a comma, waiting for a signature.
const DANGLING_CLOSING = /^[^\n]{1,40},$/;

export function stripReplyPlaceholders(reply: string, signOff: string = REPLY_SIGN_OFF): string {
  if (!SLOT_ANYWHERE.test(reply)) return reply;

  let droppedSignatureLine = false;
  const lines: string[] = [];
  for (const line of reply.split('\n')) {
    if (!SLOT_ANYWHERE.test(line)) {
      lines.push(line);
      continue;
    }
    if (ONLY_SEPARATORS.test(line.replace(SLOT_ALL, ''))) {
      droppedSignatureLine = true;
      continue;
    }
    lines.push(
      line
        .replace(SLOT_WITH_SPACE, '')
        .replace(/^[ \t]+/, '')
        .trimEnd()
    );
  }

  let out = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lastLine = out.slice(out.lastIndexOf('\n') + 1).trim();
  if (droppedSignatureLine && DANGLING_CLOSING.test(lastLine)) out += `\n${signOff}`;
  return out;
}
