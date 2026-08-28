/**
 * Safety TTS — Calypso voice for MAYDAY / position reports / distress
 *               messages, with a graceful fallback to the native
 *               `SpeechSynthesisUtterance` when Calypso isn't reachable.
 *
 * Why this exists: MOB and Radio Console were calling the browser's
 * `speechSynthesis` directly, which on iOS gives the robotic Apple
 * voice that sounds like a 1980s autopilot announcement. Distress
 * messages benefit from a calm human-sounding voice that the listener
 * (Coast Guard, nearby vessels) is more likely to take seriously and
 * understand at the first transmission.
 *
 * The fallback path matters more here than in casual TTS: a MAYDAY
 * call CANNOT silently fail because of a network blip. So we race
 * the Calypso synth against a tight timeout and fall back to native
 * the moment ElevenLabs takes too long, fails, or the device is
 * offline. The native voice is the safety net — every iOS device has
 * it, no network needed.
 *
 * Race architecture (rewritten 2026-05-04):
 *   We race ELEVENLABS *SYNTHESIS* (the network call) against the
 *   budget — NOT playback start. The previous version tried to detect
 *   "Calypso started speaking" by polling for HTMLAudioElement that
 *   was playing, which never worked on iOS native (we play through
 *   AVAudioPlayer in the AppleMusic plugin, no HTMLAudioElement
 *   exists). That meant the budget timeout always fired even when
 *   Calypso WAS about to speak, kicking off the native voice on top
 *   of Calypso's mid-flight audio — the "two voices over the top"
 *   bug the skipper hit on MOB/Radio reports.
 *
 *   New flow:
 *     1. Kick off `synthesise(text)` — ElevenLabs network call.
 *     2. Race that promise against `SAFETY_TTS_BUDGET_MS`.
 *     3. If synth resolves with audio → commit to Calypso, play
 *        through the native plugin. No native voice will ever fire.
 *     4. If synth resolves with null OR timeout fires first → commit
 *        to native voice. No Calypso playback will ever start.
 *
 *   Decision happens before any audio plays, so overlap is impossible.
 */

import { synthesise, type VoiceSettingsOverride } from './ttsClient';

/** Hard cap on how long we wait for Calypso TTS before falling back
 *  to native. Set short because safety messages must not stall. */
const SAFETY_TTS_BUDGET_MS = 4000;

/**
 * PRE-SYNTHESISED SAFETY AUDIO.
 *
 * The budget above is the right call — a distress transmission must never
 * stall on a network — but it meant Calypso essentially never won. A MOB
 * Mayday runs to ~600 characters, ElevenLabs takes several seconds on that,
 * and 4 s is not enough, so the fallback was firing every single time (Shane
 * 2026-08-28: "it is defaulting to the fallback voice").
 *
 * Raising the budget is the wrong lever: it buys a better voice with silence
 * at the exact moment silence is most expensive. Instead, synthesise EARLY.
 * The Mayday text is fully known the moment MOB goes active — minutes before
 * anyone presses Speak — so the audio can be waiting. A cache hit skips the
 * race entirely and plays Calypso instantly, and the 4 s budget stays intact
 * for anything not warmed.
 *
 * Small and text-keyed: a few distinct scripts per session at most (the text
 * changes as the position updates), so an LRU of a handful is plenty and
 * costs nothing to miss.
 */
const PREWARM_LIMIT = 4;
const prewarmed = new Map<string, string>();

/**
 * Synthesise `text` now and hold the audio for a later
 * `speakSafetyMessage(text)`. Fire-and-forget: failures are swallowed,
 * because a failed pre-warm must degrade to the ordinary race, never to an
 * error in front of the skipper.
 */
export function prewarmSafetyMessage(text: string, opts: { voiceSettings?: VoiceSettingsOverride } = {}): void {
    const trimmed = (text || '').trim();
    if (!trimmed || prewarmed.has(trimmed)) return;
    void synthesise(trimmed, { voiceSettings: opts.voiceSettings })
        .then((audio) => {
            if (!audio) return;
            // Evict oldest first; Map preserves insertion order.
            if (prewarmed.size >= PREWARM_LIMIT) {
                const oldest = prewarmed.keys().next().value;
                if (oldest !== undefined) prewarmed.delete(oldest);
            }
            prewarmed.set(trimmed, audio);
        })
        .catch(() => {
            /* a missed pre-warm just means the normal race runs */
        });
}

