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
 * Cloudflare Worker URL for the Deepgram WebSocket proxy. When set,
 * the iOS client routes streaming audio through the Worker instead of
 * Supabase Edge Functions.
 *
 * Why: Supabase Edge Functions (Deno Deploy) can't reliably sustain
 * outbound WebSockets to api.deepgram.com under iOS-paced audio load
 * — the upstream dies after ~1s with code=0. Cloudflare Workers'
 * WebSocketPair API was engineered for this case and stays stable.
 *
 * Falls back to the Supabase proxy when unset (during cutover or
 * when the Worker is being redeployed).
 *
 * Set in .env.local after `npx wrangler deploy`:
 *   VITE_DEEPGRAM_PROXY_URL=https://thalassa-deepgram-proxy.<acct>.workers.dev
 */
const DEEPGRAM_PROXY_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEEPGRAM_PROXY_URL) || '';

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
 * Words to boost recognition of via Deepgram's `keyterm` parameter.
 *
 * Nova-3 replaced the older `keywords=word:intensifier` with `keyterm`
 * (no intensifier — just the term). Sending `keywords` to Nova-3
 * returns HTTP 400 INVALID_QUERY_PARAMETER. We boost "Calypso"
 * because it's a non-English proper noun that Nova-3 wouldn't
 * otherwise have in its lexicon, and "over" so the auto-send gesture
 * fires reliably even with mumbled enunciation.
 */
const KEYTERMS = ['Calypso', 'over'];

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
 * Pre-warmed AudioContext + worklet, cached at module level. Lets the
 * tap-to-talk path skip 200-400ms of cold-start work that previously
 * happened synchronously inside the user gesture window.
 *
 * On iOS, AudioContext can be CONSTRUCTED (in suspended state) without
 * a user gesture; only resume() and any audio output need the gesture.
 * Loading an AudioWorkletProcessor module via addModule() is also
 * gesture-free since it's just JS fetch + parse + register. So we can
 * do all this work on console open and reuse on tap.
 *
 * The context is consumed by the first startDeepgramRecognizer() call;
 * subsequent calls re-prewarm via the next prewarm trigger.
 */
interface PrewarmedAudio {
    context: AudioContext;
    sampleRate: number;
}
let prewarmedAudio: PrewarmedAudio | null = null;

/**
 * Pre-warm the AudioContext + PCM worklet. Idempotent — returns the
 * existing prewarmed context if already cached. Returns false on
 * failure without throwing (the cold-start path will fall back to
 * creating these inline).
 */
export async function prewarmAudioContext(): Promise<boolean> {
    if (prewarmedAudio) return true;
    try {
        if (typeof window === 'undefined') return false;
        const Ctx =
            (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return false;

        const t0 = Date.now();
        let context: AudioContext;
        try {
            context = new Ctx({ sampleRate: 16000 });
        } catch {
            context = new Ctx();
        }
        // Worklet load — happens before any user gesture, fine on iOS.
        // Static asset path so CSP `'self'` covers it (same path used
        // inside startDeepgramRecognizer's normal flow).
        await context.audioWorklet.addModule('/pcm-worklet.js');
        prewarmedAudio = { context, sampleRate: context.sampleRate };
        emitEvent(`[DG] prewarm audio context @ ${context.sampleRate}Hz + worklet (${Date.now() - t0}ms)`);
        return true;
    } catch (err) {
        emitEvent(`[DG] prewarm audio failed: ${(err as Error).message}`);
        return false;
    }
}

/**
 * Pre-warmed microphone stream. The dominant cold-start cost on iOS
 * is `getUserMedia` activating AVAudioSession + acquiring the hardware
 * mic — typically 1.0-1.4 seconds the FIRST time it's called in a
 * session. Subsequent calls are fast because iOS keeps the audio
 * resource warm.
 *
 * Pre-acquiring the stream on console open means the user sees a
 * 1-second wait before the button becomes ready (with the iOS mic
 * indicator turning on) but the actual tap-to-talk feels instant.
 * For a voice console where the user opened explicitly to talk, this
 * is a strict improvement.
 *
 * The stream is consumed by the first startDeepgramRecognizer() call
 * (set to null after handover) and re-acquired fresh next time. We
 * also release it on console close via releasePrewarmedMicStream().
 */
let prewarmedMicStream: MediaStream | null = null;

export async function prewarmMicStream(): Promise<boolean> {
    // Already alive? No-op.
    if (prewarmedMicStream && prewarmedMicStream.getTracks().every((t) => t.readyState === 'live')) {
        return true;
    }
    if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
        return false;
    }
    try {
        const t0 = Date.now();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        prewarmedMicStream = stream;
        emitEvent(`[DG] prewarmed mic stream in ${Date.now() - t0}ms`);
        return true;
    } catch (err) {
        emitEvent(`[DG] prewarm mic failed: ${(err as Error).message}`);
        return false;
    }
}

