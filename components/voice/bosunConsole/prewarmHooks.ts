/**
 * Deepgram availability probe + cold-start prewarm, and the post-session
 * re-arm. Lifted out of BosunConsole.tsx one-for-one: each hook holds a
 * single useEffect / useCallback and is called from the same position in
 * the component body, so hook order is unchanged.
 *
 * The dependency arrays below are the originals plus the ref / setState
 * identities the extraction made visible to react-hooks/exhaustive-deps.
 * React guarantees both are stable for the component's lifetime, so the
 * arrays are unchanged in effect.
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { type Dispatch, type SetStateAction, useCallback, useEffect } from 'react';
import {
    isDeepgramAvailable,
    prewarmAudioContext,
    prewarmDeepgramWebSocket,
    prewarmMicStream,
    prewarmWorkerConnection,
    prewarmWorkletAsset,
    releasePrewarmedAudioContext,
    releasePrewarmedMicStream,
    releasePrewarmedWebSocket,
} from '../../../services/voice/deepgramRecognizer';
import { prewarmPhoneGpsContext } from '../../../services/voice/thalassaContext';
import { PREWARM_FAIL_OPEN_MS, type VoiceOperation } from './types';

export function useDeepgramPrewarm(
    captureVoiceOperation: () => VoiceOperation,
    isVoiceOperationCurrent: (operation: VoiceOperation) => boolean,
    identityGeneration: number,
    setDeepgramStatus: Dispatch<SetStateAction<'unknown' | 'available' | 'unavailable'>>,
    setPrewarmDegraded: Dispatch<SetStateAction<boolean>>,
    setPrewarmReady: Dispatch<SetStateAction<boolean>>,
): void {
    // Probe Deepgram availability on console open. This is a runtime
    // capability check (mediaDevices, WebSocket, AudioWorklet, supabase
    // creds) — not a network probe — so it returns instantly. The actual
    // token mint + WS open happens inside startDeepgramRecognizer at
    // tap-time.
    //
    // On success, also fire a background prewarm to mint a Deepgram
    // ephemeral token and cache it for ~20s. This eliminates the
    // 150-300ms token-mint round-trip from the cold-start critical path
    // when the skipper actually taps to talk — biggest single
    // contributor to the "OVER doesn't fire on first run" bug.
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        const operation = captureVoiceOperation();
        let cancelled = false;
        let readyReported = false;
        const markReady = (degraded: boolean) => {
            if (readyReported || cancelled || !isVoiceOperationCurrent(operation)) return;
            readyReported = true;
            setPrewarmDegraded(degraded);
            setPrewarmReady(true);
            if (!degraded) {
                void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {
                    /* ignore — web/sim has no haptics */
                });
            }
        };
        // Warm-up is an optimisation, never an availability gate. A network,
        // auth, GPS or microphone probe is allowed six seconds, after which
        // typed mode stays usable and speech retries on the user's tap.
        const failOpenTimer = window.setTimeout(() => markReady(true), PREWARM_FAIL_OPEN_MS);

        void isDeepgramAvailable(true)
            .then((available) => {
                if (cancelled || !isVoiceOperationCurrent(operation)) return;
                setDeepgramStatus(available ? 'available' : 'unavailable');
                if (!available) {
                    markReady(true);
                    return;
                }
                // Multi-prewarm to slash cold-start latency on first
                // tap. Each one shaves a chunk off the tap-to-ready
                // critical path:
                //   - prewarmMicStream: getUserMedia. Dominant cold-
                //     start cost on iOS (~1.0-1.4s). Acquires the mic
                //     NOW so tap-to-ready skips it.
                //   - prewarmWorkerConnection: GET to the CF Worker so
                //     DNS+TLS+TCP are established for WS reuse.
                //   - prewarmWorkletAsset: pre-fetches /pcm-worklet.js
                //     so WKWebView caches it, saving ~50-150ms on the
                //     first audioWorklet.addModule() at tap time.
                //
                // We track all four with Promise.all so we can flip
                // prewarmReady=true the moment everything is warm, fire
                // a haptic so the skipper feels "ready", and update the
                // button subtitle from "Warming up…" to the normal
                // "Tap to talk" state.
                //
                // prewarmAudioContext is now run AFTER prewarmMicStream
                // resolves so it can wire the full audio graph (mic →
                // worklet → ring buffer) ahead of tap. The earlier
                // empty-transcript regression was rooted in forcing
                // sampleRate:16000 on iOS — that's removed; iOS picks
                // its native rate and the recognizer reads it back.
                // The ring buffer captures leading audio so the first
                // words after tap don't get clipped by AVAudioSession
                // activation latency.
                void Promise.allSettled([
                    prewarmMicStream().then(async (ok) => {
                        if (ok) {
                            // Chained so the mic stream is alive when
                            // prewarmAudioContext tries to wire it
                            // into a MediaStreamSource.
                            await prewarmAudioContext();
                        }
                        return ok;
                    }),
                    prewarmWorkletAsset(),
                    // Full WebSocket prewarm — opens the Cloudflare Worker
                    // proxy + Deepgram upstream so tap-to-ready skips the
                    // ~150-300ms WS handshake. Includes a 5-second
                    // KeepAlive ping inside Deepgram's 12-second idle
                    // timeout. Subsumes prewarmWorkerConnection (kept as
                    // a fallback below if WS prewarm fails for any
                    // reason).
                    prewarmDeepgramWebSocket().then((ok) => (ok ? true : prewarmWorkerConnection())),
                    // Reverse-geocode the phone GPS in the background so
                    // Calypso's first reply can say "near Newport,
                    // Queensland" instead of reading raw coords aloud.
                    // Returns silently when offshore (no nearby place
                    // name) — Calypso falls back to coords in that case
                    // per the system prompt's PHONE GPS rules.
                    prewarmPhoneGpsContext(),
                ]).then((results) => {
                    if (cancelled || !isVoiceOperationCurrent(operation)) {
                        releasePrewarmedMicStream();
                        releasePrewarmedWebSocket();
                        releasePrewarmedAudioContext();
                        return;
                    }
                    markReady(results.some((result) => result.status === 'rejected'));
                });
            })
            .catch(() => {
                if (cancelled || !isVoiceOperationCurrent(operation)) return;
                setDeepgramStatus('unavailable');
                markReady(true);
            });
        return () => {
            cancelled = true;
            window.clearTimeout(failOpenTimer);
            // Release everything that was prewarmed when the console
            // unmounts: mic (so iOS indicator stops), the held
            // Cloudflare Worker WebSocket (with its keep-alive timer),
            // and the prewarmed audio context + graph (closes the
            // AudioContext, disconnects the worklet, frees memory).
            // Safe even if no prewarm happened — releases are no-ops
            // when the corresponding cache is empty.
            releasePrewarmedMicStream();
            releasePrewarmedWebSocket();
            releasePrewarmedAudioContext();
        };
    }, [
        captureVoiceOperation,
        identityGeneration,
        isVoiceOperationCurrent,
        setDeepgramStatus,
        setPrewarmDegraded,
        setPrewarmReady,
    ]);
}

