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
        console.log('[SR] available() →', available);
        if (!available) {
            availabilityCached = false;
            return false;
        }
        const status = await SpeechRecognition.checkPermissions();
        console.log('[SR] checkPermissions() →', status.speechRecognition);
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
        console.log('[SR] requestPermissions() →', requested.speechRecognition);
        availabilityCached = requested.speechRecognition === 'granted';
        return availabilityCached;
    } catch (err) {
        console.warn('[SR] availability check failed:', err);
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

    // Subscribe to partial results — track the most recent best match and
    // forward to the caller for live transcript display.
    const listener: PluginListenerHandle = await SpeechRecognition.addListener('partialResults', (data) => {
        partialCount++;
        const best = data.matches?.[0];
        if (typeof best === 'string') {
            lastTranscript = best;
            opts.onPartial?.(best);
            // First partial event tells us SR is actually receiving audio —
            // single most useful diagnostic for the audio-session-conflict
            // failure mode (start() resolves but no events ever fire).
            if (partialCount === 1) {
                console.log('[SR] first partial fired — SR is receiving audio');
                opts.onFirstPartial?.();
            }
        }
    });

    // Listen for plugin-internal listeningState events so we can confirm the
    // native engine actually started (vs. start() resolving with the engine
    // failing silently a moment later).
    const stateListener: PluginListenerHandle = await SpeechRecognition.addListener('listeningState', (data) => {
        console.log('[SR] listeningState →', data.status);
    });

    // partialResults: true means start() returns immediately and events
    // stream until stop(). Australian English bias matches the home-waters
    // default in the system prompt.
    console.log('[SR] start() calling…');
    try {
        await SpeechRecognition.start({
            language: 'en-AU',
            partialResults: true,
            maxResults: 1,
        });
        console.log('[SR] start() resolved');
    } catch (err) {
        // Clean up listeners on start failure so we don't leak.
        try {
            await listener.remove();
        } catch {
            /* ignore */
        }
        try {
            await stateListener.remove();
        } catch {
            /* ignore */
        }
        console.warn('[SR] start() rejected:', err);
        throw err;
    }

    return {
        async stop(): Promise<SpeechRecognizerStopResult> {
            try {
                await listener.remove();
            } catch {
                /* ignore — listener may already be torn down */
            }
            try {
                await stateListener.remove();
            } catch {
                /* ignore */
            }
            try {
                await SpeechRecognition.stop();
            } catch (err) {
                console.warn('[SR] stop failed:', err);
            }
            const trimmed = lastTranscript.trim();
            const durationMs = Date.now() - t0;
            console.log(`[SR] stop() — partials: ${partialCount}, finalChars: ${trimmed.length}, ${durationMs}ms`);
            if (trimmed.length < MIN_USABLE_CHARS) {
                return { text: null, durationMs };
            }
            return { text: trimmed, durationMs };
        },

        async cancel(): Promise<void> {
            try {
                await listener.remove();
            } catch {
                /* ignore */
            }
            try {
                await stateListener.remove();
            } catch {
                /* ignore */
            }
            try {
                await SpeechRecognition.stop();
            } catch {
                /* ignore */
            }
        },
    };
}
