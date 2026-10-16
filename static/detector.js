/*
 * LabBorrow AI detector.
 *
 * How it works: MobileNet (a pretrained image network) turns each camera frame
 * into a 1280-number "fingerprint" (embedding). The admin teaches the app with
 * sample photos of every lab item, plus a "Not a lab item" class (hands, phones,
 * desks...). On top of the fingerprints we train a small classifier layer (the
 * "head") that learns what separates each item from the others. A frame counts
 * as a lab item only if the head is confident and it is not "Not a lab item",
 * so the app only accepts laboratory materials it was trained on.
 *
 * While new samples have not been trained into the head yet (e.g. live preview
 * during training), the detector falls back to comparing with the nearest samples.
 */
const UNKNOWN = "__unknown__";
const CROPS = [0.75, 0.42]; // centre squares the scanner checks, as a share of the picture's shorter side
const FEATURE_SCALE = 10; // fingerprints are unit length; scaling them helps the head train quickly

const Detector = {
  net: null,
  classes: {},          // key -> { label, itemId, samples: [Float32Array] }
  head: null,           // { keys, W: Float32Array(D*K), b: Float32Array(K) } trained classifier
  headStale: false,     // samples changed since the head was trained
  MIN_PROBABILITY: 0.6, // head: how sure it must be (0..1)
  K: 7,                 // fallback: neighbours that vote
  MIN_CONFIDENCE: 0.7,  // fallback: share of neighbour votes the winner needs
  MIN_SIMILARITY: 0.7,  // fallback: cosine similarity the closest sample needs (0..1)

  async load() {
    if (!this.net) {
      await tf.ready();
      this.net = await mobilenet.load({ version: 2, alpha: 1.0 });
    }
    return this;
  },

  embed(source) {
    return tf.tidy(() => {
      const e = this.net.infer(source, true).flatten();
      return e.div(e.norm());
    }).dataSync();
  },

  addSample(key, label, itemId, source) {
    if (!this.classes[key]) this.classes[key] = { label, itemId, samples: [] };
    this.classes[key].samples.push(Float32Array.from(this.embed(source)));
    this.headStale = true;
    return this.classes[key].samples.length;
  },

  /* A camera frame or photo is learned from every crop the scanner looks at,
     so the AI knows each item both up close and from further away. */
  addFrameSamples(key, label, itemId, source) {
    let n = 0;
    for (const fraction of CROPS) n = this.addSample(key, label, itemId, cropSquare(source, fraction));
    return n;
  },

  /* Scanner: looks at the guide square and at a zoomed-in centre (for small or far
     items like test tubes) and returns the most confident answer. */
  predictFrame(source) {
    if (!this.isTrained()) return null;
    let best = null;
    for (const fraction of CROPS) {
      const p = this.predictEmbedding(this.embed(cropSquare(source, fraction)));
      if (!best || (p.accepted && !best.accepted) || (p.accepted === best.accepted && p.confidence > best.confidence)) best = p;
    }
    return best;
  },

  clearClass(key) { delete this.classes[key]; this.headStale = true; },

  count(key) { return this.classes[key] ? this.classes[key].samples.length : 0; },

  isTrained() {
    if (this.head && !this.headStale) return true;
    return Object.keys(this.classes).some((k) => k !== UNKNOWN && this.count(k) > 0);
  },

  predict(source) {
    if (!this.isTrained()) return null;
    return this.predictEmbedding(this.embed(source));
  },

  predictEmbedding(q) {
    if (this.head && !this.headStale) return this.predictHead(q);
    return this.predictNearest(q);
  },

  predictHead(q) {
    const { keys, W, b } = this.head;
    const K = keys.length, logits = Float32Array.from(b);
    for (let d = 0; d < q.length; d++) {
      const x = q[d] * FEATURE_SCALE;
      if (x === 0) continue;
      const row = d * K;
      for (let k = 0; k < K; k++) logits[k] += x * W[row + k];
    }
    let max = -Infinity, best = 0, sum = 0;
    for (let k = 0; k < K; k++) if (logits[k] > max) { max = logits[k]; best = k; }
    for (let k = 0; k < K; k++) sum += Math.exp(logits[k] - max);
    const confidence = 1 / sum;
    const key = keys[best], c = this.classes[key] || {};
    const accepted = key !== UNKNOWN && confidence >= this.MIN_PROBABILITY;
    return { key, label: c.label, itemId: c.itemId, confidence, accepted };
  },

  predictNearest(q) {
    const scored = [];
    for (const [key, c] of Object.entries(this.classes)) {
      for (const s of c.samples) {
        let dot = 0;
        for (let i = 0; i < q.length; i++) dot += q[i] * s[i];
        scored.push([dot, key]);
      }
    }
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, Math.min(this.K, scored.length));
    const votes = {};
    for (const [, key] of top) votes[key] = (votes[key] || 0) + 1;
    const [winner, n] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    const similarity = scored.find(([, k]) => k === winner)[0];
    const confidence = n / top.length;
    const c = this.classes[winner];
    const accepted = winner !== UNKNOWN && confidence >= this.MIN_CONFIDENCE && similarity >= this.MIN_SIMILARITY;
    return { key: winner, label: c.label, itemId: c.itemId, confidence, similarity, accepted };
  },

  /* Fingerprints of generated "nothing here" pictures - plain walls and tables, lighting
     gradients, a dark noisy room, random shapes - added to "Not a lab item" whenever the head
     is trained, so pointing the camera at an empty surface never counts as an item. */
  syntheticNegatives() {
    if (this._negatives) return this._negatives;
    const c = document.createElement("canvas");
    c.width = c.height = 224;
    const x = c.getContext("2d");
    const color = () => `hsl(${Math.random() * 360},${Math.random() * 100}%,${Math.random() * 100}%)`;
    const out = [];
    for (let i = 0; i < 48; i++) {
      x.fillStyle = color();
      x.fillRect(0, 0, 224, 224);
      if (i % 4 === 1) {
        const g = x.createLinearGradient(0, 0, Math.random() * 224, 224);
        g.addColorStop(0, color()); g.addColorStop(1, color());
        x.fillStyle = g; x.fillRect(0, 0, 224, 224);
      } else if (i % 4 === 2) {
        const im = x.createImageData(224, 224), base = Math.random() * 255;
        for (let p = 0; p < im.data.length; p += 4) {
          im.data[p] = im.data[p + 1] = im.data[p + 2] = base + (Math.random() - 0.5) * 80;
          im.data[p + 3] = 255;
        }
        x.putImageData(im, 0, 0);
      } else if (i % 4 === 3) {
        for (let k = 0; k < 6; k++) {
          x.fillStyle = color();
          x.fillRect(Math.random() * 224, Math.random() * 224, Math.random() * 120, Math.random() * 120);
        }
      }
      out.push(Float32Array.from(this.embed(c)));
    }
    return (this._negatives = out);
  },

  /* Trains the classifier head on every sample. Classes are weighted so a class with
     many samples (e.g. hundreds of camera frames) doesn't drown out the others. */
  async train({ epochs = 80, onProgress } = {}) {
    const sets = {};
    for (const [k, c] of Object.entries(this.classes)) if (c.samples.length) sets[k] = c.samples;
    if (!Object.keys(sets).some((k) => k !== UNKNOWN)) throw new Error("Add samples of at least one lab item first.");
    sets[UNKNOWN] = [...(sets[UNKNOWN] || []), ...this.syntheticNegatives()];
    const keys = Object.keys(sets);
    const D = sets[keys[0]][0].length;
    const N = keys.reduce((a, k) => a + sets[k].length, 0);
    const X = new Float32Array(N * D), Y = new Int32Array(N), classWeight = {};
    let r = 0;
    keys.forEach((k, ci) => {
      classWeight[ci] = N / (keys.length * sets[k].length);
      for (const s of sets[k]) {
        for (let d = 0; d < D; d++) X[r * D + d] = s[d] * FEATURE_SCALE;
        Y[r++] = ci;
      }
    });
    const xs = tf.tensor2d(X, [N, D]);
    const ys = tf.oneHot(tf.tensor1d(Y, "int32"), keys.length);
    const model = tf.sequential({ layers: [tf.layers.dense({
      inputShape: [D], units: keys.length, activation: "softmax",
      kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 }),
    })] });
    model.compile({ optimizer: tf.train.adam(0.003), loss: "categoricalCrossentropy" });
    // Train in chunks without TensorFlow's default animation-frame pauses, which stall
    // completely when the page is in the background (e.g. the admin switches apps).
    for (let done = 0; done < epochs; done += 10) {
      await model.fit(xs, ys, { epochs: Math.min(10, epochs - done), batchSize: 64, shuffle: true, classWeight, yieldEvery: "never" });
      if (onProgress) onProgress(Math.min(done + 10, epochs) / epochs);
      await yieldNow();
    }
    const [W, b] = model.getWeights();
    this.head = { keys, W: Float32Array.from(W.dataSync()), b: Float32Array.from(b.dataSync()) };
    this.headStale = false;
    tf.dispose([xs, ys]);
    model.dispose(); // also frees W and b
  },

  // ---- save / load. Each sample is stored as "scale|base64 int8" (4x smaller than float32).
  serialize() {
    const out = { version: 3, classes: {} };
    for (const [key, c] of Object.entries(this.classes)) {
      out.classes[key] = { label: c.label, itemId: c.itemId, samples: c.samples.map(encodeSample) };
    }
    if (this.head && !this.headStale) {
      out.head = { keys: this.head.keys, W: bytesToB64(new Uint8Array(this.head.W.buffer)), b: Array.from(this.head.b) };
    }
    return out;
  },

  deserialize(model) {
    this.classes = {}; this.head = null; this.headStale = false;
    if (!model || !model.classes) return;
    for (const [key, c] of Object.entries(model.classes)) {
      this.classes[key] = { label: c.label, itemId: c.itemId, samples: (c.samples || []).map(decodeSample) };
    }
    if (model.head) {
      this.head = { keys: model.head.keys, W: new Float32Array(b64ToBytes(model.head.W).buffer), b: Float32Array.from(model.head.b) };
    }
  },
};

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function encodeSample(f32) {
  let max = 0;
  for (const v of f32) max = Math.max(max, Math.abs(v));
  const scale = max / 127 || 1;
  const q = new Int8Array(f32.length);
  for (let i = 0; i < f32.length; i++) q[i] = Math.round(f32[i] / scale);
  return `${scale.toPrecision(6)}|${bytesToB64(new Uint8Array(q.buffer))}`;
}

