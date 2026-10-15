/**
 * The app's one display form for a calendar day: 'Sun 28 Sep 2026'.
 *
 * Bare toLocaleDateString() gave '28/9/2026' on Maintenance beside
 * '27/09/2026' elsewhere (UX scorecard run 9). Zero-padded dd/mm/yyyy stays
 * inside date inputs only.
 */
import { readLocalDay } from './localDate';

// Fixed names, not Intl: en-AU spells September 'Sept' on newer ICU.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 'Sun 28 Sep 2026', or '28 Sep 2026' with `weekday: false`. A stored day,
 * bare '2026-09-28' or synced '2026-09-28T00:00:00+00:00', is that LOCAL day
 * (utils/localDate readLocalDay, 131-B11; new Date() makes either UTC
 * midnight, the 27th west of Greenwich); any other timestamp is shown on the
 * local day it falls on, the same day the due-in-days count uses. '--' stands
 * in for a missing or unreadable date.
 */
export function formatDisplayDate(value: string | null | undefined, options: { weekday?: boolean } = {}): string {
    const date = readLocalDay(value);
    if (!date) return '--';
    const day = `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
    return options.weekday === false ? day : `${DAY_NAMES[date.getDay()]} ${day}`;
}
