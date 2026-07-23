/**
 * thalassa-deepgram-proxy — Cloudflare Worker that bridges iOS WKWebView
 * WebSocket clients to Deepgram's /v1/listen streaming endpoint.
 *
 * Why this exists:
 *
 *   iOS WKWebView's WebSocket implementation can't reliably open a
 *   direct WebSocket to api.deepgram.com — every variant of the
 *   Sec-WebSocket-Protocol auth (token+JWT, token+API-key, bearer+JWT)
 *   fails the upgrade with code=1006 before Deepgram sees the request.
 *   Confirmed empirical iOS WebKit quirk; works fine from desktop.
 *
 *   We tried proxying through a Supabase Edge Function (Deno Deploy).
 *   The proxy itself works for desktop clients (5+ seconds of audio,
 *   clean transcripts, clean close). On iOS the upstream Deepgram WS
 *   dies after ~1 second of audio with code=0 — Deno's runtime can't
 *   sustain the outbound WebSocket under iOS-paced 20-50ms packet
 *   bursts. Supabase Edge Functions are designed for short-lived
 *   stateless HTTP, not high-frequency real-time bridging.
 *
 *   Cloudflare Workers were explicitly engineered for this case:
 *   the WebSocketPair API plus fetch()-based upstream upgrade
 *   handle hundreds of bridged messages per second without breaking
 *   a sweat, and the request stays alive for the full WS session
 *   without the Deno-style execution-context tear-down.
 *
 * Architecture:
 *
 *   iOS ──wss──> Worker ──wss──> api.deepgram.com
 *                  (WebSocketPair)   (token subprotocol w/ API key)
 *
 *   Auth: client passes a 60-second, one-use proxy ticket. The Worker
 *   atomically consumes it through a restricted Supabase RPC before upgrade.
 *   Worker holds the Deepgram API key in env.DEEPGRAM_API_KEY and
 *   never exposes it to the client.
 *
 * Required Worker secrets (wrangler secret put NAME):
 *   DEEPGRAM_API_KEY    — long-lived 40-char key from Deepgram dashboard
 *   SUPABASE_ANON_KEY   — same anon JWT iOS bundles for Supabase auth
 *
 * Diagnostics:
 *   The Worker emits ProxyHello on connect and UpstreamOpen / UpstreamClose
 *   / UpstreamError JSON messages so the iOS debug strip can show the
 *   bidirectional state of the bridge.
 */

import {
    boundedDeepgramParams,
    frameByteLength,
    isProxyTicket,
    MAX_FRAME_BYTES,
    MAX_SESSION_MS,
    MAX_UPSTREAM_BYTES,
    TICKET_LOOKUP_MS,
    UPSTREAM_HANDSHAKE_MS,
    validateClientFrame,
} from './policy';

export interface Env {
    DEEPGRAM_API_KEY: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_URL: string;
}