export function releasePrewarmedMicStream(): void {
    if (prewarmedMicStream) {
        try {
            prewarmedMicStream.getTracks().forEach((t) => t.stop());
        } catch {
            /* ignore */
        }
        prewarmedMicStream = null;
        emitEvent(`[DG] released prewarmed mic stream`);
    }
}

/**
 * Pre-warm the TLS / TCP connection to the Cloudflare Worker. iOS
 * WKWebView's network stack reuses NSURLSession across HTTP and
 * WebSocket scheme requests to the same origin, so a HEAD/GET on
 * console open establishes DNS + TCP + TLS that the subsequent WS
 * upgrade can reuse — saves ~150-300ms of cold-start.
 */
export async function prewarmWorkerConnection(): Promise<boolean> {
    if (!DEEPGRAM_PROXY_URL) return false;
    try {
        const url = DEEPGRAM_PROXY_URL.replace(/\/+$/, '') + '/';
        const t0 = Date.now();
        // The Worker rejects non-WS requests with 426. We don't care
        // about the response — we just want the TLS path established.
        await fetch(url, { method: 'GET' }).catch(() => {});
        emitEvent(`[DG] prewarm worker connection in ${Date.now() - t0}ms`);
        return true;
    } catch (err) {
        emitEvent(`[DG] prewarm worker failed: ${(err as Error).message}`);
        return false;
    }
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

    // ── 1. Mint token (only when Supabase fallback is in use) ──────
    // The Cloudflare Worker proxy holds the Deepgram API key
    // server-side and authenticates upstream itself, so the iOS
    // client doesn't need a Deepgram token at all when going through
    // the Worker — saves 150-300ms off cold start.
    let token = '';
    if (!DEEPGRAM_PROXY_URL) {
        emitEvent('[DG] start: minting token (Supabase path)…');
        const tokenStart = Date.now();
        try {
            token = await mintDeepgramToken();
        } catch (err) {
            emitEvent(`[DG] token mint failed: ${(err as Error).message}`);
            throw err;
        }
        emitEvent(`[DG] token ready (${Date.now() - tokenStart}ms)`);
    } else {
        emitEvent('[DG] cloudflare path — skipping token mint');
    }

    // ── 2. Acquire mic stream ───────────────────────────────────────
    // Prefer the prewarmed stream from BosunConsole's on-open hook —
    // saves the ~1.0-1.4s iOS getUserMedia / AVAudioSession activation
    // cost from the tap-to-ready critical path. Falls back to a fresh
    // call if no prewarm was done or the prewarmed stream went stale.
    let stream: MediaStream;
    const micStart = Date.now();
    if (prewarmedMicStream && prewarmedMicStream.getTracks().every((t) => t.readyState === 'live')) {
        stream = prewarmedMicStream;
        prewarmedMicStream = null; // consumed; next session re-prewarms
        emitEvent(`[DG] reused prewarmed mic stream (saved ~1s)`);
    } else {
        emitEvent('[DG] requesting mic…');
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
    }

    // ── 3. Open AudioContext + load worklet ────────────────────────
    // Use the pre-warmed context if BosunConsole called
    // prewarmAudioContext() on open. This skips ~200-400ms of cold
    // start because the AudioContext construction and worklet module
    // load already happened idle-time.
    const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('AudioContext not available on this platform');
    }

    let audioContext: AudioContext;
    let workletAlreadyRegistered = false;
    if (prewarmedAudio) {
        audioContext = prewarmedAudio.context;
        workletAlreadyRegistered = true;
        emitEvent('[DG] reusing prewarmed audio context + worklet');
        prewarmedAudio = null; // consumed; next session re-prewarms
    } else {
        try {
            audioContext = new Ctx({ sampleRate: 16000 });
        } catch {
            audioContext = new Ctx();
        }
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

    // Skip worklet load entirely if already registered (prewarm hit).
    // Saves another ~100-300ms of cold-start latency. The same
    // PCMProcessor class is the one we'd register again here, so
    // re-registering would actually throw — must skip when present.
    let workletLoaded = workletAlreadyRegistered;
    let lastWorkletErr: Error | null = null;
    if (workletAlreadyRegistered) {
        emitEvent('[DG] worklet already registered (prewarm)');
    }
    // Load the worklet. Two strategies in priority order:
    //   1. Static file at /pcm-worklet.js — same-origin, falls under
    //      `'self'` in CSP. This is the WKWebView-friendly path; Blob
    //      URLs are rejected by the iOS Capacitor CSP even with
    //      `blob:` whitelisted in script-src/worker-src.
    //   2. Inline Blob URL — the desktop/dev fallback. Used when the
    //      static asset is missing (e.g. dev server hot-reload edge
    //      case) or when same-origin loading fails for any reason.
    const workletStart = Date.now();
    if (!workletLoaded) {
        try {
            await audioContext.audioWorklet.addModule('/pcm-worklet.js');
            workletLoaded = true;
            emitEvent(`[DG] worklet loaded from /pcm-worklet.js (${Date.now() - workletStart}ms)`);
        } catch (err) {
            lastWorkletErr = err as Error;
            emitEvent(`[DG] static worklet load failed: ${lastWorkletErr.message} — trying blob fallback`);
        }
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
    for (const term of KEYTERMS) {
        params.append('keyterm', term);
    }

    // ── 5. Connect WebSocket via Supabase proxy ─────────────────────
    // We don't connect directly to api.deepgram.com from the iOS
    // client. iOS WKWebView's WebSocket implementation has issues
    // with multi-element Sec-WebSocket-Protocol arrays — both with
    // long values (485-char JWT) and with normal-length values
    // (40-char API key). The handshake dies with code=1006 reason="ws
    // error" before Deepgram ever sees the upgrade.
    //
    // Workaround: connect to a Supabase Edge Function (deepgram-ws-proxy)
    // which iOS handles fine — it's the same WebSocket gateway that
    // Realtime uses successfully. The proxy opens its own socket to
    // Deepgram with the API key in the subprotocol header (server-side,
    // no client-side length quirks) and bridges audio + transcript
    // frames bidirectionally.
    //
    // The `token` parameter passed in here is intentionally unused for
    // the upstream auth (the proxy holds the key) but we keep the
    // round-trip to deepgram-token because it warms the network path
    // and confirms the function is reachable before we open the WS.
    void token;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        stream.getTracks().forEach((t) => t.stop());
        await audioContext.close().catch(() => {});
        throw new Error('Supabase credentials missing — cannot reach Deepgram proxy');
    }
    // Two possible proxy hosts:
    //   1. Cloudflare Worker (preferred when VITE_DEEPGRAM_PROXY_URL is set)
    //      — stable under iOS audio load, designed for WS bridging
    //   2. Supabase Edge Function (fallback / cutover)
    //      — dies after ~1s with iOS-paced packets, kept for testing
    // Both endpoints use the same `?apikey=<anon JWT>` auth pattern.
    let wsUrl: string;
    let proxyKind: string;
    if (DEEPGRAM_PROXY_URL) {
        const cfHost = DEEPGRAM_PROXY_URL.replace(/^https:/, 'wss:')
            .replace(/^http:/, 'ws:')
            .replace(/\/+$/, '');
        wsUrl = `${cfHost}/?${params.toString()}&apikey=${encodeURIComponent(SUPABASE_KEY)}`;
        proxyKind = 'cloudflare-worker';
    } else {
        const sbHost = SUPABASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
        wsUrl = `${sbHost}/functions/v1/deepgram-ws-proxy?${params.toString()}&apikey=${encodeURIComponent(SUPABASE_KEY)}`;
        proxyKind = 'supabase-edge';
    }
    emitEvent(`[DG] using ${proxyKind} proxy`);

    async function tryConnect(strategy: 'supabase-proxy'): Promise<WebSocket> {
        const stratStart = Date.now();
        let s: WebSocket;
        try {
            // No subprotocols — iOS WKWebView negotiates these cleanly
            // when the array is empty/absent. Auth is via the URL
            // ?apikey= param at the Supabase gateway.
            s = new WebSocket(wsUrl);
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
        ws = await tryConnect('supabase-proxy');
    } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        await audioContext.close().catch(() => {});
        emitEvent(`[DG] proxy ws failed: ${(err as Error).message}`);
        throw new Error(`Deepgram proxy failed: ${(err as Error).message}`);
    }
    emitEvent(`[DG] proxy ws open total ${Date.now() - wsStart}ms (full cold-start ${Date.now() - t0}ms)`);

    // ── 6. Wire incoming Deepgram messages ──────────────────────────
    let totalMessagesReceived = 0;
    ws.addEventListener('message', (event: MessageEvent<string>) => {
        totalMessagesReceived++;
        if (stopped && !flushRequested) return;
        let msg: DeepgramMessage;
        try {
            msg = JSON.parse(event.data) as DeepgramMessage;
        } catch {
            return; // ignore non-JSON
        }
        // Surface every message type we see — particularly useful
        // when transcripts come back empty: lets us see ProxyHello
        // (from Supabase proxy on connect), Metadata, SpeechStarted,
        // UtteranceEnd, Error, etc. in the debug strip so we can tell
        // whether the audio is even reaching the model.
        if (totalMessagesReceived <= 3) {
            const preview = JSON.stringify(msg).slice(0, 80);
            emitEvent(`[DG] msg #${totalMessagesReceived} type=${msg.type ?? '?'}: ${preview}`);
        }
        // ProxyHello is our own diagnostic emitted by the Supabase
        // proxy on client connect — confirms proxy→client forwarding.
        // Don't process it as a Deepgram message.
        const msgType = (msg as { type?: string }).type;
        if (msgType === 'ProxyHello') return;
        if (msgType !== 'Results') return;
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
    let flushInterval: ReturnType<typeof setInterval> | null = null;
    try {
        micSource = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        let chunksSent = 0;
        let bytesSent = 0;
        // Audio batching. The worklet produces 128-frame chunks (256 B
        // at 16-bit mono), one every ~2.7ms at 48kHz — that's ~375
        // tiny WebSocket sends per second. iOS WKWebView's WebSocket
        // implementation chokes on that rate and tends to close the
        // socket abruptly with code=1005. Batch up to ~50ms of audio
        // (8192 bytes at 48kHz mono int16) before sending so we hit
        // ~20 sends/sec instead — well within any sensible rate limit
        // and Deepgram is fine with that frame size.
        const BATCH_BYTES_TARGET = 8192;
        const batchBuffers: ArrayBuffer[] = [];
        let batchSize = 0;
        const flushBatch = (): void => {
            if (batchBuffers.length === 0) return;
            // Concatenate the batched chunks into one buffer.
            const merged = new Uint8Array(batchSize);
            let offset = 0;
            for (const buf of batchBuffers) {
                merged.set(new Uint8Array(buf), offset);
                offset += buf.byteLength;
            }
            batchBuffers.length = 0;
            const flushed = batchSize;
            batchSize = 0;
            try {
                ws.send(merged.buffer);
                chunksSent++;
                bytesSent += flushed;
                if (!firstChunkSent) {
                    firstChunkSent = true;
                    emitEvent(`[DG] first audio chunk (${flushed}B) sent at ${Date.now() - t0}ms`);
                }
                if (chunksSent === 10 || chunksSent === 50) {
                    emitEvent(`[DG] sent ${chunksSent} batched chunks (${bytesSent}B) — audio flowing`);
                }
            } catch (err) {
                emitEvent(`[DG] ws.send threw: ${(err as Error).message}`);
            }
        };
        workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
            if (stopped) return;
            if (ws.readyState !== WebSocket.OPEN) return;
            batchBuffers.push(e.data);
            batchSize += e.data.byteLength;
            if (batchSize >= BATCH_BYTES_TARGET) {
                flushBatch();
            }
        };
        // Safety flush every 100ms so even quiet/short utterances get
        // partial frames to Deepgram (otherwise a quiet 80ms reply
        // would never reach the threshold and never get sent).
        // Cleared in teardown to stop the timer + flush remaining bytes.
        flushInterval = setInterval(() => {
            if (!stopped && ws.readyState === WebSocket.OPEN && batchSize > 0) {
                flushBatch();
            }
        }, 100);
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
        if (flushInterval !== null) {
            clearInterval(flushInterval);
            flushInterval = null;
        }
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
