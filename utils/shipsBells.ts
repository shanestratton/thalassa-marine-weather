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
 * Zero has no meaning here: the top of a watch is the LAST bell of the watch
 * that just ended, so 00:00 and 04:00 return 8 rather than 0.
 *
 * How many that last bell is depends on the watch that ended, and this is
 * where a naive implementation goes wrong. A four-hour watch ends on eight.
 * A dog watch is two hours and ends on FOUR — so 18:00 is four bells, closing
 * the first dog. The one exception is the last dog, which strikes EIGHT at
 * 2000 to close the day's rotation despite being two hours long.
 *
 * This function used to return 8 at every boundary, so it called 18:00 eight
 * bells. Caught by round-tripping the printed watch table against it
 * (tests/ShipsBellTable.test.ts) rather than by reading it again.
 */
export function bellsAt(hour: number, minute: number): number {
    const h = ((Math.floor(hour) % 24) + 24) % 24;
    const halfHours = h * 2 + (minute >= 30 ? 1 : 0);
    const watch = watchAt(h, minute);
    const elapsed = halfHours - watch.startHour * 2;
    if (elapsed > 0) return elapsed;

    const index = WATCHES.findIndex((w) => w.name === watch.name);
    const previous = WATCHES[(index - 1 + WATCHES.length) % WATCHES.length];
    return previous.name === 'Last Dog Watch' ? 8 : previous.lengthHours * 2;
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

/** The watches in the order a day runs through them. */
export const WATCH_ORDER: WatchName[] = WATCHES.map((w) => w.name);

/** Short names for a table heading, where "Forenoon Watch" will not fit. */
export const WATCH_SHORT: Record<WatchName, string> = {
    'Middle Watch': 'Middle',
    'Morning Watch': 'Morning',
    'Forenoon Watch': 'Forenoon',
    'Afternoon Watch': 'Afternoon',
    'First Dog Watch': 'Dog 1st',
    'Last Dog Watch': 'Dog Last',
    'First Watch': 'First',
};

function clockLabel(totalMinutes: number): string {
    // 24:00 rather than 00:00 for the First Watch's eight bells: it ends THIS
    // day, and every printed bell table says 24:00 there.
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * When a given number of bells falls in a given watch — or null where that
 * many bells is never struck in it.
 *
 * The dog watches are why this returns null at all. The first dog is two hours
 * so it stops at four bells. The last dog, in the convention this clock
 * strikes, goes 1, 2, 3 and then EIGHT at 2000 — nothing between. Printed
 * tables show a competing merchant convention of 5, 6, 7, 8 for those same
 * three times; both are real, and this one is the Royal Navy's, said to date
 * from the Nore mutiny of 1797, whose signal was five bells in the last dog.
 */
export function bellTime(watch: WatchName, bells: number): string | null {
    const w = WATCHES.find((x) => x.name === watch);
    if (!w || bells < 1 || bells > 8) return null;
    if (watch === 'Last Dog Watch') {
        if (bells <= 3) return clockLabel(w.startHour * 60 + bells * 30);
        if (bells === 8) return clockLabel(w.startHour * 60 + 120);
        return null;
    }
    if (bells > w.lengthHours * 2) return null;
    return clockLabel(w.startHour * 60 + bells * 30);
}
