/**
 * deepgramRecognizer — streaming STT via Deepgram's WebSocket API.
 *
 * Replaces Apple SFSpeechRecognizer as the primary fast-path. Apple SR
 * remains the fallback when Deepgram is unreachable; ElevenLabs Scribe
 * is the audio-blob fallback below that.
 *
 * Why we moved off Apple SR as primary:
 *   - Apple's per-device speech-recognition rate limit ("The quota has
 *     been exceeded.") tripped on the skipper after ~3 conversations
 *     in a row during testing. Resets after 30-60min of cooldown but
 *     bricks the voice console mid-passage.
 *   - Marine vocabulary recognition was patchy ("Calypso" → "calypto",
 *     "over" sometimes dropped on accent).
 *   - On-device privacy gain is meaningful but the skipper has
 *     deprioritised "data leaves the boat" as a constraint.
 *
 * Why Deepgram over alternatives:
 *   - Streams partial transcripts over WebSocket — same UX surface as
 *     Apple SR, so the OVER auto-send gesture survives unchanged.
 *   - Nova-3 model is sharper than Apple's offline model on accented
 *     English and out-of-vocabulary proper nouns.
 *   - Per-account rate limits, not per-device, so multiple voice
 *     sessions in a row don't lock anyone out.
 *   - `keywords` parameter lets us boost recognition of "Calypso" and
 *     "over" — the two words we care about most for the gesture.
 *
 * Architecture:
 *   getUserMedia → AudioContext → AudioWorklet (Float32 → Int16 PCM)
 *                                → WebSocket binary frames
 *                                → Deepgram /v1/listen
 *                                → JSON {is_final, transcript} messages
 *                                → onPartial / onFirstPartial callbacks
 *
 * Auth: ephemeral token from /functions/v1/deepgram-token (60s TTL),
 * passed via Sec-WebSocket-Protocol because browsers can't set the
 * Authorization header on WebSockets.
 */

import { Capacitor } from '@capacitor/core';

// ── Module-level config ────────────────────────────────────────────────

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

/**
 * Deepgram model. Nova-3 is the latest as of mid-2026, with sharply
 * better accuracy on accented English and noisy environments than the
 * older Nova-2. If we ever need to roll back for cost reasons, swap to
 * `nova-2`; the API contract is identical.
 */
const DEEPGRAM_MODEL = 'nova-3';

/**
 * Endpointing window. Deepgram waits this many ms of silence before
 * emitting a `speech_final` event. 300ms matches a natural conversational
 * pause without cutting people off mid-sentence. The OVER gesture fires
 * on partials regardless, so this only affects the auto-flush behaviour
 * if the skipper trails off without saying anything.
 */
const ENDPOINTING_MS = 300;

/**
 * Words to boost recognition of via Deepgram's `keywords` parameter.
 * Weight `:2` is roughly "twice as likely as a generic word of the same
 * acoustic profile". We boost "Calypso" because it's a non-English
 * proper noun that Nova-3 wouldn't otherwise know, and "over" because
 * the auto-send gesture depends on catching it reliably at the end of
 * an utterance even with mumbled enunciation.
 */
const KEYWORDS = [
    { word: 'Calypso', boost: 2 },
    { word: 'over', boost: 1.5 },
];

/**
 * Cleanup ceiling. Each teardown step (close WS, stop tracks, suspend
 * AudioContext) is bounded so a stuck native bridge can't lock the
 * voice console. Matches the speechRecognizer wrapper pattern.
 */
const CLEANUP_TIMEOUT_MS = 1500;

/**
 * How long to wait for Deepgram's final transcript after we send
 * CloseStream on stop(). Deepgram processes any in-flight audio then
 * emits a final result; if it doesn't come back inside this budget
 * we proceed with whatever we have. 1200ms is generous — typical
 * flush is sub-200ms.
 */
const FINAL_FLUSH_TIMEOUT_MS = 1200;

