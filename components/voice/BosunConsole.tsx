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
import { TalkButton, type TalkButtonState } from './TalkButton';
import { isAudioRecordingSupported, startRecording } from '../../services/voice/audioRecorder';
import { askBosunText, askBosunVoice, isBosunReachable } from '../../services/voice/bosunVoice';
import { askCloudText, askCloudVoice } from '../../services/voice/cloudFallback';
import { startSpeechRecognition, type SpeechRecognizerHandle } from '../../services/voice/speechRecognizer';
import { gatherThalassaContext } from '../../services/voice/thalassaContext';
import type { VoiceHistoryTurn, VoiceQueryResponse, VoiceTurn } from '../../types/voice';

/** How many prior turns to send for context. Each turn = one user + one assistant message. */
const HISTORY_TURN_LIMIT = 10;

/**
 * Detect "over" at the end of an utterance. The skipper can say "over"
 * as a hands-free alternative to tap-to-send — same as ham-radio
 * etiquette. We strip it from the transcript before sending so Haiku
 * doesn't see "over" as part of the question.
 *
 * Examples:
 *   "what's the wind doing over"   → matched, cleaned = "what's the wind doing"
 *   "over."                         → matched, cleaned = ""
 *   "moreover"                      → not matched (no word boundary before)
 *   "the storm's moving over to..." → not matched (not at end of utterance)
 */
