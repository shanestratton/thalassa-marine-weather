/**
 * BosunConsole — full-screen voice console.
 *
 * Two buttons, skipper picks:
 *   - Big Blue Bosun (anchor icon) — on-boat brain, knows your vessel,
 *     reads live tools, slow but deep
 *   - White Haiku (cloud icon) — shore brain via Anthropic Haiku 4.5,
 *     fast and conversational, no boat awareness
 *
 * Each button greys out when its respective brain is unavailable. Bosun
 * is unavailable when the boat WiFi isn't reachable. Haiku is unavailable
 * when there's no internet.
 *
 * Both audio AND text are always rendered. Audio auto-plays on response;
 * text is right there if speakers are off, the wind is loud, etc.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TalkButton, type TalkButtonState } from './TalkButton';
import { isSpeechRecognitionSupported, startListening } from '../../services/voice/speechRecognition';
import { askBosun, isBosunReachable } from '../../services/voice/bosunVoice';
import { askCloud } from '../../services/voice/cloudFallback';
import type { VoiceQueryResponse, VoiceTurn } from '../../types/voice';

interface BosunConsoleProps {
    isOpen: boolean;
    onClose: () => void;
}

/** Which brain a press is targeting. Set when the user presses; cleared on send. */
type ActiveTarget = 'bosun' | 'cloud' | null;

/** Per-target state — tracks which button is currently engaged. */
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

