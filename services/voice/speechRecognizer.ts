/**
 * speechRecognizer — thin wrapper around @capacitor-community/speech-recognition
 * for Apple SFSpeechRecognizer (iOS) on the voice-console hot path.
 *
 * Why this exists: ElevenLabs Scribe is good but adds 1-3s of network round
 * trip per query. Apple's on-device SR runs in-process and emits partial
 * transcripts in real time. We use it as the FAST path; Scribe stays as the
 * audio-blob fallback when SR is unavailable, errors, or returns nothing
 * usable.
 *
 * The plugin doesn't surface word-level confidence on iOS (SFSpeechRecognizer
 * provides it natively, but the Capacitor bridge only exposes matches[]). So
 * the fallback signal is "did SR produce something usable" — non-empty,
 * meets a minimum length. Anything below that → caller falls back to the
 * Scribe path on the recorded audio blob.
 *
 * Permissions: NSSpeechRecognitionUsageDescription + NSMicrophoneUsageDescription
 * are already in Info.plist. First call triggers the iOS permission prompt;
 * subsequent calls are cached in the plugin layer.
 */

import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Minimum character count for an SR result to be considered usable.
 * Below this we suspect SR mis-fired (silence, garbled, just a partial
 * stop word) and fall back to Scribe on the audio blob.
 */
const MIN_USABLE_CHARS = 2;

/**
 * Hard ceiling on every cleanup step. The native bridge can occasionally
 * hang during stop on iOS (audio session contention, dispatch queue
 * stalls). 1500ms is comfortably more than the worst observed normal
 * cleanup time, but well under any user-noticeable delay.
 */
const CLEANUP_TIMEOUT_MS = 1500;

/**
 * Optional caller-supplied tap into [SR] events for visible UI diagnostics
 * (e.g. a debug strip in BosunConsole). Setting this lets the wrapper
 * surface what happened without requiring Web Inspector or Xcode console.
 */
let eventTap: ((message: string) => void) | null = null;
export function setSrEventTap(tap: ((message: string) => void) | null): void {
    eventTap = tap;
}
function emitEvent(message: string): void {
    console.log(message);
    eventTap?.(message);
}

/**
 * Race a promise against a timeout — resolves regardless. Used so
 * cleanup can never hang the calling code path indefinitely.
 */
