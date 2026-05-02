/**
 * Sundowner reminder — schedule a one-shot Calypso alert before sunset.
 *
 * "Calypso, remind me 30 minutes before sunset to put the anchor light
 * on and pour myself a gin." Schedules a setTimeout that, when it
 * fires, dispatches an AlertEvent through AlertNotifier — same
 * primitive the proactive-alert system uses, so it gets the chime +
 * voice + page takeover treatment.
 *
 * Limitations:
 *   - setTimeout is foreground-only on iOS. If the app is fully
 *     suspended (which iOS does after some time even with audio
 *     UIBackgroundMode), the timer dies. The user gets the reminder
 *     reliably only if the app stays alive — i.e. if they have the
 *     voice console open or are otherwise interacting.
 *   - Sunset time comes from the caller (looked up from weather
 *     data). The tool doesn't compute astronomical sunset itself.
 *
 * Future hardening: convert to @capacitor/local-notifications so
 * iOS schedules the reminder at the OS level even if the app is
 * backgrounded or killed. Deferred — V1 ships the foreground-only
 * timer to validate the UX before the package install.
 */

import { dispatchAlert } from '../../AlertNotifier';
import type { AlertEvent } from '../../../types/alerts';

/** Currently-pending sundowner timer. We only allow one at a time —
 *  scheduling a new one cancels the previous (skipper presumably
 *  meant the new time, not both). */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFireAt: number | null = null;
let pendingMessage: string | null = null;

/**
 * Schedule a reminder to fire `minutesBefore` ahead of `sunsetIso`.
 * If `sunsetIso` is in the past, returns "sunset_already_passed".
 * If the resulting fire time is in the past (i.e. minutes-before is
 * larger than time-to-sunset), fires immediately.
 */
export async function setSundownerReminder(
    sunsetIso: string,
    minutesBefore: number,
    customMessage?: string,
): Promise<{ content: string; isError: boolean }> {
    const sunsetMs = new Date(sunsetIso).getTime();
    if (!isFinite(sunsetMs)) {
        return { content: `ERROR: invalid sunset time '${sunsetIso}'`, isError: true };
    }
    const now = Date.now();
    if (sunsetMs < now) {
        return {
            content: JSON.stringify({
                status: 'sunset_already_passed',
                sunset_iso: sunsetIso,
                note: "Sunset is already past. Tell the skipper they'll need to set this for tomorrow.",
            }),
            isError: false,
        };
    }

    const lead = Math.max(0, Math.min(180, minutesBefore || 30));
    const fireAt = sunsetMs - lead * 60 * 1000;
    const delay = Math.max(0, fireAt - now);

    // Cancel any pending one — single-slot reminder.
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
    }

    const message =
        customMessage?.trim() ||
        `Skipper, sunset's in ${lead} minutes. Anchor light on, deck stowed, time for a sundowner.`;

    pendingFireAt = fireAt;
    pendingMessage = message;
    pendingTimer = setTimeout(() => {
        const now2 = Date.now();
        const event: AlertEvent = {
            ruleId: 'sundowner',
            severity: 'warn',
            title: 'Sundowner',
            spokenMessage: message,
            firstViolatingAt: now2,
            firedAt: now2,
        };
        void dispatchAlert(event);
        pendingTimer = null;
        pendingFireAt = null;
        pendingMessage = null;
    }, delay);

    return {
        content: JSON.stringify({
            status: 'scheduled',
            fire_at_iso: new Date(fireAt).toISOString(),
            sunset_iso: sunsetIso,
            minutes_before: lead,
            delay_min: Number((delay / 60_000).toFixed(1)),
            note: `Confirm to the skipper briefly: "Reminder set for ${lead} minutes before sunset." Don't recite the ISO. Tell them honestly: "If you fully close the app I lose the timer — keep me alive in the background."`,
        }),
        isError: false,
    };
}

/**
 * Cancel the pending reminder (if any). Used for "never mind, cancel
 * that sundowner" follow-ups.
 */
export async function cancelSundownerReminder(): Promise<{ content: string; isError: boolean }> {
    if (!pendingTimer) {
        return {
            content: JSON.stringify({ status: 'no_pending' }),
            isError: false,
        };
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingFireAt = null;
    pendingMessage = null;
    return {
        content: JSON.stringify({ status: 'cancelled' }),
        isError: false,
    };
}

/** Read the currently-scheduled reminder, if any. */
export async function getPendingSundowner(): Promise<{ content: string; isError: boolean }> {
    if (!pendingTimer || !pendingFireAt) {
        return {
            content: JSON.stringify({ status: 'no_pending' }),
            isError: false,
        };
    }
    return {
        content: JSON.stringify({
            status: 'pending',
            fire_at_iso: new Date(pendingFireAt).toISOString(),
            message: pendingMessage,
            minutes_until: Number(((pendingFireAt - Date.now()) / 60_000).toFixed(1)),
        }),
        isError: false,
    };
}
