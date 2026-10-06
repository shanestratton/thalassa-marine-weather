/**
 * Numbers and times for the page, in the viewer's own locale and time zone
 * (GLOBAL: the page is for anyone, not only Australians).
 */

const NUM = new Intl.NumberFormat(undefined);
export const fmt = (n: number): string => NUM.format(Math.round(n));

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_FULL = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

const WHEN = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
});
const WHEN_YEAR = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "10:05 am" in the viewer's zone, for "Last updated …". */
export function clock(iso: string): string {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? CLOCK.format(new Date(t)) : '';
}

/** "Sat 3 Oct, 2:10 pm" in the viewer's zone (the times are already floored by the server). */
export function when(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return Date.now() - t > 300 * 86_400_000 ? WHEN_YEAR.format(d) : WHEN.format(d);
}

/**
 * How exactly a public sighting is placed: "on a 1 km grid" (within about
 * 800 m), the skipper's own wider uncertainty, or, for a threatened
 * species' area count, "in a 10 km square". The app's Public line says the
 * same grid (components/sightings/VisibilityPicker.tsx).
 */
export const precision = (uncertaintyM: number, generalised: boolean): string =>
    generalised
        ? 'in a 10 km square'
        : uncertaintyM > 1500
          ? `within about ${Math.round(uncertaintyM / 1000)} km`
          : 'on a 1 km grid';

export const yearsLabel = (years: readonly [number, number] | null): string =>
    !years ? '' : years[0] === years[1] ? String(years[0]) : `${years[0]}–${years[1]}`;
