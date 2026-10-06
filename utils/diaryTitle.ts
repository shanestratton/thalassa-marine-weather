/**
 * The default title of a fresh diary entry: "Monday 14 January 2026 · 14:32".
 * The keyboard doesn't pop up on open — the skipper only edits the title if
 * they tap into the field.
 *
 * On a screen under 428 pt it is the short form, "Wed 30 Sept 2026 · 08:48".
 * The field's text is 16 px on every phone (styles/ios-input-zoom.css: under
 * 16 px iOS zooms the page to the field), and at 16 px the longest long form,
 * "Wednesday 30 September 2026 · 08:48", is wider than the field at 375 and
 * at 320 (review, 2026-10-06), so its time was cut off at the right edge.
 * In wide fonts (Verdana; DejaVu Sans on the Linux CI runner, which also stand
 * in for iOS Bold Text) it is 354.8 px (354.19 on CI, run 37451031197), and
 * the field is the screen less 59 px: 333 at 390, 344 at 402, 355 at 414,
 * a fit by 0.2 px that the next pixel of padding would break. 428 (the Pro
 * Max and Plus phones) gives 369, 14 px to spare; no iPhone lies between.
 * browser-tests/diary-compose-layout.spec.ts measures the widest of each form
 * over every day of 2026 and every minute, in wide fonts.
 */

/** The narrowest screen, in CSS px, that takes the long form. */
export const DIARY_LONG_TITLE_MIN_WIDTH = 428;

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
