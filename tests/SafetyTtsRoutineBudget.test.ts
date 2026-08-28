/**
 * Shane 2026-08-28: "the text to voice for reading the location is u/s. not
 * hal and speaks very fast and not in a manner that would suggest human talk."
 *
 * He had HAL selected and was hearing the robot. The four-second budget
 * exists so a DISTRESS transmission can never stall on a network, and that
 * is right — but the routine position readback was being held to it too. A
 * spelled-out position is far too long to synthesise in four seconds, so the
 * race was lost every single time and the native voice spoke instead: fast,
 * flat, and nothing like the voice he picked.
 *
 * A routine readback is not an emergency. The skipper pressed a button and is
 * waiting to hear their own position. It can afford to wait for the good
 * voice — provided it SAYS it is waiting, or a long budget is
 * indistinguishable from a dead button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const synthesise = vi.hoisted(() => vi.fn());
vi.mock('../services/voice/ttsClient', () => ({ synthesise }));

import { ROUTINE_TTS_BUDGET_MS, __clearSafetyPrewarmForTests, speakSafetyMessage } from '../services/voice/safetyTts';

const page = readFileSync('components/vessel/RadioConsolePage.tsx', 'utf8');

class StubUtterance {
    voice: unknown = null;
    rate = 1;
    pitch = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
}

beforeEach(() => {
    vi.clearAllMocks();
    __clearSafetyPrewarmForTests();
    vi.useFakeTimers();
    // jsdom has no speech synthesis, and without it the fallback reports an
    // error instead of speaking — which would hide the very transition this
    // file is about.
    vi.stubGlobal('SpeechSynthesisUtterance', StubUtterance);
    vi.stubGlobal('speechSynthesis', {
        speak: vi.fn((u: StubUtterance) => {
            u.onstart?.();
            u.onend?.();
        }),
        cancel: vi.fn(),
        getVoices: () => [],
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('the routine budget', () => {
    it('is long enough for a spelled-out position, and far longer than the safety budget', () => {
        expect(ROUTINE_TTS_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    });

    it('waits past four seconds for the good voice when asked to', async () => {
        // Synthesis that takes 8 s: under the old fixed budget this fell to
        // native at 4 s. With the routine budget it is still waiting.
        let resolveSynth: (v: string) => void = () => {};
        synthesise.mockReturnValue(new Promise<string>((r) => (resolveSynth = r)));
        const started: string[] = [];

        speakSafetyMessage('a spelled out position', {
            budgetMs: ROUTINE_TTS_BUDGET_MS,
            onPlaybackStart: (engine) => started.push(engine),
        });

        await vi.advanceTimersByTimeAsync(6_000);
        expect(started).toEqual([]); // NOT yet fallen back to native

        resolveSynth('AUDIO_B64');
        await vi.advanceTimersByTimeAsync(10);
        expect(started).toEqual(['calypso']);
    });

    it('still falls back once even a generous budget is spent', async () => {
        // The good voice is preferred, not waited on forever.
        synthesise.mockReturnValue(new Promise<string>(() => {}));
        const started: string[] = [];
        speakSafetyMessage('never answers', {
            budgetMs: 1_000,
            onPlaybackStart: (engine) => started.push(engine),
        });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(started).toEqual(['native']);
    });

    it('announces that synthesis has begun, so a long wait can be shown', async () => {
        synthesise.mockReturnValue(new Promise<string>(() => {}));
        const pending = vi.fn();
        speakSafetyMessage('anything', { budgetMs: 500, onSynthesisStart: pending });
        await vi.advanceTimersByTimeAsync(1);
        expect(pending).toHaveBeenCalledTimes(1);
    });
});

describe('the Radio Console wiring', () => {
    it('gives the long budget to routine reads only', () => {
        expect(page).toContain("budgetMs: dscMode === 'routine' ? ROUTINE_TTS_BUDGET_MS : undefined,");
    });

    it('pre-warms the emergency scripts instead, which keep the short budget', () => {
        // Selecting Mayday or Pan-Pan is a deliberate act taken BEFORE the
        // transmission, so the audio can be waiting by the time the button is
        // pressed. Without this they would fall to the robot exactly as the
        // routine read did.
        expect(page).toContain("if (dscMode === 'routine' || !currentTranscript) return;");
        expect(page).toContain('prewarmSafetyMessage(currentTranscript)');
    });

    it('does not pre-warm the routine read, whose text moves with every fix', () => {
        // A warm cache would almost never be hit, and every GPS fix would
        // cost an API call for a button that may never be pressed.
        const effect = page.slice(page.indexOf('useEffect(() => {\n        if (dscMode ==='));
        expect(effect.slice(0, 400)).toContain("dscMode === 'routine' || !currentTranscript) return");
    });

    it('shows a preparing state, so a long wait is not a dead button', () => {
        expect(page).toContain('onSynthesisStart: () => setIsPreparing(true)');
        expect(page).toContain("'Preparing voice…'");
        expect(page).toContain('disabled={!currentTranscript || isSpeaking || isPreparing}');
    });

    it('slows the fallback voice too, for the times it does speak', () => {
        // 0.85 raced through a string of single digits — the one thing this
        // readout exists to make copyable.
        expect(page).toContain("nativeRate: dscMode === 'distress' ? 0.7 : 0.7,");
    });
});
