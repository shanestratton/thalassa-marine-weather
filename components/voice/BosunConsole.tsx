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
import { TalkButton, type TalkButtonState } from './TalkButton';
import { isAudioRecordingSupported, startRecording } from '../../services/voice/audioRecorder';
import { askBosunText, askBosunVoice } from '../../services/voice/bosunVoice';
import { askCloudVoice } from '../../services/voice/cloudFallback';
import { publishTurn, startConversationSync, type ConversationSyncHandle } from '../../services/voice/conversationSync';
import type { SpokenReply } from '../../services/voice/spokenReplyQueue';
import { tryHelmCommand } from '../../services/voice/helmVoice';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
import { selectVoiceQueryRoute } from '../../services/voice/voiceQueryRouting';
import {
    primeAudioPipeline,
    releasePrewarmedAudioContext,
    releasePrewarmedMicStream,
    releasePrewarmedWebSocket,
    setDeepgramEventTap,
    startDeepgramRecognizer,
    type DeepgramRecognizerHandle,
} from '../../services/voice/deepgramRecognizer';
import {
    setSrEventTap,
    startSpeechRecognition,
    type SpeechRecognizerHandle,
} from '../../services/voice/speechRecognizer';
import { gatherThalassaContext } from '../../services/voice/thalassaContext';
import { GMAIL_PUBLIC_BETA_ENABLED } from '../../services/voice/integrations/gmail';
import { PI_INTEGRATION_ENABLED, PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE } from '../../services/piPublicBetaBoundary';
import { canAccess } from '../../services/SubscriptionService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVoiceHistoryStore } from '../../stores/voiceHistoryStore';
import type { VoiceQueryResponse, VoiceTurn } from '../../types/voice';
import { ConversationTurn } from './bosunConsole/ConversationTurn';
import { usePlayResponseAudio, useStopAudio, useUnlockAudio } from './bosunConsole/audioPlaybackHooks';
import { buildHistory, detectOverSuffix, voiceDiagnosticsEnabled } from './bosunConsole/helpers';
import {
    getAppleMusicNativeBridge,
    prepareNativeVoiceInput,
    releaseNativeVoiceInput,
} from './bosunConsole/nativeVoiceSession';
import { useDeepgramPrewarm, useRearmPrewarm } from './bosunConsole/prewarmHooks';
import { useAppleSrStatusProbe, useReachabilityProbe, useStorageDiagnosticsProbe } from './bosunConsole/probeHooks';
import {
    ENABLE_APPLE_SR_FALLBACK,
    initialTargetState,
    type BosunConsoleProps,
    type TargetState,
    type VoiceOperation,
} from './bosunConsole/types';
import { useRunOrchestrator } from './bosunConsole/useRunOrchestrator';

