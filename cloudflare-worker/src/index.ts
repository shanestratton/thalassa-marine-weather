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

/** Params we consume on the Worker side; everything else forwards to Deepgram. */
const WORKER_OWN_PARAMS = new Set(['apikey', 'ticket', 'token', 'access_token']);

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
        if (!ticket) return new Response('Unauthorized: missing ticket', { status: 401 });
        const ticketResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/consume_deepgram_proxy_ticket`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: env.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ p_ticket: ticket }),
        });
        const ticketValid = ticketResponse.ok ? ((await ticketResponse.json()) as boolean) : false;
        if (!ticketValid) {
            return new Response('Unauthorized: invalid or expired ticket', { status: 401 });
        }

        // ── 3. Build the upstream Deepgram URL ─────────────────────
        // Forward all client-supplied params (model, encoding, sample_rate,
        // keywords, endpointing, etc.) verbatim. Strip our own auth params.
        const upstreamParams = new URLSearchParams();
        for (const [k, v] of reqUrl.searchParams) {
            if (WORKER_OWN_PARAMS.has(k)) continue;
            upstreamParams.append(k, v);
        }
        const upstreamUrl = `${DEEPGRAM_BASE}?${upstreamParams.toString()}`;

        // ── 4. Open the upstream WebSocket via fetch upgrade ───────
        // Cloudflare Workers expose `response.webSocket` on responses
        // to fetch requests with `Upgrade: websocket`. Subprotocol
        // 'token' carries the Deepgram API key — Deepgram's documented
        // pattern for long-lived API keys, and works reliably from
        // server-side because there's no length-of-subprotocol-value
        // quirk like the WKWebView one.
        let upstreamResponse: Response;
        try {
            upstreamResponse = await fetch(upstreamUrl, {
                headers: {
                    Upgrade: 'websocket',
                    'Sec-WebSocket-Protocol': `token, ${env.DEEPGRAM_API_KEY}`,
                },
            });
        } catch (err) {
            const e = err as Error;
            const detail = `${e.name}: ${e.message}`;
            console.error(`[dg-proxy] upstream fetch threw: ${detail}`, e.stack);
            // Surface the actual error in the response body so the
            // skipper can see it client-side instead of just "502".
            return new Response(`Upstream fetch threw: ${detail}\nURL: ${upstreamUrl.slice(0, 200)}`, {
                status: 502,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        if (upstreamResponse.status !== 101) {
            const body = await upstreamResponse.text();
            console.error(`[dg-proxy] upstream status ${upstreamResponse.status}: ${body.slice(0, 200)}`);
            return new Response(
                `Upstream rejected upgrade: HTTP ${upstreamResponse.status}\nBody: ${body.slice(0, 200)}`,
                { status: 502, headers: { 'Content-Type': 'text/plain' } },
            );
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

        // ── 7. Bridge: client → upstream ───────────────────────────
        let clientChunks = 0;
        let clientBytes = 0;
        serverSocket.addEventListener('message', (ev) => {
            clientChunks++;
            const data = (ev as MessageEvent).data;
            if (data instanceof ArrayBuffer) {
                clientBytes += data.byteLength;
            }
            // Sample-log so the Worker tail can verify audio is
            // flowing without spamming on every chunk.
            if (clientChunks === 1 || clientChunks % 50 === 0) {
                const dataDesc =
                    typeof data === 'string'
                        ? `text:"${(data as string).slice(0, 60)}"`
                        : data instanceof ArrayBuffer
                          ? `binary:${data.byteLength}B`
                          : `unknown:${typeof data}`;
                console.log(`[dg-proxy] client→upstream chunk #${clientChunks} ${dataDesc}`);
            }
            try {
                upstream.send(data);
            } catch (err) {
                console.warn(`[dg-proxy] upstream send failed: ${(err as Error).message}`);
            }
        });

        // ── 8. Bridge: upstream → client ───────────────────────────
        let upstreamMessages = 0;
        upstream.addEventListener('message', (ev) => {
            upstreamMessages++;
            const data = (ev as MessageEvent).data;
            if (upstreamMessages <= 3 || upstreamMessages % 50 === 0) {
                const preview =
                    typeof data === 'string' ? data.slice(0, 200) : `<binary ${(data as ArrayBuffer).byteLength}B>`;
                console.log(`[dg-proxy] upstream→client msg #${upstreamMessages}: ${preview}`);
            }
            try {
                serverSocket.send(data);
            } catch (err) {
                console.warn(`[dg-proxy] client send failed: ${(err as Error).message}`);
            }
        });

        // ── 9. Lifecycle propagation ───────────────────────────────
        // Track whether either side has initiated close so we don't
        // re-propagate (which can keep the Worker alive past actual
        // session end and trigger Cloudflare's "code hung" error
        // when the runtime can't tell the session is really done).
        let closing = false;
        const closeBoth = (initiator: 'client' | 'upstream', ev: CloseEvent): void => {
            if (closing) return;
            closing = true;
            const c = ev.code;
            // RFC 6455: codes <1000, 1005, 1006 can't be sent in a
            // Close frame. Map to 1000 (normal) since we're explicitly
            // tearing down rather than reporting an error.
            const safeCode = c >= 1000 && c !== 1005 && c !== 1006 ? c : 1000;
            const safeReason = ev.reason || (initiator === 'upstream' ? `upstream closed ${c}` : '');
            if (initiator === 'upstream') {
                // Tell client what happened upstream BEFORE we close their side.
                try {
                    serverSocket.send(
                        JSON.stringify({
                            type: 'UpstreamClose',
                            code: c,
                            reason: ev.reason || '',
                            ts: Date.now(),
                        }),
                    );
                } catch {
                    /* client may already be closed */
                }
                try {
                    serverSocket.close(safeCode, safeReason);
                } catch {
                    /* ignore */
                }
            } else {
                try {
                    upstream.close(safeCode, safeReason);
                } catch {
                    /* ignore */
                }
            }
        };

        upstream.addEventListener('close', (ev) => {
            const closeEv = ev as CloseEvent;
            console.log(
                `[dg-proxy] upstream closed code=${closeEv.code} reason="${closeEv.reason}" | session: ` +
                    `client→upstream chunks=${clientChunks} bytes=${clientBytes}, ` +
                    `upstream→client msgs=${upstreamMessages}`,
            );
            closeBoth('upstream', closeEv);
        });

        upstream.addEventListener('error', () => {
            console.error('[dg-proxy] upstream error');
            try {
                serverSocket.send(JSON.stringify({ type: 'UpstreamError', ts: Date.now() }));
            } catch {
                /* ignore */
            }
        });

        serverSocket.addEventListener('close', (ev) => {
            const closeEv = ev as CloseEvent;
            console.log(`[dg-proxy] client closed code=${closeEv.code}`);
            closeBoth('client', closeEv);
        });

        serverSocket.addEventListener('error', () => {
            console.error('[dg-proxy] client error');
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
