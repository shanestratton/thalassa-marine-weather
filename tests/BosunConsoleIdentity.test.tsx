import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const voiceMocks = vi.hoisted(() => ({
    addTurn: vi.fn(),
    upsertTurnSorted: vi.fn(),
    clearHistory: vi.fn(),
    askHaiku: vi.fn(),
    synthesiseSpeech: vi.fn(),
    startDeepgramRecognizer: vi.fn(),
    startSpeechRecognition: vi.fn(),
    startRecording: vi.fn(),
    releaseMic: vi.fn(),
    releaseSocket: vi.fn(),
    releaseAudioContext: vi.fn(),
    startSync: vi.fn(),
    syncStop: vi.fn().mockResolvedValue(undefined),
    srTap: null as ((message: string) => void) | null,
    dgTap: null as ((message: string) => void) | null,
}));

vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
        <header>
            {title}
            {action}
        </header>
    ),
}));

vi.mock('../components/voice/PiSetupWizard', () => ({
    PiSetupWizard: () => null,
}));

vi.mock('../components/voice/TalkButton', () => ({
    TalkButton: ({ onTap, disabled, state }: { onTap: () => void; disabled?: boolean; state: string }) => (
        <button type="button" onClick={onTap} disabled={disabled}>
            Talk {state}
        </button>
    ),
}));

vi.mock('../stores/voiceHistoryStore', () => ({
    useVoiceHistoryStore: (
        selector: (state: {
            turns: [];
            addTurn: typeof voiceMocks.addTurn;
            upsertTurnSorted: typeof voiceMocks.upsertTurnSorted;
            clearHistory: typeof voiceMocks.clearHistory;
        }) => unknown,
    ) =>
        selector({
            turns: [],
            addTurn: voiceMocks.addTurn,
            upsertTurnSorted: voiceMocks.upsertTurnSorted,
            clearHistory: voiceMocks.clearHistory,
        }),
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: Record<string, unknown> }) => unknown) =>
        selector({
            settings: {
                subscriptionTier: 'skipper',
                calypsoEmailEnabled: false,
            },
        }),
}));

vi.mock('../services/SubscriptionService', () => ({
    canAccess: () => false,
}));

vi.mock('../services/voice/audioRecorder', () => ({
    isAudioRecordingSupported: () => true,
    startRecording: voiceMocks.startRecording,
}));

vi.mock('../services/voice/bosunVoice', () => ({
    askBosunText: vi.fn(),
    askBosunVoice: vi.fn(),
    isBosunReachable: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/voice/cloudFallback', () => ({
    askCloudVoice: vi.fn(),
}));

vi.mock('../services/voice/conversationSync', () => ({
    publishTurn: vi.fn(),
    startConversationSync: voiceMocks.startSync,
}));

vi.mock('../services/voice/orchestrator', () => ({
    askHaiku: voiceMocks.askHaiku,
    synthesiseSpeech: voiceMocks.synthesiseSpeech,
}));

vi.mock('../services/voice/deepgramRecognizer', () => ({
    isDeepgramAvailable: vi.fn().mockResolvedValue(true),
    prewarmAudioContext: vi.fn().mockResolvedValue(true),
    prewarmDeepgramWebSocket: vi.fn().mockResolvedValue(true),
    prewarmMicStream: vi.fn().mockResolvedValue(true),
    prewarmWorkerConnection: vi.fn().mockResolvedValue(true),
    prewarmWorkletAsset: vi.fn().mockResolvedValue(true),
    primeAudioPipeline: vi.fn(),
    releasePrewarmedAudioContext: voiceMocks.releaseAudioContext,
    releasePrewarmedMicStream: voiceMocks.releaseMic,
    releasePrewarmedWebSocket: voiceMocks.releaseSocket,
    setDeepgramEventTap: (tap: ((message: string) => void) | null) => {
        voiceMocks.dgTap = tap;
    },
    startDeepgramRecognizer: voiceMocks.startDeepgramRecognizer,
}));

