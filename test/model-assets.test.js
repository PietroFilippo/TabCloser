const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The repo root is loadable as a dev extension, so every asset the classifier
// fetches at runtime must exist here — a missing model fails closed and
// silently censors all media (verdict 'protect', reason 'error').
const modelDir = path.join(__dirname, '..', 'models', 'mobilenet_v2_mid');

test('sacred-art assets and the generated list exist in the loadable extension root', () => {
  const artDir = path.join(__dirname, '..', 'assets', 'sacred-art');
  const paintings = fs.readdirSync(artDir).filter(file => /\.(?:jpe?g|png|webp)$/i.test(file));
  assert.ok(paintings.length > 0, 'assets/sacred-art has no images');
  const listPath = path.join(__dirname, '..', 'sacred-art-list.js');
  assert.ok(fs.existsSync(listPath), 'sacred-art-list.js is missing — run `npm run build`');
  const listed = JSON.parse(fs.readFileSync(listPath, 'utf8').replace('globalThis.TabCloserSacredArt = ', '').replace(/;\s*$/, ''));
  assert.deepEqual(listed.map(entry => entry.file).sort(), paintings.sort(), 'generated list must match the assets directory');
  for (const entry of listed) {
    assert.ok(Number.isFinite(entry.aspect) && entry.aspect > 0,
      'every painting needs a parsed aspect ratio for shape matching: ' + entry.file);
  }
});

test('classifier model assets exist in the loadable extension root', () => {
  const modelJsonPath = path.join(modelDir, 'model.json');
  assert.ok(fs.existsSync(modelJsonPath), 'models/mobilenet_v2_mid/model.json is missing — run `npm run build`');
  const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
  const weightPaths = modelJson.weightsManifest.flatMap(group => group.paths);
  assert.ok(weightPaths.length > 0, 'model.json declares no weight files');
  for (const weightPath of weightPaths) {
    const file = path.join(modelDir, weightPath);
    assert.ok(fs.existsSync(file), 'missing model weights: ' + weightPath);
    assert.ok(fs.statSync(file).size > 0, 'empty model weights: ' + weightPath);
  }
});