/** Test seam. */
export function __clearSafetyPrewarmForTests(): void {
    prewarmed.clear();
}

/** Is audio already in hand for this exact text? */
export function hasPrewarmedSafetyAudio(text: string): boolean {
    return prewarmed.has((text || '').trim());
}

export interface SafetyUtteranceOptions {
    /** What was actually spoken — useful for logging or transcripts. */
    onPlaybackStart?: (engine: 'calypso' | 'native') => void;
    /** Fires when the selected playback path reports normal completion. */
    onPlaybackEnd?: () => void;
    /**
     * How long to wait for Calypso before falling back to the native voice.
     * Defaults to the 4 s safety budget. Pass ROUTINE_TTS_BUDGET_MS for
     * anything that is not an emergency — and show a pending state while it
     * runs, because the skipper cannot tell waiting from broken.
     */
    budgetMs?: number;
    /**
     * Fires the moment the race starts, before either engine speaks. The
     * hook for a "preparing" state on a longer budget.
     */
    onSynthesisStart?: () => void;
    /** Fires if both engines fail outright. UI can show a banner. */
    onError?: (err: Error) => void;
    /** Native-voice rate (0.5 - 2.0). Default 0.85 — a touch slower
     *  than conversational, matches VHF cadence convention. */
    nativeRate?: number;
    /** Native-voice pitch (0 - 2). Default 0.9 — slightly lower for
     *  authority. */
    nativePitch?: number;
    /**
     * ElevenLabs voice-settings override. Emergency comms (MOB,
     * Mayday, DSC) pass slower/calmer settings here so Calypso
     * sounds deliberate and professional, not hyped. The default
     * tone from the edge function is already tuned slower than
     * casual chat after Shane's "less Taylor Swift" feedback;
     * this is for cases that want EXTRA deliberate pacing.
     *
     *   speak with default tone: omit
     *   speak slower (emergency): { speed: 0.85, stability: 0.8 }
     */
    voiceSettings?: VoiceSettingsOverride;
}

export interface SafetyUtteranceHandle {
    /** True when playback has fully completed (or failed). */
    done: Promise<void>;
    /** Cancel mid-playback. Idempotent. */
    cancel: () => void;
    /** Which engine ended up speaking — read after `done` resolves
     *  if the caller wants to surface it in the UI ("Sent via
     *  Calypso voice" / "Sent via fallback voice"). */
    engineUsed: () => 'calypso' | 'native' | 'none';
}

/**
 * Play base64 MP3 (Calypso's synthesised voice) through whichever
 * audio path is appropriate for the current platform. On iOS native
 * we go through the AppleMusic plugin's `playTtsAudio` (AVAudioPlayer
 * in our `.playback + .mixWithOthers` session). On web/non-iOS we
 * fall back to HTML5 Audio.
 *
 * Returns a handle with a `done` promise that resolves when playback
 * completes, plus a `cancel()` that stops it mid-stream.
 */
async function playCalypsoB64(b64: string): Promise<{ done: Promise<void>; cancel: () => void }> {
    // Try native plugin first.
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
                return {
                    done: playPromise.then(() => undefined).catch(() => undefined),
                    cancel: () => {
                        void plugin.cancelTtsAudio().catch(() => undefined);
                    },
                };
            }
        }
    } catch {
        /* fall through to HTML5 */
    }

    // HTML5 fallback (web / non-iOS-native).
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = 1.0;
        audio.setAttribute('playsinline', 'true');

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            URL.revokeObjectURL(url);
        };

        const done = new Promise<void>((resolve) => {
            audio.addEventListener(
                'ended',
                () => {
                    cleanup();
                    resolve();
                },
                { once: true },
            );
            audio.addEventListener(
                'error',
                () => {
                    cleanup();
                    resolve();
                },
                { once: true },
            );
            audio.play().catch(() => {
                cleanup();
                resolve();
            });
        });

        return {
            done,
            cancel: () => {
                try {
                    audio.pause();
                } catch {
                    /* ignore */
                }
                cleanup();
            },
        };
    } catch {
        return { done: Promise.resolve(), cancel: () => undefined };
    }
}

