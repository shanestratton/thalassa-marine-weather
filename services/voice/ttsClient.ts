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

import { useSettingsStore } from '../../stores/settingsStore';
import { resolveVoiceId } from './voicePresets';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
const TTS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Read the active voice_id from settings (resolving the persisted
 * preset key via voicePresets) so the synth call uses whichever
 * voice the skipper picked in Settings → Calypso → Voice. Falls
 * back to the default when nothing is set or the store is loading.
 */
function activeVoiceId(): string {
    try {
        const settings = useSettingsStore.getState().settings;
        return resolveVoiceId(settings.calypsoVoiceId);
    } catch {
        return resolveVoiceId(undefined);
    }
}

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
export async function synthesise(text: string, opts?: { voiceId?: string }): Promise<string | null> {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    const url = `${SUPABASE_URL}/functions/v1/elevenlabs-tts`;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), TTS_REQUEST_TIMEOUT_MS);
    try {
        // Caller can override the voice (sample-play in settings); else
        // pull the active preset from the settings store. This means
        // any later TTS call after the skipper picks a new voice picks
        // up the change without restarting the app.
        const voice_id = opts?.voiceId ?? activeVoiceId();
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            body: JSON.stringify({ text: trimmed, voice_id }),
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
/**
 * If Apple Music is currently playing through the system music player,
 * pause it before our TTS plays and resume after — far more reliable
 * than fighting iOS's audio session ducking, which has been observed
 * to leave the system music player in a stopped state after our TTS
 * audio plays through WKWebView's HTML5 Audio (the WebView's audio
 * playback path doesn't always honour our app session's
 * .mixWithOthers / .duckOthers options).
 *
 * Pause is explicit, resume is explicit. The music briefly stops
 * during Calypso's narration and continues right after — clean
 * compared to the previous behaviour of music dying after one TTS
 * narration with no recovery.
 *
 * Lazy-imported so this file doesn't pull in the entire AppleMusic
 * integration as a dependency on every TTS path.
 */
async function pauseAppleMusicIfPlaying(): Promise<boolean> {
    try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return false;
        const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
        const plugin = cap?.Plugins?.AppleMusic as
            | {
                  nowPlaying: () => Promise<{ is_playing: boolean; title: string }>;
                  pause: () => Promise<{ status: string }>;
              }
            | undefined;
        if (!plugin) return false;
        const np = await plugin.nowPlaying();
        if (np.is_playing) {
            await plugin.pause();
            return true;
        }
    } catch {
        /* AppleMusic plugin not available or query failed — fine, just
         *  proceed with TTS without pausing. */
    }
    return false;
}

async function resumeAppleMusic(): Promise<void> {
    try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
        const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
        const plugin = cap?.Plugins?.AppleMusic as { resume: () => Promise<{ status: string }> } | undefined;
        if (!plugin) return;
        await plugin.resume();
    } catch {
        /* swallow — failing to resume music isn't a critical TTS bug. */
    }
}

export function speak(text: string, opts?: { voiceId?: string }): SpokenHandle {
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let objectUrl: string | null = null;
    let nativeCancel: (() => void) | null = null;

    const done = (async () => {
        const trimmed = (text || '').trim();
        if (!trimmed) return;

        const b64 = await synthesise(trimmed, opts);
        if (cancelled || !b64) return;

        // Prefer native AVAudioPlayer on iOS — HTML5 Audio in WKWebView
        // has been observed to interrupt applicationMusicPlayer every
        // time Calypso speaks. Native player respects our session
        // config (.playback + .mixWithOthers), so TTS plays alongside
        // music without killing it.
        try {
            const { Capacitor } = await import('@capacitor/core');
            if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {
                const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
                const plugin = cap?.Plugins?.AppleMusic as
                    | {
                          playTtsAudio: (opts: { audio_b64: string }) => Promise<{ status: string }>;
                          cancelTtsAudio: () => Promise<{ status: string }>;
                      }
                    | undefined;
                if (plugin) {
                    const playPromise = plugin.playTtsAudio({ audio_b64: b64 });
                    nativeCancel = () => void plugin.cancelTtsAudio().catch(() => undefined);
                    if (cancelled) {
                        nativeCancel();
                        return;
                    }
                    await playPromise.catch(() => undefined);
                    return; // native path complete — don't fall through
                }
            }
        } catch {
            // Plugin unavailable — fall through to HTML5 Audio.
        }

        // ── HTML5 Audio fallback (web / non-iOS-native) ──────────────
        // On platforms without the native plugin, use the legacy
        // path. The pause-music-around-TTS dance is preserved here
        // because HTML5 Audio still has the session-clobbering
        // problem on iOS when we hit this branch.
        const url = base64Mp3ToObjectUrl(b64);
        if (cancelled || !url) return;
        objectUrl = url;

        const wasPlayingMusic = await pauseAppleMusicIfPlaying();

        audio = new Audio(url);
        audio.volume = 1.0;
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

        if (wasPlayingMusic && !cancelled) {
            void resumeAppleMusic();
        }
    })();

    return {
        done,
        cancel: () => {
            cancelled = true;
            if (nativeCancel) {
                try {
                    nativeCancel();
                } catch {
                    /* ignore */
                }
            }
            try {
                audio?.pause();
            } catch {
                /* ignore */
            }
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
    };
}
