import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

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
});
