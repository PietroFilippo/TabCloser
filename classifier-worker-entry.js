// Runs the NSFW model inside a dedicated worker so inference never blocks the
// background page event loop (which also services the X response filters).
import * as tf from '@tensorflow/tfjs';
import { load } from 'nsfwjs/core';
import verdictConfig from './x-verdict.js';

let modelPromise;
let backendUsed = 'unknown';

async function pickBackend() {
  tf.enableProdMode();
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas unavailable');
    await tf.setBackend('webgl');
    await tf.ready();
    backendUsed = 'webgl';
  } catch {
    await tf.setBackend('cpu');
    await tf.ready();
    backendUsed = 'cpu';
  }
}

function getModel(modelUrl) {
  if (!modelPromise) {
    modelPromise = (async () => {
      await pickBackend();
      const model = await load(modelUrl, { type: 'graph', size: verdictConfig.MODEL_INPUT_SIZE });
      // Warm-up inference pays shader compilation / kernel setup before the
      // first real image arrives.
      const size = verdictConfig.MODEL_INPUT_SIZE;
      await model.classify(new ImageData(size, size), 5);
      return model;
    })().catch(error => {
      modelPromise = undefined;
      throw error;
    });
  }
  return modelPromise;
}

self.onmessage = async event => {
  const message = event.data;
  if (message?.type === 'init') {
    getModel(message.modelUrl).catch(() => {});
    return;
  }
  if (message?.type !== 'classify') return;
  try {
    const model = await getModel(message.modelUrl);
    const pixels = new Uint8ClampedArray(message.pixels);
    const imageData = new ImageData(pixels, message.width, message.height);
    const predictions = await model.classify(imageData, 5);
    const decision = verdictConfig.decidePredictions(predictions);
    self.postMessage({ type: 'result', id: message.id, ok: true, decision, backend: backendUsed });
  } catch (error) {
    self.postMessage({ type: 'result', id: message.id, ok: false, error: error?.message || 'classification failed' });
  }
};
