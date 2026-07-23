// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
    upgradeWebSocket: (req: Request) => { socket: WebSocket; response: Response };
};

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * deepgram-ws-proxy — bridge a client WebSocket to Deepgram's
 * /v1/listen streaming endpoint, with the API key applied server-side.
 *
 * Why this exists: iOS WKWebView's WebSocket implementation can't pass
 * multi-element `Sec-WebSocket-Protocol` arrays to Deepgram cleanly —
 * the upgrade dies with code=1006 reason="ws error" before Deepgram
 * sees the request. Direct connection works fine on desktop browsers
 * but not on iOS (which IS our target platform).
 *
 * Solution: iOS connects to this function via the Supabase WebSocket
 * gateway (which iOS handles fine, same as Realtime). The proxy
 * opens a WebSocket to api.deepgram.com using the long-lived API key
 * via Authorization header (server-side, not subject to browser
 * subprotocol limits) and bridges bytes both ways.
 *
 * Connection lifecycle:
 *   1. Client opens wss://<project>.supabase.co/functions/v1/deepgram-ws-proxy?<dg_params>
 *      Auth: Supabase anon JWT via URL param (gateway-level auth)
 *   2. We accept the upgrade via Deno.upgradeWebSocket
 *   3. We open a WebSocket to wss://api.deepgram.com/v1/listen?<dg_params>
 *      Auth: Authorization: Token <DEEPGRAM_API_KEY> (server header)
 *   4. Proxy events bidirectionally:
 *      - Client → Deepgram: binary audio frames + JSON control messages
 *        (CloseStream, KeepAlive)
 *      - Deepgram → Client: JSON transcript messages
 *   5. Either side closing → close the other side
 *
 * Required Supabase secret:
 *   DEEPGRAM_API_KEY
 */

const DEEPGRAM_BASE = 'wss://api.deepgram.com/v1/listen';
const MAX_SESSION_MS = 5 * 60 * 1000;
const UPSTREAM_HANDSHAKE_MS = 10_000;
const MAX_CLIENT_BYTES = 25_000_000;
const MAX_FRAME_BYTES = 1_000_000;
const MAX_EARLY_BUFFER_BYTES = 2_000_000;
const MAX_CONTROL_BYTES = 4_096;
const ALLOWED_CONTROL_TYPES = new Set(['KeepAlive', 'CloseStream', 'Finalize']);