/**
 * Minimum char count for a final transcript to count as usable. Matches
 * speechRecognizer's behaviour so the caller's null-check works the
 * same way.
 */
const MIN_USABLE_CHARS = 2;

// ── Types ──────────────────────────────────────────────────────────────

export interface DeepgramRecognizerStopResult {
    /** Final transcript, or null if Deepgram didn't produce anything usable. */
    text: string | null;
    /** Total time the recognizer was active, in ms. */
    durationMs: number;
}

export interface DeepgramRecognizerHandle {
    /** Stop listening + flush, return the final transcript. */
    stop(): Promise<DeepgramRecognizerStopResult>;
    /** Cancel without using any result. */
    cancel(): Promise<void>;
}

interface StartOptions {
    /** Live partial transcript — fires every 150-250ms while audio is streaming. */
    onPartial?: (text: string) => void;
    /**
     * Fires once when the FIRST partial event arrives — confirms the
     * mic + WS pipeline is actually moving audio. Mirrors the
     * Apple-SR diagnostic of the same name; the BosunConsole's
     * cold-start grace period for the OVER gesture hooks into this.
     */
    onFirstPartial?: () => void;
}

interface DeepgramTranscriptMessage {
    type: 'Results';
    channel?: {
        alternatives?: Array<{ transcript?: string }>;
    };
    is_final?: boolean;
    speech_final?: boolean;
}

interface DeepgramMetadataMessage {
    type: 'Metadata';
    [key: string]: unknown;
}

type DeepgramMessage = DeepgramTranscriptMessage | DeepgramMetadataMessage;

// ── Event tap (for UI debug strip) ─────────────────────────────────────

let eventTap: ((message: string) => void) | null = null;
export function setDeepgramEventTap(tap: ((message: string) => void) | null): void {
    eventTap = tap;
}
function emitEvent(message: string): void {
    console.log(message);
    eventTap?.(message);
}

// ── Helpers ────────────────────────────────────────────────────────────

async function raceTimeout<T>(p: Promise<T>, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<T | null> {
    return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

/**
 * Token cache. Pre-warmed on console open via prewarmDeepgram() so the
 * cold-start path can skip the ~150-300ms token mint round-trip when a
 * fresh token is already in hand. Tokens come back with `expires_in=30`
 * (ephemeral path) or no expiry (long-lived fallback); we conservatively
 * cap the cache at 20s either way to leave headroom for the WS handshake
 * to complete inside the token's actual TTL.
 */
interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}
let tokenCache: TokenCacheEntry | null = null;
const TOKEN_CACHE_MAX_AGE_MS = 20_000;

async function fetchDeepgramToken(): Promise<string> {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('Deepgram token mint unavailable: Supabase credentials missing');
    }
    const url = `${SUPABASE_URL}/functions/v1/deepgram-token`;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), 10_000);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            body: JSON.stringify({}),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            const text = await r.text();
            throw new Error(`Deepgram token mint ${r.status}: ${text.slice(0, 200)}`);
        }
        const data = (await r.json()) as { access_token?: string };
        if (!data.access_token) throw new Error('Deepgram token mint returned no access_token');
        return data.access_token;
    } catch (err) {
        const e = err as Error;
        if (e.name === 'AbortError') {
            throw new Error('Deepgram token mint timed out');
        }
        throw e;
    } finally {
        clearTimeout(watchdog);
    }
}

async function mintDeepgramToken(): Promise<string> {
    // Cache hit: serve a token that's still inside its conservative
    // freshness window. On a hit we skip the entire Supabase round-trip,
    // which on a typical iOS connection saves 150-300ms off cold start.
    const cached = tokenCache;
    if (cached && Date.now() < cached.expiresAt) {
        emitEvent('[DG] token cache hit');
        return cached.token;
    }
    const t0 = Date.now();
    const token = await fetchDeepgramToken();
    emitEvent(`[DG] token minted in ${Date.now() - t0}ms`);
    tokenCache = { token, expiresAt: Date.now() + TOKEN_CACHE_MAX_AGE_MS };
    return token;
}

