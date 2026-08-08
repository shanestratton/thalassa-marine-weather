/**
 * Streaming must not change what the tool loop sees.
 *
 * The reason Calypso now speaks while he is still thinking is that answer text
 * is delivered in fragments. The risk that buys is a second, subtly different
 * path through the tool dispatcher — one where a tool_use block arrives with
 * half its arguments, or a chunk boundary eats a frame. These pin the
 * reassembly against exactly that.
 */
import { describe, expect, it } from 'vitest';
import { createSseAccumulator } from '../services/voice/sseMessage';

const frame = (obj: unknown) => `event: x\ndata: ${JSON.stringify(obj)}\n\n`;

const textReply = [
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Wind is ' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'twelve knots.' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
].join('');

describe('createSseAccumulator', () => {
    it('reassembles a text reply and reports every delta in order', () => {
        const deltas: string[] = [];
        const acc = createSseAccumulator((d) => deltas.push(d));
        acc.feed(textReply);

        expect(deltas).toEqual(['Wind is ', 'twelve knots.']);
        expect(acc.result()).toEqual({
            content: [{ type: 'text', text: 'Wind is twelve knots.' }],
            stop_reason: 'end_turn',
            usage: { output_tokens: 9 },
        });
    });

    it('survives chunk boundaries that fall anywhere, including mid-frame', () => {
        // A network chunk has no idea where an SSE frame ends. Feeding one
        // character at a time is the pathological case, and it must produce
        // the identical message.
        const deltas: string[] = [];
        const acc = createSseAccumulator((d) => deltas.push(d));
        for (const ch of textReply) acc.feed(ch);

        expect(deltas.join('')).toBe('Wind is twelve knots.');
        expect(acc.result().content[0].text).toBe('Wind is twelve knots.');
    });

    it('parses tool_use arguments only once the block closes', () => {
        const acc = createSseAccumulator();
        acc.feed(
            [
                frame({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'tool_use', id: 'tu_1', name: 'thalassa_weather', input: {} },
                }),
                frame({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"lat' },
                }),
                frame({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '":-27.2,"lon":153.1}' },
                }),
            ].join(''),
        );
        // Still open — arguments are not yet valid JSON, and must not be guessed at.
        expect(acc.result().content[0].input).toEqual({});

        acc.feed(frame({ type: 'content_block_stop', index: 0 }));
        expect(acc.result().content[0].input).toEqual({ lat: -27.2, lon: 153.1 });
    });

    it('empties unparseable tool arguments rather than running on a fragment', () => {
        const acc = createSseAccumulator();
        acc.feed(
            [
                frame({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'tool_use', id: 'tu_1', name: 'pi_status', input: {} },
                }),
                frame({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"host":' },
                }),
                frame({ type: 'content_block_stop', index: 0 }),
            ].join(''),
        );
        expect(acc.result().content[0].input).toEqual({});
    });

    it('keeps a preamble and a tool call as separate blocks in order', () => {
        const deltas: string[] = [];
        const acc = createSseAccumulator((d) => deltas.push(d));
        acc.feed(
            [
                frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
                frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }),
                frame({ type: 'content_block_stop', index: 0 }),
                frame({
                    type: 'content_block_start',
                    index: 1,
                    content_block: { type: 'tool_use', id: 'tu_2', name: 'thalassa_weather', input: {} },
                }),
                frame({
                    type: 'content_block_delta',
                    index: 1,
                    delta: { type: 'input_json_delta', partial_json: '{}' },
                }),
                frame({ type: 'content_block_stop', index: 1 }),
                frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
            ].join(''),
        );

        const result = acc.result();
        expect(result.stop_reason).toBe('tool_use');
        expect(result.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
        // Only prose is spoken — a tool call has nothing to say out loud.
        expect(deltas).toEqual(['Let me check.']);
    });

    it('ignores keep-alives and junk instead of failing the reply', () => {
        const acc = createSseAccumulator();
        acc.feed(': ping\n\n');
        acc.feed('data: not json at all\n\n');
        acc.feed(textReply);
        expect(acc.result().content[0].text).toBe('Wind is twelve knots.');
    });

    it('raises a stream error event rather than returning a truncated answer', () => {
        const acc = createSseAccumulator();
        expect(() => acc.feed(frame({ type: 'error', error: { message: 'overloaded_error' } }))).toThrow(
            /overloaded_error/,
        );
    });
});
