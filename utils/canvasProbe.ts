/**
 * canvasProbe — counts WebGL contexts by watching them being made.
 *
 * ITS OWN MODULE BECAUSE OF WHEN IT HAS TO RUN, not because of what it does.
 *
 * This lived inside memoryCensus and was installed by startCensus(), which
 * useAppBootstrap calls from a useEffect after `await Promise.all([...three
 * dynamic imports])`. Mapbox creates its GL context from a different effect,
 * and nothing orders the two — so the probe wrapped getContext either before
 * or after the map, depending on how the chunks happened to land.
 *
 * Both outcomes are in Shane's crash reports, hours apart, on the same
 * install: `WebGL 1 live / 1 created` on 2026-08-23 morning and
 * `WebGL 0 live / 0 created` that afternoon, with a map plainly rendering in
 * both. A gauge that reports zero when the answer is one is not a gauge.
 *
 * Extracted so index.tsx can arm it SYNCHRONOUSLY at module scope, next to
 * the flight recorder, before React mounts anything — without eagerly pulling
 * the whole census into the entry chunk.
 *
 * There is no API that reports live GL contexts, and probing a canvas with
 * getContext('webgl') would CREATE one, making the instrument the bug. The
 * only honest way to count them is to watch them being made.
 */

let glCreated = 0;
let glRefused = 0;
/** Weak so the probe cannot itself retain a canvas. A context whose canvas
 *  has been collected is one the engine may still hold GPU memory for, which
 *  is the whole point of the measurement. */
const glCanvases: WeakRef<HTMLCanvasElement>[] = [];
let installed = false;

/** Wrap getContext. Idempotent; safe to call from several places. */
export function installCanvasProbe(): void {
    if (installed) return;
    if (typeof HTMLCanvasElement === 'undefined') return;
    installed = true;
    try {
        const proto = HTMLCanvasElement.prototype;
        const original = proto.getContext;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proto.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: any[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const context = (original as any).call(this, kind, ...rest);
            if (!context && /webgl/i.test(kind)) {
                // The engine refused. Past a per-process context cap WebKit
                // returns null rather than throwing, so this is the only
                // place the refusal is visible at all.
                glRefused += 1;
            }
            if (context && /webgl/i.test(kind)) {
                // getContext returns the SAME context on repeat calls, so
                // only count a canvas once or the number is meaningless.
                const already = glCanvases.some((ref) => ref.deref() === this);
                if (!already) {
                    glCreated += 1;
                    glCanvases.push(new WeakRef(this));
                }
            }
            return context;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
    } catch {
        // Never let the instrument break the app. A frozen prototype or an
        // exotic engine means no counts, not no map.
        installed = false;
    }
}

/** True once getContext is wrapped — so a report can say whether the numbers
 *  below mean "none" or "we were not watching". */
export function canvasProbeArmed(): boolean {
    return installed;
}

export function glCreatedCount(): number {
    return glCreated;
}

export function glRefusedCount(): number {
    return glRefused;
}

/** Contexts whose canvas is still reachable. Prunes collected entries. */
export function liveGlContexts(): number {
    let live = 0;
    for (let i = glCanvases.length - 1; i >= 0; i--) {
        if (glCanvases[i].deref()) live += 1;
        else glCanvases.splice(i, 1);
    }
    return live;
}