export const BosunConsole: React.FC<BosunConsoleProps> = ({ onBack }) => {
    const [buttonState, setButtonState] = useState<TargetState>(initialTargetState);
    const [identityGeneration, setIdentityGeneration] = useState(() => getAuthIdentityScope().generation);
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
    const stoppingRecorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
    const stoppingSpeechRecognizerRef = useRef<SpeechRecognizerHandle | null>(null);
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
    const stoppingDeepgramRecognizerRef = useRef<DeepgramRecognizerHandle | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioUrlsRef = useRef<string[]>([]);
    /** The in-flight spoken reply, so a new turn or a teardown can silence it. */
    const spokenReplyRef = useRef<SpokenReply | null>(null);
    const voiceTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    const requestControllersRef = useRef<Set<AbortController>>(new Set());
    const lifecycleGenerationRef = useRef(0);
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
    const [, setSrStatusError] = useState<string | null>(null);

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
    const [prewarmDegraded, setPrewarmDegraded] = useState(false);
    const showVoiceDiagnostics = useMemo(voiceDiagnosticsEnabled, []);

    /**
     * Open state for the Pi-provisioning wizard. Triggered from the
     * header CTA when the Pi is unreachable. The wizard owns its own
     * step state internally — we just track open/closed here.
     */

    /**
     * Last few [SR] events for the on-device debug strip. Visible to the
     * skipper without Web Inspector — when the console "locks up" we can
     * read off exactly which step stalled. Capped at 6 events so the strip
     * stays compact.
     */
    const [srEventLog, setSrEventLog] = useState<Array<{ ts: number; msg: string }>>([]);

    const captureVoiceOperation = useCallback(
        (): VoiceOperation => ({
            identity: getAuthIdentityScope(),
            lifecycleGeneration: lifecycleGenerationRef.current,
        }),
        [],
    );

    const isVoiceOperationCurrent = useCallback(
        (operation: VoiceOperation): boolean =>
            operation.lifecycleGeneration === lifecycleGenerationRef.current &&
            isAuthIdentityScopeCurrent(operation.identity),
        [],
    );

    const clearVoiceTimeouts = useCallback(() => {
        for (const timeout of voiceTimeoutsRef.current) clearTimeout(timeout);
        voiceTimeoutsRef.current.clear();
    }, []);

    const scheduleVoiceTimeout = useCallback(
        (operation: VoiceOperation, callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
            const timeout = setTimeout(() => {
                voiceTimeoutsRef.current.delete(timeout);
                if (isVoiceOperationCurrent(operation)) callback();
            }, delay);
            voiceTimeoutsRef.current.add(timeout);
            return timeout;
        },
        [isVoiceOperationCurrent],
    );

    /**
     * Immediately release every resource that can retain microphone input,
     * account text, or account audio. Promise-returning native/plugin stops
     * are deliberately started synchronously; generation fences below make
     * their eventual completions inert.
     */
    const terminateVoiceResources = useCallback(() => {
        firstPartialPromiseRef.current?.resolve();
        firstPartialPromiseRef.current = null;

        const recorder = recorderRef.current;
        recorderRef.current = null;
        try {
            recorder?.cancel();
        } catch {
            /* best-effort release */
        }
        const stoppingRecorder = stoppingRecorderRef.current;
        stoppingRecorderRef.current = null;
        try {
            stoppingRecorder?.cancel();
        } catch {
            /* best-effort release */
        }

        const appleRecognizer = speechRecognizerRef.current;
        speechRecognizerRef.current = null;
        try {
            void appleRecognizer?.cancel();
        } catch {
            /* best-effort release */
        }
        const stoppingAppleRecognizer = stoppingSpeechRecognizerRef.current;
        stoppingSpeechRecognizerRef.current = null;
        try {
            void stoppingAppleRecognizer?.cancel();
        } catch {
            /* best-effort release */
        }

        const deepgramRecognizer = deepgramRecognizerRef.current;
        deepgramRecognizerRef.current = null;
        try {
            void deepgramRecognizer?.cancel();
        } catch {
            /* best-effort release */
        }
        const stoppingDeepgramRecognizer = stoppingDeepgramRecognizerRef.current;
        stoppingDeepgramRecognizerRef.current = null;
        try {
            void stoppingDeepgramRecognizer?.cancel();
        } catch {
            /* best-effort release */
        }

        const sync = syncHandleRef.current;
        syncHandleRef.current = null;
        if (sync) void sync.stop();

        const audio = audioRef.current;
        audioRef.current = null;
        if (audio) {
            audio.onended = null;
            audio.onerror = null;
            try {
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
            } catch {
                /* best-effort release */
            }
        }

        // A console unmount / identity cutover must not leave Calypso's
        // native AVAudioPlayer or its input-capable audio session behind.
        // Stop TTS first; after the web capture resources are gone, release
        // the native session so other audio apps can take ownership again.
        spokenReplyRef.current?.cancel();
        spokenReplyRef.current = null;
        void getAppleMusicNativeBridge()
            ?.cancelTtsAudio?.()
            .catch(() => undefined);

        for (const url of audioUrlsRef.current.splice(0)) URL.revokeObjectURL(url);
        for (const controller of requestControllersRef.current) controller.abort();
        requestControllersRef.current.clear();
        clearVoiceTimeouts();
        setSrEventTap(null);
        setDeepgramEventTap(null);
        releasePrewarmedMicStream();
        releasePrewarmedWebSocket();
        releasePrewarmedAudioContext();
        releaseNativeVoiceInput();
    }, [clearVoiceTimeouts]);

    // Auth scope is a hard boundary for the live sensor. This listener runs
    // synchronously from authStore before the replacement identity is exposed.
    useEffect(() => {
        return subscribeAuthIdentityScope((next) => {
            lifecycleGenerationRef.current += 1;
            terminateVoiceResources();
            setButtonState(initialTargetState);
            setTypedQuery('');
            setRawErrorMessage(null);
            setActiveTarget(null);
            setLiveTranscript('');
            setSrActive(false);
            setActiveRecognizerKind(null);
            setPrewarmReady(false);
            setPrewarmDegraded(false);
            setSrEventLog([]);
            setIdentityGeneration(next.generation);
        });
    }, [terminateVoiceResources]);

    // Wire the speechRecognizer's event tap into local state so emitted [SR]
    // messages show up in the debug strip. Rebind on identity change so a
    // late event emitted by a cancelled A recognizer cannot appear for B.
    useEffect(() => {
        const operation = captureVoiceOperation();
        setSrEventTap((msg) => {
            if (!isVoiceOperationCurrent(operation)) return;
            setSrEventLog((prev) => [...prev.slice(-19), { ts: Date.now(), msg }]);
        });
        // Same hook for [DG] (Deepgram) events — share the debug strip so
        // the skipper can see the full path: token mint → ws open → first
        // partial → close, all in one timeline.
        setDeepgramEventTap((msg) => {
            if (!isVoiceOperationCurrent(operation)) return;
            setSrEventLog((prev) => [...prev.slice(-19), { ts: Date.now(), msg }]);
        });
        return () => {
            setSrEventTap(null);
            setDeepgramEventTap(null);
        };
    }, [captureVoiceOperation, identityGeneration, isVoiceOperationCurrent]);

    // ── Effects ─────────────────────────────────────────────────────────

    useReachabilityProbe(setBosunAvailable, setCloudAvailable);

    useAppleSrStatusProbe(setSrStatus, setSrStatusError);

    useStorageDiagnosticsProbe(showVoiceDiagnostics, setSrEventLog);

    useDeepgramPrewarm(
        captureVoiceOperation,
        isVoiceOperationCurrent,
        identityGeneration,
        setDeepgramStatus,
        setPrewarmDegraded,
        setPrewarmReady,
    );

    const rearmPrewarm = useRearmPrewarm(isVoiceOperationCurrent);

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
        const operation = captureVoiceOperation();
        let cancelled = false;
        void startConversationSync({
            onRemoteTurn: (turn) => {
                if (cancelled || !isVoiceOperationCurrent(operation)) return;
                upsertTurnSorted(turn);
            },
        }).then((handle) => {
            if (cancelled || !isVoiceOperationCurrent(operation)) {
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
    }, [captureVoiceOperation, identityGeneration, isVoiceOperationCurrent, upsertTurnSorted]);

    // Cleanup on unmount: free Blob URLs, abort any in-flight recording + SR
    useEffect(() => {
        return () => {
            lifecycleGenerationRef.current += 1;
            terminateVoiceResources();
        };
    }, [terminateVoiceResources]);

    // ── Helpers ─────────────────────────────────────────────────────────

    const setOneButton = useCallback((which: 'bosun' | 'cloud', s: TalkButtonState) => {
        // Mirror state transitions into the debug strip so the skipper can
        // see exactly where a lockup landed without needing Web Inspector.
        setSrEventLog((prev) => [...prev.slice(-19), { ts: Date.now(), msg: `[btn] ${which} → ${s}` }]);
        setButtonState((prev) => ({ ...prev, [which]: s }));
    }, []);

    const stopAudio = useStopAudio(audioRef);

    const unlockAudio = useUnlockAudio(audioRef, isVoiceOperationCurrent);

    const playResponseAudio = usePlayResponseAudio(
        audioRef,
        audioUrlsRef,
        isVoiceOperationCurrent,
        setErrorMessage,
        setOneButton,
    );

    const appendTurn = useCallback(
        (transcript: string, response: VoiceQueryResponse, operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
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
        [addTurn, isVoiceOperationCurrent],
    );

    const handleResponse = useCallback(
        (response: VoiceQueryResponse, to: 'bosun' | 'cloud', operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
            appendTurn(response.transcript || '(no transcript)', response, operation);
            setOneButton(to, 'playing');
            playResponseAudio(response, to, operation);
            // Safety net: force idle after 60s if onended never fires.
            scheduleVoiceTimeout(
                operation,
                () => {
                    setButtonState((s) => (s[to] === 'playing' ? { ...s, [to]: 'idle' } : s));
                },
                60_000,
            );
        },
        [appendTurn, isVoiceOperationCurrent, playResponseAudio, scheduleVoiceTimeout, setOneButton],
    );

    // Settings → Calypso integrations. Apple Music is always on for
    // Skipper tier — auth is handled in-app on the Music page, no
    // separate toggle. Gmail still requires (a) tier access AND (b)
    // an explicit toggle in Settings → Calypso Integrations (because
    // it kicks off an OAuth flow and links a real email account).
    const tier = useSettingsStore((s) => s.settings.subscriptionTier);
    const calypsoEmailEnabled = useSettingsStore((s) => s.settings.calypsoEmailEnabled ?? false);
    const integrationsEnabled = useMemo(
        () => ({
            appleMusic: FEATURE_VISIBILITY.appleMusic && canAccess(tier, 'calypsoMusic'),
            gmail: GMAIL_PUBLIC_BETA_ENABLED && calypsoEmailEnabled && canAccess(tier, 'calypsoEmail'),
        }),
        [tier, calypsoEmailEnabled],
    );

    const runOrchestrator = useRunOrchestrator(
        turns,
        integrationsEnabled,
        isVoiceOperationCurrent,
        setErrorMessage,
        spokenReplyRef,
    );

    const sendVoiceQuery = useCallback(
        async (
            audioBlob: Blob,
            to: 'bosun' | 'cloud',
            preTranscribed: string | null | undefined,
            operation: VoiceOperation,
        ) => {
            if (!isVoiceOperationCurrent(operation)) return;
            const hasRecognisedText = Boolean(preTranscribed?.trim());
            if (audioBlob.size === 0 && !hasRecognisedText) {
                setErrorMessage('No audio captured — try holding for a moment longer.');
                setOneButton(to, 'error');
                scheduleVoiceTimeout(operation, () => setOneButton(to, 'idle'), 1500);
                return;
            }
            const controller = new AbortController();
            requestControllersRef.current.add(controller);
            setOneButton(to, 'awaiting');
            setErrorMessage(null);
            try {
                let response: VoiceQueryResponse;
                const route = selectVoiceQueryRoute(to, preTranscribed);
                if (route.kind === 'cloud-text') {
                    // ── HELM PATH ─────────────────────────────────────────
                    // "What's the depth" is answered here, from the vessel's
                    // own instruments, spoken by the OS synthesiser, with no
                    // network call at all. Offshore in weather — which is when
                    // a skipper most wants to ask without letting go of the
                    // tiller — there is marginal signal or none, and the cloud
                    // path is four round trips. Anything open-ended returns
                    // null and falls through to Calypso below.
                    const helm = tryHelmCommand(route.text);
                    if (helm) {
                        if (!isVoiceOperationCurrent(operation)) return;
                        // Already spoken natively; no audio for the player.
                        handleResponse(
                            {
                                transcript: route.text,
                                answer_text: helm.answer,
                                source: 'cloud',
                                tool_calls: [{ name: `helm:${helm.query}`, args: {}, status: 'success' }],
                            },
                            to,
                            operation,
                        );
                        return;
                    }

                    // FAST PATH: live Deepgram/Apple SR has already produced
                    // a transcript, so run the tool-loop directly rather
                    // than making the edge function transcribe a blob again.
                    response = await runOrchestrator(route.text, operation, controller.signal, true);
                } else if (route.kind === 'bosun-text') {
                    // The boat-side path gets the same benefit. It can run
                    // its local RAG/LLM immediately instead of asking the Pi
                    // to run a second Whisper pass over a placeholder blob.
                    response = await askBosunText({ text: route.text }, controller.signal);
                } else if (route.kind === 'cloud-audio') {
                    // FALLBACK: live STT did not produce usable text, so
                    // retain the established Scribe-backed audio path.
                    const context = gatherThalassaContext();
                    const history = buildHistory(turns);
                    response = await askCloudVoice(audioBlob, context, history, controller.signal);
                } else {
                    // Offline/boat fallback: preserve the Pi Whisper path
                    // whenever no live transcript was available.
                    response = await askBosunVoice(audioBlob, controller.signal);
                }
                if (!isVoiceOperationCurrent(operation)) return;
                handleResponse(response, to, operation);
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') return;
                if (!isVoiceOperationCurrent(operation)) return;
                setQuotaTrace(err);
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                scheduleVoiceTimeout(operation, () => setOneButton(to, 'idle'), 1500);
            } finally {
                requestControllersRef.current.delete(controller);
            }
        },
        [
            handleResponse,
            isVoiceOperationCurrent,
            runOrchestrator,
            scheduleVoiceTimeout,
            setErrorMessage,
            setOneButton,
            setQuotaTrace,
            turns,
        ],
    );

    const sendTextQuery = useCallback(
        async (text: string, to: 'bosun' | 'cloud', operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
            if (!text.trim()) return;
            const controller = new AbortController();
            requestControllersRef.current.add(controller);
            setOneButton(to, 'awaiting');
            setErrorMessage(null);
            try {
                const response =
                    to === 'bosun'
                        ? await askBosunText({ text }, controller.signal)
                        : await runOrchestrator(text, operation, controller.signal, false);
                if (!isVoiceOperationCurrent(operation)) return;
                handleResponse(response, to, operation);
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') return;
                if (!isVoiceOperationCurrent(operation)) return;
                setErrorMessage((err as Error).message || 'Something went wrong.');
                setOneButton(to, 'error');
                scheduleVoiceTimeout(operation, () => setOneButton(to, 'idle'), 1500);
            } finally {
                requestControllersRef.current.delete(controller);
            }
        },
        [handleResponse, isVoiceOperationCurrent, runOrchestrator, scheduleVoiceTimeout, setErrorMessage, setOneButton],
    );

    /**
     * Hands-free send via "over". Fires from the SR partialResults stream
     * when the skipper's utterance ends with "over". Mirrors the stop+send
     * branch of handleTalkTap but uses the cleaned SR text directly,
     * skipping Scribe entirely. Self-guarding: if the recorder has already
     * been torn down (e.g. user tapped concurrently), this is a no-op.
     */
    const handleOverGesture = useCallback(
        async (cleanedText: string, target: 'bosun' | 'cloud', operation: VoiceOperation) => {
            if (!isVoiceOperationCurrent(operation)) return;
            const handle = recorderRef.current;
            const srHandle = speechRecognizerRef.current;
            const dgHandle = deepgramRecognizerRef.current;
            if (!handle && !srHandle && !dgHandle) return;
            recorderRef.current = null;
            speechRecognizerRef.current = null;
            deepgramRecognizerRef.current = null;
            stoppingRecorderRef.current = handle;
            stoppingSpeechRecognizerRef.current = srHandle;
            stoppingDeepgramRecognizerRef.current = dgHandle;
            setOneButton(target, 'sending');
            try {
                if (dgHandle) {
                    // Deepgram path — we already have the cleaned text
                    // from the partial that triggered "over". Cancel the
                    // WS (don't wait for the final flush since we're
                    // bypassing it) and ship the text directly.
                    await dgHandle.cancel();
                    if (stoppingDeepgramRecognizerRef.current === dgHandle)
                        stoppingDeepgramRecognizerRef.current = null;
                    if (!isVoiceOperationCurrent(operation)) return;
                    rearmPrewarm(operation); // overlap re-arm with the API call below
                    setActiveTarget(null);
                    setActiveRecognizerKind(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), target, cleanedText, operation);
                } else if (srHandle) {
                    // Apple SR fallback path — same flow, different recognizer.
                    await srHandle.cancel();
                    if (stoppingSpeechRecognizerRef.current === srHandle) stoppingSpeechRecognizerRef.current = null;
                    if (!isVoiceOperationCurrent(operation)) return;
                    rearmPrewarm(operation);
                    setActiveTarget(null);
                    setActiveRecognizerKind(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), target, cleanedText, operation);
                } else if (handle) {
                    const blob = await handle.stop();
                    if (stoppingRecorderRef.current === handle) stoppingRecorderRef.current = null;
                    if (!isVoiceOperationCurrent(operation)) return;
                    rearmPrewarm(operation);
                    setActiveTarget(null);
                    setActiveRecognizerKind(null);
                    setLiveTranscript('');
                    setSrActive(false);
                    await sendVoiceQuery(blob, target, cleanedText, operation);
                }
            } catch (err) {
                if (stoppingRecorderRef.current === handle) stoppingRecorderRef.current = null;
                if (stoppingSpeechRecognizerRef.current === srHandle) stoppingSpeechRecognizerRef.current = null;
                if (stoppingDeepgramRecognizerRef.current === dgHandle) stoppingDeepgramRecognizerRef.current = null;
                if (!isVoiceOperationCurrent(operation)) return;
                setErrorMessage((err as Error).message);
                setOneButton(target, 'error');
                scheduleVoiceTimeout(operation, () => setOneButton(target, 'idle'), 1500);
                // Even on error, re-arm so the next tap isn't worse than it
                // would be without this whole fix.
                rearmPrewarm(operation);
            }
        },
        [isVoiceOperationCurrent, rearmPrewarm, scheduleVoiceTimeout, sendVoiceQuery, setErrorMessage, setOneButton],
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
            const operation = captureVoiceOperation();
            // CRITICAL: unlock audio playback for iOS WKWebView synchronously,
            // BEFORE any await. iOS only lets us prime the Audio element from
            // within a user-gesture handler — once we await anything, the
            // gesture context evaporates and the response audio won't play.
            unlockAudio(operation);
            if (!isVoiceOperationCurrent(operation)) return;

            const currentState = buttonState[which];

            // Start recording
            if (currentState === 'idle' || currentState === 'error' || currentState === 'playing') {
                if (!isAudioRecordingSupported()) {
                    setErrorMessage('Voice input not supported on this device. Use the text box below instead.');
                    return;
                }
                stopAudio();
                // Calypso's response voice is native AVAudioPlayer on iOS,
                // not the HTML Audio element stopped above. Hand the shared
                // AVAudioSession back to `.playAndRecord` before touching
                // WebKit capture; otherwise an apparently-live prewarmed
                // stream can send silence after a spoken response.
                const nativeSessionPrepared = await prepareNativeVoiceInput();
                if (!isVoiceOperationCurrent(operation)) return;
                if (nativeSessionPrepared) {
                    // Native TTS and MusicKit can have changed the input
                    // route before this tap, including after the UI has
                    // already returned to idle. Do not reuse a WebKit graph
                    // that now looks live but supplies silence. Keep the
                    // prewarmed Deepgram socket: it is independent of
                    // AVAudioSession and still saves the WS handshake.
                    releasePrewarmedAudioContext();
                    releasePrewarmedMicStream();
                }
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
                                if (!isVoiceOperationCurrent(operation)) return;
                                setLiveTranscript(text);
                                const { matched, cleaned } = detectOverSuffix(text);
                                if (matched && cleaned.length > 0) {
                                    setSrEventLog((prev) => [
                                        ...prev.slice(-19),
                                        { ts: Date.now(), msg: `[over] fired: "${cleaned.slice(0, 60)}"` },
                                    ]);
                                    void handleOverGesture(cleaned, which, operation);
                                }
                            },
                            onFirstPartial: () => {
                                if (!isVoiceOperationCurrent(operation)) return;
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
                        if (!isVoiceOperationCurrent(operation)) {
                            await dgHandle.cancel();
                            return;
                        }
                        deepgramRecognizerRef.current = dgHandle;
                        recognizerStarted = true;
                        setActiveRecognizerKind('deepgram');
                    } catch (err) {
                        if (!isVoiceOperationCurrent(operation)) return;
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
                                if (!isVoiceOperationCurrent(operation)) return;
                                setLiveTranscript(text);
                                const { matched, cleaned } = detectOverSuffix(text);
                                if (matched && cleaned.length > 0) {
                                    // Surface in the debug strip so the skipper
                                    // can see the gesture actually fired.
                                    setSrEventLog((prev) => [
                                        ...prev.slice(-19),
                                        { ts: Date.now(), msg: `[over] fired: "${cleaned.slice(0, 60)}"` },
                                    ]);
                                    void handleOverGesture(cleaned, which, operation);
                                }
                            },
                            onFirstPartial: () => {
                                if (!isVoiceOperationCurrent(operation)) return;
                                setSrActive(true);
                                // Unblock any tap-to-stop grace period waiting on
                                // the first partial. Only resolves once per cycle.
                                firstPartialPromiseRef.current?.resolve();
                            },
                        });
                        if (!isVoiceOperationCurrent(operation)) {
                            await srHandle.cancel();
                            return;
                        }
                        speechRecognizerRef.current = srHandle;
                        srStarted = true;
                        recognizerStarted = true;
                        setActiveRecognizerKind('apple-sr');
                    } catch (err) {
                        if (!isVoiceOperationCurrent(operation)) return;
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
                        if (!isVoiceOperationCurrent(operation)) {
                            handle.cancel();
                            return;
                        }
                        recorderRef.current = handle;
                        setActiveRecognizerKind('media-recorder');
                    } catch (err) {
                        if (!isVoiceOperationCurrent(operation)) return;
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
                        scheduleVoiceTimeout(operation, () => setOneButton(which, 'idle'), 1500);
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
                        new Promise<void>((resolve) => scheduleVoiceTimeout(operation, resolve, 500)),
                    ]);
                    if (!isVoiceOperationCurrent(operation)) return;
                    // The OVER gesture fires synchronously inside onPartial
                    // and clears recognizer refs. If that happened during
                    // the grace, refs are gone — bail out cleanly.
                    if (!deepgramRecognizerRef.current && !speechRecognizerRef.current) return;
                }
                recorderRef.current = null;
                speechRecognizerRef.current = null;
                deepgramRecognizerRef.current = null;
                stoppingRecorderRef.current = handle;
                stoppingSpeechRecognizerRef.current = srHandle;
                stoppingDeepgramRecognizerRef.current = dgHandle;
                setOneButton(which, 'sending');
                try {
                    if (dgHandle) {
                        // Deepgram path: send CloseStream, wait for final
                        // flush, return composed transcript. No audio blob
                        // ever travels over our edge function — the audio
                        // already streamed to Deepgram directly.
                        const dg = await dgHandle.stop();
                        if (stoppingDeepgramRecognizerRef.current === dgHandle) {
                            stoppingDeepgramRecognizerRef.current = null;
                        }
                        if (!isVoiceOperationCurrent(operation)) return;
                        // Re-arm the prewarm pipeline NOW so it overlaps with
                        // the API call below. By the time the user has heard
                        // Calypso's response and is ready to tap again, the
                        // mic / context / worklet / WebSocket are all warm.
                        rearmPrewarm(operation);
                        setActiveTarget(null);
                        setActiveRecognizerKind(null);
                        setLiveTranscript('');
                        setSrActive(false);
                        if (!dg.text) {
                            setErrorMessage("Couldn't make out what you said — try again.");
                            setOneButton(which, 'error');
                            scheduleVoiceTimeout(operation, () => setOneButton(which, 'idle'), 1500);
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
                        await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), which, finalText, operation);
                    } else if (srHandle) {
                        // Apple SR fallback path: stop SR, get its
                        // on-device transcript, hit Haiku directly with
                        // text. No audio blob.
                        const sr = await srHandle.stop();
                        if (stoppingSpeechRecognizerRef.current === srHandle) {
                            stoppingSpeechRecognizerRef.current = null;
                        }
                        if (!isVoiceOperationCurrent(operation)) return;
                        rearmPrewarm(operation);
                        setActiveTarget(null);
                        setActiveRecognizerKind(null);
                        setLiveTranscript('');
                        setSrActive(false);
                        if (!sr.text) {
                            setErrorMessage("Couldn't make out what you said — try again.");
                            setOneButton(which, 'error');
                            scheduleVoiceTimeout(operation, () => setOneButton(which, 'idle'), 1500);
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
                        await sendVoiceQuery(new Blob([], { type: 'audio/mp4' }), which, finalText, operation);
                    } else if (handle) {
                        // MediaRecorder fallback path: stop, send blob to
                        // Scribe-backed edge function for STT.
                        const blob = await handle.stop();
                        if (stoppingRecorderRef.current === handle) stoppingRecorderRef.current = null;
                        if (!isVoiceOperationCurrent(operation)) return;
                        rearmPrewarm(operation);
                        setActiveTarget(null);
                        setActiveRecognizerKind(null);
                        setLiveTranscript('');
                        setSrActive(false);
                        await sendVoiceQuery(blob, which, null, operation);
                    }
                } catch (err) {
                    if (stoppingRecorderRef.current === handle) stoppingRecorderRef.current = null;
                    if (stoppingSpeechRecognizerRef.current === srHandle) stoppingSpeechRecognizerRef.current = null;
                    if (stoppingDeepgramRecognizerRef.current === dgHandle)
                        stoppingDeepgramRecognizerRef.current = null;
                    if (!isVoiceOperationCurrent(operation)) return;
                    setErrorMessage((err as Error).message);
                    setOneButton(which, 'error');
                    scheduleVoiceTimeout(operation, () => setOneButton(which, 'idle'), 1500);
                    rearmPrewarm(operation);
                }
            }
            // sending / awaiting: ignore.
        },
        [
            buttonState,
            captureVoiceOperation,
            activeTarget,
            isVoiceOperationCurrent,
            scheduleVoiceTimeout,
            sendVoiceQuery,
            setErrorMessage,
            setOneButton,
            stopAudio,
            unlockAudio,
            handleOverGesture,
            rearmPrewarm,
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
            const operation = captureVoiceOperation();
            // Same iOS audio-unlock trick as the talk button — synchronous
            // priming inside the user gesture (form submit click).
            unlockAudio(operation);
            const text = typedQuery.trim();
            if (!text) return;
            setTypedQuery('');
            void sendTextQuery(text, to, operation);
        },
        [captureVoiceOperation, typedQuery, sendTextQuery, unlockAudio],
    );

    const handleReplay = useCallback(
        (response: VoiceQueryResponse) => {
            const operation = captureVoiceOperation();
            // The replay button click IS a user gesture — unlock again to
            // be safe in case the page audio context lapsed.
            unlockAudio(operation);
            const to: 'bosun' | 'cloud' = response.source === 'cloud' ? 'cloud' : 'bosun';
            playResponseAudio(response, to, operation);
        },
        [captureVoiceOperation, playResponseAudio, unlockAudio],
    );

    /**
     * Active route — cloud Haiku is primary (faster, smarter). Local Pi
     * (Llama 3.2 3B) is the OFFLINE fallback only, used when the cloud is
     * unreachable. Null when neither path is available.
     *
     * The single Bosun button + typed input both target this route, and
     * the subtitle reflects which brain is currently active.
     */
    const signedIn = Boolean(getAuthIdentityScope().userId);
    const route: 'bosun' | 'cloud' | null =
        cloudAvailable && signedIn ? 'cloud' : PI_INTEGRATION_ENABLED && bosunAvailable ? 'bosun' : null;
    // Subtitle under the talk button. While the prewarms are still
    // running (mic acquisition is the slow one — ~1-1.4s on iOS) we
    // surface "Warming up…" so the skipper sees explicit feedback that
    // the system needs a moment, instead of seeing "Calypso cloud" and
    // tapping into a still-cold path. A medium haptic fires the moment
    // prewarm flips ready so they feel the cue too.
    const brainSubtitle = !route
        ? signedIn
            ? 'Restore internet to use Calypso'
            : 'Sign in to use Calypso'
        : !prewarmReady
          ? 'Voice warming — typing ready'
          : route === 'cloud'
            ? 'Calypso cloud'
            : route === 'bosun'
              ? 'Calypso on the boat'
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
            className="flex flex-col h-full bg-linear-to-b from-slate-900 via-slate-950 to-black animate-in fade-in duration-200"
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
                        {FEATURE_VISIBILITY.appleMusic && (
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
                        )}
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
            {/* The "Set up Pi" CTA lived here and was removed 2026-08-07
                (Shane: "this does not work???? ... i suspect that is for
                connecting via wifi when you have never connected the pi
                before. however, this should belong in the settings").

                He was right on both counts. PiSetupWizard is FIRST-TIME WI-FI
                PROVISIONING: it talks to a brand-new Pi's own
                `Calypso-Setup-XXXX` access point, so it can only work while
                the phone is joined to THAT network. Offered here it read as
                "fix my missing Pi", and for anyone whose Pi is already on the
                boat Wi-Fi it silently could not reach anything — the failure
                he hit. It is hardware onboarding, not a voice feature, and it
                now lives in Settings → Boat Network with its precondition
                stated. */}

            {/* ── Conversation log ───────────────────────── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {turns.length === 0 && !errorMessage && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 gap-2 pt-8">
                        <p className="text-sm font-bold text-gray-400">
                            {route
                                ? 'Tap Calypso to talk.'
                                : signedIn
                                  ? 'Calypso is offline.'
                                  : 'Sign in to use Calypso.'}
                        </p>
                        <p className="text-xs max-w-[280px]">
                            {PI_INTEGRATION_ENABLED
                                ? "One Calypso, two brains behind her. She answers from the boat's Pi when it is reachable, otherwise from the cloud — the active source shows under the button."
                                : PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE}
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
                            ? 'Hearing you'
                            : activeRecognizerKind === 'media-recorder'
                              ? 'Recording — transcribed when you send'
                              : 'Listening…'}
                    </p>
                </div>
            )}

            {/* SR debug strip removed from UI per user feedback. The
                underlying srEventLog state + the various event-tap
                hooks are kept intact so we can re-add a developer-mode
                toggle later if needed without rewiring everything. */}
            {showVoiceDiagnostics && srEventLog.length > 0 && (
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
                                    <span className="text-gray-400">{stamp}</span>
                                    <span className="flex-1 wrap-break-word">{e.msg}</span>
                                </div>
                            );
                        })}
                    </div>
                </details>
            )}

            {prewarmDegraded && route && (
                <div
                    className="shrink-0 mx-5 mt-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-400/20"
                    role="status"
                >
                    <p className="text-xs text-amber-100">
                        Voice warm-up did not finish. You can type now; speech will retry when you tap.
                    </p>
                </div>
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
                            !route
                                ? signedIn
                                    ? 'Restore internet to ask Calypso'
                                    : 'Sign in to ask Calypso'
                                : !prewarmReady
                                  ? 'Type now — voice is still warming…'
                                  : `Or type — sends to ${brainSubtitle.toLowerCase()}...`
                        }
                        className="flex-1 px-4 py-3 rounded-full bg-white/5 border border-white/10 text-white placeholder:text-gray-500 text-sm focus:outline-hidden focus:border-sky-500/50 disabled:opacity-50"
                        disabled={!route || isAnyAwaiting || isAnySending}
                    />
                    <button
                        type="submit"
                        disabled={
                            !route ||
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
        </div>
    );
};
