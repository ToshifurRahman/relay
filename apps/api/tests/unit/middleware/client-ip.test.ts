import { describe, expect, it } from 'vitest';

import { clientIp } from '../../../src/middleware/client-ip.js';

const header = (value: string | undefined) => ({ req: { header: () => value } });

// A request carrying several headers, so a test can set X-Forwarded-For and CF-Connecting-IP
// independently.
const headers = (values: Record<string, string | undefined>) => ({
  req: { header: (name: string) => values[name.toLowerCase()] },
});

describe('clientIp', () => {
  it('takes the last X-Forwarded-For hop, ignoring a spoofed first hop', () => {
    expect(clientIp(header('203.0.113.9, 198.51.100.4, 192.0.2.7'))).toBe('192.0.2.7');
  });

  it('trims whitespace and skips empty hops', () => {
    expect(clientIp(header(' 203.0.113.9 , , 192.0.2.7 '))).toBe('192.0.2.7');
  });

  it("falls back to 'local' when the header is absent", () => {
    expect(clientIp(header(undefined))).toBe('local');
    expect(clientIp(header(''))).toBe('local');
  });

  // SEC-02: the live service sits behind Cloudflare, which appends its own edge address to
  // X-Forwarded-For before Render appends the edge it saw. The last hop is therefore the
  // Cloudflare edge, shared by every caller behind that PoP, so keying the rate limit and the
  // sign-in lockout on it lets one caller lock out everyone. Cloudflare's CF-Connecting-IP
  // carries the real client and is overwritten by Cloudflare, so it wins when present.
  it('prefers CF-Connecting-IP over the last X-Forwarded-For hop', () => {
    expect(
      clientIp(
        headers({
          'x-forwarded-for': '203.0.113.9, 198.51.100.4, 172.70.0.1',
          'cf-connecting-ip': '203.0.113.9',
        })
      )
    ).toBe('203.0.113.9');
  });

  it('ignores a CF-Connecting-IP that is not an address', () => {
    expect(
      clientIp(
        headers({
          'x-forwarded-for': '203.0.113.9, 192.0.2.7',
          'cf-connecting-ip': 'not-an-address',
        })
      )
    ).toBe('192.0.2.7');
    expect(
      clientIp(headers({ 'x-forwarded-for': '192.0.2.7', 'cf-connecting-ip': '1.2.3.4:80' }))
    ).toBe('192.0.2.7');
  });

  it('accepts an IPv6 CF-Connecting-IP', () => {
    expect(clientIp(headers({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('uses CF-Connecting-IP when X-Forwarded-For is absent', () => {
    expect(clientIp(headers({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  // The header is only trusted when it holds a real address: a malformed value must not become
  // the rate-limit or lockout key, or a caller could pick its own key by sending junk.
  it.each([':::', '::::', '2001:db8:::1', '256.0.0.1', '1.2.3.4:80', '1.2.3', ''])(
    'ignores the malformed CF-Connecting-IP %j',
    (value) => {
      expect(clientIp(headers({ 'x-forwarded-for': '192.0.2.7', 'cf-connecting-ip': value }))).toBe(
        '192.0.2.7'
      );
    }
  );

  it('accepts a compressed and a full IPv6 address', () => {
    expect(clientIp(headers({ 'cf-connecting-ip': '::1' }))).toBe('::1');
    expect(
      clientIp(headers({ 'cf-connecting-ip': '2001:0db8:0000:0000:0000:0000:0000:0001' }))
    ).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
  });
});
