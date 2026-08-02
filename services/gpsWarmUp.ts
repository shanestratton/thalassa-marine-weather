/**
 * gpsWarmUp — get a fix ready before the skipper asks for one.
 *
 * Shane, 2026-08-02: "the acquiring GPS fix sits there for hours. Most apps
 * don't even need to wait. Maybe we could do the warm up as soon as we kick the
 * app off?" He was right about the cause. At launch the app only CONFIGURED the
 * location engine (BgGeoManager.ensureReady's own comment: "starts no
 * tracking"), so nothing listened to the GPS until some screen asked — and the
 * first screen that does was itself gated behind a weather fetch. Every cold
 * start therefore began its satellite hunt from zero, at the moment of need.
 *
 * This runs once per launch and holds the engine only long enough to get a
 * usable fix. It is a convenience, not a safety path: it never blocks boot,
 * never reports errors to the skipper, and its absence changes no behaviour
 * except latency.
 *
 * THREE RULES IT MUST NOT BREAK:
 *
 *  1. NEVER RAISE A PERMISSION PROMPT. Starting the engine is what triggers
 *     iOS's dialog. On a first-ever launch that would fire before onboarding
 *     has explained why the app wants position — so this bails unless
 *     permission is ALREADY granted (getGpsHealth is a query, not a request).
 *
 *  2. NEVER FIGHT THE REF-COUNT. Anchor watch, the ship's log and MOB all lease
 *     the same engine. This takes exactly one lease and releases it exactly
 *     once — `released` guards that, because requestStop clamps at zero and a
 *     double release would stop the engine out from under a live anchor watch.
 *
 *  3. NEVER OUTLIVE ITS WELCOME. Released on the first of: a good fix, the
 *     time box, or the app going to the background.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('gpsWarmUp');

/** Good enough to stop early — marine-usable, not survey-grade. */
const GOOD_ENOUGH_ACCURACY_M = 25;
/** Hard time box. Long enough for a cold urban/marina start, short enough that
 *  a phone left on a chart table is not holding the GPS open all afternoon. */
const WARM_UP_MS = 45_000;

let started = false;

/**
 * Start the location engine briefly so a fix is cached before any screen needs
 * one. Idempotent per app launch; safe to call from a boot effect.
 */
export async function warmUpGps(): Promise<void> {
    if (started) return;
    started = true;

    try {
        const { BgGeoManager } = await import('./BgGeoManager');

        // Rule 1 — a query, never a request.
        const health = await BgGeoManager.getGpsHealth();
        if (!health.usable) {
            log.warn(`GPS warm-up skipped — ${health.reason}`);
            return;
        }

        // Rule 2, and the one that nearly cost a voyage: NEVER TOUCH AN ENGINE
        // THAT IS ALREADY RUNNING.
        //
        // The engine survives app death (stopOnTerminate:false), but startCount
        // is plain JS state that resets to 0 with the WebView. So after a
        // mid-voyage reload or relaunch the engine is live while the ref-count
        // believes nobody holds it: the warm-up would take 0→1, get a fix
        // within a second or two because fixes are ALREADY flowing, and release
        // 1→0 — calling stop() on a recording voyage. ShipLogService.initialize
        // then reads isNativeTrackingEnabled() as its source of truth, sees
        // false, and marks the voyage STOPPED with an end time. That is the
        // relaunch black hole from 2da85a67, reopened by a convenience.
        // It also drops the anchor watch's geofences.
        //
        // Skipping is the correct semantics regardless: fixes are already
        // flowing, so there is nothing to warm up.
        if (await BgGeoManager.isNativeTrackingEnabled()) {
            log.warn('GPS warm-up skipped — engine already tracking');
            return;
        }

        // Already have something recent? Then there is nothing to warm up, and
        // holding the engine open would be pure battery. 120 s is generous on
        // purpose: this is the "is a fix ready" question, NOT a safety read.
        // Consumers with real freshness requirements (MOB 15 s, anchor watch
        // 5 s) call getFreshPosition with their own bounds and are unaffected.
        const existing = BgGeoManager.getLastPosition();
        if (existing && Date.now() - existing.receivedAt < 120_000) {
            log.warn('GPS warm-up skipped — a recent fix is already cached');
            return;
        }

        await BgGeoManager.requestStart();

        // At the steady 1 m distance filter a boat on a mooring emits almost
        // nothing on iOS, so a warm-up without this would hold the engine open
        // and still get no fix — the same trap that made "acquiring" hang.
        //
        // AWAITED for its token, and restored on release. distanceFilter 0 is
        // maximum battery, and the engine is shared: if any other consumer
        // holds a lease when the warm-up lets go (the Glass page does), the
        // engine keeps running — at 0 — for the rest of the session. The token
        // makes the restore a no-op if someone else has since set the mode
        // deliberately, so casting off mid-warm-up cannot cancel the ship's
        // log's own fast-lock.
        const samplingToken = await BgGeoManager.setSamplingMode('fastlock').catch(() => null);

        // Rule 2 — exactly one release, whichever exit fires first.
        let released = false;
        const release = (why: string) => {
            if (released) return;
            released = true;
            clearTimeout(timer);
            unsubscribe?.();
            window.removeEventListener('visibilitychange', onHidden);
            if (samplingToken !== null) {
                void BgGeoManager.restoreSamplingModeIfCurrent(samplingToken, 'default').catch(() => {});
            }
            void BgGeoManager.requestStop();
            log.warn(`GPS warm-up released (${why})`);
        };

        const timer = setTimeout(() => release('time box'), WARM_UP_MS);

        const onHidden = () => {
            if (document.visibilityState === 'hidden') release('app backgrounded');
        };
        window.addEventListener('visibilitychange', onHidden);

        const unsubscribe = BgGeoManager.subscribeLocation((pos) => {
            if (typeof pos.accuracy === 'number' && pos.accuracy > GOOD_ENOUGH_ACCURACY_M) return;
            release(`fix ±${Math.round(pos.accuracy ?? 0)} m`);
        });
    } catch (e) {
        // A warm-up that fails costs latency, nothing else. Never surfaced.
        log.warn(`GPS warm-up failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** Test-only: the once-per-launch latch outlives instances by design. */
export function resetGpsWarmUpForTest(): void {
    started = false;
}
