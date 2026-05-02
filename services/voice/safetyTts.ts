/**
 * Safety TTS — Calypso voice for MAYDAY / position reports / distress
 *               messages, with a graceful fallback to the native
 *               `SpeechSynthesisUtterance` when Calypso isn't reachable.
 *
 * Why this exists: MOB and Radio Console were calling the browser's
 * `speechSynthesis` directly, which on iOS gives the robotic Apple
 * voice that sounds like a 1980s autopilot announcement. Distress
 * messages benefit from a calm human-sounding voice that the listener
 * (Coast Guard, nearby vessels) is more likely to take seriously and
 * understand at the first transmission.
 *
 * The fallback path matters more here than in casual TTS: a MAYDAY
 * call CANNOT silently fail because of a network blip. So we race
 * the Calypso synth against a tight timeout and fall back to native
 * the moment ElevenLabs takes too long, fails, or the device is
 * offline. The native voice is the safety net — every iOS device has
 * it, no network needed.
 *
 * Latency budget: 4 seconds for ElevenLabs synth + playback start
 * before fallback. Most successful syntheses return in < 2s on a
 * normal connection; 4s gives some margin for cellular/sat connections
 * without making the user wait forever.
 */

import { speak as calypsoSpeak, type SpokenHandle } from './ttsClient';

/** Hard cap on how long we wait for Calypso TTS before falling back
 *  to native. Set short because safety messages must not stall. */
const SAFETY_TTS_BUDGET_MS = 4000;

export interface SafetyUtteranceOptions {
    /** What was actually spoken — useful for logging or transcripts. */
    onPlaybackStart?: (engine: 'calypso' | 'native') => void;
    /** Fires when playback finishes (or errors). */
    onPlaybackEnd?: () => void;
    /** Fires if both engines fail outright. UI can show a banner. */
    onError?: (err: Error) => void;
    /** Native-voice rate (0.5 - 2.0). Default 0.85 — a touch slower
     *  than conversational, matches VHF cadence convention. */
    nativeRate?: number;
    /** Native-voice pitch (0 - 2). Default 0.9 — slightly lower for
     *  authority. */
    nativePitch?: number;
}

export interface SafetyUtteranceHandle {
    /** True when playback has fully completed (or failed). */
    done: Promise<void>;
    /** Cancel mid-playback. Idempotent. */
    cancel: () => void;
    /** Which engine ended up speaking — read after `done` resolves
     *  if the caller wants to surface it in the UI ("Sent via
     *  Calypso voice" / "Sent via fallback voice"). */
    engineUsed: () => 'calypso' | 'native' | 'none';
}

/**
 * Speak the given text. Try Calypso first; fall back to native
 * `SpeechSynthesisUtterance` if Calypso doesn't deliver audio within
 * `SAFETY_TTS_BUDGET_MS`, errors, or isn't available.
 *
 * Cancellation: returned handle's `cancel()` aborts whichever engine
 * is currently playing. Calling cancel before any engine has started
 * also aborts the in-flight synth.
 */
