// Background-page bridge to the classifier worker. Keeps the heavy tf.js
// runtime off this thread so webRequest filters and messaging stay responsive.
const config = globalThis.TabCloserXVerdict;
const pending = new Map();
let worker;
let nextId = 0;

function modelUrl() {
  return browser.runtime.getURL('models/mobilenet_v2_mid/');
}

function getWorker() {
  if (!worker) {
    worker = new Worker(browser.runtime.getURL('classifier-worker.js'));
    worker.onmessage = event => {
      const message = event.data;
      if (message?.type !== 'result') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.decision);
      else entry.reject(new Error(message.error));
    };
    worker.onerror = event => {
      const error = new Error(event?.message || 'classifier worker error');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker.terminate();
      worker = undefined; // recreated lazily on the next classification
    };
    worker.postMessage({ type: 'init', modelUrl: modelUrl() });
  }
  return worker;
}

function classifyImageData(imageData) {
  const target = getWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({
      type: 'classify',
      id,
      modelUrl: modelUrl(),
      pixels: imageData.data.buffer,
      width: imageData.width,
      height: imageData.height,
    }, [imageData.data.buffer]);
  });
}

globalThis.TabCloserClassifier = {
  classifyImageData,
  warmUp: () => { getWorker(); },
  modelName: config.MODEL_NAME,
  modelVersion: config.MODEL_VERSION,
};