/**
 * Novelty and gimmick voices Apple still ships. Any of these reading a
 * MAYDAY would be grotesque, so they are excluded by name before quality
 * ranking even runs.
 */
const NOVELTY_VOICE =
    /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|hysterical|pipe organ|ralph|fred|junior|kathy/i;

/** Higher is better. Apple exposes quality only in the NAME on the web
 *  speech API, so that is what we rank on. */
function voiceQualityRank(name: string): number {
    if (/siri/i.test(name)) return 4;
    if (/premium/i.test(name)) return 3;
    if (/enhanced/i.test(name)) return 2;
    return 1; // compact / default — the robotic one
}

/** Locale preference: Shane sails Australian waters, and a Mayday read in
 *  the listener's own accent is marginally easier to copy on a noisy VHF
 *  channel. Falls through to any English voice rather than failing. */
function localeRank(lang: string): number {
    const l = (lang || '').toLowerCase().replace('_', '-');
    if (l.startsWith('en-au')) return 4;
    if (l.startsWith('en-gb')) return 3;
    if (l.startsWith('en-us')) return 2;
    if (l.startsWith('en')) return 1;
    return 0;
}

/**
 * Best English voice this device actually has.
 *
 * The fallback path used to construct the utterance and set no voice at
 * all, so iOS handed back its default — usually the compact voice, which
 * is the "1980s autopilot" this module's own header complains about. The
 * fallback is the one that fires when the network is poor, which at sea is
 * exactly when the Mayday matters, so it deserves the best voice on the
 * device rather than the first one.
 *
 * Returns null when the list is empty (iOS populates it asynchronously and
 * may not have yet) — the caller then leaves `voice` unset, which is the
 * old behaviour and still speaks.
 */
/**
 * Warm the voice list.
 *
 * iOS populates `getVoices()` asynchronously and returns an EMPTY array on
 * the first synchronous call after load — so the very first Mayday, the one
 * most likely to be the real one, would fall back to the default voice no
 * matter how good the picker is. Touching the list at module load and again
 * on `voiceschanged` means it is populated long before anyone presses the
 * button. Cheap, idempotent, and safe if the API is missing.
 */
function warmNativeVoices(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.addEventListener?.('voiceschanged', () => {
            try {
                window.speechSynthesis.getVoices();
            } catch {
                /* nothing to do — the picker degrades to the default voice */
            }
        });
    } catch {
        /* no speech synthesis on this platform */
    }
}
warmNativeVoices();

export function pickBestNativeVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
    const candidates = voices.filter((v) => localeRank(v.lang) > 0 && !NOVELTY_VOICE.test(v.name));
    if (candidates.length === 0) return null;
    return candidates.reduce((best, v) => {
        const score = voiceQualityRank(v.name) * 10 + localeRank(v.lang);
        const bestScore = voiceQualityRank(best.name) * 10 + localeRank(best.lang);
        if (score !== bestScore) return score > bestScore ? v : best;
        // Tie-break toward an on-device voice: no network, no latency, and
        // it cannot fail halfway through a distress call.
        if (v.localService !== best.localService) return v.localService ? v : best;
        return best;
    });
}

/**
 * Speak the given text. Race ElevenLabs synthesis against
 * `SAFETY_TTS_BUDGET_MS`; if synth wins, commit to Calypso, otherwise
 * fall back to native iOS speech synthesis. Decision is made before
 * any audio plays — the two engines never run simultaneously.
 *
 * Cancellation: returned handle's `cancel()` aborts whichever engine
 * has been committed to (or the in-flight synthesis if neither has
 * been committed yet).
 */
