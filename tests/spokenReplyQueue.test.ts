/**
 * Calypso only ever wrote; nothing spoke his replies, and nothing streamed, so
 * felt latency was the whole generation time (Shane 2026-08-08). This queue is
 * the fix for both at once — speak sentence by sentence off the stream so the
 * first words land while the rest is still being generated.
 *
 * What these pin is ORDER and BOUNDARIES: audio must never overlap, and a cut
 * must never land mid-clause (ElevenLabs renders a fragment with falling
 * intonation, so the reply sounds chopped even when the words are right).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const spoken: string[] = [];
const tts = vi.hoisted(() => ({ speak: vi.fn() }));

vi.mock('../services/voice/ttsClient', () => ({ speak: tts.speak }));

import { startSpokenReply } from '../services/voice/spokenReplyQueue';

/** Resolve after `ms` of fake time, so overlap is observable. */
const playFor = (ms: number) => {
    let done: () => void;
    const promise = new Promise<void>((r) => (done = r));
    setTimeout(() => done(), ms);
    return promise;
};

beforeEach(() => {
    spoken.length = 0;
    tts.speak.mockReset();
    tts.speak.mockImplementation((text: string) => {
        spoken.push(text);
        return { done: playFor(100), cancel: vi.fn() };
    });
    vi.useFakeTimers();
});

describe('startSpokenReply', () => {
    it('speaks the first sentence before the reply has finished arriving', async () => {
        const reply = startSpokenReply();
        reply.push('Wind is up to twelve knots. ');
        // Playback is scheduled on the serialising tail, so it starts a
        // microtask later — flush, don't sleep.
        await Promise.resolve();
        await Promise.resolve();
        // Nothing else has been pushed — the rest of the reply is still being
        // generated, and that is exactly the point.
        expect(spoken).toEqual(['Wind is up to twelve knots.']);
    });

    it('never overlaps audio, even when the stream races ahead', async () => {
        const overlapping: string[] = [];
        let playing = 0;
        tts.speak.mockImplementation((text: string) => {
            spoken.push(text);
            playing += 1;
            if (playing > 1) overlapping.push(text);
            return {
                done: playFor(100).then(() => {
                    playing -= 1;
                }),
                cancel: vi.fn(),
            };
        });

        const reply = startSpokenReply();
        reply.push('First one here. Second one here. Third one here. ');
        const ended = reply.end();
        await vi.advanceTimersByTimeAsync(1000);
        await ended;

        expect(spoken).toHaveLength(3);
        expect(overlapping).toEqual([]);
    });

    it('splits on sentence boundaries, not on delta boundaries', async () => {
        const reply = startSpokenReply();
        // A real stream chops mid-word; boundaries must come from the text.
        for (const delta of ['The tide tur', 'ns at four. Then it ', 'floods.']) {
            reply.push(delta);
        }
        const ended = reply.end();
        await vi.advanceTimersByTimeAsync(1000);
        await ended;
        expect(spoken).toEqual(['The tide turns at four.', 'Then it floods.']);
    });

    it('does not speak an abbreviation as its own sentence', async () => {
        const reply = startSpokenReply();
        reply.push('Call Mr. Stratton about the mooring. ');
        const ended = reply.end();
        await vi.advanceTimersByTimeAsync(1000);
        await ended;
        // "Mr." alone would stutter; it rides with the sentence it belongs to.
        expect(spoken).toEqual(['Call Mr. Stratton about the mooring.']);
    });

    it('speaks a trailing fragment that never got its full stop', async () => {
        const reply = startSpokenReply();
        reply.push('Anchor is holding');
        const ended = reply.end();
        await vi.advanceTimersByTimeAsync(1000);
        await ended;
        expect(spoken).toEqual(['Anchor is holding']);
    });

    it('cancel stops the current sentence and everything queued behind it', async () => {
        const cancelSpy = vi.fn();
        tts.speak.mockImplementation((text: string) => {
            spoken.push(text);
            return { done: playFor(100), cancel: cancelSpy };
        });

        const reply = startSpokenReply();
        reply.push('One sentence here. ');
        // Let the first sentence actually START playing — cancelling before
        // playback begins correctly cancels nothing, which is a different
        // case from the one that matters (skipper interrupts mid-sentence).
        await vi.advanceTimersByTimeAsync(10);
        expect(spoken).toEqual(['One sentence here.']);

        reply.cancel();
        reply.push('Two sentence here. ');
        await vi.advanceTimersByTimeAsync(1000);

        expect(cancelSpy).toHaveBeenCalled();
        expect(spoken).toEqual(['One sentence here.']);
    });

    it('a sentence that fails to speak does not silence the rest', async () => {
        tts.speak.mockImplementationOnce(() => {
            throw new Error('quota exhausted');
        });
        const reply = startSpokenReply();
        reply.push('First one here. Second one here. ');
        const ended = reply.end();
        await vi.advanceTimersByTimeAsync(1000);
        await expect(ended).resolves.toBeUndefined();
        expect(spoken).toContain('Second one here.');
    });
});