vi.mock('../services/voice/speechRecognizer', () => ({
    isSpeechRecognitionAvailable: vi.fn().mockResolvedValue(false),
    setSrEventTap: (tap: ((message: string) => void) | null) => {
        voiceMocks.srTap = tap;
    },
    startSpeechRecognition: voiceMocks.startSpeechRecognition,
}));

vi.mock('../services/voice/thalassaContext', () => ({
    gatherThalassaContext: () => ({}),
    prewarmPhoneGpsContext: vi.fn().mockResolvedValue(undefined),
}));

import { BosunConsole } from '../components/voice/BosunConsole';

class TestAudio {
    static instances: TestAudio[] = [];
    paused = true;
    muted = false;
    preload = '';
    src = '';
    currentTime = 0;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn().mockImplementation(() => {
        this.paused = false;
        return Promise.resolve();
    });
    pause = vi.fn().mockImplementation(() => {
        this.paused = true;
    });
    removeAttribute = vi.fn().mockImplementation((name: string) => {
        if (name === 'src') this.src = '';
    });
    load = vi.fn();

    constructor() {
        TestAudio.instances.push(this);
    }
}

async function renderReadyConsole() {
    render(<BosunConsole />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Talk idle/i })).toBeEnabled());
    return screen.getByRole('textbox');
}