export const BosunConsole: React.FC<BosunConsoleProps> = ({ isOpen, onClose }) => {
    const [target, setTarget] = useState<ActiveTarget>(null);
    const [buttonState, setButtonState] = useState<TargetState>(initialTargetState);
    const [turns, setTurns] = useState<VoiceTurn[]>([]);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [typedQuery, setTypedQuery] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    /** Availability — re-probed every 30s while the console is open. */
    const [bosunAvailable, setBosunAvailable] = useState<boolean | null>(null);
    const [cloudAvailable, setCloudAvailable] = useState<boolean | null>(null);

    const recognitionRef = useRef<ReturnType<typeof startListening> | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioUrlsRef = useRef<string[]>([]);
    const conversationEndRef = useRef<HTMLDivElement | null>(null);

    // Probe availability on open + every 30s
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

    // Auto-scroll to bottom on new content
    useEffect(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns.length, partialTranscript, errorMessage]);

    // Free Blob URLs on unmount
    useEffect(() => {
        const urls = audioUrlsRef.current;
        return () => {
            urls.forEach((u) => URL.revokeObjectURL(u));
        };
    }, []);

    const setOneButton = useCallback((which: 'bosun' | 'cloud', s: TalkButtonState) => {
        setButtonState((prev) => ({ ...prev, [which]: s }));
    }, []);

    const sendQueryTo = useCallback(
        async (text: string, to: 'bosun' | 'cloud') => {
            if (!text.trim()) {
                setOneButton(to, 'idle');
                return;
            }
            setOneButton(to, 'awaiting');
            setErrorMessage(null);
            try {
                const response = to === 'bosun' ? await askBosun({ text }) : await askCloud({ text });
                appendTurn(text, response);
                playResponseAudio(response);
                setOneButton(to, 'playing');
                // Auto-return to idle once audio could plausibly have played
                setTimeout(() => setOneButton(to, 'idle'), 600);
            } catch (err) {
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                setTimeout(() => setOneButton(to, 'idle'), 1500);
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

    const playResponseAudio = useCallback((response: VoiceQueryResponse) => {
        if (!response.audio_b64) return;
        try {
            const url = audioFromBase64(response.audio_b64);
            audioUrlsRef.current.push(url);
            const audio = audioRef.current ?? new Audio();
            audio.src = url;
            audioRef.current = audio;
            void audio.play().catch(() => {
                /* autoplay may be blocked - text is still there */
            });
        } catch {
            /* invalid base64 */
        }
    }, []);

    const handlePressStart = useCallback(
        (which: 'bosun' | 'cloud') => {
            if (!isSpeechRecognitionSupported()) {
                setErrorMessage('Voice input not supported on this device. Use the text box below instead.');
                return;
            }
            try {
                const handle = startListening();
                handle.onPartial(setPartialTranscript);
                recognitionRef.current = handle;
                setPartialTranscript('');
                setTarget(which);
                setOneButton(which, 'recording');
                setErrorMessage(null);
            } catch (err) {
                setErrorMessage((err as Error).message);
                setOneButton(which, 'error');
                setTimeout(() => setOneButton(which, 'idle'), 1200);
            }
        },
        [setOneButton],
    );

    const handlePressEnd = useCallback(
        async (which: 'bosun' | 'cloud') => {
            const handle = recognitionRef.current;
            if (!handle || target !== which) return;
            recognitionRef.current = null;
            setOneButton(which, 'sending');
            try {
                const finalText = await handle.stop();
                const text = (finalText || partialTranscript).trim();
                setPartialTranscript('');
                setTarget(null);
                await sendQueryTo(text, which);
            } catch (err) {
                setErrorMessage((err as Error).message);
                setOneButton(which, 'error');
                setTimeout(() => setOneButton(which, 'idle'), 1200);
            }
        },
        [partialTranscript, sendQueryTo, setOneButton, target],
    );

    const handleCancel = useCallback(
        (which: 'bosun' | 'cloud') => {
            recognitionRef.current?.cancel();
            recognitionRef.current = null;
            setPartialTranscript('');
            setTarget(null);
            setOneButton(which, 'idle');
        },
        [setOneButton],
    );

    const handleTypedSubmit = useCallback(
        (e: React.FormEvent, to: 'bosun' | 'cloud') => {
            e.preventDefault();
            const text = typedQuery.trim();
            if (!text) return;
            setTypedQuery('');
            void sendQueryTo(text, to);
        },
        [typedQuery, sendQueryTo],
    );

    const handleReplay = useCallback(
        (response: VoiceQueryResponse) => {
            playResponseAudio(response);
        },
        [playResponseAudio],
    );

    /** Pick the default target for typed queries — Bosun if up, else cloud. */
    const typedTarget: 'bosun' | 'cloud' = bosunAvailable ? 'bosun' : 'cloud';

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
                    <p className="text-[10px] uppercase tracking-widest text-gray-400">Hold a button to talk</p>
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
                {turns.length === 0 && partialTranscript === '' && !errorMessage && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 gap-2 pt-8">
                        <p className="text-sm font-bold text-gray-400">Pick your brain, hold the button, ask away.</p>
                        <p className="text-xs max-w-[280px]">
                            Bosun knows your boat. Haiku is faster but generic. Either is greyed out when not reachable.
                        </p>
                    </div>
                )}

                {turns.map((turn) => (
                    <ConversationTurn key={turn.id} turn={turn} onReplay={handleReplay} />
                ))}

                {/* Live transcript while recording */}
                {(buttonState.bosun === 'recording' ||
                    buttonState.cloud === 'recording' ||
                    buttonState.bosun === 'sending' ||
                    buttonState.cloud === 'sending') &&
                    partialTranscript && (
                        <div className="px-4 py-3 rounded-2xl bg-sky-500/10 border border-sky-500/20">
                            <p className="text-[10px] uppercase tracking-widest text-sky-400 mb-1">You said</p>
                            <p className="text-sm text-white italic">{partialTranscript}</p>
                        </div>
                    )}

                {errorMessage && (
                    <div className="px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/20">
                        <p className="text-[10px] uppercase tracking-widest text-red-400 mb-1">Error</p>
                        <p className="text-sm text-white">{errorMessage}</p>
                    </div>
                )}

                <div ref={conversationEndRef} />
            </div>

            {/* ── Two big talk buttons ─────────────────────── */}
            <div className="shrink-0 flex justify-center gap-6 pt-4 pb-6 px-4">
                <TalkButton
                    variant="bosun"
                    state={buttonState.bosun}
                    subtitle={bosunAvailable === true ? 'On-boat' : bosunAvailable === false ? 'Offline' : 'Checking'}
                    disabled={!bosunAvailable}
                    onPressStart={() => handlePressStart('bosun')}
                    onPressEnd={() => handlePressEnd('bosun')}
                    onCancel={() => handleCancel('bosun')}
                />
                <TalkButton
                    variant="cloud"
                    state={buttonState.cloud}
                    subtitle={cloudAvailable === true ? 'Shore' : cloudAvailable === false ? 'Offline' : 'Checking'}
                    disabled={!cloudAvailable}
                    onPressStart={() => handlePressStart('cloud')}
                    onPressEnd={() => handlePressEnd('cloud')}
                    onCancel={() => handleCancel('cloud')}
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
                        placeholder={`Or type — sends to ${typedTarget === 'bosun' ? 'Bosun' : 'Haiku'}...`}
                        className="flex-1 px-4 py-3 rounded-full bg-white/5 border border-white/10 text-white placeholder:text-gray-500 text-sm focus:outline-none focus:border-sky-500/50"
                        disabled={
                            buttonState.bosun === 'sending' ||
                            buttonState.cloud === 'sending' ||
                            buttonState.bosun === 'awaiting' ||
                            buttonState.cloud === 'awaiting'
                        }
                    />
                    <button
                        type="submit"
                        disabled={
                            !typedQuery.trim() ||
                            (!bosunAvailable && !cloudAvailable) ||
                            buttonState.bosun === 'awaiting' ||
                            buttonState.cloud === 'awaiting'
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
// Helpers
// ───────────────────────────────────────────────────────────────────────

/** Quick connectivity check for the cloud fallback (any HTTPS reach). */
async function checkCloudReachable(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
        return navigator.onLine;
    }
    return true;
}

/** Single conversation turn — skipper transcript + Bosun/Haiku answer + replay. */
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
                        {isBosun ? 'Bosun (on-boat)' : 'Haiku (shore)'}
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