// Cloudflare Workers' fetch API requires https:// for WebSocket
// upgrades — the protocol switch happens via the `Upgrade: websocket`
// request header, not via the URL scheme. Using `wss://` causes
// "Fetch API cannot load: wss://..." TypeError immediately.
const DEEPGRAM_BASE = 'https://api.deepgram.com/v1/listen';

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        // ── 1. Validate this is a WebSocket upgrade request ────────
        const upgrade = req.headers.get('upgrade')?.toLowerCase();
        if (upgrade !== 'websocket') {
            return new Response('Expected WebSocket upgrade', {
                status: 426,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        // ── 2. Auth: consume a short-lived, one-use proxy ticket ──
        const reqUrl = new URL(req.url);
        const ticket = reqUrl.searchParams.get('ticket');
        if (!env.SUPABASE_ANON_KEY || !env.SUPABASE_URL) {
            return new Response('Worker not configured: Supabase settings missing', { status: 500 });
        }
        if (!env.DEEPGRAM_API_KEY) {
            return new Response('Worker not configured: DEEPGRAM_API_KEY missing', { status: 500 });
        }
        if (!isProxyTicket(ticket)) return new Response('Unauthorized', { status: 401 });

        // Validate the complete speech contract before consuming the one-use
        // ticket. Unknown/duplicate parameters must never become an arbitrary
        // Deepgram billing surface.
        const upstreamParams = boundedDeepgramParams(reqUrl);
        if (!upstreamParams) return new Response('Invalid speech configuration', { status: 400 });

        let supabaseOrigin: string;
        try {
            const configured = new URL(env.SUPABASE_URL);
            if (configured.protocol !== 'https:' || configured.username || configured.password) throw new Error();
            supabaseOrigin = configured.origin;
        } catch {
            return new Response('Worker not configured: invalid Supabase URL', { status: 500 });
        }

        const ticketAbort = new AbortController();
        const ticketTimer = setTimeout(() => ticketAbort.abort(), TICKET_LOOKUP_MS);
        let ticketValid = false;
        try {
            const ticketResponse = await fetch(`${supabaseOrigin}/rest/v1/rpc/consume_deepgram_proxy_ticket`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: env.SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({ p_ticket: ticket }),
                signal: ticketAbort.signal,
            });
            const body = await readBoundedText(ticketResponse, 16);
            ticketValid = ticketResponse.ok && body?.trim() === 'true';
        } catch (error) {
            console.error('[dg-proxy] ticket validation failed', error);
        } finally {
            clearTimeout(ticketTimer);
        }
        if (!ticketValid) {
            return new Response('Unauthorized', { status: 401 });
        }

        // ── 3. Build the upstream Deepgram URL ─────────────────────
        const upstreamUrl = `${DEEPGRAM_BASE}?${upstreamParams.toString()}`;

        // ── 4. Open the upstream WebSocket via fetch upgrade ───────
        // Cloudflare Workers expose `response.webSocket` on responses
        // to fetch requests with `Upgrade: websocket`. Subprotocol
        // 'token' carries the Deepgram API key — Deepgram's documented
        // pattern for long-lived API keys, and works reliably from
        // server-side because there's no length-of-subprotocol-value
        // quirk like the WKWebView one.
        let upstreamResponse: Response;
        const upstreamAbort = new AbortController();
        const upstreamTimer = setTimeout(() => upstreamAbort.abort(), UPSTREAM_HANDSHAKE_MS);
        try {
            upstreamResponse = await fetch(upstreamUrl, {
                headers: {
                    Upgrade: 'websocket',
                    'Sec-WebSocket-Protocol': `token, ${env.DEEPGRAM_API_KEY}`,
                },
                signal: upstreamAbort.signal,
            });
        } catch (err) {
            const e = err as Error;
            const detail = `${e.name}: ${e.message}`;
            console.error(`[dg-proxy] upstream fetch threw: ${detail}`, e.stack);
            return new Response('Voice upstream unavailable', {
                status: 502,
                headers: { 'Content-Type': 'text/plain' },
            });
        } finally {
            clearTimeout(upstreamTimer);
        }

        if (upstreamResponse.status !== 101) {
            console.error(`[dg-proxy] upstream status ${upstreamResponse.status}`);
            void upstreamResponse.body?.cancel();
            return new Response('Voice upstream unavailable', {
                status: 502,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        const upstream = upstreamResponse.webSocket;
        if (!upstream) {
            return new Response('Upstream upgrade succeeded but webSocket missing', { status: 502 });
        }

        // ── 5. Build the client side via WebSocketPair ─────────────
        // Workers create a pair of WebSockets joined back-to-back. We
        // accept the server side and bridge it to the upstream; the
        // client side goes back in the 101 response to the iOS caller.
        const pair = new WebSocketPair();
        const [clientSocket, serverSocket] = Object.values(pair) as [WebSocket, WebSocket];

        // accept() takes ownership of the server end so this Worker
        // stays alive for the WebSocket lifecycle (Workers are
        // explicitly designed to support this — no waitUntil needed).
        serverSocket.accept();
        upstream.accept();

        // ── 6. Diagnostics: announce ourselves to the client ───────
        // ProxyHello = the Worker is reachable.
        // UpstreamOpen = the Deepgram side is up. fetch() returning 101
        //   already proves upstream is connected, so we send this
        //   immediately rather than wait for an open event (Cloudflare's
        //   WebSocket from fetch is in OPEN state by the time accept()
        //   returns).
        try {
            serverSocket.send(JSON.stringify({ type: 'ProxyHello', ts: Date.now() }));
            serverSocket.send(JSON.stringify({ type: 'UpstreamOpen', ts: Date.now() }));
        } catch (err) {
            console.warn(`[dg-proxy] hello send failed: ${(err as Error).message}`);
        }

        // ── 7. Bounded bridge + lifecycle propagation ─────────────
        let clientChunks = 0;
        let clientBytes = 0;
        let upstreamMessages = 0;
        let upstreamBytes = 0;
        let closing = false;
        let sessionTimer: ReturnType<typeof setTimeout> | null = null;

        const safeCloseCode = (code: number): number =>
            code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000;
        const closeBoth = (code: number, reason: string): void => {
            if (closing) return;
            closing = true;
            if (sessionTimer) clearTimeout(sessionTimer);
            sessionTimer = null;
            const safeCode = safeCloseCode(code);
            // A short ASCII reason stays inside the RFC 6455 123-byte cap.
            const safeReason = reason.replace(/[^\x20-\x7e]/g, '').slice(0, 100);
            try {
                serverSocket.close(safeCode, safeReason);
            } catch {
                /* already closed */
            }
            try {
                upstream.close(safeCode, safeReason);
            } catch {
                /* already closed */
            }
        };
        sessionTimer = setTimeout(() => closeBoth(1000, 'session limit reached'), MAX_SESSION_MS);

        serverSocket.addEventListener('message', (ev) => {
            if (closing) return;
            const decision = validateClientFrame((ev as MessageEvent).data, clientBytes);
            if (!decision.accepted) {
                closeBoth(decision.closeCode, decision.reason);
                return;
            }
            clientChunks += 1;
            clientBytes += decision.bytes;
            if (clientChunks === 1 || clientChunks % 50 === 0) {
                console.log(
                    `[dg-proxy] client→upstream chunk #${clientChunks} bytes=${decision.bytes} total=${clientBytes}`,
                );
            }
            try {
                upstream.send(decision.data);
            } catch (err) {
                console.warn(`[dg-proxy] upstream send failed: ${(err as Error).message}`);
                closeBoth(1011, 'upstream send failed');
            }
        });

        upstream.addEventListener('message', (ev) => {
            if (closing) return;
            const data = (ev as MessageEvent).data;
            const bytes = frameByteLength(data);
            if (bytes == null || bytes > MAX_FRAME_BYTES || upstreamBytes > MAX_UPSTREAM_BYTES - bytes) {
                closeBoth(1009, 'upstream data limit exceeded');
                return;
            }
            upstreamMessages += 1;
            upstreamBytes += bytes;
            if (upstreamMessages <= 3 || upstreamMessages % 50 === 0) {
                console.log(
                    `[dg-proxy] upstream→client msg #${upstreamMessages} bytes=${bytes} total=${upstreamBytes}`,
                );
            }
            try {
                serverSocket.send(data as ArrayBuffer | string);
            } catch (err) {
                console.warn(`[dg-proxy] client send failed: ${(err as Error).message}`);
                closeBoth(1011, 'client send failed');
            }
        });

        upstream.addEventListener('close', (ev) => {
            const closeEv = ev as CloseEvent;
            console.log(
                `[dg-proxy] upstream closed code=${closeEv.code} | session: ` +
                    `client→upstream chunks=${clientChunks} bytes=${clientBytes}, ` +
                    `upstream→client msgs=${upstreamMessages} bytes=${upstreamBytes}`,
            );
            if (!closing) {
                try {
                    serverSocket.send(
                        JSON.stringify({
                            type: 'UpstreamClose',
                            code: closeEv.code,
                            reason: closeEv.reason.slice(0, 120),
                            ts: Date.now(),
                        }),
                    );
                } catch {
                    /* client may already be closed */
                }
            }
            closeBoth(closeEv.code, 'upstream closed');
        });

        upstream.addEventListener('error', () => {
            console.error('[dg-proxy] upstream error');
            if (!closing) {
                try {
                    serverSocket.send(JSON.stringify({ type: 'UpstreamError', ts: Date.now() }));
                } catch {
                    /* ignore */
                }
            }
            closeBoth(1011, 'upstream error');
        });

        serverSocket.addEventListener('close', (ev) => {
            const closeEv = ev as CloseEvent;
            console.log(`[dg-proxy] client closed code=${closeEv.code}`);
            closeBoth(closeEv.code, 'client closed');
        });

        serverSocket.addEventListener('error', () => {
            console.error('[dg-proxy] client error');
            closeBoth(1011, 'client error');
        });

        // ── 10. Return the client end of the pair to the caller ────
        // Workers stay alive for the WebSocket lifecycle automatically
        // — once both sockets close, the runtime cleans up. The single
        // `closing` flag above prevents the close handlers from
        // bouncing events back and forth, which is what was triggering
        // the "Worker's code had hung" error in earlier deploys.
        return new Response(null, {
            status: 101,
            webSocket: clientSocket,
        });
    },
} satisfies ExportedHandler<Env>;
