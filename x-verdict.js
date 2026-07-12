(function initXVerdict(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabCloserXVerdict = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createXVerdict() {
  const MODEL_NAME = 'MobileNetV2Mid';
  const MODEL_VERSION = 'nsfwjs-4.3.0-mobilenet-v2-mid';
  const MODEL_INPUT_SIZE = 224;
  const ADULT_THRESHOLD = 0.2;
  // 'Sexy' means provocative-but-not-explicit; half weight keeps swimwear,
  // fitness, and portrait photos from tripping the threshold on their own.
  const SEXY_WEIGHT = 0.5;
  // The model gives benign paintings/illustrations a moderate Hentai score
  // with Drawing dominant; real hentai scores Hentai above Drawing. Hentai
  // only counts when it beats Drawing or is unambiguous on its own.
  const HENTAI_SOLO_THRESHOLD = 0.5;
  const ADULT_CLASSES = new Set(['Porn', 'Hentai', 'Sexy']);
  const EXPECTED_CLASSES = new Set(['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy']);

  function normalizeScores(predictions) {
    const scores = {};
    for (const prediction of predictions || []) {
      if (!EXPECTED_CLASSES.has(prediction?.className)) continue;
      const probability = Number(prediction.probability);
      if (Number.isFinite(probability)) scores[prediction.className] = probability;
    }
    return scores;
  }

  // User-selectable operating points along the precision/recall curve.
  // 'balanced' mirrors the tuned defaults above.
  const SENSITIVITY_PRESETS = {
    lenient: { threshold: 0.3, sexyWeight: 0.35, hentaiSolo: 0.6 },
    balanced: { threshold: ADULT_THRESHOLD, sexyWeight: SEXY_WEIGHT, hentaiSolo: HENTAI_SOLO_THRESHOLD },
    strict: { threshold: 0.12, sexyWeight: 0.7, hentaiSolo: 0.4 },
  };

  function presetValues(name) {
    return SENSITIVITY_PRESETS[name] || SENSITIVITY_PRESETS.balanced;
  }

  function decidePredictions(predictions, threshold = ADULT_THRESHOLD, sexyWeight = SEXY_WEIGHT, hentaiSolo = HENTAI_SOLO_THRESHOLD) {
    const scores = normalizeScores(predictions);
    if (Object.keys(scores).length !== EXPECTED_CLASSES.size) {
      return { verdict: 'protect', reason: 'invalid', adultScore: 1, scores };
    }
    const hentaiSignal = scores.Hentai > scores.Drawing || scores.Hentai >= hentaiSolo ? scores.Hentai : 0;
    const adultScore = scores.Porn + hentaiSignal + sexyWeight * scores.Sexy;
    return {
      verdict: adultScore >= threshold ? 'protect' : 'safe',
      reason: 'visual',
      adultScore,
      scores,
    };
  }

  return {
    ADULT_CLASSES,
    ADULT_THRESHOLD,
    EXPECTED_CLASSES,
    MODEL_INPUT_SIZE,
    HENTAI_SOLO_THRESHOLD,
    MODEL_NAME,
    MODEL_VERSION,
    SENSITIVITY_PRESETS,
    SEXY_WEIGHT,
    decidePredictions,
    normalizeScores,
    presetValues,
  };
});
