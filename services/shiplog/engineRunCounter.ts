/** Voyage engine time from explicit declarations or fresh measured RPM. Never from SOG or polar estimates. */
export const ENGINE_RPM_VALID_MS = 13_000;
const MAX_RUN_MS = 366 * 86_400_000;

export interface EngineRunCounter {
    schema: 1;
    voyageId: string;
    startedAtMs: number;
    atMs: number;
    declared: boolean | null;
    rpm: { running: boolean; atMs: number } | null;
    logOnMs: number;
    rpmOnMs: number;
    offMs: number;
    unknownMs: number;
    clockUncertain: boolean;
    ended: boolean;
}

function time(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

export function newEngineRunCounter(voyageId: string, atMs: number): EngineRunCounter {
    if (!voyageId || voyageId.length > 200 || !time(atMs)) throw new RangeError('Invalid engine-log identity or clock');
    return {
        schema: 1,
        voyageId,
        startedAtMs: atMs,
        atMs,
        declared: null,
        rpm: null,
        logOnMs: 0,
        rpmOnMs: 0,
        offMs: 0,
        unknownMs: 0,
        clockUncertain: false,
        ended: false,
    };
}

/** Treat persisted counters as untrusted; malformed totals must never become a maintenance addition. */
export function validEngineRunCounter(raw: unknown, voyageId: string): raw is EngineRunCounter {
    if (!raw || typeof raw !== 'object') return false;
    const c = raw as EngineRunCounter;
    if (
        c.schema !== 1 ||
        c.voyageId !== voyageId ||
        !time(c.startedAtMs) ||
        !time(c.atMs) ||
        c.atMs < c.startedAtMs ||
        c.atMs - c.startedAtMs > MAX_RUN_MS ||
        ![true, false, null].includes(c.declared) ||
        typeof c.clockUncertain !== 'boolean' ||
        typeof c.ended !== 'boolean'
    )
        return false;
    if (c.rpm !== null && (!c.rpm || typeof c.rpm.running !== 'boolean' || !time(c.rpm.atMs) || c.rpm.atMs > c.atMs))
        return false;
    const totals = [c.logOnMs, c.rpmOnMs, c.offMs, c.unknownMs];
    return (
        totals.every((n) => Number.isSafeInteger(n) && n >= 0) &&
        totals.reduce((a, b) => a + b, 0) === c.atMs - c.startedAtMs
    );
}

export function advanceEngineRunCounter(counter: EngineRunCounter, atMs: number): EngineRunCounter {
    if (!validEngineRunCounter(counter, counter.voyageId)) throw new RangeError('Invalid engine-log counter');
    if (counter.ended) return counter;
    if (!time(atMs) || atMs < counter.atMs || atMs - counter.startedAtMs > MAX_RUN_MS) {
        return { ...counter, clockUncertain: true };
    }
    const next = { ...counter, atMs };
    const span = atMs - counter.atMs;
    if (counter.clockUncertain) {
        next.unknownMs += span;
        return next;
    }
    // RPM is allowed to override a declaration only for its own short source-clock window.
    const measuredEnd = counter.rpm ? Math.min(atMs, counter.rpm.atMs + ENGINE_RPM_VALID_MS) : counter.atMs;
    const measured = Math.max(0, measuredEnd - counter.atMs);
    if (measured > 0) {
        if (counter.rpm?.running) next.rpmOnMs += measured;
        else next.offMs += measured;
    }
    const remaining = span - measured;
    if (counter.declared === true) next.logOnMs += remaining;
    else if (counter.declared === false) next.offMs += remaining;
    else next.unknownMs += remaining;
    return next;
}

export function declareEngineRunning(counter: EngineRunCounter, running: boolean, atMs: number): EngineRunCounter {
    const next = advanceEngineRunCounter(counter, atMs);
    return next.ended ? next : { ...next, declared: running };
}

/** Source time, not reception time. Delayed, future or repeated samples do not extend the RPM window. */
export function observeEngineRpm(
    counter: EngineRunCounter,
    rpm: number,
    sourceAtMs: number,
    receivedAtMs: number,
): EngineRunCounter {
    const next = advanceEngineRunCounter(counter, receivedAtMs);
    if (
        next.ended ||
        next.clockUncertain ||
        !Number.isFinite(rpm) ||
        rpm < 0 ||
        rpm > 20_000 ||
        !time(sourceAtMs) ||
        sourceAtMs > receivedAtMs ||
        receivedAtMs - sourceAtMs > ENGINE_RPM_VALID_MS ||
        (counter.rpm !== null && sourceAtMs <= counter.rpm.atMs)
    )
        return next;
    // No back-filling before receipt: that time has already been classified, and cannot be counted twice.
    return { ...next, rpm: { running: rpm > 0, atMs: sourceAtMs } };
}

export function endEngineRunCounter(counter: EngineRunCounter, atMs: number): EngineRunCounter {
    return { ...advanceEngineRunCounter(counter, atMs), ended: true };
}

/** Pausing or changing account is not evidence of engine-off. The unobserved interval stays unknown. */
export function suspendEngineRunCounter(counter: EngineRunCounter, atMs: number): EngineRunCounter {
    const next = advanceEngineRunCounter(counter, atMs);
    return next.ended ? next : { ...next, declared: null, rpm: null };
}

export function engineRunSummary(counter: EngineRunCounter) {
    if (!validEngineRunCounter(counter, counter.voyageId)) throw new RangeError('Invalid engine-log counter');
    return {
        seconds: Math.floor((counter.logOnMs + counter.rpmOnMs) / 1000),
        loggedSeconds: Math.floor(counter.logOnMs / 1000),
        measuredSeconds: Math.floor(counter.rpmOnMs / 1000),
        unknownSeconds: Math.ceil(counter.unknownMs / 1000),
        clockUncertain: counter.clockUncertain,
        ended: counter.ended,
    };
}