function boundedDeepgramParams(incoming: URL): URLSearchParams | null {
    if (incoming.search.length > 2_048) return null;
    const allowedKeys = new Set([
        'model',
        'encoding',
        'sample_rate',
        'channels',
        'interim_results',
        'smart_format',
        'endpointing',
        'language',
        'vad_events',
        'punctuate',
        'keyterm',
        'apikey',
        'ticket',
        'token',
        'access_token',
    ]);
    for (const key of incoming.searchParams.keys()) {
        if (!allowedKeys.has(key)) return null;
    }

    const sampleRate = Number(incoming.searchParams.get('sample_rate'));
    const endpointing = Number(incoming.searchParams.get('endpointing'));
    if (
        incoming.searchParams.get('model') !== 'nova-3' ||
        incoming.searchParams.get('encoding') !== 'linear16' ||
        !Number.isInteger(sampleRate) ||
        sampleRate < 8_000 ||
        sampleRate > 48_000 ||
        incoming.searchParams.get('channels') !== '1' ||
        !Number.isInteger(endpointing) ||
        endpointing < 100 ||
        endpointing > 2_000 ||
        incoming.searchParams.get('language') !== 'en-AU'
    ) {
        return null;
    }
    for (const flag of ['interim_results', 'smart_format', 'vad_events', 'punctuate']) {
        if (incoming.searchParams.get(flag) !== 'true') return null;
    }

    const keyterms = incoming.searchParams.getAll('keyterm');
    if (
        keyterms.length > 10 ||
        keyterms.some((term) => term.length < 1 || term.length > 64 || !/^[\p{L}\p{N} .'-]+$/u.test(term))
    ) {
        return null;
    }

    const forwarded = new URLSearchParams({
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: String(endpointing),
        language: 'en-AU',
        vad_events: 'true',
        punctuate: 'true',
    });
    for (const term of keyterms) forwarded.append('keyterm', term);
    return forwarded;
}

Deno.serve(async (req: Request) => {
    const upgrade = req.headers.get('upgrade')?.toLowerCase() ?? '';
    if (upgrade !== 'websocket') {
        return new Response(JSON.stringify({ error: 'expected WebSocket upgrade' }), {
            status: 426,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const apiKey = Deno.env.get('DEEPGRAM_API_KEY');
    if (!apiKey) {
        console.error('[dg-proxy] DEEPGRAM_API_KEY is not configured');
        return new Response(JSON.stringify({ error: 'Voice service is not configured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const incoming = new URL(req.url);
    const ticket = incoming.searchParams.get('ticket');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!ticket || !/^[a-f0-9]{64}$/.test(ticket) || !supabaseUrl || !anonKey) {
        return new Response(JSON.stringify({ error: 'Missing proxy authorization' }), { status: 401 });
    }
    const forwarded = boundedDeepgramParams(incoming);
    if (!forwarded) {
        return new Response(JSON.stringify({ error: 'Invalid speech configuration' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    const ticketClient = createClient(supabaseUrl, anonKey);
    const { data: ticketValid, error: ticketError } = await ticketClient.rpc('consume_deepgram_proxy_ticket', {
        p_ticket: ticket,
    });
    if (ticketError || !ticketValid) {
        return new Response(JSON.stringify({ error: 'Invalid or expired proxy ticket' }), { status: 401 });
    }

    const dgUrl = `${DEEPGRAM_BASE}?${forwarded.toString()}`;
    console.log('[dg-proxy] opening bounded nova-3 upstream');

    // Accept the client upgrade FIRST so we can echo open/close cleanly
    // even if the upstream connection has trouble.
    const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
    // CRITICAL: Deno's upgradeWebSocket defaults binaryType to 'blob'.
    // We need 'arraybuffer' so audio frames forward as raw bytes
    // through `upstreamSocket.send()` without an extra Blob→ArrayBuffer
    // round-trip that loses the binary content type on the upstream.
    clientSocket.binaryType = 'arraybuffer';

    let upstreamSocket: WebSocket | null = null;
    let upstreamReady = false;
    let clientChunksReceived = 0;
    let clientBytesReceived = 0;
    let upstreamMessagesReceived = 0;
    let earlyBufferBytes = 0;
    let upstreamHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
    const closeBoth = (code: number, reason: string): void => {
        if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
            try {
                clientSocket.close(code, reason);
            } catch {
                // Ignore close races.
            }
        }
        if (
            upstreamSocket &&
            (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING)
        ) {
            try {
                upstreamSocket.close(code, reason);
            } catch {
                // Ignore close races.
            }
        }
    };
    const sessionTimer = setTimeout(() => closeBoth(1000, 'session limit reached'), MAX_SESSION_MS);
    /**
     * Buffer audio chunks that arrive on the client socket BEFORE the
     * upstream has finished handshaking. iOS sends the first PCM chunk
     * within ~50ms of connecting; the Deepgram handshake takes 100-300ms.
     * Without buffering we'd drop those early chunks and Deepgram would
     * never see the start of the utterance.
     */
    const earlyBuffer: (ArrayBuffer | string)[] = [];

    clientSocket.addEventListener('open', () => {
        console.log('[dg-proxy] client socket open');
        // Diagnostic: immediately send a hello ping to the client. If
        // the client logs receipt of this, we know proxy→client
        // forwarding works and any later silence is the upstream
        // (Deepgram) side. If the client never sees this, the
        // bidirectional WS is broken in the iOS direction.
        try {
            clientSocket.send(JSON.stringify({ type: 'ProxyHello', ts: Date.now() }));
        } catch (err) {
            console.warn('[dg-proxy] hello send failed:', (err as Error).message);
        }
    });

    // Open upstream — iOS doesn't see this directly. Standard browser
    // WebSocket subprotocol carries the API key. Server-side has no
    // length limits on the Sec-WebSocket-Protocol value, so the
    // long-lived 40-char key fits trivially. Deno's WebSocket honours
    // the same browser-style array form for subprotocols.
    try {
        upstreamSocket = new WebSocket(dgUrl, ['token', apiKey]);
        upstreamSocket.binaryType = 'arraybuffer';
        upstreamHandshakeTimer = setTimeout(
            () => closeBoth(1011, 'upstream handshake timed out'),
            UPSTREAM_HANDSHAKE_MS,
        );
    } catch (err) {
        console.error('[dg-proxy] upstream ctor failed:', (err as Error).message);
        try {
            clientSocket.close(1011, 'upstream ctor failed');
        } catch {
            /* ignore */
        }
        return response;
    }

    upstreamSocket.addEventListener('open', () => {
        console.log('[dg-proxy] upstream open');
        if (upstreamHandshakeTimer) clearTimeout(upstreamHandshakeTimer);
        upstreamHandshakeTimer = null;
        upstreamReady = true;
        // Tell the client the upstream is up — diagnostic, lets the
        // iOS debug strip show whether Deepgram itself ever connected.
        try {
            clientSocket.send(JSON.stringify({ type: 'UpstreamOpen', ts: Date.now() }));
        } catch {
            /* ignore */
        }
        // Flush anything we buffered while upstream was handshaking.
        for (const chunk of earlyBuffer) {
            try {
                upstreamSocket?.send(chunk);
            } catch (err) {
                console.warn('[dg-proxy] flush send failed:', (err as Error).message);
            }
        }
        earlyBuffer.length = 0;
        earlyBufferBytes = 0;
    });

    upstreamSocket.addEventListener('message', (ev: MessageEvent) => {
        upstreamMessagesReceived++;
        const upstreamSize =
            typeof ev.data === 'string'
                ? new TextEncoder().encode(ev.data).byteLength
                : ev.data instanceof ArrayBuffer
                  ? ev.data.byteLength
                  : MAX_FRAME_BYTES + 1;
        if (upstreamSize > MAX_FRAME_BYTES) {
            closeBoth(1009, 'upstream frame too large');
            return;
        }
        // Sample-log first 5 messages (so we can see the metadata frame
        // and the first transcript) plus every 50th after that.
        if (upstreamMessagesReceived <= 5 || upstreamMessagesReceived % 50 === 0) {
            const preview = typeof ev.data === 'string' ? ev.data.slice(0, 200) : `<binary ${ev.data.byteLength}B>`;
            console.log(`[dg-proxy] upstream msg #${upstreamMessagesReceived}: ${preview}`);
        }
        // Pass Deepgram → client. Deepgram only sends JSON text frames
        // (transcript results, metadata, errors) but we forward the
        // event data as-is regardless of type.
        if (clientSocket.readyState === WebSocket.OPEN) {
            try {
                clientSocket.send(ev.data);
            } catch (err) {
                console.warn('[dg-proxy] client send failed:', (err as Error).message);
            }
        }
    });

    upstreamSocket.addEventListener('close', (ev: CloseEvent) => {
        if (upstreamHandshakeTimer) clearTimeout(upstreamHandshakeTimer);
        upstreamHandshakeTimer = null;
        clearTimeout(sessionTimer);
        console.log(`[dg-proxy] upstream closed code=${ev.code} reason="${ev.reason}" ready=${upstreamReady}`);
        // Tell the client the upstream just closed. Send BEFORE we
        // close the client socket so the iOS debug strip sees the
        // signal. Critical diagnostic when upstream silently dies.
        try {
            clientSocket.send(
                JSON.stringify({
                    type: 'UpstreamClose',
                    code: ev.code,
                    reason: ev.reason || '',
                    everOpened: upstreamReady,
                    ts: Date.now(),
                }),
            );
        } catch {
            /* ignore */
        }
        if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
            try {
                // Codes 1005, 1006 (reserved) and 0 (no close frame)
                // can't be sent in a Close frame. Map any of them to
                // 1011 (server error) so the client gets a real signal
                // instead of a silent TCP-RST.
                const safeCode = ev.code < 1000 || ev.code === 1005 || ev.code === 1006 ? 1011 : ev.code;
                const safeReason = ev.reason || `upstream closed ${ev.code}`;
                clientSocket.close(safeCode, safeReason);
            } catch (err) {
                console.warn('[dg-proxy] client close failed:', (err as Error).message);
            }
        }
    });

    upstreamSocket.addEventListener('error', () => {
        console.error('[dg-proxy] upstream error');
        try {
            clientSocket.send(JSON.stringify({ type: 'UpstreamError', ts: Date.now() }));
        } catch {
            /* ignore */
        }
    });

    clientSocket.addEventListener('message', (ev: MessageEvent) => {
        // Pass client → Deepgram. ev.data is ArrayBuffer (audio) or
        // string (control messages like CloseStream).
        clientChunksReceived++;
        const frameBytes =
            typeof ev.data === 'string'
                ? new TextEncoder().encode(ev.data).byteLength
                : ev.data instanceof ArrayBuffer
                  ? ev.data.byteLength
                  : MAX_FRAME_BYTES + 1;
        if (frameBytes > MAX_FRAME_BYTES || clientBytesReceived + frameBytes > MAX_CLIENT_BYTES) {
            closeBoth(1009, 'audio limit exceeded');
            return;
        }
        if (typeof ev.data === 'string') {
            if (frameBytes > MAX_CONTROL_BYTES) {
                closeBoth(1008, 'control message too large');
                return;
            }
            try {
                const control = JSON.parse(ev.data) as { type?: unknown };
                if (typeof control.type !== 'string' || !ALLOWED_CONTROL_TYPES.has(control.type)) {
                    closeBoth(1008, 'invalid control message');
                    return;
                }
            } catch {
                closeBoth(1008, 'invalid control message');
                return;
            }
        }
        clientBytesReceived += frameBytes;
        // Diagnostic: log first chunk + every 100th to verify audio
        // is actually flowing through. If clientChunksReceived stays
        // at 0 we know iOS isn't sending audio at all; if it's >0 but
        // upstreamMessagesReceived stays low (just the Metadata frame)
        // we know Deepgram is receiving audio but can't decode it.
        if (clientChunksReceived === 1 || clientChunksReceived % 100 === 0) {
            const dataType =
                typeof ev.data === 'string'
                    ? `text:"${(ev.data as string).slice(0, 60)}"`
                    : ev.data instanceof ArrayBuffer
                      ? `binary:${ev.data.byteLength}B`
                      : `unknown:${typeof ev.data}`;
            console.log(`[dg-proxy] client chunk #${clientChunksReceived} ${dataType} (total ${clientBytesReceived}B)`);
        }
        if (!upstreamReady) {
            if (earlyBufferBytes + frameBytes <= MAX_EARLY_BUFFER_BYTES) {
                earlyBuffer.push(ev.data);
                earlyBufferBytes += frameBytes;
            } else {
                closeBoth(1009, 'handshake buffer exceeded');
            }
            return;
        }
        if (upstreamSocket && upstreamSocket.readyState === WebSocket.OPEN) {
            try {
                upstreamSocket.send(ev.data);
            } catch (err) {
                console.warn('[dg-proxy] upstream send failed:', (err as Error).message);
            }
        }
    });

    clientSocket.addEventListener('close', (ev: CloseEvent) => {
        clearTimeout(sessionTimer);
        if (upstreamHandshakeTimer) clearTimeout(upstreamHandshakeTimer);
        upstreamHandshakeTimer = null;
        console.log(
            `[dg-proxy] client closed code=${ev.code} | session-summary: ` +
                `client→proxy chunks=${clientChunksReceived} bytes=${clientBytesReceived}, ` +
                `upstream→client msgs=${upstreamMessagesReceived}`,
        );
        if (upstreamSocket && upstreamSocket.readyState === WebSocket.OPEN) {
            try {
                upstreamSocket.close(ev.code, ev.reason);
            } catch {
                /* ignore */
            }
        }
    });

    clientSocket.addEventListener('error', () => {
        console.error('[dg-proxy] client error');
    });

    return response;
}); // Deno.serve handler — Deno keeps the WS alive after response returns.
