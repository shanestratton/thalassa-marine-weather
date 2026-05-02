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
 *   Auth: client passes the Supabase anon JWT as ?apikey= URL param.
 *   Worker compares to env.SUPABASE_ANON_KEY (set as Worker secret) —
 *   same trust boundary as our other Supabase-fronted endpoints.
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
}

const DEEPGRAM_BASE = 'wss://api.deepgram.com/v1/listen';

/** Params we consume on the Worker side; everything else forwards to Deepgram. */
const WORKER_OWN_PARAMS = new Set(['apikey', 'token', 'access_token']);

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

        // ── 2. Auth: client must present the Supabase anon key ─────
        const reqUrl = new URL(req.url);
        const clientKey = reqUrl.searchParams.get('apikey');
        if (!env.SUPABASE_ANON_KEY) {
            return new Response('Worker not configured: SUPABASE_ANON_KEY missing', { status: 500 });
        }
        if (!env.DEEPGRAM_API_KEY) {
            return new Response('Worker not configured: DEEPGRAM_API_KEY missing', { status: 500 });
        }
        // Constant-time-ish comparison. The keys are public anon JWTs so
        // timing leaks aren't security-critical, but no reason to be
        // sloppy when the cost is one extra line.
        if (clientKey !== env.SUPABASE_ANON_KEY) {
            return new Response('Unauthorized: invalid apikey', { status: 401 });
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
            console.error(`[dg-proxy] upstream fetch threw: ${(err as Error).message}`);
            return new Response('Upstream connection failed', { status: 502 });
        }

        if (upstreamResponse.status !== 101) {
            const body = await upstreamResponse.text();
            console.error(`[dg-proxy] upstream status ${upstreamResponse.status}: ${body.slice(0, 200)}`);
            return new Response(`Upstream rejected upgrade: ${upstreamResponse.status}`, { status: 502 });
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
        upstream.addEventListener('close', (ev) => {
            const closeEv = ev as CloseEvent;
            console.log(
                `[dg-proxy] upstream closed code=${closeEv.code} reason="${closeEv.reason}" | session: ` +
                    `client→upstream chunks=${clientChunks} bytes=${clientBytes}, ` +
                    `upstream→client msgs=${upstreamMessages}`,
            );
            // Tell the client what happened before we close their side.
            try {
                serverSocket.send(
                    JSON.stringify({
                        type: 'UpstreamClose',
                        code: closeEv.code,
                        reason: closeEv.reason || '',
                        ts: Date.now(),
                    }),
                );
            } catch {
                /* ignore */
            }
            // RFC 6455 reserves codes <1000, 1005, 1006 — they can't be
            // sent in a Close frame. Map any of those to 1011 so the
            // client gets a clean signal instead of a silent TCP-RST.
            const c = closeEv.code;
            const safeCode = c < 1000 || c === 1005 || c === 1006 ? 1011 : c;
            const safeReason = closeEv.reason || `upstream closed ${c}`;
            try {
                serverSocket.close(safeCode, safeReason);
            } catch {
                /* ignore */
            }
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
            try {
                upstream.close(
                    closeEv.code >= 1000 && closeEv.code !== 1005 && closeEv.code !== 1006 ? closeEv.code : 1000,
                    closeEv.reason || '',
                );
            } catch {
                /* ignore */
            }
        });

        serverSocket.addEventListener('error', () => {
            console.error('[dg-proxy] client error');
        });

        // ── 10. Return the client end of the pair to the caller ────
        return new Response(null, {
            status: 101,
            webSocket: clientSocket,
        });
    },
} satisfies ExportedHandler<Env>;