/**
 * Re-arm the prewarm pipeline after a recognizer session ends.
 *
 * Background: the mount-time prewarm (above) makes the FIRST tap fast.
 * But the recognizer's teardown closes the AudioContext, stops the mic
 * tracks, and closes the WebSocket — by design, so the iOS mic
 * indicator goes off and resources free. The downside is every
 * subsequent tap cold-starts (~200-500ms), and on iOS that's enough to
 * eat the first few words of speech.
 *
 * Fix: kick the same prewarm chain again the moment a session ends, so
 * by the time the user is ready to tap again everything is warm. Fire-
 * and-forget; we don't block the response cycle on it. Each prewarm
 * function is idempotent and safe to call when the slot is null
 * (which it always is post-teardown, since consume + teardown null
 * out prewarmedMicStream / prewarmedAudio / prewarmedWebSocket).
 *
 * Skips setPrewarmReady — already true from the mount-time prewarm.
 * If a re-arm somehow fails we don't toggle it false; falling through
 * to a cold getUserMedia/context build is still functional, just slower.
 */
export function useRearmPrewarm(
    isVoiceOperationCurrent: (operation: VoiceOperation) => boolean,
): (operation: VoiceOperation) => void {
    return useCallback(
        (operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
            void Promise.all([
                prewarmMicStream().then(async (ok) => {
                    if (ok) await prewarmAudioContext();
                    return ok;
                }),
                prewarmWorkletAsset(),
                prewarmDeepgramWebSocket().then((ok) => (ok ? true : prewarmWorkerConnection())),
            ]).then(() => {
                if (isVoiceOperationCurrent(operation)) return;
                // A transition may occur while getUserMedia/WS acquisition is
                // pending. Release anything that completed after the cutover.
                releasePrewarmedMicStream();
                releasePrewarmedWebSocket();
                releasePrewarmedAudioContext();
            });
        },
        [isVoiceOperationCurrent],
    );
}