export function speakSafetyMessage(text: string, opts: SafetyUtteranceOptions = {}): SafetyUtteranceHandle {
    const trimmed = (text || '').trim();
    let cancelled = false;
    let calypsoCancelFn: (() => void) | null = null;
    let nativeUtt: SpeechSynthesisUtterance | null = null;
    let engineUsed: 'calypso' | 'native' | 'none' = 'none';

    const done = (async () => {
        if (!trimmed) return;

        // ── Race synthesis against the budget ───────────────────────
        // Whichever resolves first wins. If synth comes back with
        // audio_b64, we play Calypso. If synth returns null (failure)
        // OR the timeout fires, we go native. The race never hands
        // back a "Calypso is playing — sort of" intermediate state,
        // so we can't double-fire.
        // Already synthesised? Then there is nothing to race — play the good
        // voice immediately. This is the path a pre-warmed Mayday takes.
        const ready = prewarmed.get(trimmed) ?? null;
        const synthPromise: Promise<string | null> = ready
            ? Promise.resolve(ready)
            : synthesise(trimmed, { voiceSettings: opts.voiceSettings });
        if (!ready) opts.onSynthesisStart?.();
        const timeoutPromise = new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), opts.budgetMs ?? SAFETY_TTS_BUDGET_MS);
        });
        const audio_b64 = ready ?? (await Promise.race([synthPromise, timeoutPromise]));

        if (cancelled) return;

        // ── Calypso path ────────────────────────────────────────────
        if (audio_b64) {
            engineUsed = 'calypso';
            opts.onPlaybackStart?.('calypso');
            const handle = await playCalypsoB64(audio_b64);
            calypsoCancelFn = handle.cancel;
            if (cancelled) {
                handle.cancel();
                return;
            }
            await handle.done;
            opts.onPlaybackEnd?.();
            return;
        }

        // ── Native fallback ─────────────────────────────────────────
        // Calypso couldn't deliver in time (or at all). Play through
        // iOS speechSynthesis. Always available — Apple's
        // SFSpeechSynthesizer is OS-level, no network needed.
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
            opts.onError?.(new Error('No speech synthesis available'));
            return;
        }
        try {
            const utt = new SpeechSynthesisUtterance(trimmed);
            utt.rate = opts.nativeRate ?? 0.85;
            utt.pitch = opts.nativePitch ?? 0.9;
            // Pick the best voice the device has rather than accepting the
            // default. iOS ships Siri/Premium/Enhanced voices alongside the
            // compact one, and the default is often the compact.
            try {
                const best = pickBestNativeVoice(window.speechSynthesis.getVoices() ?? []);
                if (best) {
                    utt.voice = best;
                    utt.lang = best.lang;
                }
            } catch {
                /* voice list unavailable — the default still speaks */
            }
            engineUsed = 'native';
            await new Promise<void>((resolve) => {
                let started = false;
                utt.onstart = () => {
                    started = true;
                    opts.onPlaybackStart?.('native');
                };
                utt.onend = () => {
                    opts.onPlaybackEnd?.();
                    resolve();
                };
                utt.onerror = () => {
                    // A native utterance can fail after `onstart` (audio-session
                    // interruption, route loss, synthesis failure). Callers of
                    // emergency scripts must be told that playback was not
                    // completed, even if a fragment was already spoken.
                    opts.onError?.(
                        new Error(started ? 'Native synth stopped before completion' : 'Native synth failed'),
                    );
                    resolve();
                };
                if (cancelled) {
                    resolve();
                    return;
                }
                nativeUtt = utt;
                speechSynthesis.speak(utt);
            });
        } catch (err) {
            opts.onError?.(err as Error);
        }
    })();

    return {
        done,
        cancel: () => {
            cancelled = true;
            if (calypsoCancelFn) {
                try {
                    calypsoCancelFn();
                } catch {
                    /* ignore */
                }
            }
            if (nativeUtt && typeof window !== 'undefined' && 'speechSynthesis' in window) {
                try {
                    speechSynthesis.cancel();
                } catch {
                    /* ignore */
                }
            }
        },
        engineUsed: () => engineUsed,
    };
}
