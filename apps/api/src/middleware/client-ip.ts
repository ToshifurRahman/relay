// Behind Cloudflare and Render's proxy the caller's address arrives in CF-Connecting-IP, which
// Cloudflare sets (and overwrites) at its edge. X-Forwarded-For is a chain: the client may write
// the early hops, Cloudflare appends its edge address and Render appends the edge it saw, so the
// last hop is a Cloudflare address shared by every caller behind that PoP. Keying a rate limit or
// a sign-in lockout on it would let one caller lock out everyone, so the header Cloudflare owns
// wins when it holds an address. Locally there is no proxy and neither header is present.
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function isAddress(value: string): boolean {
  if (IPV4.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  return value.includes(':') && IPV6.test(value);
}

export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const connecting = c.req.header('cf-connecting-ip')?.trim();
  if (connecting && isAddress(connecting)) return connecting;

  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? 'local';
}
