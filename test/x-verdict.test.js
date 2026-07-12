const test = require('node:test');
const assert = require('node:assert/strict');
const { ADULT_THRESHOLD, decidePredictions, presetValues } = require('../x-verdict.js');

function predictions(values) {
  return Object.entries(values).map(([className, probability]) => ({ className, probability }));
}

test('releases only scores below the conservative adult threshold', () => {
  const result = decidePredictions(predictions({ Drawing: 0.02, Hentai: 0.01, Neutral: 0.9, Porn: 0.03, Sexy: 0.04 }));
  assert.equal(result.verdict, 'safe');
  assert.ok(result.adultScore < ADULT_THRESHOLD);
});

test('protects when combined adult probability reaches the threshold', () => {
  const result = decidePredictions(predictions({ Drawing: 0.02, Hentai: 0.03, Neutral: 0.65, Porn: 0.18, Sexy: 0.12 }));
  assert.equal(result.verdict, 'protect');
  assert.ok(result.adultScore >= ADULT_THRESHOLD);
});

test('benign paintings with a moderate hentai score stay safe when drawing dominates', () => {
  const painting = decidePredictions(predictions({ Drawing: 0.6, Hentai: 0.3, Neutral: 0.05, Porn: 0.02, Sexy: 0.03 }));
  assert.equal(painting.verdict, 'safe');
  const hentai = decidePredictions(predictions({ Drawing: 0.2, Hentai: 0.7, Neutral: 0.05, Porn: 0.03, Sexy: 0.02 }));
  assert.equal(hentai.verdict, 'protect');
  const unambiguous = decidePredictions(predictions({ Drawing: 0.55, Hentai: 0.5, Neutral: 0.02, Porn: 0.02, Sexy: 0.01 }));
  assert.equal(unambiguous.verdict, 'protect');
});

test('does not over-restrict provocative-but-not-explicit content', () => {
  const result = decidePredictions(predictions({ Drawing: 0.05, Hentai: 0.01, Neutral: 0.63, Porn: 0.01, Sexy: 0.3 }));
  assert.equal(result.verdict, 'safe');
  const explicit = decidePredictions(predictions({ Drawing: 0.02, Hentai: 0.02, Neutral: 0.16, Porn: 0.2, Sexy: 0.6 }));
  assert.equal(explicit.verdict, 'protect');
});

test('sensitivity presets move the operating point in the promised direction', () => {
  const borderline = predictions({ Drawing: 0.05, Hentai: 0.01, Neutral: 0.72, Porn: 0.1, Sexy: 0.12 });
  const decide = name => {
    const preset = presetValues(name);
    return decidePredictions(borderline, preset.threshold, preset.sexyWeight, preset.hentaiSolo).verdict;
  };
  assert.equal(decide('lenient'), 'safe');
  assert.equal(decide('balanced'), 'safe');
  assert.equal(decide('strict'), 'protect');
  assert.deepEqual(presetValues('nonsense'), presetValues('balanced'), 'unknown names fall back to balanced');
  assert.equal(presetValues('balanced').threshold, ADULT_THRESHOLD);
});

test('fails closed when a model class is missing or invalid', () => {
  assert.equal(decidePredictions(predictions({ Neutral: 1 })).verdict, 'protect');
  assert.equal(decidePredictions(null).reason, 'invalid');
});
