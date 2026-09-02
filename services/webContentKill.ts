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

/** Where the last boot sent the skipper after a death, if it did. */
const RESTORE_KEY = 'thalassa.lastRestore';

/**
 * Should we put the skipper back on `view`?
 *
 * No, if the previous boot already restored them there and it died again.
 * Observed in Shane's log on 2026-08-09:
 *
 *     died 2x ... on 'map'
 *     restoring the skipper to 'map'
 *     died 3x ... on 'map'
 *
 * Restoring into the screen that just killed the app is a crash loop, and a
 * loop is worse than the dashboard: the skipper cannot get out of it to reach
 * Settings, the chart cache, or anything else that might let them recover.
 * One attempt, then stand off.
 */
export function shouldRestore(view: string): boolean {
    const last = readJson<{ view?: string }>(RESTORE_KEY);
    return last?.view !== view;
}

/** Remember that we restored, so a second death on the same view stands off. */
export function noteRestored(view: string, now = Date.now()): void {
    writeJson(RESTORE_KEY, { view, at: now });
}

/** A session that ended cleanly clears the stand-off. */
export function clearRestoreGuard(): void {
    try {
        localStorage.removeItem(RESTORE_KEY);
    } catch {
        /* nothing to do */
    }
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

/**
 * A fingerprint of the running build, from the hashed bundle filename.
 *
 * Vite emits /assets/index-<hash>.js and the hash changes on every build, so
 * this identifies the install without a build-time constant or an async
 * Capacitor call on the boot path.
 *
 * Needed because an Xcode "Run" TERMINATES the previous app in the foreground.
 * Shane installed builds all day on 2026-08-09 and every one of them looked
 * exactly like a crash to this module — same missing cleanup, same raised flag.
 * A death across a build change is a reinstall, not a fault.
 */
function buildFingerprint(): string | null {
    try {
        const scripts = document.getElementsByTagName('script');
        for (const script of Array.from(scripts)) {
            const src = script.getAttribute('src') || '';
            const match = src.match(/\/assets\/[^/]*-([A-Za-z0-9_-]{6,})\.js/);
            if (match) return match[1];
        }
    } catch {
        /* fall through */
    }
    return null;
}

/** Raise the flag. Called at boot and whenever the app returns to the front. */
export function markSessionOpen(view: string | null, now = Date.now()): void {
    writeJson(OPEN_KEY, { at: now, view, build: buildFingerprint() });
}

/**
 * Was the previous session killed in the foreground? Consumes the flag.
 *
 * Returns the updated tally when it was, null when the last exit was orderly
 * (or when this is a first run).
 */
export function detectAbnormalExit(now = Date.now()): AbnormalExit | null {
    const open = readJson<{ at?: number; view?: string | null; build?: string | null }>(OPEN_KEY);
    if (open && typeof open.at === 'number') {
        const nowBuild = buildFingerprint();
        if (open.build && nowBuild && open.build !== nowBuild) {
            // Different bundle: the previous session ended because a new build
            // replaced it. Xcode kills the running app to install, which leaves
            // exactly the same evidence a crash does.
            markOrderlyExit();
            clearRestoreGuard();
            log.info('previous session ended at a build change — reinstall, not a crash');
            return null;
        }
    }
    if (!open || typeof open.at !== 'number') {
        // A clean boot means whatever we did last time worked. Let a future
        // death try a restore again.
        clearRestoreGuard();
        return null;
    }

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
/** The pending appStateChange registration, so it can be removed on teardown. */
let appStatePromise: Promise<{ remove: () => void } | null> | null = null;
/**
 * Bumped by every stop. An arm captures it and, when its own registration
 * finally resolves, refuses to keep a handle minted for a generation that has
 * already been torn down.
 *
 * Why a counter and not a boolean: arm/stop can interleave more than once in a
 * session (identity switches re-run the bootstrap), and a boolean cannot tell
 * "stopped, then re-armed" from "still stopped".
 */
let watchGeneration = 0;

/**
 * Stop watching and release the native listener.
 *
 * The registration is a PROMISE, and it can resolve after teardown has already
 * run — so the handle has to be awaited and removed then, not skipped. The
 * bootstrap has a test for exactly this shape of leak, and it caught this one.
 */
export function stopSessionWatch(): void {
    // Bump FIRST. An arm whose dynamic import is still in flight will compare
    // against this and remove itself on arrival — see the race below.
    watchGeneration += 1;
    const pending = appStatePromise;
    appStatePromise = null;
    if (!pending) return;
    void pending.then((handle) => handle?.remove()).catch(() => undefined);
}

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

        // THE ONE THAT MATTERS ON iOS. WKWebView does not reliably fire
        // visibilitychange when a Capacitor app is backgrounded — this
        // codebase already knew that (MusicPage: "Capacitor's appStateChange
        // is the reliable signal"; ShipLogService listens to both) and this
        // module did not. Without it, every ordinary suspend-then-terminate
        // left the flag raised and was reported as a foreground death, which
        // is how a count reached 21 on a day with no crash reports and no
        // Jetsam events to match.
        // ARMING IS IDEMPOTENT — one listener at a time, always.
        //
        // This assignment used to simply overwrite appStatePromise. Arm twice
        // without a stop between (an identity switch, a bootstrap remount, a
        // React StrictMode double-invoke) and the FIRST registration was
        // orphaned on the spot: nothing held it, so nothing could ever remove
        // it. On iOS that is a native appStateChange subscription outliving
        // its own React tree and writing session crumbs forever, one more
        // added every time the hook remounts.
        //
        // Releasing the previous one first is what makes the trace read
        // ARM → STOP → ARM instead of ARM → ARM → one STOP.
        stopSessionWatch();

        // THE ARM/STOP RACE, found 2026-09-02 by running the suite under heavy
        // load until useAppBootstrap's leak test failed honestly.
        //
        // Registration is two awaits deep: a dynamic import, then addListener.
        // If teardown lands between arming and arrival — which is ordinary on
        // a busy machine, and was reproducible at load average 110 — then
        // stopSessionWatch() runs while appStatePromise is still null, finds
        // nothing to release, and the listener that arrives moments later is
        // held by no one and removed by nobody. On iOS that is a native
        // appStateChange subscription surviving its own React tree, still
        // writing session crumbs for a screen that no longer exists.
        //
        // So the arm carries its generation with it and checks on arrival.
        const generation = watchGeneration;
        appStatePromise = import('@capacitor/app')
            .then(({ App }) =>
                App.addListener('appStateChange', ({ isActive }) => {
                    if (isActive) markSessionOpen(readCurrentViewCrumb());
                    else markOrderlyExit();
                }),
            )
            .then((handle) => {
                if (generation === watchGeneration) return handle;
                // Torn down while we were arming: release it immediately and
                // report nothing, so a later stop cannot double-remove.
                handle?.remove();
                return null;
            })
            .catch(() => null);
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
