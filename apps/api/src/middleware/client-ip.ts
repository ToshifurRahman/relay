import { isIP } from 'node:net';

// Trust boundary: the service is reachable only through Cloudflare, which fronts Render's proxy
// (both the service host and Render's origin host resolve to Cloudflare CDN, and Cloudflare
// rejects a client-supplied CF-Connecting-IP with error 1000). Under that sole-ingress topology
// the header is Cloudflare's own and can be trusted. If the service were ever exposed behind a
// non-Cloudflare proxy, or reachable at the Render origin directly, a caller could set the header
// and choose its own rate-limit and sign-in-lockout key; origin lockdown is what keeps that true.
//
// X-Forwarded-For is a chain: the client may write the early hops, Cloudflare appends its edge
// address and Render appends the edge it saw, so the last hop is a Cloudflare address shared by
// every caller behind that PoP. Keying a rate limit or a sign-in lockout on it would let one
// caller lock out everyone, so the header Cloudflare owns wins when it holds an address. Locally
// there is no proxy and neither header is present.
export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const connecting = c.req.header('cf-connecting-ip')?.trim();
  if (connecting && isIP(connecting) !== 0) return connecting;

  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? 'local';
}
