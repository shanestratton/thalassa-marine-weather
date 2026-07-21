/**
 * flightRecorder — a black box for crashes that only happen on the boat.
 *
 * Two confident diagnoses of the "pick a far location → app returns to the
 * Glass" bug have now been wrong, because every theory was reasoned from
 * source with no evidence from the device. This records a short trail that
 * SURVIVES the event, so the next occurrence says what actually happened
 * instead of us guessing a third time.
 *
 * Why localStorage and not Sentry: a WKWebView content-process kill runs no
 * JS — no unload handler, no beforeunload, no flush. Anything buffered in
 * memory dies with the process. Only writes already on disk survive, so every
 * crumb is written SYNCHRONOUSLY at the moment it happens.
 *
 * ── How to read the verdict ──
 *
 * Two independent bits, captured at boot, classify the restart:
 *
 *   reload flag | prior crumbs | verdict
 *   ------------|--------------|-------------------------------------------
 *   set         | present      | window.location.reload() — a CONTROLLED
 *               |              | restart (lazyRetry chunk failure, or
 *               |              | settingsStore.resetSettings). NOT memory.
 *   absent      | present      | the process DIED without running JS —
 *               |              | WKWebView OOM / jetsam. The last crumb is
 *               |              | where it died.
 *   absent      | absent       | genuine cold start, nothing to report.
 *
 * `pagehide` fires for a reload but NOT for a content-process kill, which is
 * what makes the two cases separable at all.
 */

const TRAIL_KEY = 'thalassa_flight_trail';
const PREV_KEY = 'thalassa_flight_prev';
const CLEAN_EXIT_KEY = 'thalassa_flight_clean_exit';
const MAX_CRUMBS = 40;

export interface Crumb {
    /** ms since the page loaded — relative, so no clock dependency. */
    t: number;
    /** Short stable tag, e.g. 'pick:commit'. */
    tag: string;
    /** Optional detail: distance, cell counts, sizes. Keep it tiny. */
    info?: string;
}

let armed = false;

function read(key: string): Crumb[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as Crumb[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Drop a crumb. Synchronous by design — see the header. Costs one small
 * localStorage write, so keep call sites to genuine phase boundaries rather
 * than anything per-frame or per-particle.
 */
export function crumb(tag: string, info?: string): void {
    if (!armed) return;
    try {
        const trail = read(TRAIL_KEY);
        trail.push({ t: Math.round(performance.now()), tag, ...(info ? { info } : {}) });
        // Ring buffer: the crumbs just BEFORE the death are the interesting
        // ones, so drop from the front.
        localStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-MAX_CRUMBS)));
    } catch {
        /* storage full or unavailable — never let the recorder break the app */
    }
}

export type FlightVerdict = 'process-died' | 'controlled-reload' | 'clean-start';

export interface FlightReport {
    verdict: FlightVerdict;
    /** The trail from the previous run, oldest first. Empty on a clean start. */
    trail: Crumb[];
    /** Human-readable one-liner for the log. */
    summary: string;
}

/**
 * Call ONCE at startup, before anything heavy. Rotates the previous run's
 * trail aside, classifies how the last run ended, and arms recording.
 */
export function startFlightRecorder(): FlightReport {
    let prior: Crumb[] = [];
    let cleanExit = false;
    try {
        prior = read(TRAIL_KEY);
        cleanExit = localStorage.getItem(CLEAN_EXIT_KEY) === '1';
        localStorage.setItem(PREV_KEY, JSON.stringify(prior));
        localStorage.removeItem(TRAIL_KEY);
        localStorage.removeItem(CLEAN_EXIT_KEY);
    } catch {
        /* ignore */
    }

    armed = true;

    // pagehide runs for a reload/navigation but NOT for a process kill — that
    // asymmetry is the whole discriminator.
    try {
        window.addEventListener('pagehide', () => {
            try {
                localStorage.setItem(CLEAN_EXIT_KEY, '1');
            } catch {
                /* ignore */
            }
        });
    } catch {
        /* ignore */
    }

    let verdict: FlightVerdict;
    if (prior.length === 0) verdict = 'clean-start';
    else if (cleanExit) verdict = 'controlled-reload';
    else verdict = 'process-died';

    const last = prior[prior.length - 1];
    const summary =
        verdict === 'clean-start'
            ? 'no prior trail — clean start'
            : verdict === 'controlled-reload'
              ? `previous run ended in a CONTROLLED RELOAD (lazyRetry chunk failure or resetSettings), last crumb: ${last?.tag ?? 'n/a'}`
              : `previous run DIED WITHOUT RUNNING JS (WKWebView OOM / jetsam), last crumb: ${last?.tag ?? 'n/a'} @${last?.t ?? '?'}ms`;

    return { verdict, trail: prior, summary };
}

/** The previous run's trail, for surfacing in a debug view. */
export function lastFlightTrail(): Crumb[] {
    return read(PREV_KEY);
}
