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
// so adding or removing paintings never requires a code change.
const artFiles = (await readdir(path.join(root, 'assets', 'sacred-art')))
  .filter(file => /\.(?:jpe?g|png|webp)$/i.test(file))
  .sort();
await writeFile(path.join(dist, 'sacred-art-list.js'), 'globalThis.TabCloserSacredArt = ' + JSON.stringify(artFiles) + ';\n');

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
