/**
 * BosunConsole — full-screen voice console.
 *
 * One big blue Bosun button. The brain it routes to is decided here
 * based on connectivity, with cloud as the primary path:
 *   - Cloud reachable       → "Bosun cloud"      — Anthropic Haiku 4.5 (primary)
 *   - Offline, Pi reachable → "Bosun local (3B)" — Llama 3.2 3B fallback
 *   - Neither               → button greyed out, "Bosun offline"
 *
 * The active brain is shown in the subtitle under the button — there is
 * one Bosun, the brain swaps in behind it. Local 3B is a graceful
 * degradation, never the preferred path.
 *
 * Voice transport: MediaRecorder + getUserMedia. The previous Web Speech
 * API approach was unreliable on iOS WKWebView (audio session conflicts,
 * second-query failures, inconsistent onend firing). MediaRecorder is a
 * standards-based API supported on iOS 14.3+ that behaves the same way
 * as on Chrome. STT happens server-side (Whisper.cpp on the Pi for the
 * local path; ElevenLabs Scribe in the Edge Function for the cloud path).
 *
 * Both audio AND text are always rendered. Audio auto-plays on response;
 * text is right there if speakers are off, the wind is loud, etc.
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import { PiSetupWizard } from './PiSetupWizard';
import { TalkButton, type TalkButtonState } from './TalkButton';
import { isAudioRecordingSupported, startRecording } from '../../services/voice/audioRecorder';
import { askBosunText, askBosunVoice, isBosunReachable } from '../../services/voice/bosunVoice';
import { askCloudVoice } from '../../services/voice/cloudFallback';
import { publishTurn, startConversationSync, type ConversationSyncHandle } from '../../services/voice/conversationSync';
import { askHaiku, synthesiseSpeech } from '../../services/voice/orchestrator';
import {
    isDeepgramAvailable,
    prewarmAudioContext,
    prewarmDeepgram,
    prewarmDeepgramWebSocket,
    prewarmMicStream,
    prewarmWorkerConnection,
    prewarmWorkletAsset,
    primeAudioPipeline,
    releasePrewarmedAudioContext,
    releasePrewarmedMicStream,
    releasePrewarmedWebSocket,
    setDeepgramEventTap,
    startDeepgramRecognizer,
    type DeepgramRecognizerHandle,
} from '../../services/voice/deepgramRecognizer';
import {
    isSpeechRecognitionAvailable,
    setSrEventTap,
    startSpeechRecognition,
    type SpeechRecognizerHandle,
} from '../../services/voice/speechRecognizer';
import { gatherThalassaContext, prewarmPhoneGpsContext } from '../../services/voice/thalassaContext';
import { canAccess } from '../../services/SubscriptionService';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVoiceHistoryStore } from '../../stores/voiceHistoryStore';
import type { VoiceHistoryTurn, VoiceQueryResponse, VoiceTurn } from '../../types/voice';

/**
 * How many prior turns to send for context. Each turn = one user + one
 * assistant message, so 2 turns = 4 messages. Tuned aggressively down
 * (was 4, was 10 originally) because each call carries 1.5-3K tokens
 * of state context + tool definitions + this history slice, which
 * stacks against per-minute Anthropic rate limits when the skipper
 * fires several queries in succession. Recent style-instructions still
 * persist (e.g. "speak like a pirate") within ~2 turns; older context
 * gets trimmed.
 */
const HISTORY_TURN_LIMIT = 2;

/**
 * Feature flag — disable Apple SR's slot in the fallback chain.
 *
 * Why this exists: when both Deepgram and Apple SR are wired in,
 * silent failures on the Deepgram path cascade into Apple SR, which
 * then hits its per-device quota lockout, which then cascades into
 * MediaRecorder. The skipper sees the "iOS speech-recognition rate
 * limit" toast and we have no way to tell whether Deepgram even ran.
 *
 * Set to false to make Deepgram → MediaRecorder the only path. Apple
 * SR is skipped entirely — its status pill stays informational but
 * its handler never runs. If Deepgram fails for any reason, the
 * cascade goes straight to MediaRecorder + Scribe (loses the live
 * OVER gesture but keeps the question quality via strip-at-stop).
 *
 * Flip to true once we're confident Deepgram is reliable on the
 * skipper's iOS device.
 */
const ENABLE_APPLE_SR_FALLBACK = false;

/**
 * Detect "over" at the end of an utterance. The skipper can say "over"
 * as a hands-free alternative to tap-to-send — same as ham-radio
 * etiquette. We strip it from the transcript before sending so Haiku
 * doesn't see "over" as part of the question.
 *
 * Apple SR is autocorrect-happy and tends to insert punctuation that
 * the previous word-boundary regex couldn't handle ("doing? Over.",
 * "doing, over!", smart quotes, etc.). The two-stage match below is
 * more forgiving: strip trailing punctuation/whitespace first, then
 * look for the literal final word "over".
 *
 * Examples:
 *   "what's the wind doing over"      → matched, cleaned = "what's the wind doing"
 *   "What's the wind doing? Over."    → matched, cleaned = "What's the wind doing?"
 *   "over."                            → matched, cleaned = ""
 *   "moreover"                         → not matched (no whitespace before)
 *   "the storm's moving over to it"   → not matched (not at end)
 */