/**
 * Pre-warm the Deepgram token cache. Call from the BosunConsole on open
 * so the very first tap-to-talk skips the token mint round-trip — the
 * worst single contributor to cold-start latency. Refreshing on every
 * call is cheap because we only refetch when the cache is stale.
 *
 * Resolves to true on successful warm; false on failure (no exception
 * thrown). The voice console treats both the same — start-time mint
 * will retry with a clean error path.
 */
export async function prewarmDeepgram(): Promise<boolean> {
    if (tokenCache && Date.now() < tokenCache.expiresAt) return true;
    try {
        const t0 = Date.now();
        const token = await fetchDeepgramToken();
        tokenCache = { token, expiresAt: Date.now() + TOKEN_CACHE_MAX_AGE_MS };
        emitEvent(`[DG] prewarm minted token in ${Date.now() - t0}ms`);
        return true;
    } catch (err) {
        emitEvent(`[DG] prewarm failed: ${(err as Error).message}`);
        return false;
    }
}

/**
 * Inline AudioWorklet code: takes Float32 mic samples, converts to Int16
 * (linear16 PCM, the format Deepgram expects), and posts the buffer to
 * the main thread for forwarding to the WebSocket.
 *
 * Lives as a string so we don't need a separate worklet file in the
 * build output — loaded via `Blob` URL at runtime. This survives
 * Vite/Capacitor without any bundler config.
 */
