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
export const ARCHIVE_NOT_LOADED_UNDER_LINE = 'Not loaded';

/** Signed out there is no account history to load, so "didn't load" is not
 *  true for this skipper: the Log says what it holds and what signing in adds
 *  (UX scorecard run 10). */
export const LOG_SIGNED_OUT_BODY = 'Sign in to see voyages from your other devices.';
/** The page-level line for a signed-out phone, in place of HISTORY_PHONE_ONLY. */
export const LOG_SIGNED_OUT_LINE = `Voyages on this phone. ${LOG_SIGNED_OUT_BODY}`;

/** One card recipe for the Log's sibling disclosure cards (Voyage stats,
 *  Archived voyages): Plan's Departure material and radius, so the two no
 *  longer differ in corner, surface, title colour and icon. */
export const LOG_CARD_SHELL =
    'overflow-hidden rounded-2xl border border-sky-500/20 bg-linear-to-br from-sky-500/10 to-slate-900/40 shadow-[0_0_20px_rgba(14,165,233,0.08)]';
/** Archived voyages keeps the recipe but wears a gold hue (Shane 2026-09-29:
 *  identical to Voyage stats directly above it, the two did not read apart at
 *  a glance). Border, glow and a faint wash only — not the filled amber of the
 *  'history didn't load' notice, so it never reads as a warning. */
export const LOG_CARD_SHELL_ARCHIVED =
    'overflow-hidden rounded-2xl border border-amber-300/40 bg-linear-to-br from-amber-400/10 to-slate-900/40 shadow-[0_0_22px_rgba(251,191,36,0.14)]';
/** The card's title is a tappable row title, so it wears the app's one row
 *  recipe (Settings, the Vessel hub, Scuttlebutt): bold white sentence case
 *  over a grey description. Tracked sky capitals made 'VOYAGE STATS' read as
 *  a section eyebrow, a second recipe for the same kind of row (UX scorecard
 *  run 10); tracked capitals stay for eyebrows and chips. */
export const LOG_CARD_TITLE = 'block text-sm font-bold text-white';

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