function detectOverSuffix(text: string): { matched: boolean; cleaned: string } {
    const m = text.match(/^(.*?)\s*\bover[.,!?]*\s*$/i);
    if (!m) return { matched: false, cleaned: text };
    return { matched: true, cleaned: m[1].trim() };
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
        const asstText = (t.response.answer_text || '').trim();
        if (!userText || !asstText) continue;
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
    const [turns, setTurns] = useState<VoiceTurn[]>([]);
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

    // Auto-scroll on new content
    useEffect(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns.length, errorMessage, buttonState.bosun, buttonState.cloud]);

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

    const appendTurn = useCallback((transcript: string, response: VoiceQueryResponse) => {
        const turn: VoiceTurn = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            transcript,
            response,
        };
        setTurns((prev) => [...prev.slice(-9), turn]);
    }, []);

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
                // Snapshot Thalassa state RIGHT NOW so Bosun answers against
                // what the skipper currently sees on screen, not whatever was
                // selected when the console was first opened.
                const context = gatherThalassaContext();
                // Recent conversation history so Haiku has continuity across
                // turns (e.g. "for the next 3 questions, speak like a pirate"
                // actually persists). Capped at HISTORY_TURN_LIMIT.
                const history = buildHistory(turns);
                let response: VoiceQueryResponse;
                if (to === 'cloud' && preTranscribed) {
                    // FAST PATH: Apple SR already gave us an on-device
                    // transcript — skip the Scribe round-trip entirely and
                    // hit Haiku directly with the text.
                    response = await askCloudText({ text: preTranscribed, context, history });
                } else {
                    response =
                        to === 'bosun'
                            ? await askBosunVoice(audioBlob)
                            : await askCloudVoice(audioBlob, context, history);
                }
                handleResponse(response, to);
            } catch (err) {
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
            }
        },
        [handleResponse, setOneButton, turns],
    );

    const sendTextQuery = useCallback(
        async (text: string, to: 'bosun' | 'cloud') => {
            if (!text.trim()) return;
            setOneButton(to, 'awaiting');
            setErrorMessage(null);
            try {
                const context = gatherThalassaContext();
                const history = buildHistory(turns);
                const response =
                    to === 'bosun' ? await askBosunText({ text }) : await askCloudText({ text, context, history });
                handleResponse(response, to);
            } catch (err) {
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
            }
        },
        [handleResponse, setOneButton, turns],
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
            if (!handle) return;
            recorderRef.current = null;
            speechRecognizerRef.current = null;
            setOneButton(target, 'sending');
            try {
                const [blob] = await Promise.all([handle.stop(), srHandle ? srHandle.cancel() : Promise.resolve()]);
                setActiveTarget(null);
                setLiveTranscript('');
                await sendVoiceQuery(blob, target, cleanedText);
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
                try {
                    const handle = await startRecording();
                    recorderRef.current = handle;
                    setActiveTarget(which);
                    setOneButton(which, 'recording');

                    // Best-effort: kick off Apple SR alongside MediaRecorder
                    // for the on-device fast-path. If it fails (permission,
                    // unavailable, mic-share conflict) we silently fall back
                    // to the Scribe path on the recorded blob.
                    if (which === 'cloud') {
                        try {
                            const srHandle = await startSpeechRecognition({
                                onPartial: (text) => {
                                    setLiveTranscript(text);
                                    // Hands-free send: "over" at the end of
                                    // the utterance triggers the same flow
                                    // as a second tap. Empty cleaned text
                                    // (skipper said only "over") → ignore.
                                    const { matched, cleaned } = detectOverSuffix(text);
                                    if (matched && cleaned.length > 0) {
                                        void handleOverGesture(cleaned, which);
                                    }
                                },
                            });
                            speechRecognizerRef.current = srHandle;
                        } catch (err) {
                            console.warn('[BosunConsole] SR unavailable, will use Scribe:', err);
                        }
                    }
                } catch (err) {
                    setErrorMessage((err as Error).message);
                    setOneButton(which, 'error');
                    setTimeout(() => setOneButton(which, 'idle'), 1500);
                }
                return;
            }

            // Stop + send
            if (currentState === 'recording') {
                const handle = recorderRef.current;
                const srHandle = speechRecognizerRef.current;
                if (!handle || activeTarget !== which) {
                    setOneButton(which, 'idle');
                    return;
                }
                recorderRef.current = null;
                speechRecognizerRef.current = null;
                setOneButton(which, 'sending');
                try {
                    // Stop both in parallel — MediaRecorder yields the audio
                    // blob (Scribe fallback), SR yields the on-device text
                    // (fast path). Resolving both before deciding the route
                    // means we always have the audio backup ready.
                    const [blob, sr] = await Promise.all([
                        handle.stop(),
                        srHandle ? srHandle.stop() : Promise.resolve(null),
                    ]);
                    setActiveTarget(null);
                    setLiveTranscript('');
                    await sendVoiceQuery(blob, which, sr?.text ?? null);
                } catch (err) {
                    setErrorMessage((err as Error).message);
                    setOneButton(which, 'error');
                    setTimeout(() => setOneButton(which, 'idle'), 1500);
                }
            }
            // sending / awaiting: ignore.
        },
        [buttonState, activeTarget, sendVoiceQuery, setOneButton, stopAudio, unlockAudio, handleOverGesture],
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
    const brainSubtitle = route === 'cloud' ? 'Bosun cloud' : route === 'bosun' ? 'Bosun local (3B)' : 'Bosun offline';
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
            aria-label="Bosun voice console"
        >
            {/* ── Header ──────────────────────────────────── */}
            <header className="shrink-0 flex items-center justify-between px-5 pt-12 pb-4 border-b border-white/5">
                <div>
                    <p className="text-base font-bold text-white">Voice Console</p>
                    <p className="text-[10px] uppercase tracking-widest text-gray-400">
                        Tap to talk — tap again or say &ldquo;over&rdquo; to send
                    </p>
                </div>
                <button
                    onClick={onClose}
                    className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition-colors"
                    aria-label="Close console"
                >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </header>

            {/* ── Conversation log ───────────────────────── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {turns.length === 0 && !errorMessage && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 gap-2 pt-8">
                        <p className="text-sm font-bold text-gray-400">Tap Bosun to talk.</p>
                        <p className="text-xs max-w-[280px]">
                            One Bosun, two brains behind it. Local 3B on the Pi when reachable, cloud Haiku otherwise —
                            the active brain shows under the button.
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
            {/* Only shown while recording — disappears on send. Italic so */}
            {/* it reads as in-progress, not final. */}
            {route && buttonState[route] === 'recording' && (
                <div className="shrink-0 px-5 pt-2 pb-1 min-h-[28px] flex items-center justify-center">
                    <p className="text-xs italic text-sky-200/70 text-center max-w-[320px] line-clamp-2">
                        {liveTranscript || 'Listening… say "over" or tap to send'}
                    </p>
                </div>
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
    return (
        <div className="space-y-2">
            <div className="px-4 py-3 rounded-2xl bg-white/5 border border-white/10">
                <p className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">You said</p>
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
                        {isBosun ? 'Bosun local (3B)' : 'Bosun cloud'}
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
