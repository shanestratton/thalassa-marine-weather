/**
 * ttsClient — Standalone ElevenLabs TTS client for Calypso.
 *
 * Extracted from orchestrator.ts so any service (alert dispatcher,
 * notification handler, future tutorial flows) can put words in
 * Calypso's mouth without standing up the full voice console.
 *
 * Two surfaces:
 *   - synthesise(text) → base64 MP3 (or null on failure)
 *   - speak(text)      → synthesise + playback in one call
 *
 * Playback uses an HTML5 Audio element, which iOS routes through the
 * AVAudioSession the AlarmAudioPlugin keeps in `.playback` mode while
 * the app is alive. That session bypasses the mute switch and survives
 * app backgrounding (the `audio` UIBackgroundMode in Info.plist) — so
 * Calypso will speak through the device speaker even when the app is
 * minimised, which is exactly the "interrupt the skipper to flag a
 * problem" behaviour the alert system needs.
 *
 * Note on quota / failure modes: synthesise returns null on quota
 * exhaustion, network failure, or auth issues. Callers should treat
 * a null return as "TTS unavailable, fall back to chime + visible
 * banner" — never raise an exception out of the audio path because
 * the alert is already valid; only the audible delivery failed.
 */

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
const TTS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Last-known TTS error surface — same pattern as orchestrator's. Lets
 * callers surface a transient toast ("TTS quota exhausted") instead
 * of a silent failure.
 */
let lastTtsErrorMessage: string | null = null;
export function consumeTtsClientError(): string | null {
    const v = lastTtsErrorMessage;
    lastTtsErrorMessage = null;
    return v;
}

/**
 * Send `text` to the elevenlabs-tts edge function and return the
 * resulting MP3 as a base64 string. Returns null on any failure
 * (quota, network, auth).
 *
 * The edge function applies prepareForTTS normalisation server-side
 * (units → spelled-out words, pressure-to-words, etc.), so callers
 * can pass raw text like "Battery 11.4 volts" and the synth will
 * pronounce it as "Battery eleven point four volts".
 */
export async function synthesise(text: string): Promise<string | null> {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    const url = `${SUPABASE_URL}/functions/v1/elevenlabs-tts`;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), TTS_REQUEST_TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            body: JSON.stringify({ text: trimmed }),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            const body = await r.text().catch(() => '');
            const lc = body.toLowerCase();
            if (lc.includes('quota') || lc.includes('credit')) {
                lastTtsErrorMessage = 'ElevenLabs TTS quota exhausted — Calypso muted. Top up at elevenlabs.io.';
            } else if (r.status === 401 || r.status === 403) {
                lastTtsErrorMessage = 'ElevenLabs auth failed — Calypso muted.';
            } else {
                lastTtsErrorMessage = `ElevenLabs TTS failed (${r.status}) — Calypso muted this turn.`;
            }
            return null;
        }
        const data = (await r.json()) as { audio_b64?: string };
        return data.audio_b64 ?? null;
    } catch (err) {
        const e = err as Error;
        if (e.name !== 'AbortError') {
            lastTtsErrorMessage = `ElevenLabs unreachable — Calypso muted this turn.`;
        }
        return null;
    } finally {
        clearTimeout(watchdog);
    }
}

/**
 * Decode a base64 MP3 into a playable object URL. Returns null on
 * decode failure (bad input). Caller is responsible for revoking
 * the URL after playback to free memory.
 */
function base64Mp3ToObjectUrl(b64: string): string | null {
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // Cast through BlobPart for TS 5.7's stricter ArrayBufferLike narrowing
        // (see AlertNotifier comment for full context).
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' });
        return URL.createObjectURL(blob);
    } catch {
        return null;
    }
}

/**
 * Single-utterance handle. Lets the caller cancel mid-playback if a
 * higher-priority alert lands, or if the rule clears. Returns
 * resolved when playback completes (or fails).
 */
export interface SpokenHandle {
    /** True once the synth+playback chain finishes (or errors). */
    done: Promise<void>;
    /** Stop playback immediately. Safe to call after done resolves. */
    cancel: () => void;
}

/**
 * Synthesise + play in one call. Returns a handle so the caller can
 * cancel mid-playback if needed (e.g. a higher-severity alert
 * preempts a lower one).
 *
 * Idempotent against falsy text — `speak('')` resolves immediately.
 */
export function speak(text: string): SpokenHandle {
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let objectUrl: string | null = null;

    const done = (async () => {
        const trimmed = (text || '').trim();
        if (!trimmed) return;

        const b64 = await synthesise(trimmed);
        if (cancelled || !b64) return;
        const url = base64Mp3ToObjectUrl(b64);
        if (cancelled || !url) return;
        objectUrl = url;

        audio = new Audio(url);
        // Crank the playback volume to max — the iOS audio session
        // already bypasses the mute switch (set up by AlarmAudioPlugin),
        // but the per-element volume defaults to 1.0 anyway. Setting
        // explicitly is just belt-and-braces.
        audio.volume = 1.0;
        // playsInline avoids iOS auto-fullscreen on the (invisible)
        // <audio> element on some WKWebView builds.
        audio.setAttribute('playsinline', 'true');

        await new Promise<void>((resolve) => {
            if (!audio) return resolve();
            const cleanup = () => {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                resolve();
            };
            audio.addEventListener('ended', cleanup, { once: true });
            audio.addEventListener('error', cleanup, { once: true });
            audio.play().catch(() => cleanup());
        });
    })();

    return {
        done,
        cancel: () => {
            cancelled = true;
            try {
                audio?.pause();
            } catch {
                /* ignore */
            }
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
    };
}
