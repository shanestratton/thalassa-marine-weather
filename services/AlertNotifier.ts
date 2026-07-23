/**
 * AlertNotifier — Routes AlertEvents to the user.
 *
 * On every alert, we do four things in parallel:
 *
 *   1. Chime — short audible burst via AlarmAudioService for
 *      `critical` severity events. Bypasses the iOS mute switch
 *      (AVAudioSession is `.playback` category, the same primitive
 *      Anchor Watch uses). Intentionally short — half a second — so
 *      it doesn't compete with Calypso's voice.
 *
 *   2. Voice — Calypso speaks the alert via the standalone ttsClient.
 *      The HTML5 Audio playback rides the same active AVAudioSession
 *      so it's audible even when the app is backgrounded.
 *
 *   3. Page takeover — dispatch a `thalassa:navigate` event with
 *      tab=voice so App.tsx swaps to the Bosun voice page. The
 *      skipper sees the alert in the conversation log immediately.
 *      For non-critical alerts we skip the takeover (banner only).
 *
 *   4. Voice-history turn — write a synthesised "system" turn to
 *      voiceHistoryStore so the alert appears in the conversation
 *      log alongside Calypso's other replies. Includes the synthesised
 *      audio_b64 so the skipper can replay it from the log.
 *
 * Single concurrent utterance: a new alert preempts an in-flight one.
 * The preempted alert's voice is cancelled; its history-log turn is
 * left in place (so we don't lose the record).
 */

import { AlarmAudioService } from './AlarmAudioService';
import { type SpokenHandle, synthesise } from './voice/ttsClient';
import { useVoiceHistoryStore } from '../stores/voiceHistoryStore';
import type { AlertEvent } from '../types/alerts';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';

/** Currently-speaking utterance. Cancelled when a new alert preempts. */
let activeUtterance: SpokenHandle | null = null;
let activeDispatchEpoch = 0;
let activeChimeStopTimer: ReturnType<typeof setTimeout> | null = null;

subscribeAuthIdentityScope(() => {
    activeDispatchEpoch += 1;
    const hadActiveChime = activeChimeStopTimer !== null;
    if (activeChimeStopTimer) {
        clearTimeout(activeChimeStopTimer);
        activeChimeStopTimer = null;
    }
    if (hadActiveChime) void AlarmAudioService.stopAlarm().catch(() => undefined);
    try {
        activeUtterance?.cancel();
    } catch {
        /* best effort */
    }
    activeUtterance = null;
});

/**
 * Dispatch a fired alert to the user. Fire-and-forget — caller does
 * not await. Caller is the rule engine, which doesn't care about
 * playback timing.
 */
export async function dispatchAlert(event: AlertEvent): Promise<void> {
    const identity = getAuthIdentityScope();
    const dispatchEpoch = ++activeDispatchEpoch;
    // Capture the identity-bound action before the first await. The store
    // replaces its action closures on account transitions, and the captured
    // old closure then rejects this alert rather than writing it into B.
    const addHistoryTurn = useVoiceHistoryStore.getState().addTurn;
    const isCurrentDispatch = () => dispatchEpoch === activeDispatchEpoch && isAuthIdentityScopeCurrent(identity);

    // Preempt any in-flight utterance — the new alert is more recent
    // information than what's currently playing.
    if (activeUtterance) {
        try {
            activeUtterance.cancel();
        } catch {
            /* ignore */
        }
        activeUtterance = null;
    }
    if (activeChimeStopTimer) {
        clearTimeout(activeChimeStopTimer);
        activeChimeStopTimer = null;
    }

    // 1. Page takeover for critical events. Less aggressive for warns
    // — warns don't yank the skipper out of whatever page they're on.
    if (event.severity === 'critical' && isCurrentDispatch()) {
        try {
            window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'voice' } }));
        } catch {
            /* ignore — page event dispatch isn't load-bearing */
        }
    }

    // 2. Chime for critical only. We do not hold the alarm tone for the
    // duration of the alert — half a second of attention-grabbing,
    // then Calypso's voice.
    if (event.severity === 'critical') {
        try {
            await AlarmAudioService.startAlarm();
            if (!isCurrentDispatch()) {
                await AlarmAudioService.stopAlarm().catch(() => undefined);
                return;
            }
            const stopTimer = setTimeout(() => {
                if (activeChimeStopTimer === stopTimer) activeChimeStopTimer = null;
                void AlarmAudioService.stopAlarm().catch(() => undefined);
            }, 500);
            activeChimeStopTimer = stopTimer;
        } catch {
            /* ignore — chime is decoration, voice is the real signal */
        }
    }

    // 3. Synthesise + voice. We synthesise FIRST (rather than using
    // speak() in fire-and-forget mode) so we can persist the audio_b64
    // into the history turn — same shape as a normal Calypso reply.
    const audio_b64 = await synthesise(event.spokenMessage);
    if (!isCurrentDispatch()) return;

    // 4. Voice-history turn — visible in BosunConsole's log.
    try {
        addHistoryTurn({
            id: `alert-${event.ruleId}-${event.firedAt}`,
            timestamp: event.firedAt,
            // Empty transcript — the user didn't ask anything; this is
            // unprompted Calypso. The console UI handles empty
            // transcripts by suppressing the user-side bubble.
            transcript: '',
            response: {
                transcript: '',
                answer_text: event.spokenMessage,
                audio_b64: audio_b64 ?? undefined,
                // 'cloud' since the synthesis came through ElevenLabs.
                // No dedicated 'system' source variant — alert events are
                // distinguishable by the alert-prefixed turn id.
                source: 'cloud',
                tool_calls: [],
            },
            // Mark the speaker as Calypso so the bubble renders on the
            // assistant side of the log.
            userName: 'Calypso',
        });
    } catch (err) {
        console.warn('[AlertNotifier] failed to write history turn', err);
    }

    // 5. Play the audio. We bypass speak() because we already have the
    // base64; just turn it into a blob URL and play it. This keeps
    // playback parallel to the page navigation + history-turn write
    // above (the user sees the bubble appear at roughly the same
    // moment the audio starts).
    if (audio_b64 && isCurrentDispatch()) {
        const utterance = playFromBase64(audio_b64);
        activeUtterance = utterance;
        try {
            await utterance.done;
        } finally {
            if (activeUtterance === utterance) activeUtterance = null;
        }
    }
}

/**
 * Internal helper: turn a base64 MP3 string into a SpokenHandle just
 * like ttsClient.speak() does, but skip the synth network round-trip.
 */
function playFromBase64(b64: string): SpokenHandle {
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let objectUrl: string | null = null;

    const done = (async () => {
        let bytes: Uint8Array;
        try {
            const bin = atob(b64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch {
            return;
        }
        // Cast through BlobPart to dodge TS 5.7's stricter ArrayBufferLike
        // narrowing: Uint8Array's `.buffer` is now ArrayBufferLike (= ArrayBuffer
        // | SharedArrayBuffer), and Blob's constructor explicitly wants ArrayBuffer.
        // Runtime is unaffected — atob output never produces a SharedArrayBuffer.
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' });
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return;
        }
        audio = new Audio(objectUrl);
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