const PCM_WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0]) {
            const float32 = input[0];
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                const s = Math.max(-1, Math.min(1, float32[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            // Post the Int16 buffer to the main thread (transferred,
            // not copied — main thread takes ownership).
            this.port.postMessage(int16.buffer, [int16.buffer]);
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

// ── Availability ───────────────────────────────────────────────────────

let availabilityCached: boolean | null = null;

/**
 * Returns true if Deepgram streaming should work on this device:
 *   - getUserMedia available (mic permission already granted or askable)
 *   - WebSocket available
 *   - AudioContext + AudioWorklet available
 *   - Supabase credentials present (for token mint)
 *
 * Doesn't actually open the socket — that happens at start() time. This
 * is a fast pre-flight check so the UI can decide whether to show the
 * Deepgram-ready pill before the skipper taps anything.
 */
export async function isDeepgramAvailable(force = false): Promise<boolean> {
    if (!force && availabilityCached !== null) return availabilityCached;
    try {
        if (typeof window === 'undefined') {
            availabilityCached = false;
            return false;
        }
        if (!navigator?.mediaDevices?.getUserMedia) {
            availabilityCached = false;
            return false;
        }
        if (typeof WebSocket === 'undefined') {
            availabilityCached = false;
            return false;
        }
        // AudioWorklet is available on iOS Safari 14.5+. WKWebView inherits
        // Safari's capabilities. If it's not there, fall back to
        // ScriptProcessorNode would be possible but not worth the code
        // path — older iOS isn't a target.
        const Ctx =
            (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) {
            availabilityCached = false;
            return false;
        }
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            availabilityCached = false;
            return false;
        }
        availabilityCached = true;
        return true;
    } catch {
        availabilityCached = false;
        return false;
    }
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Start a Deepgram streaming session. Returns a handle whose stop() yields
 * the final transcript.
 *
 * Throws on:
 *   - Mic permission denied
 *   - Token mint failure (network / Deepgram down / our edge fn down)
 *   - WebSocket connection failure
 *
 * Caller should fall through to a fallback (Apple SR / Scribe) on any
 * thrown error.
 */
export async function startDeepgramRecognizer(opts: StartOptions = {}): Promise<DeepgramRecognizerHandle> {
    const t0 = Date.now();
    let stopped = false;
    let firstPartialFired = false;
    let partialCount = 0;

    /**
     * Transcript accumulator. Deepgram chunks long utterances: when
     * `is_final=true` arrives, that segment is locked and the next
     * partials start a fresh segment. We concatenate finals + the
     * latest interim so each onPartial event reflects the FULL
     * utterance so far, matching Apple SR's behaviour. Without this,
     * a long sentence ending in "over" would only show the last chunk
     * to the OVER-gesture watcher.
     */
    let accumulatedFinals = '';
    let currentInterim = '';

    const composedTranscript = (): string => {
        const joined = accumulatedFinals + (currentInterim ? ' ' + currentInterim : '');
        return joined.trim().replace(/\s+/g, ' ');
    };

    // Final-flush coordination for stop(). When we send CloseStream,
    // Deepgram emits one last is_final=true result with whatever's left,
    // then closes. We resolve this promise on that final or on socket
    // close, whichever comes first.
    let resolveFinalFlush: () => void = () => {};
    const finalFlushPromise = new Promise<void>((resolve) => {
        resolveFinalFlush = resolve;
    });
    let flushRequested = false;

    // ── 1. Mint ephemeral token ─────────────────────────────────────
    emitEvent('[DG] start: minting token…');
    let token: string;
    const tokenStart = Date.now();
    try {
        token = await mintDeepgramToken();
    } catch (err) {
        emitEvent(`[DG] token mint failed: ${(err as Error).message}`);
        throw err;
    }
    emitEvent(`[DG] token ready (${Date.now() - tokenStart}ms)`);

    // ── 2. Acquire mic stream ───────────────────────────────────────
    emitEvent('[DG] requesting mic…');
    const micStart = Date.now();
    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
    } catch (err) {
        emitEvent(`[DG] getUserMedia failed: ${(err as Error).message}`);
        throw new Error(`Microphone access denied: ${(err as Error).message}`);
    }
    emitEvent(`[DG] mic stream acquired (${Date.now() - micStart}ms)`);

    // ── 3. Open AudioContext + load worklet ────────────────────────
    const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('AudioContext not available on this platform');
    }

    let audioContext: AudioContext;
    try {
        // Best-effort 16kHz request. iOS often clamps to native rate
        // (44.1k or 48k). We send whatever rate we end up with to
        // Deepgram in the URL query — they handle resampling.
        audioContext = new Ctx({ sampleRate: 16000 });
    } catch {
        // Older Safari throws on explicit sampleRate. Fall back to
        // hardware-default rate.
        audioContext = new Ctx();
    }

    // iOS WKWebView starts AudioContext suspended. resume() requires a
    // user gesture, but the caller already tapped to invoke us, so we're
    // inside a gesture window.
    const ctxStart = Date.now();
    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
        } catch (err) {
            emitEvent(`[DG] AudioContext.resume failed: ${(err as Error).message}`);
        }
    }

    const sampleRate = audioContext.sampleRate;
    emitEvent(`[DG] audio ctx @ ${sampleRate}Hz state=${audioContext.state} (${Date.now() - ctxStart}ms)`);

    // Load the worklet. Two strategies in priority order:
    //   1. Static file at /pcm-worklet.js — same-origin, falls under
    //      `'self'` in CSP. This is the WKWebView-friendly path; Blob
    //      URLs are rejected by the iOS Capacitor CSP even with
    //      `blob:` whitelisted in script-src/worker-src.
    //   2. Inline Blob URL — the desktop/dev fallback. Used when the
    //      static asset is missing (e.g. dev server hot-reload edge
    //      case) or when same-origin loading fails for any reason.
    const workletStart = Date.now();
    let workletLoaded = false;
    let lastWorkletErr: Error | null = null;
    try {
        await audioContext.audioWorklet.addModule('/pcm-worklet.js');
        workletLoaded = true;
        emitEvent(`[DG] worklet loaded from /pcm-worklet.js (${Date.now() - workletStart}ms)`);
    } catch (err) {
        lastWorkletErr = err as Error;
        emitEvent(`[DG] static worklet load failed: ${lastWorkletErr.message} — trying blob fallback`);
    }
    if (!workletLoaded) {
        const workletBlob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(workletBlob);
        try {
            await audioContext.audioWorklet.addModule(workletUrl);
            workletLoaded = true;
            emitEvent(`[DG] worklet loaded from blob (${Date.now() - workletStart}ms)`);
        } catch (err) {
            lastWorkletErr = err as Error;
        } finally {
            URL.revokeObjectURL(workletUrl);
        }
    }
    if (!workletLoaded) {
        stream.getTracks().forEach((t) => t.stop());
        await audioContext.close().catch(() => {});
        const msg = lastWorkletErr?.message ?? 'unknown';
        emitEvent(`[DG] worklet load failed (both paths): ${msg}`);
        throw new Error(`Failed to load PCM worklet: ${msg}`);
    }

    // ── 4. Build WebSocket URL with parameters ─────────────────────
    const params = new URLSearchParams({
        model: DEEPGRAM_MODEL,
        encoding: 'linear16',
        sample_rate: String(Math.round(sampleRate)),
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: String(ENDPOINTING_MS),
        language: 'en-AU',
        // VAD events surface the speech_started/speech_finished signals
        // separate from transcripts — useful diagnostically though we
        // don't gate UI on them.
        vad_events: 'true',
        // Punctuate keeps capitalization/punctuation; smart_format adds
        // numerals + dates + currencies. Both safe for our use case.
        punctuate: 'true',
    });
    for (const kw of KEYWORDS) {
        params.append('keywords', `${kw.word}:${kw.boost}`);
    }

    // ── 5. Connect WebSocket ────────────────────────────────────────
    // Two auth strategies, tried in order:
    //   1. Sec-WebSocket-Protocol: ['token', '<jwt>']
    //      Standard Deepgram browser-side auth. Per their docs.
    //   2. Query parameter: &access_token=<jwt>  (fallback)
    //      Some WebSocket implementations (older iOS WKWebView) don't
    //      negotiate the subprotocol cleanly with multi-element arrays;
    //      the server-side handshake fails and we get "error before
    //      OPEN" with no close code. Falling back to URL-param auth
    //      sidesteps the subprotocol entirely.
    const baseWsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    async function tryConnect(strategy: 'subprotocol-bearer' | 'urlparam'): Promise<WebSocket> {
        const url = strategy === 'urlparam' ? `${baseWsUrl}&access_token=${encodeURIComponent(token)}` : baseWsUrl;
        const stratStart = Date.now();
        let s: WebSocket;
        try {
            // Deepgram subprotocol: 'bearer' is REQUIRED for JWT
            // access tokens minted via /v1/auth/grant. Naively using
            // 'token' (the long-lived-API-key subprotocol) gets you
            // HTTP 401 INVALID_AUTH on the WS upgrade — confirmed
            // empirically against Deepgram's server. 'bearer' also
            // works for raw API keys, so it's the correct universal
            // choice when the client treats the token opaquely.
            s = strategy === 'subprotocol-bearer' ? new WebSocket(url, ['bearer', token]) : new WebSocket(url);
            s.binaryType = 'arraybuffer';
        } catch (err) {
            emitEvent(`[DG] ws ctor (${strategy}) threw: ${(err as Error).message}`);
            throw new Error(`Deepgram WebSocket failed: ${(err as Error).message}`);
        }
        // Capture both error and close so we don't lose the close code
        // when error fires first (which is the common path on auth/
        // subprotocol failures). We wait briefly after error for close
        // to arrive with the actual diagnostic code.
        return await new Promise<WebSocket>((resolve, reject) => {
            let lastCloseCode: number | null = null;
            let lastCloseReason = '';
            let errored = false;
            const cleanup = () => {
                s.removeEventListener('open', onOpen);
                s.removeEventListener('error', onError);
                s.removeEventListener('close', onClose);
            };
            const onOpen = () => {
                cleanup();
                emitEvent(
                    `[DG] ws open via ${strategy} in ${Date.now() - stratStart}ms` +
                        (s.protocol ? ` (protocol="${s.protocol}")` : ''),
                );
                resolve(s);
            };
            const onError = () => {
                errored = true;
                emitEvent(`[DG] ws error via ${strategy} (waiting for close code…)`);
                // Don't reject yet — let close fire so we capture the
                // code. If close doesn't fire within 500ms we'll bail.
                setTimeout(() => {
                    if (errored) {
                        cleanup();
                        const detail =
                            lastCloseCode !== null
                                ? `code=${lastCloseCode} reason=${lastCloseReason}`
                                : 'no close code';
                        reject(new Error(`Deepgram WS error via ${strategy} (${detail})`));
                    }
                }, 500);
            };
            const onClose = (ev: CloseEvent) => {
                lastCloseCode = ev.code;
                lastCloseReason = ev.reason || '';
                if (!errored) {
                    cleanup();
                    reject(
                        new Error(
                            `Deepgram WS closed before OPEN via ${strategy}: code=${ev.code} reason="${ev.reason || '(none)'}"`,
                        ),
                    );
                }
                // If errored already, the timeout in onError will fire
                // soon and reject with the captured code.
            };
            s.addEventListener('open', onOpen);
            s.addEventListener('error', onError);
            s.addEventListener('close', onClose);
            setTimeout(() => {
                cleanup();
                reject(new Error(`Deepgram WS connect timed out via ${strategy} (5s)`));
            }, 5_000);
        });
    }

    let ws: WebSocket;
    const wsStart = Date.now();
    try {
        ws = await tryConnect('subprotocol-bearer');
    } catch (subErr) {
        emitEvent(`[DG] subprotocol-bearer failed → trying URL-param auth: ${(subErr as Error).message}`);
        try {
            ws = await tryConnect('urlparam');
        } catch (urlErr) {
            stream.getTracks().forEach((t) => t.stop());
            await audioContext.close().catch(() => {});
            const finalMsg = `${(subErr as Error).message} | fallback: ${(urlErr as Error).message}`;
            emitEvent(`[DG] both ws strategies failed: ${finalMsg}`);
            throw new Error(`Deepgram WebSocket failed: ${finalMsg}`);
        }
    }
    emitEvent(`[DG] ws open total ${Date.now() - wsStart}ms (full cold-start ${Date.now() - t0}ms)`);

    // ── 6. Wire incoming Deepgram messages ──────────────────────────
    ws.addEventListener('message', (event: MessageEvent<string>) => {
        if (stopped && !flushRequested) return;
        let msg: DeepgramMessage;
        try {
            msg = JSON.parse(event.data) as DeepgramMessage;
        } catch {
            return; // ignore non-JSON
        }
        if (msg.type !== 'Results') return;
        const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
        const isFinal = Boolean(msg.is_final);
        if (transcript.length === 0) {
            // Empty results happen on pure-silence chunks. Don't
            // disturb partials with these.
            if (isFinal && flushRequested) {
                resolveFinalFlush();
            }
            return;
        }

        if (isFinal) {
            // Lock this segment in. Reset interim. Future partials
            // belong to the next segment.
            accumulatedFinals = (accumulatedFinals + ' ' + transcript).trim().replace(/\s+/g, ' ');
            currentInterim = '';
            if (flushRequested) {
                resolveFinalFlush();
            }
        } else {
            currentInterim = transcript;
        }

        partialCount++;
        if (!firstPartialFired) {
            firstPartialFired = true;
            emitEvent(`[DG] first partial in ${Date.now() - t0}ms (audio→partial) — "${transcript.slice(0, 40)}"`);
            opts.onFirstPartial?.();
        }
        opts.onPartial?.(composedTranscript());
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
        emitEvent(`[DG] ws closed code=${ev.code} reason=${ev.reason || '(none)'}`);
        // If stop() is waiting on flush, unblock it — no more results coming.
        if (flushRequested) resolveFinalFlush();
    });

    ws.addEventListener('error', () => {
        emitEvent('[DG] ws error');
    });

    // ── 7. Wire mic → worklet → ws ─────────────────────────────────
    let workletNode: AudioWorkletNode | null = null;
    let micSource: MediaStreamAudioSourceNode | null = null;
    let firstChunkSent = false;
    try {
        micSource = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
            if (stopped) return;
            if (ws.readyState !== WebSocket.OPEN) return;
            try {
                ws.send(e.data);
                if (!firstChunkSent) {
                    firstChunkSent = true;
                    emitEvent(`[DG] first audio chunk sent (${Date.now() - t0}ms total)`);
                }
            } catch (err) {
                // Send can throw if WS is closing. Don't crash — next
                // iteration will see readyState !== OPEN.
                emitEvent(`[DG] ws.send threw: ${(err as Error).message}`);
            }
        };
        micSource.connect(workletNode);
        // Worklet is a sink — we don't connect it to ctx.destination
        // because we don't want the mic monitored back into the
        // speakers (would cause feedback on iOS).
    } catch (err) {
        // Wire-up failure — tear everything down and propagate.
        try {
            ws.close();
        } catch {
            /* ignore */
        }
        stream.getTracks().forEach((t) => t.stop());
        await audioContext.close().catch(() => {});
        emitEvent(`[DG] audio wire failed: ${(err as Error).message}`);
        throw new Error(`Audio pipeline setup failed: ${(err as Error).message}`);
    }

    // ── 8. Teardown helpers ────────────────────────────────────────
    const teardown = async (): Promise<void> => {
        stopped = true;
        try {
            if (workletNode) {
                workletNode.port.onmessage = null;
                workletNode.disconnect();
            }
            if (micSource) micSource.disconnect();
        } catch {
            /* ignore */
        }
        try {
            stream.getTracks().forEach((t) => t.stop());
        } catch {
            /* ignore */
        }
        await raceTimeout(audioContext.close().catch(() => {}));
        try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        } catch {
            /* ignore */
        }
    };

    // ── 9. Public handle ───────────────────────────────────────────
    return {
        async stop(): Promise<DeepgramRecognizerStopResult> {
            const durationMs = Date.now() - t0;

            // Tell Deepgram to flush remaining audio. CloseStream is
            // a JSON control message — Deepgram processes any buffered
            // audio, emits a final transcript, then closes.
            flushRequested = true;
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'CloseStream' }));
                }
            } catch {
                /* socket might already be closing */
            }

            // Wait briefly for the final flush, capped so we never
            // block the caller's send pipeline if Deepgram hangs.
            await Promise.race([
                finalFlushPromise,
                new Promise<void>((resolve) => setTimeout(resolve, FINAL_FLUSH_TIMEOUT_MS)),
            ]);

            await teardown();

            const trimmed = composedTranscript().trim();
            const preview = trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
            emitEvent(`[DG] stop() — partials: ${partialCount}, ${durationMs}ms, text="${preview || '(empty)'}"`);
            if (trimmed.length < MIN_USABLE_CHARS) {
                return { text: null, durationMs };
            }
            return { text: trimmed, durationMs };
        },

        async cancel(): Promise<void> {
            await teardown();
            emitEvent(`[DG] cancel() — partials: ${partialCount}, ${Date.now() - t0}ms`);
        },
    };
}

// ── Platform check ─────────────────────────────────────────────────────

/**
 * Whether Deepgram should be the default primary STT. True on web/iOS;
 * we don't gate by Capacitor.isNativePlatform() because the WebSocket
 * pipeline works in WKWebView the same as in Safari.
 *
 * Reserved as a hook in case we later decide to disable Deepgram on
 * specific platforms (e.g. metered cellular) — currently always on
 * when the runtime checks pass.
 */
export function isDeepgramPreferredOnThisPlatform(): boolean {
    // Currently no platform-specific exclusions. Deepgram works in
    // WKWebView, mobile Safari, and desktop Chrome alike.
    void Capacitor;
    return true;
}