async function raceTimeout<T>(p: Promise<T>, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<T | null> {
    return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

export interface SpeechRecognizerStopResult {
    /** Final transcript, or null if SR didn't produce anything usable. */
    text: string | null;
    /** Total time the recognizer was active, in ms. */
    durationMs: number;
}

export interface SpeechRecognizerHandle {
    /** Stop listening and return the final transcript (or null if unusable). */
    stop(): Promise<SpeechRecognizerStopResult>;
    /** Cancel without using any result — removes listeners + stops the recognizer. */
    cancel(): Promise<void>;
}

interface StartOptions {
    /** Called whenever the recognizer emits a partial transcript (for live UI display). */
    onPartial?: (text: string) => void;
    /**
     * Called once when the FIRST partial event fires — confirms SR is
     * actually receiving audio. The most useful diagnostic for the
     * audio-session-conflict failure mode where start() resolves but no
     * partials ever arrive (silent failure).
     */
    onFirstPartial?: () => void;
}

let availabilityCached: boolean | null = null;

/**
 * Returns true if speech recognition is available on this device AND the
 * permission is granted (asks the user the first time).
 *
 * Cached after the first call — re-entry is cheap. Pass `force` to re-check.
 */
export async function isSpeechRecognitionAvailable(force = false): Promise<boolean> {
    if (!force && availabilityCached !== null) return availabilityCached;
    try {
        const { available } = await SpeechRecognition.available();
        emitEvent(`[SR] available() → ${available}`);
        if (!available) {
            availabilityCached = false;
            return false;
        }
        const status = await SpeechRecognition.checkPermissions();
        emitEvent(`[SR] checkPermissions() → ${status.speechRecognition}`);
        if (status.speechRecognition === 'granted') {
            availabilityCached = true;
            return true;
        }
        if (status.speechRecognition === 'denied') {
            availabilityCached = false;
            return false;
        }
        // Not yet asked — trigger the iOS permission prompt.
        const requested = await SpeechRecognition.requestPermissions();
        emitEvent(`[SR] requestPermissions() → ${requested.speechRecognition}`);
        availabilityCached = requested.speechRecognition === 'granted';
        return availabilityCached;
    } catch (err) {
        emitEvent(`[SR] availability check failed: ${(err as Error).message}`);
        availabilityCached = false;
        return false;
    }
}

/**
 * Start the recognizer. Returns a handle whose stop() yields the final text.
 *
 * Both this recognizer and a parallel MediaRecorder typically run during a
 * single PTT cycle. iOS shares the input via AVAudioSession in playAndRecord
 * mode and the two co-exist in practice; if not, start() throws and the
 * caller falls back to Scribe transparently.
 */
export async function startSpeechRecognition(opts: StartOptions = {}): Promise<SpeechRecognizerHandle> {
    const ok = await isSpeechRecognitionAvailable();
    if (!ok) throw new Error('Speech recognition unavailable or permission denied');

    const t0 = Date.now();
    let lastTranscript = '';
    let partialCount = 0;
    /**
     * Once we begin teardown, ignore any further partial events from the
     * native side. The plugin's recognition task can fire one or more
     * results AFTER our stop() promise resolves (it dispatches its result
     * handler on a background queue). Without this guard those late events
     * write into stale state and confuse the next cycle.
     */
    let stopped = false;

    // Subscribe to partial results — track the most recent best match and
    // forward to the caller for live transcript display.
    const listener: PluginListenerHandle = await SpeechRecognition.addListener('partialResults', (data) => {
        if (stopped) return;
        partialCount++;
        const best = data.matches?.[0];
        if (typeof best === 'string') {
            lastTranscript = best;
            opts.onPartial?.(best);
            // First partial event tells us SR is actually receiving audio —
            // single most useful diagnostic for the audio-session-conflict
            // failure mode (start() resolves but no events ever fire).
            if (partialCount === 1) {
                emitEvent('[SR] first partial fired — SR is receiving audio');
                opts.onFirstPartial?.();
            }
        }
    });

    // Listen for plugin-internal listeningState events so we can confirm the
    // native engine actually started (vs. start() resolving with the engine
    // failing silently a moment later).
    const stateListener: PluginListenerHandle = await SpeechRecognition.addListener('listeningState', (data) => {
        if (stopped) return;
        emitEvent(`[SR] listeningState → ${data.status}`);
    });

    // partialResults: true means start() returns immediately and events
    // stream until stop(). Australian English bias matches the home-waters
    // default in the system prompt.
    emitEvent('[SR] start() calling…');
    try {
        await SpeechRecognition.start({
            language: 'en-AU',
            partialResults: true,
            maxResults: 1,
        });
        emitEvent('[SR] start() resolved');
    } catch (err) {
        stopped = true;
        await raceTimeout(listener.remove());
        await raceTimeout(stateListener.remove());
        emitEvent(`[SR] start() rejected: ${(err as Error).message}`);
        throw err;
    }

    /**
     * Tear down listeners + stop the native engine. Each step is bounded
     * by raceTimeout so a hung native bridge can never block the calling
     * code (which would manifest as the voice console "locking up" between
     * the first and second message).
     */
    const teardown = async (): Promise<void> => {
        stopped = true;
        await raceTimeout(listener.remove());
        await raceTimeout(stateListener.remove());
        // Stop returns void; wrap in .then(() => undefined) for raceTimeout typing.
        await raceTimeout(
            SpeechRecognition.stop()
                .then(() => undefined)
                .catch((err) => {
                    emitEvent(`[SR] stop failed: ${(err as Error).message}`);
                }),
        );
    };

    return {
        async stop(): Promise<SpeechRecognizerStopResult> {
            await teardown();
            const trimmed = lastTranscript.trim();
            const durationMs = Date.now() - t0;
            // Include the captured text (truncated) in the debug log so
            // the skipper can see exactly what SR heard — useful for
            // diagnosing "I said over but the gesture didn't fire" cases.
            const preview = trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
            emitEvent(`[SR] stop() — partials: ${partialCount}, ${durationMs}ms, text="${preview || '(empty)'}"`);
            if (trimmed.length < MIN_USABLE_CHARS) {
                return { text: null, durationMs };
            }
            return { text: trimmed, durationMs };
        },

        async cancel(): Promise<void> {
            await teardown();
            emitEvent(`[SR] cancel() — partials: ${partialCount}, ${Date.now() - t0}ms`);
        },
    };
}
