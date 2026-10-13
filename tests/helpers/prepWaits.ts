/**
 * The router prep's waits, held until the test lets each one land (128-ROUTE-P).
 *
 * A test's IO fakes (cells, OSM water, satellite water, bridges, notices,
 * tides, ETOPO) `ask` here instead of answering at once. The test then
 * `drive`s the route: it lands one waiting answer at a time, in the order a
 * `pick` rule chooses, until the route settles. Two uses:
 *
 * - order: land the answers in any order the prep allows (`pick`), to prove
 *   the route is the same whatever order they arrive in;
 * - time: each wait takes virtual milliseconds after it was asked (or after
 *   its `lane` is free: a serial queue such as the iOS plugin bridge), and the
 *   default `pick` lands the earliest due, so `now` is how long the prep would
 *   wait with those delays. CPU work takes no virtual time.
 *
 * Nothing here is real data: the answers are the test's own.
 */

export interface PrepWait {
    /** `name#n`: the n-th ask under that name. */
    name: string;
    seq: number;
    askedAt: number;
    due: number;
    lane?: string;
    land: () => void;
}

export type PickWait = (pending: readonly PrepWait[]) => PrepWait;

/** Timer ticks with no new ask before a wait lands. */
const QUIET_TICKS = 2;

/** The earliest due (ties: the first asked): the virtual clock's own order. */
export const earliestDue: PickWait = (pending) =>
    pending.reduce((a, b) => (b.due < a.due || (b.due === a.due && b.seq < a.seq) ? b : a));

/** First asked, first landed. */
export const firstAsked: PickWait = (pending) => pending.reduce((a, b) => (b.seq < a.seq ? b : a));

/** Last asked, first landed. */
export const lastAsked: PickWait = (pending) => pending.reduce((a, b) => (b.seq > a.seq ? b : a));

/** By name, in the order given (a name not listed lands last); the last asked among equals. */
export const byName =
    (order: readonly string[]): PickWait =>
    (pending) => {
        const rank = (w: PrepWait): number => {
            const at = order.findIndex((n) => w.name.startsWith(n));
            return at < 0 ? order.length : at;
        };
        return pending.reduce((a, b) => (rank(b) < rank(a) || (rank(b) === rank(a) && b.seq > a.seq) ? b : a));
    };

/** A fixed pseudo-random order (seeded), so a failure can be replayed. */
export function seeded(seed: number): PickWait {
    let s = seed >>> 0 || 1;
    return (pending) => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return [...pending].sort((a, b) => a.seq - b.seq)[s % pending.length];
    };
}

export class PrepWaits {
    pending: PrepWait[] = [];
    landed: { name: string; at: number }[] = [];
    seq = 0;
    /** Virtual milliseconds since reset(): moves only when a wait lands. */
    now = 0;
    /** Called with the new `now` whenever it moves (a test can set the system clock). */
    onTick: ((now: number) => void) | null = null;
    private counts = new Map<string, number>();
    private laneFree = new Map<string, number>();
    private laneBusy = new Map<string, number>();
    /** The most waits each lane has held at once (asked, not yet landed). */
    laneMax = new Map<string, number>();

    reset(): void {
        this.pending = [];
        this.landed = [];
        this.seq = 0;
        this.now = 0;
        this.onTick = null;
        this.counts.clear();
        this.laneFree.clear();
        this.laneBusy.clear();
        this.laneMax.clear();
    }

    /** How many waits under this name were asked for. */
    asked(name: string): number {
        return this.counts.get(name) ?? 0;
    }

    /**
     * Ask for `value()` under `name`. It lands when the driver lets it: `ms`
     * virtual milliseconds after now, or after its `lane` is free.
     */
    ask<T>(name: string, value: () => T | Promise<T>, ms = 0, lane?: string): Promise<T> {
        const n = (this.counts.get(name) ?? 0) + 1;
        this.counts.set(name, n);
        const start = lane ? Math.max(this.now, this.laneFree.get(lane) ?? 0) : this.now;
        const due = start + ms;
        if (lane) {
            this.laneFree.set(lane, due);
            const busy = (this.laneBusy.get(lane) ?? 0) + 1;
            this.laneBusy.set(lane, busy);
            this.laneMax.set(lane, Math.max(this.laneMax.get(lane) ?? 0, busy));
        }
        return new Promise<T>((resolve, reject) => {
            this.pending.push({
                name: `${name}#${n}`,
                seq: ++this.seq,
                askedAt: this.now,
                due,
                lane,
                land: () => {
                    if (lane) this.laneBusy.set(lane, (this.laneBusy.get(lane) ?? 1) - 1);
                    Promise.resolve().then(value).then(resolve, reject);
                },
            });
        });
    }

    /**
     * Land waits one at a time, as `pick` chooses, until `run` settles. Before
     * each landing it lets the prep ask for everything it is going to ask for
     * (QUIET_TICKS timer ticks in a row with no new ask), so `pick` sees every
     * wait at once.
     */
    async drive<T>(run: Promise<T>, pick: PickWait = earliestDue): Promise<T> {
        let done = false;
        run.then(
            () => (done = true),
            () => (done = true),
        );
        let seenSeq = -1;
        let quiet = 0;
        for (let tick = 0; !done && tick < 200_000; tick++) {
            await new Promise((r) => setTimeout(r, 1));
            if (done || this.pending.length === 0) continue;
            if (this.seq !== seenSeq) {
                seenSeq = this.seq;
                quiet = 0;
                continue;
            }
            if (++quiet < QUIET_TICKS) continue;
            quiet = 0;
            const next = pick(this.pending);
            this.pending.splice(this.pending.indexOf(next), 1);
            if (next.due > this.now) {
                this.now = next.due;
                this.onTick?.(this.now);
            }
            this.landed.push({ name: next.name, at: this.now });
            next.land();
        }
        return run;
    }
}

/** The one instance the test files' IO fakes ask (each file gets its own module copy). */
export const waits = new PrepWaits();
