/*
 * LabBorrow AI detector.
 *
 * How it works: MobileNet (a pretrained image network) turns each camera frame
 * into a 1280-number "fingerprint" (embedding). The admin teaches the app by
 * capturing sample photos of every lab item, plus a "Not a lab item" class
 * (hands, faces, tables, phones...). To recognise a frame we compare its
 * fingerprint with all the saved samples (k-nearest-neighbours). If the best
 * match is not close enough, or it's the "not a lab item" class, nothing is
 * detected - so the app only accepts laboratory materials it was trained on.
 */
const UNKNOWN = "__unknown__";

const Detector = {
  net: null,
  classes: {},          // key -> { label, itemId, samples: [Float32Array] }
  K: 7,                 // neighbours that vote
  MIN_CONFIDENCE: 0.7,  // share of neighbour votes the winner needs
  MIN_SIMILARITY: 0.7,  // cosine similarity the closest sample needs (0..1)

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
    return this.classes[key].samples.length;
  },

  clearClass(key) { delete this.classes[key]; },

  count(key) { return this.classes[key] ? this.classes[key].samples.length : 0; },

  isTrained() {
    return Object.keys(this.classes).some((k) => k !== UNKNOWN && this.count(k) > 0);
  },

  predict(source) {
    if (!this.isTrained()) return null;
    const q = this.embed(source);
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

  // ---- save / load (embeddings are stored as base64 Float32 for compactness)
  serialize() {
    const out = { version: 1, classes: {} };
    for (const [key, c] of Object.entries(this.classes)) {
      out.classes[key] = { label: c.label, itemId: c.itemId, samples: c.samples.map(f32ToB64) };
    }
    return out;
  },

  deserialize(model) {
    this.classes = {};
    if (!model || !model.classes) return;
    for (const [key, c] of Object.entries(model.classes)) {
      this.classes[key] = { label: c.label, itemId: c.itemId, samples: c.samples.map(b64ToF32) };
    }
  },
};

function f32ToB64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/* ---- camera helper shared by the scan and training screens ---- */
const Camera = {
  stream: null,
  supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },
  async start(video) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
  },
  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  },
};

/* Load a photo chosen with <input type=file> into an <img> the model can read. */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
