/**
 * Audio-element hooks for the voice console: the stale-playback stop, the
 * iOS user-gesture unlock, and response playback. Lifted out of
 * BosunConsole.tsx one-for-one; each hook holds a single useCallback and is
 * called from the same position in the component body.
 *
 * The dependency arrays below are the originals plus the ref / setState
 * identities the extraction made visible to react-hooks/exhaustive-deps.
 * React guarantees both are stable for the component's lifetime, so the
 * arrays are unchanged in effect.
 */
import { type MutableRefObject, useCallback } from 'react';
import type { TalkButtonState } from '../TalkButton';
import { audioFromBase64 } from './helpers';
import type { VoiceOperation } from './types';
import type { VoiceQueryResponse } from '../../../types/voice';

export function useStopAudio(audioRef: MutableRefObject<HTMLAudioElement | null>): () => void {
    return useCallback(() => {
        const audio = audioRef.current;
        if (audio && !audio.paused) {
            try {
                audio.pause();
                audio.currentTime = 0;
            } catch {
                /* ignore */
            }
        }
    }, [audioRef]);
}

/**
 * Unlock audio playback for iOS WKWebView.
 *
 * iOS only lets HTMLAudio.play() succeed without warning when called
 * from a synchronous user-gesture handler. After our async fetch + STT
 * round-trip, that gesture context is gone, and audio.play() rejects
 * with NotAllowedError (silently — text shows but no voice plays).
 *
 * The fix: when the user taps the talk button (real user gesture),
 * synchronously create + play a silent buffer on a persistent Audio
 * element. iOS marks that element as "user-gesture-authorized" for the
 * lifetime of the page. Future src changes + play() calls on the SAME
 * element work without needing a fresh gesture.
 *
 * Must be called synchronously inside the tap handler — NOT inside
 * useCallback (callbacks are fine but they must run before any await).
 */
export function useUnlockAudio(
    audioRef: MutableRefObject<HTMLAudioElement | null>,
    isVoiceOperationCurrent: (operation: VoiceOperation) => boolean,
): (operation: VoiceOperation) => void {
    return useCallback(
        (operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
            if (!audioRef.current) {
                audioRef.current = new Audio();
                audioRef.current.preload = 'auto';
            }
            const audio = audioRef.current;
            // CRITICAL: clear stale onended/onerror from the previous response.
            // Without this, the silent unlock WAV's 'ended' event fires the
            // OLD closure (e.g. setOneButton('cloud', 'idle') from cycle 1)
            // which then clobbers the 'recording' state we're about to set —
            // observed as "tap → tap to send → straight back to tap to talk".
            audio.onended = null;
            audio.onerror = null;

            // Tiny silent WAV (44-byte RIFF header, no samples) — just enough
            // to satisfy iOS that this Audio element is in a "playing" lineage.
            const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
            try {
                audio.muted = true;
                audio.src = silentWav;
                // .play() returns a Promise we don't await — fire and continue.
                // The promise resolves successfully on iOS when called from
                // within a user gesture, even with the silent buffer.
                const p = audio.play();
                if (p && typeof p.then === 'function') {
                    p.then(() => {
                        if (!isVoiceOperationCurrent(operation) || audioRef.current !== audio) return;
                        audio.pause();
                        audio.muted = false;
                        audio.currentTime = 0;
                    }).catch(() => {
                        if (!isVoiceOperationCurrent(operation) || audioRef.current !== audio) return;
                        audio.muted = false;
                    });
                }
            } catch {
                /* ignore — we'll surface the real error on actual playback */
            }
        },
        [isVoiceOperationCurrent, audioRef],
    );
}

export function usePlayResponseAudio(
    audioRef: MutableRefObject<HTMLAudioElement | null>,
    audioUrlsRef: MutableRefObject<string[]>,
    isVoiceOperationCurrent: (operation: VoiceOperation) => boolean,
    setErrorMessage: (msg: string | null) => void,
    setOneButton: (which: 'bosun' | 'cloud', s: TalkButtonState) => void,
): (response: VoiceQueryResponse, to: 'bosun' | 'cloud', operation: VoiceOperation) => void {
    return useCallback(
        (response: VoiceQueryResponse, to: 'bosun' | 'cloud', operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
            if (!response.audio_b64) {
                setOneButton(to, 'idle');
                return;
            }

            // ── iOS native: route through the AppleMusic plugin's
            //    playTtsAudio. That path uses AVAudioPlayer in our
            //    `.playback + .mixWithOthers` session AND explicitly
            //    pauses MusicKit before playback / resumes after, so
            //    Calypso narrating doesn't kill the user's music. The
            //    HTML5 fallback below activates a different audio
            //    session that interrupts MusicKit permanently.
            const audio_b64 = response.audio_b64;
            void (async () => {
                try {
                    const { Capacitor } = await import('@capacitor/core');
                    if (!isVoiceOperationCurrent(operation)) return;
                    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {
                        const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
                            .Capacitor;
                        const plugin = cap?.Plugins?.AppleMusic as
                            | {
                                  playTtsAudio: (opts: { audio_b64: string }) => Promise<{ status: string }>;
                                  cancelTtsAudio?: () => Promise<{ status: string }>;
                              }
                            | undefined;
                        if (plugin) {
                            try {
                                await plugin.playTtsAudio({ audio_b64 });
                            } catch {
                                /* swallow — TTS already failed; nothing to surface */
                            }
                            if (!isVoiceOperationCurrent(operation)) {
                                void plugin.cancelTtsAudio?.().catch(() => undefined);
                                return;
                            }
                            setOneButton(to, 'idle');
                            return;
                        }
                    }
                } catch {
                    /* fall through to HTML5 path */
                }

                // ── HTML5 Audio fallback (web / non-iOS-native) ──
                try {
                    if (!isVoiceOperationCurrent(operation)) return;
                    const url = audioFromBase64(audio_b64);
                    if (!isVoiceOperationCurrent(operation)) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    audioUrlsRef.current.push(url);

                    // Reuse the unlocked Audio element from the user tap. If
                    // it doesn't exist (text-input path), create one —
                    // playback may not work on iOS but text is still rendered.
                    let audio = audioRef.current;
                    if (!audio) {
                        audio = new Audio();
                        audioRef.current = audio;
                    }
                    try {
                        audio.pause();
                    } catch {
                        /* ignore */
                    }
                    audio.src = url;
                    audio.muted = false;
                    audio.currentTime = 0;
                    audio.onended = () => {
                        if (isVoiceOperationCurrent(operation) && audioRef.current === audio) setOneButton(to, 'idle');
                    };
                    audio.onerror = () => {
                        if (isVoiceOperationCurrent(operation) && audioRef.current === audio) setOneButton(to, 'idle');
                    };

                    const playPromise = audio.play();
                    if (playPromise && typeof playPromise.then === 'function') {
                        playPromise.catch((err: Error) => {
                            if (!isVoiceOperationCurrent(operation) || audioRef.current !== audio) return;
                            if (err?.name === 'NotAllowedError') {
                                setErrorMessage(
                                    'Audio playback blocked by iOS — tap a talk button first to enable, then replay this answer.',
                                );
                            }
                            setOneButton(to, 'idle');
                        });
                    }
                } catch {
                    if (isVoiceOperationCurrent(operation)) setOneButton(to, 'idle');
                }
            })();
        },
        [isVoiceOperationCurrent, setErrorMessage, setOneButton, audioRef, audioUrlsRef],
    );
}
