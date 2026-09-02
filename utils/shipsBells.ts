/**
 * Ship's bells — the watch system a bell clock actually strikes.
 *
 * A watch is four hours. A bell is struck every half hour through it, one
 * more each time, so eight bells ends the watch and the count starts again.
 * They are struck in PAIRS — five bells is ding-ding, ding-ding, ding — which
 * is why the pattern matters as much as the number: a sailor counts pairs.
 *
 * THE DOG WATCHES are the exception, and they exist for a reason: 1600–2000
 * is split into two two-hour watches so the same men do not stand the same
 * watch every day. The first dog strikes 1–4. The last dog strikes 1, 2, 3 and
 * then EIGHT at 2000 to end the day's rotation — not 4, which is the mistake
 * every naive implementation makes.
 *
 * Pure and timezone-agnostic: callers pass the hour and minute they want
 * described, so the same maths serves the boat's clock, UTC, and anywhere the
 * skipper is dropping the hook.
 */

export type WatchName =
    | 'Middle Watch'
    | 'Morning Watch'
    | 'Forenoon Watch'
    | 'Afternoon Watch'
    | 'First Dog Watch'
    | 'Last Dog Watch'
    | 'First Watch';

export interface WatchPeriod {
    name: WatchName;
    /** Hour the watch begins, 0–23. */
    startHour: number;
    /** Hours it runs — four, or two for a dog watch. */
    lengthHours: number;
}

const WATCHES: WatchPeriod[] = [
    { name: 'Middle Watch', startHour: 0, lengthHours: 4 },
    { name: 'Morning Watch', startHour: 4, lengthHours: 4 },
    { name: 'Forenoon Watch', startHour: 8, lengthHours: 4 },
    { name: 'Afternoon Watch', startHour: 12, lengthHours: 4 },
    { name: 'First Dog Watch', startHour: 16, lengthHours: 2 },
    { name: 'Last Dog Watch', startHour: 18, lengthHours: 2 },
    { name: 'First Watch', startHour: 20, lengthHours: 4 },
];

/** The watch containing this time of day. */
export function watchAt(hour: number, minute: number): WatchPeriod {
    const h = ((Math.floor(hour) % 24) + 24) % 24;
    void minute;
    let found = WATCHES[0];
    for (const w of WATCHES) if (h >= w.startHour) found = w;
    return found;
}

/**
 * Bells struck at the most recent half hour, 1–8.
 *
 * Zero has no meaning here — the top of a watch IS eight bells, struck for the
 * watch that just ended — so 00:00, 04:00 and so on return 8, not 0.
 */
export function bellsAt(hour: number, minute: number): number {
    const h = ((Math.floor(hour) % 24) + 24) % 24;
    const halfHours = h * 2 + (minute >= 30 ? 1 : 0);
    const watch = watchAt(h, minute);
    const elapsed = halfHours - watch.startHour * 2;

    // The last dog watch ends on EIGHT bells at 2000, not four: it closes the
    // day's rotation. Its 18:00 boundary is still the eight bells of the
    // first dog watch that just ended.
    if (watch.name === 'Last Dog Watch' && elapsed === 0) return 8;
    if (elapsed === 0) return 8;
    return elapsed;
}

/** When the next bell falls: the next half hour, exactly. */
export function nextBellFrom(date: Date): Date {
    const next = new Date(date.getTime());
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() < 30 ? 30 : 60);
    return next;
}

/**
 * How the bells are struck: pairs, then any odd single.
 *
 * Five bells → [2, 2, 1]. This is what a sailor hears and counts, and it is
 * why the face groups its markers the same way.
 */
export function bellPattern(bells: number): number[] {
    const n = Math.max(0, Math.min(8, Math.floor(bells)));
    const pattern: number[] = [];
    for (let i = 0; i < Math.floor(n / 2); i++) pattern.push(2);
    if (n % 2 === 1) pattern.push(1);
    return pattern;
}

/** "Five bells" / "One bell" — how it is said, not how it is typed. */
export function bellsSpoken(bells: number): string {
    const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
    const n = Math.max(1, Math.min(8, Math.floor(bells)));
    return `${words[n]} bell${n === 1 ? '' : 's'}`;
}
