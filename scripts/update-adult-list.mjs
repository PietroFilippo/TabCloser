// Maintainer-only update: the extension never downloads lists or sends browsing
// data. Pin the upstream revision, validate the data, and review the diff.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parse } from 'tldts';
const directory = new URL('../data/', import.meta.url);
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return response;
}
const revision = process.argv[2] || (await (await download('https://api.github.com/repos/blocklistproject/Lists/commits/main')).json()).sha;
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full upstream commit SHA.');
const base = `https://raw.githubusercontent.com/blocklistproject/Lists/${revision}/`;
const [input, license] = await Promise.all(['alt-version/porn-nl.txt', 'LICENSE'].map(async file => (await download(base + file)).text()));
if (!license.includes('public domain') || !license.includes('unlicense.org')) throw new Error('Upstream license changed; review before importing.');
// Keep mixed-content platforms available. X has its own media protection.
// Specific adult subdomains on shared hosts can still be listed.
const excludedParents = ['x.com', 'twitter.com', 'reddit.com', 'youtube.com', 'youtu.be', 'tumblr.com', 'blogspot.com', 'wordpress.com'];
const domains = new Set();
const excludedPublicSuffixes = [];
let invalid = 0;
for (const line of input.split(/\r?\n/)) {
  const raw = line.split('#')[0].trim().toLowerCase();
  if (!raw) continue;
  if (raw.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw) || raw.split('.').some(label => label.length > 63)) { invalid++; continue; }
  if (!parse(raw).domain) { excludedPublicSuffixes.push(raw); continue; }
  if (!excludedParents.includes(raw)) domains.add(raw);
}
if (domains.size < 10000 || invalid > 1000) throw new Error(`Unexpected list: ${domains.size} domains, ${invalid} invalid rows`);
// Remove redundant children, retaining the exact host or parent boundary match.
const compact = [...domains].filter(host => {
  for (let i = host.indexOf('.'); i >= 0; i = host.indexOf('.', i + 1)) if (domains.has(host.slice(i + 1))) return false;
  return true;
}).sort();
const content = Buffer.from(compact.join('\n') + '\n');
const metadata = { source: 'The Block List Project — Porn', repository: 'https://github.com/blocklistproject/Lists', revision,
  sourceUrl: base + 'alt-version/porn-nl.txt', retrievedAt: new Date().toISOString(), license: 'Unlicense',
  sourceSha256: createHash('sha256').update(input).digest('hex'), sha256: createHash('sha256').update(content).digest('hex'),
  sourceCount: domains.size, count: compact.length, excludedParents, excludedPublicSuffixes, invalidRows: invalid };
await mkdir(directory, { recursive: true });
await writeFile(new URL('adult-domains.txt.gz', directory), gzipSync(content, { level: 9 }));
await writeFile(new URL('adult-list.json', directory), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(new URL('ADULT_LIST_LICENSE.txt', directory), license);
console.log(`Saved ${compact.length.toLocaleString()} domains in ${fileURLToPath(directory)} at ${revision}`);
