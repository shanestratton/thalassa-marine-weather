/**
 * webContentKill — did the web layer die under us last time?
 *
 * THE PROBLEM IS AN EVIDENCE PROBLEM. Shane has reported the planning screen
 * "crashing back to the Glass page" since 2026-08-01, and every attempt to
 * chase it hit the same wall: nothing in the logs. Two genuine causes were
 * found and fixed anyway — auth churn re-navigating (d812494a) and ENC memory
 * pressure (0a607bd3) — and it still happens when he zooms in while adding a
 * leg.
 *
 * The logs are empty because iOS is not killing the app. Under memory pressure
 * it kills the WebContent process, and every line of our JavaScript dies with
 * it, logger included. Capacitor's WebViewDelegationHandler catches it, resets
 * the bridge and reloads — so the app survives, `uiStore` seeds currentView
 * from bootView at module scope ('dashboard'), and a memory kill becomes
 * indistinguishable from an ordinary cold boot. Same destination, no evidence.
 *
 * HOW THIS DETECTS IT WITHOUT NATIVE CODE. A process that is killed gets no
 * chance to tidy up. So: raise a flag while the app is in the foreground, and
 * lower it on every ORDERLY exit. If the flag is still raised at the next
 * boot, the previous session did not exit in an orderly way — it was killed.
 *
 * The discrimination that makes this worth having: the flag is lowered when the
 * app is BACKGROUNDED, so being killed while suspended (which iOS does to
 * everyone, all the time, and which costs the skipper nothing) is not reported.
 * Only a death while the skipper was actually looking at the screen survives
 * the filter — which is precisely the "I was zooming and it crashed" case.
 *
 * Everything here is localStorage and synchronous. A kill gives no warning and
 * no unload event; anything async may never flush, and a flag that isn't
 * written before the process dies is no flag at all.
 *
 * WHAT IT DOES NOT DO: prove the cause. It proves the event, with a count, a
 * time and the screen it happened on. That is the evidence the last two fixes
 * had and this one did not.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('webContentKill');

/** Raised while the app is in the foreground; cleared on an orderly exit. */
const OPEN_KEY = 'thalassa.sessionOpen';
/** The running tally of sessions that ended without one. */
const EXITS_KEY = 'thalassa.abnormalExits';

export interface AbnormalExit {
    /** How many foreground deaths this install has had. */
    count: number;
    /** When the most recent one was noticed (i.e. the following boot). */
    at: number;
    /** The screen the skipper was on when it died, if a breadcrumb existed. */
    view: string | null;
}

function readJson<T>(key: string): T | null {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode / quota. A diagnostic must never be the thing that
        // breaks the app it is diagnosing.
    }
}

/** The recorded history of foreground deaths. */
export function readAbnormalExit(): AbnormalExit | null {
    const record = readJson<Partial<AbnormalExit>>(EXITS_KEY);
    if (!record || typeof record.count !== 'number' || typeof record.at !== 'number') return null;
    return { count: record.count, at: record.at, view: typeof record.view === 'string' ? record.view : null };
}

/** Forget the history. For a diagnostics screen's "I've seen this". */
export function clearAbnormalExit(): void {
    try {
        localStorage.removeItem(EXITS_KEY);
    } catch {
        /* nothing to do */
    }
}

/** Lower the flag. Called on every orderly exit — backgrounding included. */
export function markOrderlyExit(): void {
    try {
        localStorage.removeItem(OPEN_KEY);
    } catch {
        /* nothing to do */
    }
}

/** Raise the flag. Called at boot and whenever the app returns to the front. */
export function markSessionOpen(view: string | null, now = Date.now()): void {
    writeJson(OPEN_KEY, { at: now, view });
}

/**
 * Was the previous session killed in the foreground? Consumes the flag.
 *
 * Returns the updated tally when it was, null when the last exit was orderly
 * (or when this is a first run).
 */
export function detectAbnormalExit(now = Date.now()): AbnormalExit | null {
    const open = readJson<{ at?: number; view?: string | null }>(OPEN_KEY);
    if (!open || typeof open.at !== 'number') return null;

    // The flag was still raised, so the previous session never exited in an
    // orderly way. Consume it before doing anything else: if the tally write
    // throws, the flag must still be down or every subsequent boot reports the
    // same death again.
    markOrderlyExit();

    const previous = readAbnormalExit();
    const record: AbnormalExit = {
        count: (previous?.count ?? 0) + 1,
        at: now,
        // The breadcrumb first: the flag's view is whatever was showing when
        // the flag was RAISED (boot, or return to foreground), while the
        // breadcrumb is rewritten on every navigation. A skipper who booted on
        // the dashboard and died on the planning screen must be reported as
        // dying on the planning screen. Safe to read here because this runs
        // before anything has navigated in the new session.
        view: readCurrentViewCrumb() ?? (typeof open.view === 'string' ? open.view : null),
    };
    writeJson(EXITS_KEY, record);
    return record;
}

/**
 * Start watching. Call once at boot, before anything can navigate.
 *
 * Returns the previous session's death if there was one, so the caller can log
 * it and put the skipper back where they were.
 */
export function armSessionWatch(currentView: string | null): AbnormalExit | null {
    let died: AbnormalExit | null = null;
    try {
        died = detectAbnormalExit();
        markSessionOpen(currentView);

        if (typeof document !== 'undefined') {
            // Backgrounding is an orderly exit. iOS kills suspended apps
            // constantly and it costs the skipper nothing; reporting those
            // would bury the one case that matters in noise.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') markOrderlyExit();
                else markSessionOpen(readCurrentViewCrumb());
            });
        }
        if (typeof window !== 'undefined') {
            // A real navigation away or a deliberate reload is orderly too.
            window.addEventListener('pagehide', markOrderlyExit);
        }
    } catch (err) {
        log.warn('could not arm the session watch', err);
    }
    return died;
}

/**
 * The view breadcrumb, read directly rather than through uiStore.
 *
 * Deliberately not an import: this module is on the boot path and must not
 * pull the store — and its listeners outlive any React tree.
 */
function readCurrentViewCrumb(): string | null {
    const crumb = readJson<{ view?: string }>('thalassa.lastView');
    return typeof crumb?.view === 'string' ? crumb.view : null;
}
