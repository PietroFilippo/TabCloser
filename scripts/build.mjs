import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { MobileNetV2MidModel } from 'nsfwjs/models/mobilenet_v2_mid';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const staticFiles = [
  'background.js',
  'blocked.css', 'blocked.html', 'blocked.js',
  'catholic-quotes.js',
  'common.js',
  'manifest.json',
  'options.css', 'options.html', 'options.js',
  'THIRD_PARTY_NOTICES.md',
  'popup.css', 'popup.html', 'popup.js',
  'x-media-utils.js', 'x-metadata.js', 'x-protection-v2.js', 'x-protection-v3.css', 'x-verdict.js',
];
async function writeModelAssets() {
  const modelDir = path.join(dist, 'models', 'mobilenet_v2_mid');
  await mkdir(modelDir, { recursive: true });
  const modelJson = (await MobileNetV2MidModel.modelJson()).default;
  await writeFile(path.join(modelDir, 'model.json'), JSON.stringify(modelJson));
  const paths = modelJson.weightsManifest.flatMap(group => group.paths);
  for (let index = 0; index < MobileNetV2MidModel.weightBundles.length; index += 1) {
    const base64 = (await MobileNetV2MidModel.weightBundles[index]()).default;
    await writeFile(path.join(modelDir, paths[index]), Buffer.from(base64, 'base64'));
  }
}


await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all(staticFiles.map(file => cp(path.join(root, file), path.join(dist, file))));
await cp(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true });
await cp(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });

// The replacement-art list is generated from whatever is in assets/sacred-art
// so adding or removing paintings never requires a code change. Each entry
// carries the painting's aspect ratio so the coordinator can pick artwork
// that fits the censored cell's shape instead of leaving huge backdrop bars.
function jpegDimensions(buffer) {
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xFF) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xC0 && marker <= 0xCF &&
      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function pngDimensions(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504E47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function artAspect(file) {
  try {
    const buffer = await readFile(path.join(root, 'assets', 'sacred-art', file));
    const size = /\.png$/i.test(file) ? pngDimensions(buffer) : jpegDimensions(buffer);
    if (!size?.width || !size?.height) return null;
    return Math.round((size.width / size.height) * 1000) / 1000;
  } catch {
    return null;
  }
}

const artFiles = (await readdir(path.join(root, 'assets', 'sacred-art')))
  .filter(file => /\.(?:jpe?g|png|webp)$/i.test(file))
  .sort();
const artEntries = await Promise.all(artFiles.map(async file => ({ file, aspect: await artAspect(file) })));
await writeFile(path.join(dist, 'sacred-art-list.js'), 'globalThis.TabCloserSacredArt = ' + JSON.stringify(artEntries) + ';\n');

await writeModelAssets();
const bundleOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['firefox140'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};
await build({
  ...bundleOptions,
  entryPoints: [path.join(root, 'classifier-entry.js')],
  outfile: path.join(dist, 'classifier-runtime.js'),
});
await build({
  ...bundleOptions,
  entryPoints: [path.join(root, 'classifier-worker-entry.js')],
  outfile: path.join(dist, 'classifier-worker.js'),
});

const manifestPath = path.join(dist, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
// The repo root doubles as the dev-loadable extension; it needs every
// generated runtime asset too.
await cp(path.join(dist, 'classifier-runtime.js'), path.join(root, 'classifier-runtime.js'));
await cp(path.join(dist, 'classifier-worker.js'), path.join(root, 'classifier-worker.js'));
await cp(path.join(dist, 'sacred-art-list.js'), path.join(root, 'sacred-art-list.js'));
await cp(path.join(dist, 'models'), path.join(root, 'models'), { recursive: true });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Built extension in ' + dist);
