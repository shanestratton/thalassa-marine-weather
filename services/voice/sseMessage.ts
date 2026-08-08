/**
 * sseMessage — reassemble an Anthropic SSE stream into an ordinary message.
 *
 * The tool loop in the orchestrator wants `content` blocks and a
 * `stop_reason`, exactly as the buffered endpoint returns them. Streaming must
 * change WHEN text arrives, not what the loop sees — otherwise there are two
 * divergent paths through the tool dispatcher and only one of them gets
 * exercised.
 *
 * The fiddly parts, and why they are here rather than inline in a fetch
 * handler: network chunks do not align with SSE frames (a frame can be split
 * mid-line, or several can arrive at once), and `tool_use` arguments come as
 * JSON string fragments that are only valid once the block closes. Both are
 * pure text handling, so both are testable without a socket.
 */

export interface StreamedContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface StreamedMessage {
    content: StreamedContentBlock[];
    stop_reason: string;
    usage?: Record<string, number>;
}

export interface SseAccumulator {
    /** Feed a decoded chunk of the response body. Chunk boundaries are free. */
    feed(chunk: string): void;
    /** The message assembled so far. */
    result(): StreamedMessage;
}

/**
 * `onTextDelta` fires for each fragment of assistant prose as it arrives —
 * that is the whole point of streaming here.
 */
export function createSseAccumulator(onTextDelta?: (delta: string) => void): SseAccumulator {
    const content: StreamedContentBlock[] = [];
    /** tool_use arguments, accumulated per index until the block closes. */
    const partialJson = new Map<number, string>();
    let stopReason = 'end_turn';
    let usage: Record<string, number> | undefined;
    let pending = '';

    const handleEvent = (payload: string) => {
        if (!payload || payload === '[DONE]') return;
        let evt: Record<string, unknown>;
        try {
            evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
            // Keep-alive comment or a frame we don't recognise. Dropping it is
            // correct — the alternative is failing a whole reply over noise.
            return;
        }
        const type = evt.type as string | undefined;
        const index = typeof evt.index === 'number' ? evt.index : 0;

        if (type === 'content_block_start') {
            const block = { ...(evt.content_block as StreamedContentBlock) };
            if (block.type === 'text') block.text = block.text ?? '';
            content[index] = block;
            if (block.type === 'tool_use') partialJson.set(index, '');
            return;
        }
        if (type === 'content_block_delta') {
            const delta = evt.delta as { type?: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                const block = content[index];
                if (block) block.text = (block.text ?? '') + delta.text;
                onTextDelta?.(delta.text);
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json);
            }
            return;
        }
        if (type === 'content_block_stop') {
            const block = content[index];
            const raw = partialJson.get(index);
            if (block?.type === 'tool_use') {
                try {
                    block.input = raw && raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
                } catch {
                    // Half-parsed arguments are worse than none: the tool would
                    // run with a plausible-looking but wrong subset. Empty input
                    // makes it fail where the failure can be seen.
                    block.input = {};
                }
            }
            partialJson.delete(index);
            return;
        }
        if (type === 'message_delta') {
            const delta = evt.delta as { stop_reason?: string } | undefined;
            if (delta?.stop_reason) stopReason = delta.stop_reason;
            if (evt.usage) usage = { ...usage, ...(evt.usage as Record<string, number>) };
            return;
        }
        if (type === 'error') {
            const err = evt.error as { message?: string } | undefined;
            throw new Error(err?.message || 'Anthropic stream error');
        }
    };

    return {
        feed(chunk: string) {
            pending += chunk;
            // Frames are separated by a blank line. Anything after the last
            // separator is an incomplete frame and waits for the next chunk.
            let split = pending.indexOf('\n\n');
            while (split !== -1) {
                const frame = pending.slice(0, split);
                pending = pending.slice(split + 2);
                for (const line of frame.split('\n')) {
                    if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
                }
                split = pending.indexOf('\n\n');
            }
        },
        result() {
            return { content: content.filter(Boolean), stop_reason: stopReason, ...(usage ? { usage } : {}) };
        },
    };
}
