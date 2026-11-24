import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

// Story 7.12.10 portfolio readiness: this repository is the project's public face, so the files a
// visitor reads first must be true. These checks are deterministic and local (no network, no
// Docker) and pin the five audited surfaces: the LICENSE, README and docs links, the README's own
// claims, and the screenshots it embeds.

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const README = path.join(ROOT, 'README.md');
const DOCS = path.join(ROOT, 'docs');

const read = (file: string) => readFileSync(file, 'utf8');

type RootManifest = { license?: string; engines: { node: string } };
const manifest = (): RootManifest =>
  JSON.parse(read(path.join(ROOT, 'package.json'))) as RootManifest;

type DecodedPng = { width: number; height: number; pixels: Uint8Array; channels: number };

/**
 * Decodes an 8-bit RGB/RGBA PNG using only Node's zlib, so the screenshot check needs no image
 * dependency and stays deterministic. Enough of the format for a browser screenshot: IHDR, the
 * concatenated IDAT stream, and the five scanline filters.
 */
function decodePng(file: string): DecodedPng {
  const buffer = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[rowStart + x] = value & 0xff;
    }
  }
  return { width, height, pixels, channels };
}

/** The page background is the most common pixel colour; anything far from it is content. */
function modalColor(image: DecodedPng): [number, number, number] {
  const tally = new Map<string, number>();
  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) {
      const i = (y * image.width + x) * image.channels;
      const key = `${image.pixels[i]},${image.pixels[i + 1]},${image.pixels[i + 2]}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const [winner] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [r, g, b] = winner[0].split(',').map(Number);
  return [r, g, b];
}

function isContent(image: DecodedPng, background: [number, number, number], i: number): boolean {
  return (
    Math.abs(image.pixels[i] - background[0]) > 10 ||
    Math.abs(image.pixels[i + 1] - background[1]) > 10 ||
    Math.abs(image.pixels[i + 2] - background[2]) > 10
  );
}

/** Rows from `fromRow` to the bottom that carry more than two pixels of non-background content. */
function contentRows(image: DecodedPng, fromRow: number): number {
  const background = modalColor(image);
  let rows = 0;
  for (let y = fromRow; y < image.height; y++) {
    let hits = 0;
    for (let x = 0; x < image.width && hits <= 2; x++) {
      if (isContent(image, background, (y * image.width + x) * image.channels)) hits++;
    }
    if (hits > 2) rows++;
  }
  return rows;
}

function lastContentRow(image: DecodedPng): number {
  const background = modalColor(image);
  for (let y = image.height - 1; y >= 0; y--) {
    for (let x = 0; x < image.width; x++) {
      if (isContent(image, background, (y * image.width + x) * image.channels)) return y;
    }
  }
  return -1;
}

/** Markdown inline links and images, minus anchor-only targets and absolute URLs. */
function relativeLinks(markdown: string): string[] {
  const links: string[] = [];
  const pattern = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    const target = raw.split('#')[0];
    if (target) links.push(target);
  }
  return links;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

describe('portfolio: LICENSE', () => {
  it('has a non-empty MIT LICENSE at the repository root', () => {
    const license = path.join(ROOT, 'LICENSE');
    expect(existsSync(license)).toBe(true);
    const text = read(license);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('MIT License');
    expect(text).toContain('Md. Toshifur Rahman');
  });

  it('declares the same licence in the root package.json', () => {
    expect(manifest().license).toBe('MIT');
  });
});

describe('portfolio: README and docs links', () => {
  it('resolves every relative link in README.md to a real file', () => {
    const broken = relativeLinks(read(README)).filter(
      (target) => !existsSync(path.resolve(ROOT, target))
    );
    expect(broken).toEqual([]);
  });

  it('resolves every relative link in the feature docs to a real file', () => {
    const docs = markdownFiles(DOCS).filter(
      (file) => !file.includes(`${path.sep}audit${path.sep}`)
    );
    const broken: string[] = [];
    for (const file of docs) {
      for (const target of relativeLinks(read(file))) {
        if (!existsSync(path.resolve(path.dirname(file), target))) {
          broken.push(`${path.relative(ROOT, file)} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('portfolio: README truthfulness', () => {
  const readme = read(README);

  it('points CI and browse links at ToshifurRahman/relay, not the old repo name', () => {
    expect(readme).not.toContain('github.com/ToshifurRahman/ticket-pipe');
    expect(readme).toContain('github.com/ToshifurRahman/relay');
  });

  it('documents the live demo URL', () => {
    expect(readme).toContain('https://ticket-pipeline.onrender.com');
  });

  it('warns about the free-tier cold start', () => {
    expect(readme.toLowerCase()).toContain('cold start');
  });

  it('asks visitors not to submit real personal data', () => {
    expect(readme.toLowerCase()).toMatch(/do not submit (any )?real/);
  });

  it('documents the ElasticMQ / SQS endpoint option', () => {
    expect(readme).toContain('ElasticMQ');
    expect(readme).toContain('SQS_ENDPOINT');
  });

  it('states the Node version the repository actually requires', () => {
    const minimum = manifest().engines.node.replace(/[^0-9.]/g, '');
    expect(readme).toContain(minimum);
  });
});

describe('portfolio: screenshots', () => {
  it('ships every screenshot README.md embeds, each non-empty', () => {
    const embedded = relativeLinks(read(README)).filter((target) =>
      target.startsWith('docs/screenshots/')
    );
    expect(embedded.length).toBeGreaterThan(0);
    const problems = embedded.filter((target) => {
      const file = path.resolve(ROOT, target);
      return !existsSync(file) || statSync(file).size === 0;
    });
    expect(problems).toEqual([]);
  });

  it('captures the phone screenshot without motion, so the ticket thread is not clipped', () => {
    const script = read(path.join(ROOT, 'scripts/screenshots.ts'));
    const phone = script.indexOf('const phone = await browser.newContext(');
    expect(phone).toBeGreaterThan(-1);
    const phoneBlock = script.slice(phone, script.indexOf('// The ops console', phone));
    expect(phoneBlock).toContain("reducedMotion: 'reduce'");
    expect(phoneBlock).toContain("animations: 'disabled'");
  });

  it('is not a blank capture of mobile-ticket.png', () => {
    // A capture taken mid print-in animation is clipped to its header: content stops around row 500
    // of 1688 and the thread, customer message and reply never reach the file. With motion off the
    // capture fills the page and carries content to the footer. This checks for a header-only blank,
    // not for the shot covering the page's full scroll height: a viewport-height crop of the current
    // page also clears both thresholds.
    const image = decodePng(path.join(ROOT, 'docs/screenshots/mobile-ticket.png'));
    expect(contentRows(image, 0) / image.height).toBeGreaterThanOrEqual(0.7);
    expect(lastContentRow(image)).toBeGreaterThan(image.height - 100);
  });
});

describe('portfolio: ops alert subject', () => {
  it('does not document the retired [Ticket Pipe] alert subject', () => {
    expect(read(path.join(ROOT, 'docs/ops.md'))).not.toContain('[Ticket Pipe]');
  });
});
