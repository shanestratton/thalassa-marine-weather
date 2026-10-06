/**
 * Pure helpers + external-store adapters for LogPage — extracted verbatim from
 * pages/LogPage.tsx. No React, no component state.
 */

import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import type { ShipLogEntry } from '../../types';
import { FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS, SYSTEM_LOG_ENDPOINT_NAMES } from './logPageTypes';

/** A human-entered waypoint wins; recorder placeholders do not name a place. */
export function meaningfulLogEndpointName(entry: Pick<ShipLogEntry, 'waypointName'> | undefined): string | null {
    const name = entry?.waypointName?.trim();
    return name && !SYSTEM_LOG_ENDPOINT_NAMES.has(name) ? name : null;
}

/** Do not trap the cast-off sheet behind an unbounded marine-data request.
 *  Late fulfilments are consumed but ignored, so they cannot resurrect a
 *  selection after the UI has unlocked. */
export function withFollowRouteLoadDeadline<T>(promise: Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
            settled = true;
            resolve(null);
        }, FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export const subscribeIdentitySnapshot = (notify: () => void): (() => void) =>
    subscribeAuthIdentityScope(() => notify());
export const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

/** The one-second reading of "the lifetime read failed" (UX scorecard run 6:
 *  "Lifetime unavailable · this phone only" could not be read at a glance). */
export const LIFETIME_PHONE_ONLY = 'Totals from this phone only — full history didn’t load';

/** The archive's collapsed status after a failed read, in the same words as
 *  the totals ("didn't load"), not a second phrasing (UX scorecard run 7). */
export const ARCHIVE_DIDNT_LOAD = 'Archive didn’t load';

/** The one page-level line when BOTH history reads failed: one cause, one
 *  Retry, instead of two failure cards with a Retry each (UX scorecard run 7). */
export const HISTORY_PHONE_ONLY = 'Your full voyage history didn’t load — showing this phone only.';

/** Under that page-level line the failure is already said once, so the cards
 *  below it only say what they hold: the Voyage stats and Archived voyages
 *  status lines shrink to these (UX scorecard run 8: one failure was said
 *  three times). Without the line, the cards keep LIFETIME_PHONE_ONLY and
 *  ARCHIVE_DIDNT_LOAD, which carry the cause themselves. */
export const LIFETIME_PHONE_ONLY_UNDER_LINE = 'This phone only';
/** The Voyage stats card's own short form of LIFETIME_PHONE_ONLY, when no
 *  page line is above it: it still names the cause, in the archive's words. */
export const LIFETIME_DIDNT_LOAD = 'Totals didn’t load';
export const ARCHIVE_NOT_LOADED_UNDER_LINE = 'Not loaded';

/** Signed out there is no account history to load, so "didn't load" is not
 *  true for this skipper: the Log says what it holds and what signing in adds
 *  (UX scorecard run 10). */
export const LOG_SIGNED_OUT_BODY = 'Sign in to see voyages from your other devices.';
/** The page-level line for a signed-out phone, in place of HISTORY_PHONE_ONLY. */
export const LOG_SIGNED_OUT_LINE = `Voyages on this phone. ${LOG_SIGNED_OUT_BODY}`;

/** The Log's Voyage stats and Archived voyages cards wear the Vessel page's
 *  Diary and Scuttlebutt card (components/vesselHub/JournalCard) and its one
 *  accent, the hub's sky, so the three pages' pairs read as one (Shane
 *  2026-10-06: "make them look the same as the diary and scuttlebutt boxes for
 *  consistency"). The archive's gold hue (2026-09-29) told two identical
 *  stacked rows apart; side by side, with their own glyphs, they read apart
 *  as Diary and Scuttlebutt do. */
export const LOG_CARD_ACCENT = 'var(--day-ui-accent, #7dd3fc)';

/**
 * The full notice for a lifetime read that failed and never succeeded. It
 * names a cause only when the app already knows it (the probe-verified
 * offline state), and never says "incomplete" over tiles that show '--'
 * because this phone has nothing of its own to count.
 *
 * `underHistoryLine`: the page-level HistoryStatusLine is showing and has
 * already said the history didn't load (and that the phone is offline), so
 * the notice drops that lead sentence rather than repeat it word for word
 * directly under it (UX scorecard run 8).
 */
export function lifetimeUnavailableNotice(
    localVoyageCount: number,
    offline: boolean,
    underHistoryLine = false,
): string {
    const detail =
        localVoyageCount === 0
            ? 'There are no voyages on this phone to count yet.'
            : 'These totals count only the voyages on this phone.';
    if (underHistoryLine) return detail;
    const lead = offline
        ? 'Your full voyage history didn’t load — you’re offline.'
        : 'Your full voyage history didn’t load.';
    return `${lead} ${detail}`;
}
