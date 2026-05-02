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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiSetupWizard } from './PiSetupWizard';
import { TalkButton, type TalkButtonState } from './TalkButton';
import { isAudioRecordingSupported, startRecording } from '../../services/voice/audioRecorder';
import { askBosunText, askBosunVoice, isBosunReachable } from '../../services/voice/bosunVoice';
import { askCloudVoice } from '../../services/voice/cloudFallback';
import { publishTurn, startConversationSync, type ConversationSyncHandle } from '../../services/voice/conversationSync';
import { askHaiku, synthesiseSpeech } from '../../services/voice/orchestrator';
import {
    isSpeechRecognitionAvailable,
    setSrEventTap,
    startSpeechRecognition,
    type SpeechRecognizerHandle,
} from '../../services/voice/speechRecognizer';
import { gatherThalassaContext } from '../../services/voice/thalassaContext';
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
    isOpen: boolean;
    onClose: () => void;
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

export const BosunConsole: React.FC<BosunConsoleProps> = ({ isOpen, onClose }) => {
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
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [activeTarget, setActiveTarget] = useState<'bosun' | 'cloud' | null>(null);

    const [bosunAvailable, setBosunAvailable] = useState<boolean | null>(null);
    const [cloudAvailable, setCloudAvailable] = useState<boolean | null>(null);

    const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
    const speechRecognizerRef = useRef<SpeechRecognizerHandle | null>(null);
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
     * Whether the SR engine has actually fired at least one partial event
     * for the CURRENT recording cycle. If false during recording, SR didn't
     * start successfully and we'll fall back to Scribe on stop. Visible to
     * the skipper as a small indicator next to the live transcript.
     */
    const [srActive, setSrActive] = useState(false);

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
            setSrEventLog((prev) => [...prev.slice(-5), { ts: Date.now(), msg }]);
        });
        return () => setSrEventTap(null);
    }, []);

    // ── Effects ─────────────────────────────────────────────────────────

    // Probe availability when console opens + every 30s
    useEffect(() => {
        if (!isOpen) return;
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
    }, [isOpen]);

    // Probe SR availability on console open. Surfaces the result in the
    // header pill so the skipper doesn't need Web Inspector or Xcode logs
    // to tell whether the on-device fast-path is going to be in play.
    useEffect(() => {
        if (!isOpen) return;
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
    }, [isOpen]);

    // Auto-scroll on new content
    useEffect(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns.length, errorMessage, buttonState.bosun, buttonState.cloud]);

    // Subscribe to per-vessel Realtime when the console opens so crew turns
    // arrive in real time. Unsubscribes on close. Falls back to local-only
    // silently if the user isn't on a vessel.
    useEffect(() => {
        if (!isOpen) return;
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
    }, [isOpen, upsertTurnSorted]);

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
        };
    }, []);

    // ── Helpers ─────────────────────────────────────────────────────────

    const setOneButton = useCallback((which: 'bosun' | 'cloud', s: TalkButtonState) => {
        // Mirror state transitions into the debug strip so the skipper can
        // see exactly where a lockup landed without needing Web Inspector.
        setSrEventLog((prev) => [...prev.slice(-5), { ts: Date.now(), msg: `[btn] ${which} → ${s}` }]);
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
            try {
                const url = audioFromBase64(response.audio_b64);
                audioUrlsRef.current.push(url);

                // Reuse the unlocked Audio element from the user tap. If it
                // doesn't exist (text-input path), create one — playback may
                // not work on iOS but text is still rendered.
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
                        // Surface autoplay-blocked failures rather than
                        // silently going idle, so the user knows why.
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
    const runOrchestrator = useCallback(
        async (text: string): Promise<VoiceQueryResponse> => {
            const context = gatherThalassaContext();
            const history = buildHistory(turns);
            const result = await askHaiku({ text, context, history });
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
        [turns],
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
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
            }
        },
        [handleResponse, runOrchestrator, setOneButton, turns],
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
            if (!handle && !srHandle) return;
            recorderRef.current = null;
            speechRecognizerRef.current = null;
            setOneButton(target, 'sending');
            try {
                if (srHandle) {
                    // SR-only path — we already have the cleaned text from
                    // the partial that triggered "over". Cancel SR (don't
                    // need its final result) and ship the text.
                    await srHandle.cancel();
                    setActiveTarget(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), target, cleanedText);
                } else if (handle) {
                    const blob = await handle.stop();
                    setActiveTarget(null);
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
                setErrorMessage(null);
                setLiveTranscript('');
                setSrActive(false);

                // Decide capture path: SR-only when available (avoids the
                // iOS dual-mic contention that was making partials never
                // fire), MediaRecorder + Scribe as the fallback when SR
                // isn't on. Never both.
                const useSR = which === 'cloud' && srStatus === 'available';
                let srStarted = false;
                if (useSR) {
                    // Fresh first-partial promise for THIS cycle. Resolved
                    // by onFirstPartial below; awaited (with timeout) by
                    // the tap-to-stop branch so cold-start cycles get a
                    // chance to fire OVER before we tear SR down.
                    let resolveFirstPartial: () => void = () => {};
                    const firstPartialPromise = new Promise<void>((resolve) => {
                        resolveFirstPartial = resolve;
                    });
                    firstPartialPromiseRef.current = {
                        promise: firstPartialPromise,
                        resolve: resolveFirstPartial,
                    };
                    try {
                        const srHandle = await startSpeechRecognition({
                            onPartial: (text) => {
                                setLiveTranscript(text);
                                const { matched, cleaned } = detectOverSuffix(text);
                                if (matched && cleaned.length > 0) {
                                    // Surface in the debug strip so the skipper
                                    // can see the gesture actually fired.
                                    setSrEventLog((prev) => [
                                        ...prev.slice(-5),
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
                                ...prev.slice(-5),
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

                if (!srStarted) {
                    try {
                        const handle = await startRecording();
                        recorderRef.current = handle;
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
                                ...prev.slice(-5),
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
                if ((!handle && !srHandle) || activeTarget !== which) {
                    setOneButton(which, 'idle');
                    return;
                }
                // Cold-start grace period: when SR is the active path AND
                // hasn't fired any partial yet, give it up to 250ms before
                // tearing down. Apple SR's first partial after app launch
                // can arrive 200-400ms slower than warmed-up cycles; without
                // this wait, an utterance ending in "over" gets through to
                // a manual tap before the live OVER gesture catches it.
                // Skips entirely on warm cycles (srActive === true) so
                // no perceptible latency once SR is hot.
                if (srHandle && !srActive && firstPartialPromiseRef.current) {
                    await Promise.race([
                        firstPartialPromiseRef.current.promise,
                        new Promise<void>((resolve) => setTimeout(resolve, 250)),
                    ]);
                    // The OVER gesture fires synchronously inside onPartial
                    // and clears speechRecognizerRef. If that happened
                    // during the grace, refs are gone — bail out cleanly.
                    if (!speechRecognizerRef.current) return;
                }
                recorderRef.current = null;
                speechRecognizerRef.current = null;
                setOneButton(which, 'sending');
                try {
                    if (srHandle) {
                        // SR-only path: stop SR, get its on-device transcript,
                        // hit Haiku directly with text. No audio blob.
                        const sr = await srHandle.stop();
                        setActiveTarget(null);
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
                                    ...prev.slice(-5),
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
                        setLiveTranscript('');
                        setSrActive(false);
                        await sendVoiceQuery(blob, which, null);
                    }
                } catch (err) {
                    setErrorMessage((err as Error).message);
                    setOneButton(which, 'error');
                    setTimeout(() => setOneButton(which, 'idle'), 1500);
                }
            }
            // sending / awaiting: ignore.
        },
        [buttonState, activeTarget, sendVoiceQuery, setOneButton, stopAudio, unlockAudio, handleOverGesture, srActive],
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
    const brainSubtitle =
        route === 'cloud' ? 'Calypso cloud' : route === 'bosun' ? 'Calypso local (3B)' : 'Calypso offline';
    const typedTarget: 'bosun' | 'cloud' = route ?? 'cloud';

    const isAnyAwaiting = useMemo(
        () => buttonState.bosun === 'awaiting' || buttonState.cloud === 'awaiting',
        [buttonState],
    );
    const isAnySending = useMemo(
        () => buttonState.bosun === 'sending' || buttonState.cloud === 'sending',
        [buttonState],
    );

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-[200] flex flex-col bg-gradient-to-b from-slate-900 via-slate-950 to-black"
            role="dialog"
            aria-label="Calypso voice console"
        >
            {/* ── Header ──────────────────────────────────── */}
            <header className="shrink-0 flex items-center justify-between px-5 pt-12 pb-4 border-b border-white/5">
                <div>
                    <p className="text-base font-bold text-white">Voice Console</p>
                    <p className="text-[10px] uppercase tracking-widest text-gray-400">
                        Tap to talk — tap again or say &ldquo;over&rdquo; to send
                    </p>
                    {/* Persistent SR availability pill. If it shows */}
                    {/* "unsupported" the new pod isn't in the Xcode build — */}
                    {/* clean rebuild needed (Cmd+Shift+K, then Cmd+R). */}
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                                srStatus === 'available'
                                    ? 'bg-emerald-400'
                                    : srStatus === 'denied'
                                      ? 'bg-amber-400'
                                      : srStatus === 'unsupported' || srStatus === 'error'
                                        ? 'bg-red-400'
                                        : 'bg-gray-500 animate-pulse'
                            }`}
                        />
                        <p className="text-[10px] tracking-wide text-gray-400">
                            {srStatus === 'available' && 'Apple SR ready (fast path)'}
                            {srStatus === 'denied' && 'SR permission denied — Settings > Thalassa'}
                            {srStatus === 'unsupported' && 'SR plugin missing — clean rebuild Xcode'}
                            {srStatus === 'error' && `SR error: ${srStatusError ?? 'unknown'}`}
                            {srStatus === 'unknown' && 'Probing SR…'}
                        </p>
                    </div>
                    {/* Pi-setup CTA — visible only when no Pi is */}
                    {/* discovered on the network. Opens the wizard for */}
                    {/* a fresh Pi or one whose WiFi password changed. */}
                    {bosunAvailable === false && (
                        <button
                            onClick={() => setPiSetupOpen(true)}
                            className="mt-1.5 text-[10px] uppercase tracking-widest text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline"
                        >
                            Set up Pi →
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {turns.length > 0 && (
                        <button
                            onClick={clearHistory}
                            className="px-3 h-10 rounded-full bg-white/5 hover:bg-white/10 text-[10px] uppercase tracking-widest text-white/70 hover:text-white transition-colors"
                            aria-label="Clear conversation history"
                        >
                            Clear
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition-colors"
                        aria-label="Close console"
                    >
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </header>

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

            {/* ── Live partial transcript (Apple SR) ─────────────── */}
            {/* Only shown while recording — disappears on send. The "SR" */}
            {/* dot tells the skipper at a glance whether on-device fast- */}
            {/* path is firing (green) or we'll fall back to Scribe (gray). */}
            {/* Width and leading tuned so italic letters with ascenders */}
            {/* (the "d" in "send") aren't clipped by line-height. */}
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
                        {srActive ? 'On-device SR active' : 'SR pending… (will use Scribe if it stays gray)'}
                    </p>
                </div>
            )}

            {/* ── SR debug strip — last few events, on-device readable ── */}
            {/* Reproduce the lockup → screenshot this strip → I can tell */}
            {/* you exactly which step stalled. Hidden when no events yet. */}
            {srEventLog.length > 0 && (
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
            <div className="shrink-0 flex justify-center pt-4 pb-6 px-4">
                <TalkButton
                    state={route ? buttonState[route] : 'idle'}
                    subtitle={brainSubtitle}
                    disabled={!route}
                    onTap={() => route && handleTalkTap(route)}
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
                        placeholder={`Or type — sends to ${brainSubtitle.toLowerCase()}...`}
                        className="flex-1 px-4 py-3 rounded-full bg-white/5 border border-white/10 text-white placeholder:text-gray-500 text-sm focus:outline-none focus:border-sky-500/50"
                        disabled={isAnyAwaiting || isAnySending}
                    />
                    <button
                        type="submit"
                        disabled={
                            !typedQuery.trim() || (!bosunAvailable && !cloudAvailable) || isAnyAwaiting || isAnySending
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
