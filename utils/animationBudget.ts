/**
 * animationBudget — keep the number of LIVE compositor animations under the
 * ceiling WebKit will kill us for.
 *
 * WHY THIS EXISTS. Shane's device logs, repeatedly:
 *
 *   Connection::sendMessage(): Too many messages (129) in the queue to remote
 *   PID: 0 (most common: 129 DrawingArea_AcceleratedAnimationDidStart)
 *   ... WebProcessProxy::didClose: (web process 0 crash)
 *
 * Every accelerated (compositor-run) animation sends an AnimationDidStart
 * message when it is created. WebKit's IPC queue caps at 129; blow past it
 * and iOS kills the WebContent process — the app then relaunches on its
 * default tab, which reads to the user as "the planning page threw me out to
 * the Glass".
 *
 * Two fixes were shipped on assumptions about WHEN animations start
 * (backgrounded pausing, then removal). Both were reasonable; both left the
 * crash in place. So this module stops assuming and starts MEASURING:
 * `document.getAnimations()` is the ground truth for what is actually
 * registered right now.
 *
 * It does two jobs:
 *   1. DIAGNOSE — when the count crosses the warn line, log the total and the
 *      top offending animation names, so the next report names the culprit
 *      instead of narrowing it one guess at a time.
 *   2. SHED — cross the budget and `body.animation-diet` goes on, which
 *      index.css uses to strip decorative animations (pulse/ping/bounce/
 *      entrances/custom infinites). Genuine loading spinners are kept: a
 *      frozen spinner reads as a hung app. The class comes off once the
 *      count falls well below budget, so the diet is self-releasing rather
 *      than a one-way downgrade.
 *
 * Deliberately cheap: one poll every 2 s, skipped entirely while hidden, and
 * it touches the DOM only when the state actually changes.
 */

import { createLogger } from './createLogger';

const log = createLogger('AnimBudget');

/** Shed above this many live animations — well clear of WebKit's 129 cap so
 *  a burst arriving between polls still has headroom. */
export const ANIMATION_BUDGET = 55;
/** Release the diet below this (hysteresis — no flapping at the boundary). */
const RELEASE_AT = 30;
const CHECK_MS = 2_000;
const DIET_CLASS = 'animation-diet';

interface AnimationLike {
    animationName?: string;
    transitionProperty?: string;
    effect?: { target?: Element | null } | null;
}

/** Human label for one animation — its keyframes name, else the element. */
function describe(animation: Animation): string {
    const candidate = animation as unknown as AnimationLike;
    if (candidate.animationName) return candidate.animationName;
    if (candidate.transitionProperty) return `transition:${candidate.transitionProperty}`;
    const target = candidate.effect?.target;
    if (target) {
        const className =
            typeof target.className === 'string' ? target.className.split(/\s+/).slice(0, 2).join('.') : '';
        return `${target.tagName.toLowerCase()}${className ? `.${className}` : ''}`;
    }
    return 'unknown';
}

/** The worst offenders, "name×count" ordered by count. */
export function summariseAnimations(animations: readonly Animation[], top = 5): string {
    const counts = new Map<string, number>();
    for (const animation of animations) {
        const key = describe(animation);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, top)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ');
}

/**
 * Start the guard. Returns a disposer. No-ops where getAnimations is absent
 * (jsdom, ancient WebKit) rather than throwing into app bootstrap.
 */
export function startAnimationBudgetGuard(): () => void {
    if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') {
        return () => undefined;
    }

    let dieting = false;
    let peak = 0;
    // Canvas backing-store telemetry. A sized canvas allocates width×height×4
    // bytes of UNPURGEABLE renderer memory; 226 hero-carousel canvases
    // (~130MB) was a jetsam-shaped kill — and iOS writes NO WebContent crash
    // report for jetsam, so the only way to see this class of problem is for
    // the app to measure itself. Logged on meaningful growth (+8MB steps).
    let canvasPeakMb = 0;

    const check = () => {
        // A hidden page cannot drain its queue; it also cannot usefully be
        // measured or repainted. The backgrounded freeze in index.css owns
        // that state.
        if (document.hidden) return;

        let animations: Animation[];
        try {
            animations = document.getAnimations();
        } catch {
            return;
        }
        const count = animations.length;

        try {
            const canvases = document.querySelectorAll('canvas');
            let bytes = 0;
            canvases.forEach((canvas) => {
                bytes += canvas.width * canvas.height * 4;
            });
            const mb = bytes / 1_048_576;
            if (mb > canvasPeakMb + 8) {
                canvasPeakMb = mb;
                log.warn(`canvas backing grew to ~${Math.round(mb)}MB across ${canvases.length} canvases`);
            }
        } catch {
            /* measurement is best-effort */
        }

        if (count > peak) {
            peak = count;
            // warn(), not info() — info is silenced in production builds, and
            // this line is the whole point of the exercise.
            if (count > ANIMATION_BUDGET / 2) {
                log.warn(`live animations peaked at ${count} — top: ${summariseAnimations(animations)}`);
            }
        }

        if (!dieting && count > ANIMATION_BUDGET) {
            dieting = true;
            document.body.classList.add(DIET_CLASS);
            log.warn(
                `animation budget exceeded (${count} > ${ANIMATION_BUDGET}) — shedding decorative animations. ` +
                    `Top: ${summariseAnimations(animations, 8)}`,
            );
        } else if (dieting && count < RELEASE_AT) {
            dieting = false;
            document.body.classList.remove(DIET_CLASS);
            log.warn(`animation budget recovered (${count}) — decorative animations restored`);
        }
    };

    const timer = window.setInterval(check, CHECK_MS);
    // One immediate read so a heavy first paint is caught before the first
    // interval tick.
    check();

    return () => {
        window.clearInterval(timer);
        document.body.classList.remove(DIET_CLASS);
    };
}
