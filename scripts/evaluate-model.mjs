import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as tf from '@tensorflow/tfjs';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import { load } from 'nsfwjs/core';
import { MobileNetV2MidModel } from 'nsfwjs/models/mobilenet_v2_mid';

const require = createRequire(import.meta.url);
const verdictConfig = require('../x-verdict.js');
const { PNG } = pngjs;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const manifestPath = argument('--manifest') || process.argv[2];
const corpusRoot = argument('--corpus') || process.argv[3];
if (!manifestPath || !corpusRoot) {
  console.error('Usage: npm run evaluate:model -- --manifest <manifest.json> --corpus <private-directory>');
  process.exit(1);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function decodeImage(buffer, extension) {
  if (extension === '.png') return PNG.sync.read(buffer);
  if (extension === '.jpg' || extension === '.jpeg') return jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  throw new Error('Only PNG and JPEG fixtures are supported by the automated evaluator.');
}

function imageTensor(image) {
  const rgb = new Int32Array(image.width * image.height * 3);
  for (let source = 0, target = 0; source < image.data.length; source += 4) {
    rgb[target++] = image.data[source];
    rgb[target++] = image.data[source + 1];
    rgb[target++] = image.data[source + 2];
  }
  return tf.tensor3d(rgb, [image.height, image.width, 3], 'int32');
}

function metrics(rows, threshold) {
  const unsafe = rows.filter(row => row.expected !== 'safe');
  const safe = rows.filter(row => row.expected === 'safe');
  const known = rows.filter(row => row.expected === 'known-miss');
  const protectedCount = values => values.filter(row => row.adultScore >= threshold).length;
  return {
    threshold,
    unsafeRecall: unsafe.length ? protectedCount(unsafe) / unsafe.length : 0,
    knownMissRecall: known.length ? protectedCount(known) / known.length : 1,
    safeReleaseRate: safe.length ? safe.filter(row => row.adultScore < threshold).length / safe.length : 0,
  };
}

const manifest = JSON.parse((await readFile(path.resolve(manifestPath), 'utf8')).replace(/^\uFEFF/, ''));
if (!Array.isArray(manifest.samples) || !manifest.samples.length) throw new Error('Corpus manifest has no samples.');

tf.enableProdMode();
await tf.setBackend('cpu');
await tf.ready();
const model = await load(verdictConfig.MODEL_NAME, { modelDefinitions: [MobileNetV2MidModel] });
const rows = [];

for (const sample of manifest.samples) {
  if (!['safe', 'adult', 'hentai', 'borderline', 'known-miss'].includes(sample.expected)) {
    throw new Error('Invalid expected label for sample ' + sample.id);
  }
  const filePath = path.resolve(corpusRoot, sample.file);
  const buffer = await readFile(filePath);
  if (sample.sha256 && sha256(buffer) !== sample.sha256.toLowerCase()) throw new Error('Hash mismatch for sample ' + sample.id);
  const image = decodeImage(buffer, path.extname(filePath).toLowerCase());
  const tensor = imageTensor(image);
  const started = performance.now();
  try {
    const predictions = await model.classify(tensor, 5);
    const decision = verdictConfig.decidePredictions(predictions);
    rows.push({ id: sample.id, expected: sample.expected, adultScore: decision.adultScore, durationMs: performance.now() - started });
  } finally {
    tensor.dispose();
  }
}

const passing = [];
for (let step = 1; step < 100; step += 1) {
  const result = metrics(rows, step / 100);
  if (result.knownMissRecall === 1 && result.unsafeRecall >= 0.98 && result.safeReleaseRate >= 0.9) passing.push(result);
}
passing.sort((a, b) => b.unsafeRecall - a.unsafeRecall || b.safeReleaseRate - a.safeReleaseRate || a.threshold - b.threshold);
const durations = rows.map(row => row.durationMs).sort((a, b) => a - b);
const report = {
  model: verdictConfig.MODEL_VERSION,
  samples: rows.length,
  configured: metrics(rows, verdictConfig.ADULT_THRESHOLD),
  recommended: passing[0] || null,
  warmLatencyMs: {
    median: durations[Math.floor(durations.length * 0.5)],
    p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))],
  },
};
console.log(JSON.stringify(report, null, 2));
model.dispose();
if (!passing.length) process.exitCode = 2;
