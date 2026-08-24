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
/**
 * Raised while the app is suspended in the background.
 *
 * pagehide does NOT fire when a Capacitor app is backgrounded, so a process
 * terminated while suspended — which iOS does constantly, and which costs the
 * skipper nothing — used to read as PROCESS-DIED. On 2026-08-09 that produced
 * a trail claiming a foreground death on a session whose last crumb was a
 * weather call two minutes earlier: it had simply been backgrounded and
 * reaped. Same blind spot webContentKill had, fixed the same way — Capacitor's
 * appStateChange is the reliable signal.
 */
const SUSPENDED_KEY = 'thalassa_flight_suspended';
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
let lastReport: FlightReport | null = null;

/**
 * The verdict on the PREVIOUS run, as classified at this boot.
 *
 * This is the couch-readable half of the recorder. The crumbs always survived
 * a process kill; the verdict always printed to the Xcode console — a channel
 * that requires a Mac, a cable, and sobriety, none of which are reliably
 * aboard. The System Status modal renders this instead, so "the map died at
 * Lady Musgrave" becomes a screenshot of the i-FAB rather than a boat-to-desk
 * forensics session (Shane 2026-08-24, phone-only Musgrave crash, wine in
 * hand).
 */
export function getLastFlightReport(): FlightReport | null {
    return lastReport;
}

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

export type FlightVerdict = 'process-died' | 'controlled-reload' | 'suspended-kill' | 'clean-start';

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
    let wasSuspended = false;
    try {
        prior = read(TRAIL_KEY);
        cleanExit = localStorage.getItem(CLEAN_EXIT_KEY) === '1';
        wasSuspended = localStorage.getItem(SUSPENDED_KEY) === '1';
        localStorage.setItem(PREV_KEY, JSON.stringify(prior));
        localStorage.removeItem(TRAIL_KEY);
        localStorage.removeItem(CLEAN_EXIT_KEY);
        localStorage.removeItem(SUSPENDED_KEY);
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

    // The suspend marker, via the signal that actually fires on iOS. Raised
    // when the app leaves the foreground, lowered when it returns — so a death
    // while it is raised is a background reap, and a death while it is lowered
    // is the real thing. Fire-and-forget import: the recorder must never make
    // boot wait, and on web the module simply is not there.
    void import('@capacitor/app')
        .then(({ App }) =>
            App.addListener('appStateChange', ({ isActive }) => {
                try {
                    if (isActive) localStorage.removeItem(SUSPENDED_KEY);
                    else localStorage.setItem(SUSPENDED_KEY, '1');
                } catch {
                    /* ignore */
                }
            }),
        )
        .catch(() => undefined);

    // Suspended-kill is checked BEFORE process-died: a raised suspend marker
    // means the last thing known about the session is that it left the
    // foreground, and iOS reaping it there is routine, not a crash.
    let verdict: FlightVerdict;
    if (prior.length === 0) verdict = 'clean-start';
    else if (cleanExit) verdict = 'controlled-reload';
    else if (wasSuspended) verdict = 'suspended-kill';
    else verdict = 'process-died';

    const last = prior[prior.length - 1];
    const summary =
        verdict === 'clean-start'
            ? 'no prior trail — clean start'
            : verdict === 'controlled-reload'
              ? `previous run ended in a CONTROLLED RELOAD (lazyRetry chunk failure or resetSettings), last crumb: ${last?.tag ?? 'n/a'}`
              : verdict === 'suspended-kill'
                ? `previous run was terminated while BACKGROUNDED — routine iOS reaping, not a foreground crash. last crumb: ${last?.tag ?? 'n/a'} @${last?.t ?? '?'}ms`
                : `previous run DIED IN THE FOREGROUND without running JS, last crumb: ${last?.tag ?? 'n/a'} @${last?.t ?? '?'}ms`;

    lastReport = { verdict, trail: prior, summary };
    return lastReport;
}

/**
 * Append the census's last-alive bound to the previous-run report. The trail
 * is event-driven — kill #28's fatal web trail ended at 29.6 s while the
 * timer-driven census kept ticking to 121 s, so the death hid behind 91 s of
 * apparent silence. useAppBootstrap reads the dead session's census (before
 * startCensus overwrites it) and hands the bound here; the Last Flight card
 * then shows how long the process REALLY lived past its last crumb.
 */
export function attachLastAliveInfo(sinceBootSecs: number): void {
    if (!lastReport || lastReport.verdict === 'clean-start') return;
    lastReport = {
        ...lastReport,
        summary: `${lastReport.summary} — last census tick ~${sinceBootSecs}s into that run (death after this point)`,
    };
}

/** The previous run's trail, for surfacing in a debug view. */
export function lastFlightTrail(): Crumb[] {
    return read(PREV_KEY);
}
