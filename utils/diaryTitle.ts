/**
 * The default title of a fresh diary entry: "Monday 14 January 2026 · 14:32".
 * The keyboard doesn't pop up on open — the skipper only edits the title if
 * they tap into the field.
 *
 * On a screen under 390 pt it is the short form, "Wed 30 Sept 2026 · 08:48".
 * The field's text is 16 px on every phone (styles/ios-input-zoom.css: under
 * 16 px iOS zooms the page to the field), and at 16 px the longest long form,
 * "Wednesday 30 September 2026 · 08:48", is wider than the field at 375 and
 * at 320 (review, 2026-10-06), so its time was cut off at the right edge.
 * browser-tests/diary-compose-layout.spec.ts measures the widest of each form
 * over every day of 2026 and every minute.
 */

/** The narrowest screen, in CSS px, that takes the long form. */
export const DIARY_LONG_TITLE_MIN_WIDTH = 390;

/** True on a screen narrower than DIARY_LONG_TITLE_MIN_WIDTH. */
export function prefersCompactDiaryTitle(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(`(max-width: ${DIARY_LONG_TITLE_MIN_WIDTH - 0.02}px)`).matches;
}

export function formatEntryTitleDefault(d: Date, compact: boolean = prefersCompactDiaryTitle()): string {
    const weekday = d.toLocaleDateString('en-AU', { weekday: compact ? 'short' : 'long' });
    const month = d.toLocaleDateString('en-AU', { month: compact ? 'short' : 'long' });
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${weekday} ${d.getDate()} ${month} ${d.getFullYear()} · ${hh}:${mm}`;
}