function detectOverSuffix(text: string): { matched: boolean; cleaned: string } {
    // Strip trailing punctuation/whitespace so SR-added periods or
    // exclamation marks don't break the suffix match.
    const stripped = text.replace(/[\s.,;:!?'"]+$/, '');
    if (/^over$/i.test(stripped)) {
        return { matched: true, cleaned: '' };
    }
    const m = stripped.match(/^(.+?)\s+over$/i);
    if (m) return { matched: true, cleaned: m[1].trim() };
    return { matched: false, cleaned: text };
}

/**
 * Convert recent VoiceTurns into the {role, text} shape the edge function
 * expects. Drops everything except the user's transcript and the assistant's
 * final answer text — no tool_use/tool_result blocks, since we replay just
 * the conversational thread for continuity.
 */
function buildHistory(turns: VoiceTurn[]): VoiceHistoryTurn[] {
    const recent = turns.slice(-HISTORY_TURN_LIMIT);
    const out: VoiceHistoryTurn[] = [];
    for (const t of recent) {
        const userText = (t.transcript || '').trim();
        const asstTextRaw = (t.response.answer_text || '').trim();
        if (!userText || !asstTextRaw) continue;
        // Identity-bias fix: persisted history may contain pre-rename
        // assistant turns where she introduced herself as "Bosun". When
        // those get sent back as history, the model picks up the old
        // identity and re-asserts it ("I'm Bosun") even though the
        // current system prompt says Calypso. Replace on the wire so
        // the conversation thread is consistent. Captain's user-text
        // is left alone — they may have legitimately referred to her
        // as Bosun and we don't rewrite their words.
        const asstText = asstTextRaw.replace(/\bBosun\b/g, 'Calypso');
        out.push({ role: 'user', text: userText });
        out.push({ role: 'assistant', text: asstText });
    }
    return out;
}

interface BosunConsoleProps {
    /**
     * Optional back-navigation callback. When provided, the page header
     * renders a back button that calls this. Routed pages typically pass
     * `() => setPage('dashboard')` (or wherever the skipper came from).
     */
    onBack?: () => void;
}

interface TargetState {
    bosun: TalkButtonState;
    cloud: TalkButtonState;
}

const initialTargetState: TargetState = { bosun: 'idle', cloud: 'idle' };

/** Decode a base64 string to a Blob URL for HTML5 audio playback. */
function audioFromBase64(b64: string, mimeType = 'audio/mpeg'): string {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
}

/** Quick connectivity check for the cloud fallback (any HTTPS reach). */
async function checkCloudReachable(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
        return navigator.onLine;
    }
    return true;
}

export const BosunConsole: React.FC<BosunConsoleProps> = ({ onBack }) => {
    const [buttonState, setButtonState] = useState<TargetState>(initialTargetState);
    // Conversation history persists across console open/close via Zustand +
    // localStorage. Adding a turn auto-trims to MAX_PERSISTED_TURNS in the
    // store. The slice we SEND to Haiku is still capped at HISTORY_TURN_LIMIT
    // below — UI can show more than we send.
    const turns = useVoiceHistoryStore((s) => s.turns);
    const addTurn = useVoiceHistoryStore((s) => s.addTurn);
    const upsertTurnSorted = useVoiceHistoryStore((s) => s.upsertTurnSorted);
    const clearHistory = useVoiceHistoryStore((s) => s.clearHistory);

    /**
     * Realtime sync handle for cross-crew conversation sharing. Resolves
     * to a no-op handle when the user isn't authenticated or isn't on a
     * vessel; in that case the console runs local-only as before.
     */
    const syncHandleRef = useRef<ConversationSyncHandle | null>(null);

    /**
     * Promise that resolves when SR fires its first partial event for
     * the current recording cycle. Used by the tap-to-stop branch to
     * wait briefly on cold-start cycles — gives the live OVER gesture
     * a chance to catch a slow-arriving partial before we tear the
     * recognizer down. Set fresh on each SR start; resolved by the
     * onFirstPartial callback.
     */
    const firstPartialPromiseRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
    const [typedQuery, setTypedQuery] = useState('');
    const [rawErrorMessage, setRawErrorMessage] = useState<string | null>(null);

    /**
     * Wrapped error setter. Two responsibilities:
     *
     *   1. Intercept the bare "The quota has been exceeded." string and
     *      remap to a friendly + actionable message. Hypothesis (post
     *      8-hour test confirming zombie SR is dead): this text is iOS
     *      Safari's verbatim localStorage QuotaExceededError message
     *      ("The quota has been exceeded." with name=QuotaExceededError
     *      and code=22). When localStorage fills up — accumulated across
     *      many Zustand-persisted stores plus Capacitor Preferences plus
     *      whatever else writes — set() inside the persist middleware
     *      synchronously throws that exact string from the native
     *      Safari WebStorage API.
     *
     *   2. Capture the trace at error origin via the Error object's own
     *      stack (NOT a synthesised wrapper Error — that captures this
     *      line, not the actual throw point). The setErrorMessage call
     *      sites are now responsible for passing the original Error or
     *      its stack via setQuotaTrace() so we get the real source.
     */
    const setErrorMessage = useCallback((msg: string | null) => {
        if (
            msg &&
            (/^The quota has been exceeded\.?$/i.test(msg.trim()) ||
                /quota.{0,15}exceeded/i.test(msg) ||
                /quotaexceedederror/i.test(msg))
        ) {
            const friendly =
                'Local storage is full — tap CLEAR at top right to free voice history, ' +
                'then try again. (iOS WKWebView caps localStorage at ~5MB per origin.)';
            setRawErrorMessage(friendly);
            return;
        }
        setRawErrorMessage(msg);
    }, []);

    /**
     * Companion setter for the error origin trace. Call sites that
     * catch errors and call setErrorMessage should also call this with
     * the caught Error so we can show the actual throw line in the
     * debug strip — far more useful than the catch-site stack.
     */
    const setQuotaTrace = useCallback((err: unknown) => {
        if (!err || !(err instanceof Error)) return;
        const stack = err.stack ?? '(no stack)';
        const message = err.message ?? '(no message)';
        const name = err.name ?? '(no name)';
        if (
            !/^The quota has been exceeded\.?$/i.test(message.trim()) &&
            !/quota.{0,15}exceeded/i.test(message) &&
            !/quotaexceedederror/i.test(message + name)
        ) {
            return;
        }
        console.warn('[quota-trace]', name, message, stack);
        const topFrames = stack.split('\n').slice(0, 5).join(' | ').slice(0, 250);
        setSrEventLog((prev) => [
            ...prev.slice(-19),
            { ts: Date.now(), msg: `[quota-trace] name=${name} → ${topFrames}` },
        ]);
    }, []);
    const errorMessage = rawErrorMessage;
    const [activeTarget, setActiveTarget] = useState<'bosun' | 'cloud' | null>(null);

    const [bosunAvailable, setBosunAvailable] = useState<boolean | null>(null);
    const [cloudAvailable, setCloudAvailable] = useState<boolean | null>(null);

    const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
    const speechRecognizerRef = useRef<SpeechRecognizerHandle | null>(null);
    /**
     * Deepgram WebSocket recognizer — primary cloud-streaming STT. Used
     * in preference to Apple SR when available because (a) it doesn't
     * share Apple's per-device rate limit, (b) Nova-3 is sharper on
     * accented English + marine vocabulary, (c) `keywords` parameter
     * lets us boost "Calypso" and "over" so the OVER auto-send gesture
     * fires reliably even with mumbled enunciation.
     *
     * Apple SR remains the fallback below this — same handle interface,
     * so the stop/cancel paths are uniform regardless of which one
     * actually started.
     */
    const deepgramRecognizerRef = useRef<DeepgramRecognizerHandle | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioUrlsRef = useRef<string[]>([]);
    const conversationEndRef = useRef<HTMLDivElement | null>(null);

    /**
     * Live partial-transcript shown under the talk button while recording.
     * Updates from Apple SR's partialResults stream — the skipper sees their
     * words appear as they speak, instead of waiting for Scribe round-trip.
     */
    const [liveTranscript, setLiveTranscript] = useState('');

    /**
     * Whether the active recognizer (Deepgram OR Apple SR) has fired at
     * least one partial event for the CURRENT recording cycle. If false
     * during recording, the streaming path didn't take and we'll fall
     * back to Scribe on stop. Visible to the skipper as a small
     * indicator next to the live transcript. Name kept for backwards
     * compatibility with the existing debug strip filter conventions.
     */
    const [srActive, setSrActive] = useState(false);

    /**
     * Which recognizer is actually running this cycle. Set when start()
     * succeeds for one of the tiers; back to null on stop/cancel/error.
     * Drives the UI label so the skipper can see whether they're on
     * Deepgram, Apple SR, or the audio-blob fallback at a glance.
     */
    const [activeRecognizerKind, setActiveRecognizerKind] = useState<'deepgram' | 'apple-sr' | 'media-recorder' | null>(
        null,
    );

    /**
     * Persistent SR availability status, checked on console open. Visible as
     * a pill in the header so the skipper can tell at a glance whether the
     * Apple SR fast-path will be in play before they ever tap the button.
     *
     *   'unknown'    initial / probing
     *   'available'  plugin loaded + permission granted
     *   'denied'     permission denied — go to iOS Settings to grant
     *   'unsupported' plugin not registered (Xcode build missing the pod)
     *                or device doesn't have SFSpeechRecognizer
     *   'error'      probe threw an exception; check srStatusError
     */
    const [srStatus, setSrStatus] = useState<'unknown' | 'available' | 'denied' | 'unsupported' | 'error'>('unknown');
    const [srStatusError, setSrStatusError] = useState<string | null>(null);

    /**
     * Deepgram availability status, probed on console open. The probe is
     * a fast pre-flight (no actual WS open) so we can decide at tap-time
     * which path to attempt without a perceptible delay.
     */
    const [deepgramStatus, setDeepgramStatus] = useState<'unknown' | 'available' | 'unavailable'>('unknown');

    /**
     * Tracks when ALL the cold-start prewarms have completed (mic stream
     * acquired, Worker TLS path established, worklet asset cached). Used
     * to gate the talk button's subtitle so the skipper sees "Warming
     * up…" until everything is actually ready, instead of seeing "Tap
     * to talk" while iOS is still ~1s into acquiring the mic.
     *
     * We also fire a haptic the moment this flips to true — tactile
     * cue that the system is ready for the tap.
     */
    const [prewarmReady, setPrewarmReady] = useState(false);

    /**
     * Open state for the Pi-provisioning wizard. Triggered from the
     * header CTA when the Pi is unreachable. The wizard owns its own
     * step state internally — we just track open/closed here.
     */
    const [piSetupOpen, setPiSetupOpen] = useState(false);

    /**
     * Last few [SR] events for the on-device debug strip. Visible to the
     * skipper without Web Inspector — when the console "locks up" we can
     * read off exactly which step stalled. Capped at 6 events so the strip
     * stays compact.
     */
    const [srEventLog, setSrEventLog] = useState<Array<{ ts: number; msg: string }>>([]);

    // Wire the speechRecognizer's event tap into local state so emitted [SR]
    // messages show up in the debug strip. Runs once per mount.
    useEffect(() => {
        setSrEventTap((msg) => {
            setSrEventLog((prev) => [...prev.slice(-19), { ts: Date.now(), msg }]);
        });
        // Same hook for [DG] (Deepgram) events — share the debug strip so
        // the skipper can see the full path: token mint → ws open → first
        // partial → close, all in one timeline.
        setDeepgramEventTap((msg) => {
            setSrEventLog((prev) => [...prev.slice(-19), { ts: Date.now(), msg }]);
        });
        return () => {
            setSrEventTap(null);
            setDeepgramEventTap(null);
        };
    }, []);

    // ── Effects ─────────────────────────────────────────────────────────

    // Probe availability when console opens + every 30s
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        let cancelled = false;
        const probe = async () => {
            const [bosun, cloud] = await Promise.all([isBosunReachable(), checkCloudReachable()]);
            if (!cancelled) {
                setBosunAvailable(bosun);
                setCloudAvailable(cloud);
            }
        };
        void probe();
        const interval = setInterval(probe, 30_000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, []);

    // Probe SR availability on console open. Surfaces the result in the
    // header pill so the skipper doesn't need Web Inspector or Xcode logs
    // to tell whether the on-device fast-path is going to be in play.
    //
    // Skipped entirely when ENABLE_APPLE_SR_FALLBACK is false — calling
    // even the availability check on Apple's SFSpeechRecognizer API
    // counts against iOS's per-device rate limit and can lock the
    // audio session for 30-60 minutes if quota was already low.
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        if (!ENABLE_APPLE_SR_FALLBACK) {
            // Don't even ask iOS about SR — keep the audio system clean.
            setSrStatus('unsupported');
            setSrStatusError('Apple SR disabled by feature flag');
            return;
        }
        let cancelled = false;
        const probe = async () => {
            try {
                const available = await isSpeechRecognitionAvailable(true);
                if (cancelled) return;
                if (available) {
                    setSrStatus('available');
                    setSrStatusError(null);
                } else {
                    // Distinguish "unsupported" from "denied" by re-checking
                    // permission state directly. If the bridge throws, the
                    // catch below sets 'unsupported'.
                    try {
                        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
                        const status = await SpeechRecognition.checkPermissions();
                        if (cancelled) return;
                        setSrStatus(status.speechRecognition === 'denied' ? 'denied' : 'unsupported');
                        setSrStatusError(null);
                    } catch (err) {
                        if (cancelled) return;
                        setSrStatus('unsupported');
                        setSrStatusError((err as Error).message);
                    }
                }
            } catch (err) {
                if (cancelled) return;
                setSrStatus('error');
                setSrStatusError((err as Error).message);
            }
        };
        void probe();
        return () => {
            cancelled = true;
        };
    }, []);

    // localStorage usage probe on console open. iOS WKWebView caps
    // localStorage at ~5 MB per origin; once full, setItem() throws
    // verbatim "The quota has been exceeded." which has been
    // confusing the skipper. Logging the size + breakdown to the
    // debug strip lets us see at a glance whether storage pressure
    // is the actual cause.
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        try {
            let total = 0;
            const big: Array<{ key: string; size: number }> = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k === null) continue;
                const v = localStorage.getItem(k) ?? '';
                const size = k.length + v.length;
                total += size;
                if (size > 50_000) big.push({ key: k, size });
            }
            big.sort((a, b) => b.size - a.size);
            const totalKb = (total / 1024).toFixed(0);
            const topKeys =
                big
                    .slice(0, 3)
                    .map((b) => `${b.key.slice(0, 22)}=${(b.size / 1024).toFixed(0)}KB`)
                    .join(', ') || '(none >50KB)';
            setSrEventLog((prev) => [
                ...prev.slice(-19),
                { ts: Date.now(), msg: `[storage] total=${totalKb}KB; top: ${topKeys}` },
            ]);
        } catch (err) {
            setSrEventLog((prev) => [
                ...prev.slice(-19),
                { ts: Date.now(), msg: `[storage] probe failed: ${(err as Error).message}` },
            ]);
        }
    }, []);

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
        let cancelled = false;
        void isDeepgramAvailable(true).then((available) => {
            if (cancelled) return;
            setDeepgramStatus(available ? 'available' : 'unavailable');
            if (available) {
                // Multi-prewarm to slash cold-start latency on first
                // tap. Each one shaves a chunk off the tap-to-ready
                // critical path:
                //   - prewarmDeepgram: token cache (no-op on Cloudflare
                //     path which doesn't need a token)
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
                void Promise.all([
                    prewarmDeepgram(),
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
                ]).then(() => {
                    if (cancelled) return;
                    setPrewarmReady(true);
                    void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {
                        /* ignore — web/sim has no haptics */
                    });
                });
            }
        });
        return () => {
            cancelled = true;
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
    }, []);

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
    const rearmPrewarm = useCallback(() => {
        void Promise.all([
            prewarmDeepgram(),
            prewarmMicStream().then(async (ok) => {
                if (ok) await prewarmAudioContext();
                return ok;
            }),
            prewarmWorkletAsset(),
            prewarmDeepgramWebSocket().then((ok) => (ok ? true : prewarmWorkerConnection())),
        ]);
    }, []);

    // Auto-scroll on new content
    useEffect(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns.length, errorMessage, buttonState.bosun, buttonState.cloud]);

    // Subscribe to per-vessel Realtime when the console opens so crew turns
    // arrive in real time. Unsubscribes on close. Falls back to local-only
    // silently if the user isn't on a vessel.
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        let cancelled = false;
        void startConversationSync({
            onRemoteTurn: (turn) => {
                if (cancelled) return;
                upsertTurnSorted(turn);
            },
        }).then((handle) => {
            if (cancelled) {
                void handle.stop();
                return;
            }
            syncHandleRef.current = handle;
        });
        return () => {
            cancelled = true;
            const handle = syncHandleRef.current;
            syncHandleRef.current = null;
            if (handle) void handle.stop();
        };
    }, [upsertTurnSorted]);

    // Cleanup on unmount: free Blob URLs, abort any in-flight recording + SR
    useEffect(() => {
        const urls = audioUrlsRef.current;
        return () => {
            urls.forEach((u) => URL.revokeObjectURL(u));
            const rec = recorderRef.current;
            if (rec) {
                try {
                    rec.cancel();
                } catch {
                    /* ignore */
                }
            }
            const sr = speechRecognizerRef.current;
            if (sr) {
                try {
                    void sr.cancel();
                } catch {
                    /* ignore */
                }
            }
            const dg = deepgramRecognizerRef.current;
            if (dg) {
                try {
                    void dg.cancel();
                } catch {
                    /* ignore */
                }
            }
        };
    }, []);

    // ── Helpers ─────────────────────────────────────────────────────────

    const setOneButton = useCallback((which: 'bosun' | 'cloud', s: TalkButtonState) => {
        // Mirror state transitions into the debug strip so the skipper can
        // see exactly where a lockup landed without needing Web Inspector.
        setSrEventLog((prev) => [...prev.slice(-19), { ts: Date.now(), msg: `[btn] ${which} → ${s}` }]);
        setButtonState((prev) => ({ ...prev, [which]: s }));
    }, []);

    const stopAudio = useCallback(() => {
        const audio = audioRef.current;
        if (audio && !audio.paused) {
            try {
                audio.pause();
                audio.currentTime = 0;
            } catch {
                /* ignore */
            }
        }
    }, []);

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
    const unlockAudio = useCallback(() => {
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
                    audio.pause();
                    audio.muted = false;
                    audio.currentTime = 0;
                }).catch(() => {
                    audio.muted = false;
                });
            }
        } catch {
            /* ignore — we'll surface the real error on actual playback */
        }
    }, []);

    const playResponseAudio = useCallback(
        (response: VoiceQueryResponse, to: 'bosun' | 'cloud') => {
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
                    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {
                        const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
                            .Capacitor;
                        const plugin = cap?.Plugins?.AppleMusic as
                            | {
                                  playTtsAudio: (opts: { audio_b64: string }) => Promise<{ status: string }>;
                              }
                            | undefined;
                        if (plugin) {
                            try {
                                await plugin.playTtsAudio({ audio_b64 });
                            } catch {
                                /* swallow — TTS already failed; nothing to surface */
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
                    const url = audioFromBase64(audio_b64);
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
                    audio.onended = () => setOneButton(to, 'idle');
                    audio.onerror = () => setOneButton(to, 'idle');

                    const playPromise = audio.play();
                    if (playPromise && typeof playPromise.then === 'function') {
                        playPromise.catch((err: Error) => {
                            if (err?.name === 'NotAllowedError') {
                                setErrorMessage(
                                    'Audio playback blocked by iOS — tap a talk button first to enable, then replay this answer.',
                                );
                            }
                            setOneButton(to, 'idle');
                        });
                    }
                } catch {
                    setOneButton(to, 'idle');
                }
            })();
        },
        [setOneButton],
    );

    const appendTurn = useCallback(
        (transcript: string, response: VoiceQueryResponse) => {
            const turn: VoiceTurn = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: Date.now(),
                transcript,
                response,
            };
            addTurn(turn);
            // Fire-and-forget: publish to Realtime so crew on the same
            // vessel see this turn appear in their own conversation log.
            // No-op if sharing is unavailable (not signed in, not on a
            // vessel, RLS rejected). We don't await — the local UI
            // shouldn't wait on the network for what's already on screen.
            const sync = syncHandleRef.current;
            if (sync && sync.active) {
                void publishTurn(sync, turn, response);
            }
        },
        [addTurn],
    );

    const handleResponse = useCallback(
        (response: VoiceQueryResponse, to: 'bosun' | 'cloud') => {
            appendTurn(response.transcript || '(no transcript)', response);
            setOneButton(to, 'playing');
            playResponseAudio(response, to);
            // Safety net: force idle after 60s if onended never fires.
            setTimeout(() => {
                setButtonState((s) => (s[to] === 'playing' ? { ...s, [to]: 'idle' } : s));
            }, 60_000);
        },
        [appendTurn, playResponseAudio, setOneButton],
    );

    /**
     * Run the on-device orchestrator path: Haiku tool-loop runs locally
     * via anthropic-proxy, dispatching Pi tools and thalassa_weather
     * client-side, then ElevenLabs TTS via elevenlabs-tts. Returns the
     * standard VoiceQueryResponse envelope so handleResponse can stay
     * agnostic to which path produced the answer.
     */
    // Settings → Calypso integrations. Apple Music is always on for
    // Skipper tier — auth is handled in-app on the Music page, no
    // separate toggle. Gmail still requires (a) tier access AND (b)
    // an explicit toggle in Settings → Calypso Integrations (because
    // it kicks off an OAuth flow and links a real email account).
    const tier = useSettingsStore((s) => s.settings.subscriptionTier);
    const calypsoEmailEnabled = useSettingsStore((s) => s.settings.calypsoEmailEnabled ?? false);
    const integrationsEnabled = useMemo(
        () => ({
            appleMusic: canAccess(tier, 'calypsoMusic'),
            gmail: calypsoEmailEnabled && canAccess(tier, 'calypsoEmail'),
        }),
        [tier, calypsoEmailEnabled],
    );

    const runOrchestrator = useCallback(
        async (text: string): Promise<VoiceQueryResponse> => {
            const context = gatherThalassaContext();
            const history = buildHistory(turns);
            const result = await askHaiku({
                text,
                context,
                history,
                integrations: integrationsEnabled,
            });
            const audio_b64 = await synthesiseSpeech(result.answerText);
            return {
                transcript: text,
                answer_text: result.answerText,
                audio_b64: audio_b64 ?? undefined,
                source: 'cloud',
                tool_calls: result.toolCalls.map((name) => ({
                    name,
                    args: {},
                    status: 'success' as const,
                })),
            };
        },
        [turns, integrationsEnabled],
    );

    const sendVoiceQuery = useCallback(
        async (audioBlob: Blob, to: 'bosun' | 'cloud', preTranscribed?: string | null) => {
            if (audioBlob.size === 0 && !preTranscribed) {
                setErrorMessage('No audio captured — try holding for a moment longer.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
                return;
            }
            setOneButton(to, 'awaiting');
            setErrorMessage(null);
            try {
                let response: VoiceQueryResponse;
                if (to === 'cloud' && preTranscribed) {
                    // FAST PATH: Apple SR transcribed on-device. Run the
                    // full Haiku tool-loop on the iPhone so Pi tools are
                    // dispatched without extra Supabase round-trips.
                    response = await runOrchestrator(preTranscribed);
                } else if (to === 'cloud') {
                    // FALLBACK: SR didn't produce text, ship the audio
                    // blob to the legacy edge function which runs Scribe
                    // STT then its own Haiku loop. Path A doesn't extract
                    // STT yet — separate commit.
                    const context = gatherThalassaContext();
                    const history = buildHistory(turns);
                    response = await askCloudVoice(audioBlob, context, history);
                } else {
                    // Tier-D: Pi cascade (3B + RAG) on local LAN.
                    response = await askBosunVoice(audioBlob);
                }
                handleResponse(response, to);
            } catch (err) {
                setQuotaTrace(err);
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
            }
        },
        [handleResponse, runOrchestrator, setOneButton, setQuotaTrace, turns],
    );

    const sendTextQuery = useCallback(
        async (text: string, to: 'bosun' | 'cloud') => {
            if (!text.trim()) return;
            setOneButton(to, 'awaiting');
            setErrorMessage(null);
            try {
                const response = to === 'bosun' ? await askBosunText({ text }) : await runOrchestrator(text);
                handleResponse(response, to);
            } catch (err) {
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
            }
        },
        [handleResponse, runOrchestrator, setOneButton],
    );

    /**
     * Hands-free send via "over". Fires from the SR partialResults stream
     * when the skipper's utterance ends with "over". Mirrors the stop+send
     * branch of handleTalkTap but uses the cleaned SR text directly,
     * skipping Scribe entirely. Self-guarding: if the recorder has already
     * been torn down (e.g. user tapped concurrently), this is a no-op.
     */
    const handleOverGesture = useCallback(
        async (cleanedText: string, target: 'bosun' | 'cloud') => {
            const handle = recorderRef.current;
            const srHandle = speechRecognizerRef.current;
            const dgHandle = deepgramRecognizerRef.current;
            if (!handle && !srHandle && !dgHandle) return;
            recorderRef.current = null;
            speechRecognizerRef.current = null;
            deepgramRecognizerRef.current = null;
            setOneButton(target, 'sending');
            try {
                if (dgHandle) {
                    // Deepgram path — we already have the cleaned text
                    // from the partial that triggered "over". Cancel the
                    // WS (don't wait for the final flush since we're
                    // bypassing it) and ship the text directly.
                    await dgHandle.cancel();
                    setActiveTarget(null);
                    setActiveRecognizerKind(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), target, cleanedText);
                } else if (srHandle) {
                    // Apple SR fallback path — same flow, different recognizer.
                    await srHandle.cancel();
                    setActiveTarget(null);
                    setActiveRecognizerKind(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), target, cleanedText);
                } else if (handle) {
                    const blob = await handle.stop();
                    setActiveTarget(null);
                    setActiveRecognizerKind(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(blob, target, cleanedText);
                }
            } catch (err) {
                setErrorMessage((err as Error).message);
                setOneButton(target, 'error');
                setTimeout(() => setOneButton(target, 'idle'), 1500);
            }
        },
        [sendVoiceQuery, setOneButton],
    );

    // ── Tap handlers ────────────────────────────────────────────────────

    /**
     * Tap-to-toggle. State machine:
     *   idle / error / playing → start recording (mic acquired, button glows)
     *   recording              → stop + send (button shows 'sending', then awaiting)
     *   sending / awaiting     → ignore (request in flight)
     */
    const handleTalkTap = useCallback(
        async (which: 'bosun' | 'cloud') => {
            // CRITICAL: unlock audio playback for iOS WKWebView synchronously,
            // BEFORE any await. iOS only lets us prime the Audio element from
            // within a user-gesture handler — once we await anything, the
            // gesture context evaporates and the response audio won't play.
            unlockAudio();

            const currentState = buttonState[which];

            // Start recording
            if (currentState === 'idle' || currentState === 'error' || currentState === 'playing') {
                if (!isAudioRecordingSupported()) {
                    setErrorMessage('Voice input not supported on this device. Use the text box below instead.');
                    return;
                }
                stopAudio();
                if (recorderRef.current) {
                    try {
                        recorderRef.current.cancel();
                    } catch {
                        /* ignore */
                    }
                    recorderRef.current = null;
                }
                if (speechRecognizerRef.current) {
                    try {
                        void speechRecognizerRef.current.cancel();
                    } catch {
                        /* ignore */
                    }
                    speechRecognizerRef.current = null;
                }
                if (deepgramRecognizerRef.current) {
                    try {
                        void deepgramRecognizerRef.current.cancel();
                    } catch {
                        /* ignore */
                    }
                    deepgramRecognizerRef.current = null;
                }
                setErrorMessage(null);
                setLiveTranscript('');
                setSrActive(false);

                // Decide capture path. Priority:
                //   1. Deepgram (cloud streaming, no per-device rate limit,
                //      keyword-boosted recognition for Calypso + over).
                //   2. Apple SR (on-device, no token mint round-trip, but
                //      hits per-device "quota exceeded" lockouts).
                //   3. MediaRecorder + ElevenLabs Scribe on the audio blob
                //      (no streaming partials → no live OVER gesture, but
                //      strip-at-stop fallback still cleans the question).
                //
                // Each tier falls through to the next on start failure,
                // so a Deepgram outage automatically degrades to Apple SR
                // and then to Scribe without intervention.
                let recognizerStarted = false;
                const tryDeepgram = which === 'cloud' && deepgramStatus === 'available';
                const tryAppleSr = ENABLE_APPLE_SR_FALLBACK && which === 'cloud' && srStatus === 'available';

                // Cold-start grace promise — populated by whichever
                // recognizer we end up using. Resolved on first partial.
                let resolveFirstPartial: () => void = () => {};
                const firstPartialPromise = new Promise<void>((resolve) => {
                    resolveFirstPartial = resolve;
                });
                firstPartialPromiseRef.current = {
                    promise: firstPartialPromise,
                    resolve: resolveFirstPartial,
                };

                // ── Tier 1: Deepgram ─────────────────────────────────
                if (tryDeepgram) {
                    try {
                        const dgHandle = await startDeepgramRecognizer({
                            onPartial: (text) => {
                                setLiveTranscript(text);
                                const { matched, cleaned } = detectOverSuffix(text);
                                if (matched && cleaned.length > 0) {
                                    setSrEventLog((prev) => [
                                        ...prev.slice(-19),
                                        { ts: Date.now(), msg: `[over] fired: "${cleaned.slice(0, 60)}"` },
                                    ]);
                                    void handleOverGesture(cleaned, which);
                                }
                            },
                            onFirstPartial: () => {
                                setSrActive(true);
                                firstPartialPromiseRef.current?.resolve();
                                // Haptic confirm — tactile signal that
                                // the recognizer has audio flowing and
                                // the skipper can speak. Sidesteps the
                                // "did it work?" pause where the user
                                // is waiting for visual feedback during
                                // cold start.
                                void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
                                    /* haptics not available (web/sim) — skip */
                                });
                            },
                        });
                        deepgramRecognizerRef.current = dgHandle;
                        recognizerStarted = true;
                        setActiveRecognizerKind('deepgram');
                    } catch (err) {
                        // Deepgram failed (token mint, WS, mic). Surface
                        // in the debug strip and fall through to Apple SR.
                        const msg = (err as Error).message || 'unknown';
                        setSrEventLog((prev) => [
                            ...prev.slice(-19),
                            { ts: Date.now(), msg: `[DG] start failed → fallback: ${msg.slice(0, 80)}` },
                        ]);
                    }
                }

                // ── Tier 2: Apple SR (only if Deepgram didn't take, ──
                // and only if the SR fallback flag is on). When flag
                // is off and Deepgram failed, surface a debug-strip
                // entry so the skipper can see we deliberately skipped
                // SR — otherwise cascading straight to MediaRecorder
                // looks like a bug.
                if (!ENABLE_APPLE_SR_FALLBACK && !recognizerStarted) {
                    setSrEventLog((prev) => [
                        ...prev.slice(-19),
                        {
                            ts: Date.now(),
                            msg: '[skip] Apple SR fallback disabled — going straight to MediaRecorder',
                        },
                    ]);
                }
                const useSR = tryAppleSr && !recognizerStarted;
                let srStarted = false;
                if (useSR) {
                    try {
                        const srHandle = await startSpeechRecognition({
                            onPartial: (text) => {
                                setLiveTranscript(text);
                                const { matched, cleaned } = detectOverSuffix(text);
                                if (matched && cleaned.length > 0) {
                                    // Surface in the debug strip so the skipper
                                    // can see the gesture actually fired.
                                    setSrEventLog((prev) => [
                                        ...prev.slice(-19),
                                        { ts: Date.now(), msg: `[over] fired: "${cleaned.slice(0, 60)}"` },
                                    ]);
                                    void handleOverGesture(cleaned, which);
                                }
                            },
                            onFirstPartial: () => {
                                setSrActive(true);
                                // Unblock any tap-to-stop grace period waiting on
                                // the first partial. Only resolves once per cycle.
                                firstPartialPromiseRef.current?.resolve();
                            },
                        });
                        speechRecognizerRef.current = srHandle;
                        srStarted = true;
                        recognizerStarted = true;
                        setActiveRecognizerKind('apple-sr');
                    } catch (err) {
                        // SR start rejected — fall through to MediaRecorder.
                        // The wrapper already logged the rejection to the
                        // debug strip via emitEvent.
                        const rawMsg = (err as Error).message || '';
                        if (/quota has been exceeded/i.test(rawMsg)) {
                            // Apple SR per-device rate limit. Surface in
                            // the debug strip so the skipper can see
                            // why SR went silent without needing the
                            // Xcode console.
                            setSrEventLog((prev) => [
                                ...prev.slice(-19),
                                {
                                    ts: Date.now(),
                                    msg: '[SR] iOS quota — falling back to Scribe',
                                },
                            ]);
                        } else {
                            console.warn('[BosunConsole] SR start failed, falling back to MediaRecorder:', err);
                        }
                    }
                }

                // Fall through to MediaRecorder + Scribe only when BOTH
                // streaming paths failed (or weren't applicable for this
                // target). That's the slowest path — no live partials,
                // no OVER auto-send — but it works on any iOS audio
                // session state and any network condition that lets us
                // POST audio to Supabase.
                void srStarted; // covered by recognizerStarted
                if (!recognizerStarted) {
                    try {
                        const handle = await startRecording();
                        recorderRef.current = handle;
                        setActiveRecognizerKind('media-recorder');
                    } catch (err) {
                        // Translate iOS's per-device speech-recognition
                        // rate limit ("The quota has been exceeded.") into
                        // something actionable. This is Apple's SR bucket,
                        // NOT Anthropic/ElevenLabs/Supabase. Resets after
                        // ~30-60 minutes of not hammering it. Cascades into
                        // MediaRecorder because iOS shares the audio system.
                        const rawMsg = (err as Error).message || 'Recording failed';
                        const isAppleSrQuota = /quota has been exceeded/i.test(rawMsg);
                        const friendly = isAppleSrQuota
                            ? 'iOS hit its speech-recognition rate limit. Wait 30-60 minutes, or use the text box below for now.'
                            : rawMsg;
                        if (isAppleSrQuota) {
                            setSrEventLog((prev) => [
                                ...prev.slice(-19),
                                {
                                    ts: Date.now(),
                                    msg: '[SR] Apple device quota — voice path locked until iOS unblocks',
                                },
                            ]);
                        }
                        setErrorMessage(friendly);
                        setOneButton(which, 'error');
                        setTimeout(() => setOneButton(which, 'idle'), 1500);
                        return;
                    }
                }

                setActiveTarget(which);
                setOneButton(which, 'recording');
                return;
            }

            // Stop + send
            if (currentState === 'recording') {
                const handle = recorderRef.current;
                const srHandle = speechRecognizerRef.current;
                const dgHandle = deepgramRecognizerRef.current;
                if ((!handle && !srHandle && !dgHandle) || activeTarget !== which) {
                    setOneButton(which, 'idle');
                    return;
                }
                // Cold-start grace period: when a streaming recognizer is
                // active but hasn't fired any partial yet, give it up to
                // 500ms before tearing down. Apple SR's first partial can
                // arrive 200-400ms slower on cold start; Deepgram has to
                // mint a token (cached after prewarm), open a WebSocket,
                // load the audio worklet, and stream the first chunk —
                // typically 400-600ms cold even with prewarm. Without
                // this wait, an utterance ending in "over" reaches a
                // manual tap before the live OVER gesture catches it.
                // Skips entirely on warm cycles (srActive === true).
                const streamingHandle = dgHandle ?? srHandle;
                if (streamingHandle && !srActive && firstPartialPromiseRef.current) {
                    await Promise.race([
                        firstPartialPromiseRef.current.promise,
                        new Promise<void>((resolve) => setTimeout(resolve, 500)),
                    ]);
                    // The OVER gesture fires synchronously inside onPartial
                    // and clears recognizer refs. If that happened during
                    // the grace, refs are gone — bail out cleanly.
                    if (!deepgramRecognizerRef.current && !speechRecognizerRef.current) return;
                }
                recorderRef.current = null;
                speechRecognizerRef.current = null;
                deepgramRecognizerRef.current = null;
                setOneButton(which, 'sending');
                try {
                    if (dgHandle) {
                        // Deepgram path: send CloseStream, wait for final
                        // flush, return composed transcript. No audio blob
                        // ever travels over our edge function — the audio
                        // already streamed to Deepgram directly.
                        const dg = await dgHandle.stop();
                        setActiveTarget(null);
                        setActiveRecognizerKind(null);
                        setLiveTranscript('');
                        setSrActive(false);
                        if (!dg.text) {
                            setErrorMessage("Couldn't make out what you said — try again.");
                            setOneButton(which, 'error');
                            setTimeout(() => setOneButton(which, 'idle'), 1500);
                            return;
                        }
                        // Strip-at-stop safety net for the OVER gesture,
                        // same as the Apple SR path below — covers cases
                        // where the live partial stream missed the gesture
                        // because the skipper said "over" inside the
                        // grace-period window.
                        const finalText = (() => {
                            const det = detectOverSuffix(dg.text);
                            if (det.matched && det.cleaned.length > 0) {
                                setSrEventLog((prev) => [
                                    ...prev.slice(-19),
                                    {
                                        ts: Date.now(),
                                        msg: `[over] stripped at stop: "${det.cleaned.slice(0, 60)}"`,
                                    },
                                ]);
                                return det.cleaned;
                            }
                            return dg.text;
                        })();
                        await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), which, finalText);
                    } else if (srHandle) {
                        // Apple SR fallback path: stop SR, get its
                        // on-device transcript, hit Haiku directly with
                        // text. No audio blob.
                        const sr = await srHandle.stop();
                        setActiveTarget(null);
                        setActiveRecognizerKind(null);
                        setLiveTranscript('');
                        setSrActive(false);
                        if (!sr.text) {
                            setErrorMessage("Couldn't make out what you said — try again.");
                            setOneButton(which, 'error');
                            setTimeout(() => setOneButton(which, 'idle'), 1500);
                            return;
                        }
                        // Safety net: if the live partial-stream over-detection
                        // missed (cold-start cycles where SR fires partials too
                        // late for the gesture to trigger BEFORE the skipper
                        // taps), strip a trailing "over" from the final
                        // transcript so the question to Haiku doesn't contain
                        // it. Same intent as handleOverGesture, applied
                        // retroactively at stop time.
                        const finalText = (() => {
                            const det = detectOverSuffix(sr.text);
                            if (det.matched && det.cleaned.length > 0) {
                                setSrEventLog((prev) => [
                                    ...prev.slice(-19),
                                    {
                                        ts: Date.now(),
                                        msg: `[over] stripped at stop: "${det.cleaned.slice(0, 60)}"`,
                                    },
                                ]);
                                return det.cleaned;
                            }
                            return sr.text;
                        })();
                        await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), which, finalText);
                    } else if (handle) {
                        // MediaRecorder fallback path: stop, send blob to
                        // Scribe-backed edge function for STT.
                        const blob = await handle.stop();
                        setActiveTarget(null);
                        setActiveRecognizerKind(null);
                        setLiveTranscript('');
                        setSrActive(false);
                        await sendVoiceQuery(blob, which, null);
                    }
                } catch (err) {
                    setErrorMessage((err as Error).message);
                    setOneButton(which, 'error');
                    setTimeout(() => setOneButton(which, 'idle'), 1500);
                } finally {
                    // Re-arm so the NEXT tap is as fast as the first.
                    // The teardown above closed the AudioContext, stopped
                    // the mic tracks, and consumed all prewarm slots —
                    // without this every subsequent tap cold-starts and
                    // eats the first few words of speech on iOS.
                    rearmPrewarm();
                }
            }
            // sending / awaiting: ignore.
        },
        [
            buttonState,
            activeTarget,
            sendVoiceQuery,
            setOneButton,
            stopAudio,
            unlockAudio,
            handleOverGesture,
            srActive,
            // CRITICAL: status states must be in deps. Without them the
            // callback closes over the initial 'unknown' values, so even
            // after the probes set them to 'available' the start path
            // computes tryDeepgram=false and skips straight to the
            // MediaRecorder fallback. This was the actual reason
            // Deepgram appeared "broken on first tap" on iOS — it was
            // never being attempted at all.
            deepgramStatus,
            srStatus,
        ],
    );

    const handleTypedSubmit = useCallback(
        (e: React.FormEvent, to: 'bosun' | 'cloud') => {
            e.preventDefault();
            // Same iOS audio-unlock trick as the talk button — synchronous
            // priming inside the user gesture (form submit click).
            unlockAudio();
            const text = typedQuery.trim();
            if (!text) return;
            setTypedQuery('');
            void sendTextQuery(text, to);
        },
        [typedQuery, sendTextQuery, unlockAudio],
    );

    const handleReplay = useCallback(
        (response: VoiceQueryResponse) => {
            // The replay button click IS a user gesture — unlock again to
            // be safe in case the page audio context lapsed.
            unlockAudio();
            const to: 'bosun' | 'cloud' = response.source === 'cloud' ? 'cloud' : 'bosun';
            playResponseAudio(response, to);
        },
        [playResponseAudio, unlockAudio],
    );

    /**
     * Active route — cloud Haiku is primary (faster, smarter). Local Pi
     * (Llama 3.2 3B) is the OFFLINE fallback only, used when the cloud is
     * unreachable. Null when neither path is available.
     *
     * The single Bosun button + typed input both target this route, and
     * the subtitle reflects which brain is currently active.
     */
    const route: 'bosun' | 'cloud' | null = cloudAvailable ? 'cloud' : bosunAvailable ? 'bosun' : null;
    // Subtitle under the talk button. While the prewarms are still
    // running (mic acquisition is the slow one — ~1-1.4s on iOS) we
    // surface "Warming up…" so the skipper sees explicit feedback that
    // the system needs a moment, instead of seeing "Calypso cloud" and
    // tapping into a still-cold path. A medium haptic fires the moment
    // prewarm flips ready so they feel the cue too.
    const brainSubtitle = !prewarmReady
        ? 'Warming up…'
        : route === 'cloud'
          ? 'Calypso cloud'
          : route === 'bosun'
            ? 'Calypso local (3B)'
            : 'Calypso offline';
    const typedTarget: 'bosun' | 'cloud' = route ?? 'cloud';

    const isAnyAwaiting = useMemo(
        () => buttonState.bosun === 'awaiting' || buttonState.cloud === 'awaiting',
        [buttonState],
    );
    const isAnySending = useMemo(
        () => buttonState.bosun === 'sending' || buttonState.cloud === 'sending',
        [buttonState],
    );

    return (
        <div
            className="flex flex-col h-full bg-gradient-to-b from-slate-900 via-slate-950 to-black"
            role="region"
            aria-label="Calypso voice console"
        >
            {/* ── Header — shared chrome, matches Ship's Log / Route Planner ── */}
            <PageHeader
                title="Calypso"
                subtitle={'Tap to talk — tap again or say "over" to send'}
                onBack={onBack}
                action={
                    <div className="flex items-center gap-2">
                        {/* Music page — opens MusicPage for playlist
                         *  browsing + playback. Always visible because
                         *  music can be triggered from any console
                         *  state (idle, talking, listening). */}
                        <button
                            onClick={() => {
                                window.dispatchEvent(
                                    new CustomEvent('thalassa:navigate', { detail: { tab: 'music' } }),
                                );
                            }}
                            className="w-10 h-10 rounded-full bg-pink-500/15 border border-pink-400/30 flex items-center justify-center text-pink-300 hover:bg-pink-500/25 active:scale-95 transition-all"
                            aria-label="Open music"
                        >
                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M9 17.5a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 4 17.5 2.5 2.5 0 0 1 6.5 15c.34 0 .67.07.97.18V6L20 4v11.5a2.5 2.5 0 0 1-2.5 2.5 2.5 2.5 0 0 1-2.5-2.5 2.5 2.5 0 0 1 2.5-2.5c.34 0 .67.07.97.18V7.79L9 9.5v8z" />
                            </svg>
                        </button>
                        {turns.length > 0 && (
                            <button
                                onClick={clearHistory}
                                className="px-3 h-10 rounded-full bg-white/5 hover:bg-white/10 text-[10px] uppercase tracking-widest text-white/70 hover:text-white transition-colors"
                                aria-label="Clear conversation history"
                            >
                                Clear
                            </button>
                        )}
                    </div>
                }
            />
            {/* Pi-setup CTA — surfaces only when no Pi is discovered. */}
            {bosunAvailable === false && (
                <div className="shrink-0 px-4 pb-2">
                    <button
                        onClick={() => setPiSetupOpen(true)}
                        className="text-[10px] uppercase tracking-widest text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline"
                    >
                        Set up Pi →
                    </button>
                </div>
            )}

            {/* ── Conversation log ───────────────────────── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {turns.length === 0 && !errorMessage && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 gap-2 pt-8">
                        <p className="text-sm font-bold text-gray-400">Tap Calypso to talk.</p>
                        <p className="text-xs max-w-[280px]">
                            One Calypso, two brains behind her. Local 3B on the Pi when reachable, cloud Haiku otherwise
                            — the active brain shows under the button.
                        </p>
                    </div>
                )}

                {turns.map((turn) => (
                    <ConversationTurn key={turn.id} turn={turn} onReplay={handleReplay} />
                ))}

                {errorMessage && (
                    <div className="px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/20">
                        <p className="text-[10px] uppercase tracking-widest text-red-400 mb-1">Error</p>
                        <p className="text-sm text-white">{errorMessage}</p>
                    </div>
                )}

                <div ref={conversationEndRef} />
            </div>

            {/* ── Live partial transcript (streaming STT) ────────────── */}
            {/* Only shown while recording — disappears on send. The dot */}
            {/* tells the skipper at a glance which streaming path is */}
            {/* moving audio: Deepgram (primary) or Apple SR (fallback). */}
            {/* MediaRecorder fallback shows neither — no live partials. */}
            {route && buttonState[route] === 'recording' && (
                <div className="shrink-0 px-5 pt-3 pb-2 min-h-[56px] flex flex-col items-center justify-center gap-1.5">
                    <p className="text-sm italic text-sky-200/80 text-center max-w-[340px] leading-relaxed px-2">
                        {liveTranscript || 'Listening… say "OVER" to send, or tap the button'}
                    </p>
                    <p className="text-[9px] uppercase tracking-widest text-gray-500 flex items-center gap-1.5">
                        <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                                srActive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'
                            }`}
                        />
                        {srActive
                            ? activeRecognizerKind === 'deepgram'
                                ? 'Deepgram active'
                                : activeRecognizerKind === 'apple-sr'
                                  ? 'Apple SR active'
                                  : 'Streaming STT active'
                            : activeRecognizerKind === 'media-recorder'
                              ? 'Recording — Scribe will transcribe on send'
                              : 'STT pending… (will use Scribe if it stays gray)'}
                    </p>
                </div>
            )}

            {/* SR debug strip removed from UI per user feedback. The
                underlying srEventLog state + the various event-tap
                hooks are kept intact so we can re-add a developer-mode
                toggle later if needed without rewiring everything. */}
            {false && srEventLog.length > 0 && (
                <details className="shrink-0 px-5 pt-1">
                    <summary className="text-[9px] uppercase tracking-widest text-gray-500 cursor-pointer select-none">
                        SR debug ({srEventLog.length})
                    </summary>
                    <div className="mt-1 px-2 py-2 rounded-lg bg-black/40 border border-white/5 font-mono text-[10px] leading-snug text-gray-400 max-h-[120px] overflow-y-auto">
                        {srEventLog.map((e, i) => {
                            const t = new Date(e.ts);
                            const stamp = `${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}.${Math.floor(t.getMilliseconds() / 100)}`;
                            return (
                                <div key={`${e.ts}-${i}`} className="flex gap-2">
                                    <span className="text-gray-600">{stamp}</span>
                                    <span className="flex-1 break-words">{e.msg}</span>
                                </div>
                            );
                        })}
                    </div>
                </details>
            )}

            {/* ── One Bosun button — auto-routed to active brain ────── */}
            {/* Locked out until ALL prewarms complete (mic, token, WS,
                worklet, GPS reverse-geocode). Once prewarmReady flips
                true, the button colors back in + a medium haptic
                fires elsewhere — both visual and tactile cue that
                the system is fully ready for the tap. Prevents the
                skipper from tapping into a still-cold pipeline and
                experiencing a 1-2s lag before audio actually flows. */}
            <div className="shrink-0 flex justify-center pt-4 pb-6 px-4">
                <TalkButton
                    state={route ? buttonState[route] : 'idle'}
                    subtitle={brainSubtitle}
                    disabled={!route || !prewarmReady}
                    /* Fire AudioContext.resume() on pointerdown — that's
                     * a gesture, so iOS lets it actually start. By the
                     * time onTap fires (a few ms later on click), the
                     * AVAudioSession is warming up and the worklet is
                     * either already producing samples or about to,
                     * cutting the leading-edge latency that clips the
                     * first words. Idempotent + safe to call when the
                     * pipeline isn't prewarmed. */
                    onPrime={() => prewarmReady && primeAudioPipeline()}
                    onTap={() => route && prewarmReady && handleTalkTap(route)}
                />
            </div>

            {/* ── Text input alternative ─────────────────── */}
            <form
                onSubmit={(e) => handleTypedSubmit(e, typedTarget)}
                className="shrink-0 px-5 pb-8 pt-3 border-t border-white/5"
            >
                <div className="flex gap-2 items-center">
                    <input
                        type="text"
                        value={typedQuery}
                        onChange={(e) => setTypedQuery(e.target.value)}
                        placeholder={
                            !prewarmReady
                                ? 'Warming up Calypso…'
                                : `Or type — sends to ${brainSubtitle.toLowerCase()}...`
                        }
                        className="flex-1 px-4 py-3 rounded-full bg-white/5 border border-white/10 text-white placeholder:text-gray-500 text-sm focus:outline-none focus:border-sky-500/50 disabled:opacity-50"
                        disabled={!prewarmReady || isAnyAwaiting || isAnySending}
                    />
                    <button
                        type="submit"
                        disabled={
                            !prewarmReady ||
                            !typedQuery.trim() ||
                            (!bosunAvailable && !cloudAvailable) ||
                            isAnyAwaiting ||
                            isAnySending
                        }
                        className="w-12 h-12 rounded-full bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white transition-colors shrink-0"
                        aria-label="Send"
                    >
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                        </svg>
                    </button>
                </div>
            </form>

            {/* Pi-provisioning wizard — overlays the console when open. */}
            {/* Renders nothing when piSetupOpen=false, so no perf cost. */}
            <PiSetupWizard isOpen={piSetupOpen} onClose={() => setPiSetupOpen(false)} />
        </div>
    );
};

// ───────────────────────────────────────────────────────────────────────
// ConversationTurn
// ───────────────────────────────────────────────────────────────────────

const ConversationTurn: React.FC<{
    turn: VoiceTurn;
    onReplay: (response: VoiceQueryResponse) => void;
}> = ({ turn, onReplay }) => {
    const isBosun = turn.response.source === 'bosun';
    // Attribution: turns the local skipper authored have no userName
    // (we set it on remote turns only). When userName is set, the turn
    // came from a crewmate and we label it. "You said" stays for self.
    const speakerLabel = turn.userName ? `${turn.userName} said` : 'You said';
    const isCrew = Boolean(turn.userName);
    return (
        <div className="space-y-2">
            <div
                className={`px-4 py-3 rounded-2xl ${
                    isCrew ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-white/5 border border-white/10'
                }`}
            >
                <p
                    className={`text-[10px] uppercase tracking-widest mb-1 ${
                        isCrew ? 'text-amber-300' : 'text-gray-400'
                    }`}
                >
                    {speakerLabel}
                </p>
                <p className="text-sm text-white">{turn.transcript}</p>
            </div>
            <div
                className={`px-4 py-3 rounded-2xl ${
                    isBosun ? 'bg-sky-500/10 border border-sky-500/20' : 'bg-slate-200/10 border border-slate-300/20'
                }`}
            >
                <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${isBosun ? 'bg-sky-400' : 'bg-slate-300'}`} />
                        {isBosun ? 'Calypso local (3B)' : 'Calypso cloud'}
                    </p>
                    {turn.response.audio_b64 && (
                        <button
                            onClick={() => onReplay(turn.response)}
                            className="text-[10px] uppercase tracking-widest text-sky-400 hover:text-sky-300 flex items-center gap-1"
                            aria-label="Replay audio"
                        >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                            Replay
                        </button>
                    )}
                </div>
                <p className="text-sm text-white whitespace-pre-wrap">{turn.response.answer_text}</p>
                {turn.response.tool_calls && turn.response.tool_calls.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-white/10">
                        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Tools used</p>
                        {turn.response.tool_calls.map((tc, i) => (
                            <p key={i} className="text-[11px] text-gray-400 font-mono">
                                {tc.name}({Object.keys(tc.args).length ? '...' : ''}) → {tc.status}
                            </p>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