function decodeSample(s) {
  let v;
  if (s.includes("|")) {
    const [scale, b64] = s.split("|");
    const q = new Int8Array(b64ToBytes(b64).buffer);
    v = Float32Array.from(q, (x) => x * Number(scale));
  } else {
    v = new Float32Array(b64ToBytes(s).buffer); // version 1: raw float32
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/* Lets the page update between heavy steps. Unlike setTimeout or animation frames,
   this is not slowed down when the page is in the background. */
function yieldNow() {
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = r; ch.port2.postMessage(0); });
}

function urlToImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

/* ---- camera helper shared by the scan and training screens ---- */
const Camera = {
  stream: null,
  supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },
  async start(video) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      // high resolution so the zoomed-in crop of a small item still has detail
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
  },
  /* Optical/digital zoom range if the phone camera supports it (most Android phones), else null. */
  zoomRange() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    return caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
  },
  setZoom(value) {
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (track) track.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {});
  },
  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  },
};

/* Cuts a centred square (fraction of the shorter side) out of a video frame or image, at 224x224. */
const cropCanvas = document.createElement("canvas");
cropCanvas.width = cropCanvas.height = 224;
function cropSquare(source, fraction) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const side = Math.min(w, h) * fraction;
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 224, 224);
  return cropCanvas;
}

/* Load a photo chosen with <input type=file> into an <img> the model can read. */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
