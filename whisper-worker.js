// On-device speech-to-text (Whisper) running in a Web Worker so the app stays responsive.
// The library and model are downloaded the first time and cached by the browser afterwards.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null, loaded = null;

self.onmessage = async e => {
  const { audio, lang, model } = e.data;
  try {
    if (!asr || loaded !== model) {
      self.postMessage({ type: 'status', msg: 'Downloading model…' });
      asr = await pipeline('automatic-speech-recognition', 'Xenova/' + model, {
        progress_callback: p => self.postMessage({ type: 'progress', p })
      });
      loaded = model;
    }
    self.postMessage({ type: 'status', msg: 'Transcribing on your device…' });
    const opts = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
    if (lang) opts.language = lang;
    const out = await asr(audio, opts);
    const chunks = (out.chunks && out.chunks.length) ? out.chunks : [{ text: out.text || '', timestamp: [0, null] }];
    self.postMessage({ type: 'done', chunks });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
