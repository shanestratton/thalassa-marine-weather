/**
 * pcm-worklet — AudioWorkletProcessor for the Deepgram streaming
 * recognizer. Takes Float32 microphone samples, converts to Int16 PCM
 * (linear16 — Deepgram's native expected format), and posts the buffer
 * to the main thread for forwarding to the WebSocket.
 *
 * Why this is a static file rather than inline:
 *   The iOS WKWebView Content Security Policy rejects AudioWorklet
 *   modules loaded from `blob:` URLs even with `blob:` whitelisted in
 *   both `script-src` and `worker-src`. The only reliable path is to
 *   serve the worklet from the same origin so it falls under `'self'`.
 *   Vite copies everything in `public/` straight to the build output
 *   so this file ends up at `/pcm-worklet.js` in the iOS bundle.
 *
 * Counterpart: services/voice/deepgramRecognizer.ts (loads this).
 */
class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0]) {
            const float32 = input[0];
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                const s = Math.max(-1, Math.min(1, float32[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            // Post the Int16 buffer to the main thread (transferred,
            // not copied — main thread takes ownership).
            this.port.postMessage(int16.buffer, [int16.buffer]);
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);