export function speakSafetyMessage(text: string, opts: SafetyUtteranceOptions = {}): SafetyUtteranceHandle {
    const trimmed = (text || '').trim();
    let cancelled = false;
    let calypsoHandle: SpokenHandle | null = null;
    let nativeUtt: SpeechSynthesisUtterance | null = null;
    let engineUsed: 'calypso' | 'native' | 'none' = 'none';

    const done = (async () => {
        if (!trimmed) return;

        // Race: Calypso synth + playback against the budget. Whichever
        // wins decides the engine. A `won === 'calypso'` outcome means
        // Calypso started speaking before the budget expired and we
        // let it finish; a `won === 'timeout'` outcome means we bail
        // and switch to native.
        const calypsoStarted = new Promise<'started'>((resolve, reject) => {
            try {
                calypsoHandle = calypsoSpeak(trimmed);
                // Calypso's `done` promise resolves when playback
                // ENDS, but for race semantics we want to know when
                // it STARTS. We approximate "started" by polling for
                // a brief window — cleaner than threading a callback
                // through ttsClient.
                const startCheck = setInterval(() => {
                    if (cancelled) {
                        clearInterval(startCheck);
                        reject(new Error('cancelled'));
                        return;
                    }
                    if (typeof window !== 'undefined') {
                        // If any HTMLAudioElement is currently playing
                        // we treat that as "started" — close enough.
                        const playing = document.querySelectorAll('audio');
                        for (let i = 0; i < playing.length; i++) {
                            const el = playing[i] as HTMLAudioElement;
                            if (!el.paused && el.currentTime > 0) {
                                clearInterval(startCheck);
                                resolve('started');
                                return;
                            }
                        }
                    }
                }, 100);
                // If the synth resolves (playback ended) before the
                // poll caught it, treat that as "started" too — it
                // played, just very quickly.
                if (calypsoHandle) {
                    void calypsoHandle.done
                        .then(() => {
                            clearInterval(startCheck);
                            resolve('started');
                        })
                        .catch(() => {
                            clearInterval(startCheck);
                            reject(new Error('synth failed'));
                        });
                }
            } catch (err) {
                reject(err);
            }
        });

        const timeout = new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), SAFETY_TTS_BUDGET_MS);
        });

        let won: 'started' | 'timeout' = 'timeout';
        try {
            won = await Promise.race([calypsoStarted, timeout]);
        } catch {
            won = 'timeout';
        }

        if (cancelled) return;

        // TS's closure-narrowing thinks calypsoHandle is still `null`
        // here because the assignment happened inside a Promise
        // executor it can't statically prove ran synchronously. Cast
        // through unknown to recover the actual runtime type.
        const handle = calypsoHandle as unknown as SpokenHandle | null;
        if (won === 'started' && handle) {
            engineUsed = 'calypso';
            opts.onPlaybackStart?.('calypso');
            // Wait for Calypso playback to finish.
            try {
                await handle.done;
            } catch {
                /* swallow — playback failure already triggered the
                 *  reject in the race; we're past the start signal so
                 *  there's nothing graceful to do here. */
            }
            opts.onPlaybackEnd?.();
            return;
        }

        // Calypso didn't start in time. Cancel its in-flight synth so
        // we don't get a delayed double-speak when it finally arrives.
        if (handle) {
            try {
                handle.cancel();
            } catch {
                /* ignore */
            }
            calypsoHandle = null;
        }

        // Native fallback. Always available on iOS — Apple's
        // SFSpeechSynthesizer is OS-level, no network needed.
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
            opts.onError?.(new Error('No speech synthesis available'));
            return;
        }
        try {
            const utt = new SpeechSynthesisUtterance(trimmed);
            utt.rate = opts.nativeRate ?? 0.85;
            utt.pitch = opts.nativePitch ?? 0.9;
            engineUsed = 'native';
            await new Promise<void>((resolve) => {
                let started = false;
                utt.onstart = () => {
                    started = true;
                    opts.onPlaybackStart?.('native');
                };
                utt.onend = () => {
                    opts.onPlaybackEnd?.();
                    resolve();
                };
                utt.onerror = () => {
                    if (!started) opts.onError?.(new Error('Native synth failed'));
                    resolve();
                };
                if (cancelled) {
                    resolve();
                    return;
                }
                nativeUtt = utt;
                speechSynthesis.speak(utt);
            });
        } catch (err) {
            opts.onError?.(err as Error);
        }
    })();

    return {
        done,
        cancel: () => {
            cancelled = true;
            if (calypsoHandle) {
                try {
                    calypsoHandle.cancel();
                } catch {
                    /* ignore */
                }
            }
            if (nativeUtt && typeof window !== 'undefined' && 'speechSynthesis' in window) {
                try {
                    speechSynthesis.cancel();
                } catch {
                    /* ignore */
                }
            }
        },
        engineUsed: () => engineUsed,
    };
}
