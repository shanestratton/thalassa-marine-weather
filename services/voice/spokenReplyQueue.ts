/**
 * spokenReplyQueue — speak a streaming reply sentence by sentence.
 *
 * Calypso's felt latency is time-to-first-WORD-HEARD, not time-to-last-token.
 * Synthesising the whole reply and then playing it means the skipper waits for
 * generation AND synthesis AND the full audio to start. Cutting at sentence
 * boundaries collapses that to the first sentence: everything after it is
 * synthesised while the previous sentence is still playing.
 *
 * Sentence boundaries, not fixed chunks. A chunk boundary lands mid-clause and
 * ElevenLabs renders the fragment with falling intonation, so the reply sounds
 * chopped even though the words are right. A sentence is the smallest unit
 * that survives being spoken alone.
 *
 * Playback is strictly serial. `speak()` resolves when the audio finishes, so
 * awaiting each one in turn is what keeps sentence two from talking over
 * sentence one — the queue's whole job is to hold that ordering while the
 * stream races ahead of the voice.
 */
import { speak } from './ttsClient';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('spokenReply');

/**
 * Below this, a "sentence" is usually an abbreviation or a stray delimiter
 * ("Mr.", "12."). Speaking those alone produces a stutter, so let them
 * accumulate into the next one.
 */
const MIN_SPEAKABLE_CHARS = 12;

/** Sentence-final punctuation followed by whitespace, or end of input. */
const SENTENCE_END = /[.!?…]["')\]]*(\s|$)/;

export interface SpokenReply {
    /** Feed a text delta as it arrives from the stream. */
    push(delta: string): void;
    /**
     * Turn boundary: speak whatever is buffered, even without terminal
     * punctuation. Haiku often says "Let me check the wind" before calling a
     * tool; without this the fragment would sit in the buffer and merge into
     * the first sentence of the actual answer.
     */
    flush(): void;
    /** No more deltas — speak whatever is left and resolve when audio ends. */
    end(): Promise<void>;
    /** Stop immediately; cancels in-flight and pending audio. */
    cancel(): void;
}

/**
 * Start a spoken reply. Returns immediately; audio begins as soon as the first
 * complete sentence arrives.
 */
export function startSpokenReply(): SpokenReply {
    let buffer = '';
    let cancelled = false;
    /** Serialises playback — each sentence awaits the previous one's audio. */
    let tail: Promise<void> = Promise.resolve();
    let current: { cancel: () => void } | null = null;

    const enqueue = (sentence: string) => {
        const text = sentence.trim();
        if (!text || cancelled) return;
        tail = tail
            .then(async () => {
                if (cancelled) return;
                const handle = speak(text);
                current = handle;
                await handle.done;
            })
            .catch((err) => {
                // A failed sentence must not take the rest of the reply with
                // it — TTS is the delivery, not the answer. The text is
                // already on screen either way.
                log.warn('sentence failed to speak', err);
            });
    };

    /**
     * Pull every complete sentence out of the buffer, leaving the remainder.
     *
     * A too-short candidate merges FORWARD to the next boundary rather than
     * being spoken alone — that is what keeps "Call Mr." from being uttered as
     * a sentence and then leaving "Stratton about the mooring." stranded as
     * the next one.
     */
    const drain = () => {
        for (;;) {
            let searchFrom = 0;
            let cut = -1;
            for (;;) {
                const match = SENTENCE_END.exec(buffer.slice(searchFrom));
                if (!match) break;
                const end = searchFrom + match.index + match[0].length;
                if (buffer.slice(0, end).trim().length >= MIN_SPEAKABLE_CHARS) {
                    cut = end;
                    break;
                }
                // Too short — this boundary is an abbreviation or a list
                // number. Keep looking past it.
                searchFrom = end;
            }
            // No boundary long enough yet; wait for more of the stream.
            if (cut < 0) return;
            enqueue(buffer.slice(0, cut));
            buffer = buffer.slice(cut);
        }
    };

    return {
        push(delta: string) {
            if (cancelled || !delta) return;
            buffer += delta;
            drain();
        },
        flush() {
            if (cancelled || !buffer.trim()) return;
            enqueue(buffer);
            buffer = '';
        },
        async end() {
            if (!cancelled && buffer.trim()) {
                enqueue(buffer);
                buffer = '';
            }
            await tail;
        },
        cancel() {
            cancelled = true;
            buffer = '';
            try {
                current?.cancel();
            } catch {
                /* already finished */
            }
        },
    };
}
