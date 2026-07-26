/**
 * Live PCM batching keeps Deepgram responsive without flooding iOS WebSocket
 * with one 256-byte AudioWorklet frame every few milliseconds.
 *
 * A 45 ms target is short enough that partial dictation feels live, while
 * still limiting a 48 kHz mono stream to roughly 22 binary frames per second
 * (comfortably below the Cloudflare bridge's sustained-message capacity).
 */
export const PCM_BATCH_TARGET_MS = 45;

/**
 * Short/irregular audio frames must not wait indefinitely for the byte
 * threshold. This is deliberately a little longer than the normal batch so
 * continuous speech is size-driven, not timer-driven.
 */
export const PCM_BATCH_SAFETY_FLUSH_MS = 60;

const PCM_BYTES_PER_SAMPLE = 2; // 16-bit mono linear PCM

export function pcmBatchBytesForSampleRate(sampleRate: number): number {
    const normalizedRate = Math.max(8_000, Math.min(48_000, Math.round(sampleRate)));
    return Math.max(
        PCM_BYTES_PER_SAMPLE,
        Math.ceil((normalizedRate * PCM_BYTES_PER_SAMPLE * PCM_BATCH_TARGET_MS) / 1_000),
    );
}
