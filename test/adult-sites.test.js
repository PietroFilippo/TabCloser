const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { match } = require('../adult-sites.js');

test('adult matching respects host boundaries, scheme, case, terminal dots, and punycode', () => {
  const domains = new Set(['adult.example', 'xn--bcher-kva.example']);
  for (const url of ['https://adult.example/', 'http://WWW.ADULT.EXAMPLE.:80/a', 'https://bücher.example']) assert.ok(match(url, domains));
  for (const url of ['https://notadult.example', 'https://adult.example.safe.org', 'https://safe.org/adult.example', 'https://adult.example@safe.org', 'file://adult.example/a', 'garbage']) assert.equal(match(url, domains), null);
});

test('bundled list matches pinned metadata and contains expected domains without broad social-platform blocks', () => {
  const directory = path.join(__dirname, '../data');
  const content = gunzipSync(fs.readFileSync(path.join(directory, 'adult-domains.txt.gz')));
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'adult-list.json')));
  assert.equal(createHash('sha256').update(content).digest('hex'), metadata.sha256);
  const domains = new Set(content.toString().trim().split('\n'));
  assert.equal(domains.size, metadata.count);
  assert.ok(domains.size > 10000);
  assert.equal(match('https://www.pornhub.com/', domains), 'pornhub.com');
  assert.equal(match('https://xvideos.com/', domains), 'xvideos.com');
  for (const host of metadata.excludedParents) assert.equal(match('https://' + host, domains), null);
});

test('the imported list never contains a public suffix',()=>{
  const {parse}=require('tldts');
  const domains=gunzipSync(fs.readFileSync(path.join(__dirname,'../data/adult-domains.txt.gz'))).toString().trim().split('\n');
  assert.deepEqual(domains.filter(host=>!parse(host).domain),[]);
});
