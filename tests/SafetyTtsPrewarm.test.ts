/**
 * Shane 2026-08-28: "it is defaulting to the fallback voice."
 *
 * It was, every time. A MOB Mayday runs to ~600 characters, ElevenLabs takes
 * several seconds on that, and SAFETY_TTS_BUDGET_MS gives it four — so the
 * race was lost before it started and the robotic voice was what actually
 * transmitted. Raising the budget is the wrong lever: it buys a better voice
 * with silence at the moment silence is most expensive.
 *
 * So the audio is synthesised EARLY. The Mayday text is known from the
 * instant MOB goes active; a cache hit then skips the race entirely.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const synthesise = vi.hoisted(() => vi.fn());
vi.mock('../services/voice/ttsClient', () => ({ synthesise }));

import {
    __clearSafetyPrewarmForTests,
    hasPrewarmedSafetyAudio,
    prewarmSafetyMessage,
} from '../services/voice/safetyTts';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.clearAllMocks();
    __clearSafetyPrewarmForTests();
    synthesise.mockResolvedValue('AUDIO_B64');
});

describe('safety TTS pre-warm', () => {
    it('holds the audio so a later speak does not have to race for it', async () => {
        prewarmSafetyMessage('Mayday Mayday Mayday');
        await flush();
        expect(hasPrewarmedSafetyAudio('Mayday Mayday Mayday')).toBe(true);
    });

    it('synthesises each distinct script once, however often it is asked', async () => {
        // The effect re-fires as the position updates; paying ElevenLabs
        // twice for identical text would be pure waste.
        prewarmSafetyMessage('same text');
        await flush();
        prewarmSafetyMessage('same text');
        await flush();
        expect(synthesise).toHaveBeenCalledTimes(1);
    });

    it('matches on the trimmed text, the way speak will look it up', async () => {
        prewarmSafetyMessage('  padded  ');
        await flush();
        expect(hasPrewarmedSafetyAudio('padded')).toBe(true);
    });

    it('caches nothing when synthesis fails, so the race still runs', async () => {
        synthesise.mockResolvedValue(null);
        prewarmSafetyMessage('unreachable');
        await flush();
        expect(hasPrewarmedSafetyAudio('unreachable')).toBe(false);
    });

    it('swallows a rejection — a failed pre-warm must never surface as an error', async () => {
        synthesise.mockRejectedValue(new Error('offline'));
        expect(() => prewarmSafetyMessage('boom')).not.toThrow();
        await flush();
        expect(hasPrewarmedSafetyAudio('boom')).toBe(false);
    });

    it('ignores empty text rather than calling the API for nothing', async () => {
        prewarmSafetyMessage('   ');
        await flush();
        expect(synthesise).not.toHaveBeenCalled();
    });

    it('evicts oldest first, keeping the cache bounded as the fix updates', async () => {
        for (const t of ['one', 'two', 'three', 'four', 'five']) {
            prewarmSafetyMessage(t);
            await flush();
        }
        expect(hasPrewarmedSafetyAudio('one')).toBe(false);
        expect(hasPrewarmedSafetyAudio('five')).toBe(true);
    });
});
