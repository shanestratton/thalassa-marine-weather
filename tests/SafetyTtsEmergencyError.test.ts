import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ synthesise: vi.fn() }));

vi.mock('../services/voice/ttsClient', () => ({
    synthesise: (...args: unknown[]) => mocks.synthesise(...args),
}));

import { speakSafetyMessage } from '../services/voice/safetyTts';

class InterruptedUtterance {
    rate = 1;
    pitch = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly text: string) {}
}

describe('Safety TTS emergency error propagation', () => {
    beforeEach(() => {
        mocks.synthesise.mockResolvedValue(null);
        vi.stubGlobal('SpeechSynthesisUtterance', InterruptedUtterance);
        vi.stubGlobal('speechSynthesis', {
            speak: vi.fn((utterance: InterruptedUtterance) => {
                utterance.onstart?.();
                utterance.onerror?.();
            }),
            cancel: vi.fn(),
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('reports native onerror even after playback has started', async () => {
        const onPlaybackStart = vi.fn();
        const onPlaybackEnd = vi.fn();
        const onError = vi.fn();

        const handle = speakSafetyMessage('Mayday test', { onPlaybackStart, onPlaybackEnd, onError });
        await handle.done;

        expect(onPlaybackStart).toHaveBeenCalledWith('native');
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'Native synth stopped before completion' }),
        );
        expect(onPlaybackEnd).not.toHaveBeenCalled();
    });
});