describe('BosunConsole identity cutover', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        TestAudio.instances = [];
        Object.defineProperty(globalThis, 'Audio', { configurable: true, value: TestAudio });
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value: vi.fn(),
        });
        Object.defineProperty(globalThis, 'Capacitor', {
            configurable: true,
            value: {
                Plugins: {
                    AppleMusic: {
                        cancelTtsAudio: vi.fn().mockResolvedValue({ status: 'cancelled' }),
                    },
                },
            },
        });
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn().mockReturnValue('blob:voice-a'),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
        voiceMocks.startSync.mockResolvedValue({
            active: false,
            vesselOwnerId: null,
            currentUserId: null,
            stop: voiceMocks.syncStop,
        });
        voiceMocks.startRecording.mockRejectedValue(new Error('fallback should not run'));
        voiceMocks.synthesiseSpeech.mockResolvedValue(null);
        setAuthIdentityScope(null);
        setAuthIdentityScope('voice-a');
    });

    it('drops A typed/orchestrator work when its deferred result resolves for B', async () => {
        const haiku = deferred<{ answerText: string; toolCalls: string[] }>();
        voiceMocks.askHaiku.mockReturnValueOnce(haiku.promise);
        const input = await renderReadyConsole();

        fireEvent.change(input, { target: { value: 'A private passage question' } });
        fireEvent.submit(input.closest('form')!);
        expect(voiceMocks.askHaiku).toHaveBeenCalledTimes(1);
        const requestSignal = voiceMocks.askHaiku.mock.calls[0][0].signal as AbortSignal;
        expect(requestSignal.aborted).toBe(false);

        act(() => setAuthIdentityScope('voice-b'));
        expect(requestSignal.aborted).toBe(true);
        expect(screen.queryByDisplayValue('A private passage question')).not.toBeInTheDocument();

        await act(async () => {
            haiku.resolve({ answerText: 'A private answer', toolCalls: [] });
            await haiku.promise;
        });

        expect(voiceMocks.synthesiseSpeech).not.toHaveBeenCalled();
        expect(voiceMocks.addTurn).not.toHaveBeenCalled();
        expect(screen.queryByText(/A private/i)).not.toBeInTheDocument();
    });

    it('drops deferred A TTS and never installs its audio or object URL for B', async () => {
        const tts = deferred<string | null>();
        voiceMocks.askHaiku.mockResolvedValueOnce({
            answerText: 'A private spoken answer',
            toolCalls: [],
        });
        voiceMocks.synthesiseSpeech.mockReturnValueOnce(tts.promise);
        const input = await renderReadyConsole();

        fireEvent.change(input, { target: { value: 'A asks for spoken details' } });
        fireEvent.submit(input.closest('form')!);
        await waitFor(() => expect(voiceMocks.synthesiseSpeech).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('voice-b'));
        await act(async () => {
            tts.resolve('AA==');
            await tts.promise;
        });

        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(voiceMocks.addTurn).not.toHaveBeenCalled();
        expect(screen.queryByText(/private spoken/i)).not.toBeInTheDocument();
    });

    it('revokes A response audio and makes its deferred playback callbacks inert', async () => {
        voiceMocks.askHaiku.mockResolvedValueOnce({
            answerText: 'A audio answer',
            toolCalls: [],
        });
        voiceMocks.synthesiseSpeech.mockResolvedValueOnce('AA==');
        const input = await renderReadyConsole();

        fireEvent.change(input, { target: { value: 'A audio question' } });
        fireEvent.submit(input.closest('form')!);
        await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)));
        const audio = TestAudio.instances[0];
        const staleEnded = audio.onended;

        act(() => setAuthIdentityScope('voice-b'));
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-a');
        expect(audio.onended).toBeNull();

        act(() => staleEnded?.());
        expect(screen.queryByText(/A audio/i)).not.toBeInTheDocument();
    });

    it('cancels a recognizer that resolves after A→B and rejects its late transcript', async () => {
        const start = deferred<{
            stop: () => Promise<{ text: string | null; durationMs: number }>;
            cancel: () => Promise<void>;
        }>();
        const cancel = vi.fn().mockResolvedValue(undefined);
        let callbacks: { onPartial?: (text: string) => void } | undefined;
        voiceMocks.startDeepgramRecognizer.mockImplementationOnce((options) => {
            callbacks = options;
            return start.promise;
        });
        await renderReadyConsole();

        fireEvent.click(screen.getByRole('button', { name: /Talk idle/i }));
        await waitFor(() => expect(voiceMocks.startDeepgramRecognizer).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('voice-b'));
        act(() => callbacks?.onPartial?.('A microphone secret'));
        expect(screen.queryByText('A microphone secret')).not.toBeInTheDocument();

        await act(async () => {
            start.resolve({
                stop: vi.fn().mockResolvedValue({ text: null, durationMs: 0 }),
                cancel,
            });
            await start.promise;
        });

        await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('A microphone secret')).not.toBeInTheDocument();
    });

    it('synchronously clears live A UI and terminates active capture, audio, sync, and prewarm resources', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        let callbacks: { onPartial?: (text: string) => void; onFirstPartial?: () => void } | undefined;
        voiceMocks.startDeepgramRecognizer.mockImplementationOnce(async (options) => {
            callbacks = options;
            return {
                stop: vi.fn().mockResolvedValue({ text: null, durationMs: 0 }),
                cancel,
            };
        });
        await renderReadyConsole();

        fireEvent.click(screen.getByRole('button', { name: /Talk idle/i }));
        await waitFor(() => expect(screen.getByRole('button', { name: /Talk recording/i })).toBeEnabled());
        act(() => {
            callbacks?.onFirstPartial?.();
            callbacks?.onPartial?.('A live private transcript');
        });
        expect(screen.getByText('A live private transcript')).toBeInTheDocument();
        const audio = TestAudio.instances[0];

        act(() => setAuthIdentityScope('voice-b'));

        expect(screen.queryByText('A live private transcript')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Talk idle/i })).toBeDisabled();
        expect(cancel).toHaveBeenCalled();
        expect(audio.pause).toHaveBeenCalled();
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        expect(voiceMocks.syncStop).toHaveBeenCalled();
        expect(voiceMocks.releaseMic).toHaveBeenCalled();
        expect(voiceMocks.releaseSocket).toHaveBeenCalled();
        expect(voiceMocks.releaseAudioContext).toHaveBeenCalled();
    });
});
