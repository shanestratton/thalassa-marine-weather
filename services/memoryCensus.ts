/**
 * memoryCensus — what the caches looked like just before the web layer died.
 *
 * WHY. The kill detector (services/webContentKill.ts) tells us WHERE the app
 * died and how often. Shane's log on 2026-08-09 went 1 → 9 across a session,
 * on 'map' and on 'voyage'. What it cannot say is WHAT was large at the time,
 * and without that every fix is a guess — three have been so far, two of them
 * right for reasons that turned out not to be the whole story.
 *
 * The obvious instrument does not exist here: `performance.memory` is
 * Chromium-only and WKWebView has no equivalent, so the heap itself cannot be
 * read from JS. What CAN be read is the occupancy of the caches we own, which
 * is where the memory actually goes — the ENC blob LRU, the merges that pin
 * cell geometry by reference, glaze, contours, indexes.
 *
 * THE TRICK IS THE SAME ONE THE BREADCRUMB USES. A killed process cannot
 * report anything, so the census is written continuously to localStorage,
 * synchronously, while everything is still healthy. Whatever is on disk when
 * the process dies is the last known state — and the next boot reports it
 * alongside the death.
 *
 * Deliberately cheap: a handful of Map.size reads and one small set union, a
 * few times a minute. An instrument that costs memory to run would be its own
 * problem.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('memoryCensus');

const CENSUS_KEY = 'thalassa.lastCensus';
/** Often enough to catch the run-up to a kill, rare enough to cost nothing. */
const CENSUS_INTERVAL_MS = 5_000;
/**
 * For the first stretch after boot, sample every second.
 *
 * Kills 11 and 13 on 2026-08-09 both happened early enough that the only
 * reading on disk was the one taken at boot, before anything had rendered — so
 * the report described an empty app and told us nothing. A fast crash is
 * exactly the case that needs a fine-grained trail, and this is the window
 * where sampling hard costs nothing because the app is doing little else.
 */
const CENSUS_FAST_INTERVAL_MS = 1_000;
const CENSUS_FAST_WINDOW_MS = 20_000;

export interface MemoryCensus {
    at: number;
    /** The screen showing when this was taken. */
    view: string | null;
    /** ENC blob LRU: cells held, and their JSON text size. */
    encCells: number;
    encTextMB: number;
    /** Cached viewport merges, and the distinct cells they PIN by reference. */
    merges: number;
    pinnedCells: number;
    /** Secondary ENC caches. */
    glaze: number;
    contours: number;
    indexes: number;
    /** A blunt proxy for DOM/renderer growth. */
    domNodes: number;
    /** True while the route tracer is drawing. */
    plotting: boolean;

    /**
     * Milliseconds since this session booted.
     *
     * Added after the 2026-08-09 readings, which were ambiguous in a way I had
     * not designed out: kills 11 and 13 reported ENC 0 / DOM 161, which could
     * mean "died with nothing loaded" OR "died before the second census tick".
     * Those are completely different bugs. This settles it.
     */
    sinceBootMs: number;

    /**
     * HIGH-WATER MARKS for the session, not just the latest reading.
     *
     * The same 5 s sampling that produced the ambiguity above can also miss a
     * spike entirely: a cache that ballooned and was evicted between ticks
     * leaves no trace in a snapshot. A peak cannot be hidden that way.
     */
    peakEncTextMB: number;
    peakPinnedCells: number;
    peakDomNodes: number;
    peakCanvases: number;

    /**
     * ACTUAL JS heap, from Chrome's `performance.memory` (2026-08-10, kill
     * #23). Every counted cache read healthy at the moment of that death —
     * this is the first field that measures the PROCESS rather than our own
     * bookkeeping. Null where the browser doesn't expose the gauge (iOS
     * WKWebView), so a missing reading is "couldn't measure", never "zero".
     */
    heapUsedMB: number | null;
    heapLimitMB: number | null;
    peakHeapUsedMB: number | null;

    /** Live <canvas> elements — 'map' means Mapbox GL, which means WebGL. */
    canvases: number;
    /**
     * WebGL contexts CREATED this session, and how many are still alive.
     *
     * This is the number the JetsamEvent points at and the one JS cannot
     * otherwise see. From the note in PassageRouteMap.tsx, describing a kill
     * on this very screen:
     *
     *   "map.remove() + new mapboxgl.Map() — a full style/worker/GL-context
     *    spin-up. WebKit does not promptly return that memory: Shane's
     *    JetsamEvent (2026-08-04 12:48) shows our WebContent killed at
     *    reason: per-process-limit with rpages 131626 (~2.0 GB, lifetimeMax ==
     *    rpages — monotonic growth)"
     *
     * That is why every cache reading has come back near zero while the
     * process dies: the memory is GL and WebKit-side, invisible to the heap
     * and to every counter this census had until now. If `created` climbs
     * while `live` does not, contexts are being spun up and abandoned — the
     * exact mechanism above, and it would explain a crash on the SECOND leg
     * rather than the first.
     */
    glCreated: number;
    glLive: number;
    peakGlLive: number;
    /**
     * Times WebKit REFUSED a WebGL context (getContext returned null).
     *
     * Found while testing the counter, and it may be the most telling field
     * here. WebKit caps simultaneous WebGL contexts per process; past the cap
     * getContext hands back null rather than throwing. A non-zero value is
     * hard proof we are exhausting contexts — which would explain a crash on
     * the SECOND leg and nothing on the first, and would rule out memory
     * volume entirely.
     */
    glRefused: number;
    /**
     * Did a WebGL context drop during this session?
     *
     * Recorded the instant it happens rather than at the next tick, because a
     * context loss can be immediately followed by the process going away. If
     * this is ever true the investigation moves off memory entirely: a GPU or
     * WebGL failure kills the WebContent process with the heap nearly empty,
     * which is exactly the shape of kills 11 and 13.
     */
    glContextLost: boolean;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let plotting = false;
const bootAt = Date.now();
let glContextLost = false;
const peaks = { encTextMB: 0, pinnedCells: 0, domNodes: 0, canvases: 0, glLive: 0, heapUsedMB: 0 };

/** WebGL contexts created since boot, and weak handles to their canvases. */
let glCreated = 0;
let glRefused = 0;
const glCanvases: WeakRef<HTMLCanvasElement>[] = [];
let canvasProbeInstalled = false;

/**
 * Count WebGL context creations by wrapping getContext.
 *
 * There is no API that reports live GL contexts, and probing a canvas with
 * getContext('webgl') would CREATE one — making the instrument the bug. The
 * only honest way to count them is to watch them being made.
 *
 * Weak handles so the probe cannot itself retain a canvas. A context whose
 * canvas has been collected is one WebKit may still be holding GPU memory
 * for, which is the whole point of the measurement.
 */
function installCanvasProbe(): void {
    if (canvasProbeInstalled) return;
    if (typeof HTMLCanvasElement === 'undefined') return;
    canvasProbeInstalled = true;
    try {
        const proto = HTMLCanvasElement.prototype;
        const original = proto.getContext;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proto.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: any[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const context = (original as any).call(this, kind, ...rest);
            if (!context && /webgl/i.test(kind)) {
                // WebKit refused. Past the per-process context cap it returns
                // null rather than throwing, so this is the only place the
                // refusal is visible at all.
                glRefused += 1;
            }
            if (context && /webgl/i.test(kind)) {
                // getContext returns the SAME context on repeat calls, so only
                // count a canvas once or the number is meaningless.
                const already = glCanvases.some((ref) => ref.deref() === this);
                if (!already) {
                    glCreated += 1;
                    glCanvases.push(new WeakRef(this));
                }
            }
            return context;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
    } catch (err) {
        log.warn('could not install the canvas probe', err);
    }
}

/** How many probed canvases are still reachable. */
function liveGlContexts(): number {
    let live = 0;
    for (let i = glCanvases.length - 1; i >= 0; i--) {
        if (glCanvases[i].deref()) live += 1;
        else glCanvases.splice(i, 1);
    }
    return live;
}

/** Told by the tracer, so a census line says whether a leg was being drawn. */
export function setCensusPlotting(active: boolean): void {
    plotting = active;
}

function readView(): string | null {
    try {
        const raw = localStorage.getItem('thalassa.lastView');
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { view?: string };
        return typeof parsed.view === 'string' ? parsed.view : null;
    } catch {
        return null;
    }
}

/**
 * Take a reading. Every source is guarded individually: a census that throws
 * because one cache moved would take the whole diagnostic down at exactly the
 * moment it is needed.
 */
export async function takeCensus(now = Date.now()): Promise<MemoryCensus> {
    const census: MemoryCensus = {
        at: now,
        view: readView(),
        encCells: 0,
        encTextMB: 0,
        merges: 0,
        pinnedCells: 0,
        glaze: 0,
        contours: 0,
        indexes: 0,
        domNodes: 0,
        plotting,
        sinceBootMs: now - bootAt,
        peakEncTextMB: 0,
        peakPinnedCells: 0,
        peakDomNodes: 0,
        peakCanvases: 0,
        heapUsedMB: null,
        heapLimitMB: null,
        peakHeapUsedMB: null,
        canvases: 0,
        glCreated,
        glRefused,
        glLive: 0,
        peakGlLive: 0,
        glContextLost,
    };

    try {
        const store = await import('./enc/EncCellStore');
        const stats = store.blobCacheStats();
        census.encCells = stats.entries;
        census.encTextMB = stats.textMB;
    } catch {
        /* leave at zero */
    }
    try {
        const merged = await import('./enc/mergedDataCache');
        census.merges = merged.mergedDataCacheSize();
        census.pinnedCells = merged.mergedPinnedCellCount();
    } catch {
        /* leave at zero */
    }
    try {
        census.glaze = (await import('./enc/glazeCellCache')).glazeCellCacheSize();
    } catch {
        /* leave at zero */
    }
    try {
        census.contours = (await import('./enc/derivedContourCache')).derivedContourCacheSize();
    } catch {
        /* leave at zero */
    }
    try {
        census.indexes = (await import('./enc/encIndexCache')).indexCacheSize();
    } catch {
        /* leave at zero */
    }
    try {
        census.domNodes = document.getElementsByTagName('*').length;
        census.canvases = document.getElementsByTagName('canvas').length;
    } catch {
        /* leave at zero */
    }

    try {
        const { heapMB } = await import('../utils/heapGauge');
        const h = heapMB();
        if (h) {
            census.heapUsedMB = h.used;
            census.heapLimitMB = h.limit;
            peaks.heapUsedMB = Math.max(peaks.heapUsedMB, h.used);
            census.peakHeapUsedMB = peaks.heapUsedMB;
        }
    } catch {
        /* leave at null */
    }

    peaks.encTextMB = Math.max(peaks.encTextMB, census.encTextMB);
    peaks.pinnedCells = Math.max(peaks.pinnedCells, census.pinnedCells);
    peaks.domNodes = Math.max(peaks.domNodes, census.domNodes);
    peaks.canvases = Math.max(peaks.canvases, census.canvases);
    census.glLive = liveGlContexts();
    peaks.glLive = Math.max(peaks.glLive, census.glLive);
    census.peakGlLive = peaks.glLive;
    census.peakEncTextMB = peaks.encTextMB;
    census.peakPinnedCells = peaks.pinnedCells;
    census.peakDomNodes = peaks.domNodes;
    census.peakCanvases = peaks.canvases;

    return census;
}

function persist(census: MemoryCensus): void {
    try {
        // Synchronous on purpose: a kill gives no warning, so a census that is
        // still being written when the process dies is a census we never had.
        localStorage.setItem(CENSUS_KEY, JSON.stringify(census));
    } catch {
        /* private mode / quota */
    }
}

/** The last reading taken before the previous session ended. */
export function readLastCensus(): MemoryCensus | null {
    try {
        const raw = localStorage.getItem(CENSUS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<MemoryCensus>;
        return typeof parsed.at === 'number' ? (parsed as MemoryCensus) : null;
    } catch {
        return null;
    }
}

/** One line, for the crash report. */
export function describeCensus(c: MemoryCensus): string {
    const age = Math.round((Date.now() - c.at) / 1000);
    const uptime = c.sinceBootMs === undefined ? '?' : `${Math.round(c.sinceBootMs / 1000)}s`;
    return (
        `${age}s before the end, ${uptime} into that session, on '${c.view ?? 'unknown'}'` +
        `${c.plotting ? ' (plotting)' : ''}${c.glContextLost ? ' [WEBGL CONTEXT WAS LOST]' : ''}: ` +
        // Real heap first — the one number that measures the process, not our
        // caches. "heap ?" means the browser doesn't expose the gauge.
        `heap ${c.heapUsedMB ?? '?'}${c.heapUsedMB != null ? `/${c.heapLimitMB}MB (peak ${c.peakHeapUsedMB})` : ''}, ` +
        `ENC ${c.encCells} cells/${c.encTextMB}MB text (peak ${c.peakEncTextMB ?? 0}MB), ` +
        `${c.merges} merges pinning ${c.pinnedCells} cells (peak ${c.peakPinnedCells ?? 0}), ` +
        `glaze ${c.glaze}, contours ${c.contours}, indexes ${c.indexes}, ` +
        `DOM ${c.domNodes} (peak ${c.peakDomNodes ?? 0}), canvas ${c.canvases ?? 0} (peak ${c.peakCanvases ?? 0}), ` +
        `WebGL ${c.glLive ?? 0} live / ${c.glCreated ?? 0} created (peak live ${c.peakGlLive ?? 0})` +
        `${c.glRefused ? ` [${c.glRefused} CONTEXT REFUSALS]` : ''}`
    );
}

/** Begin taking readings. Idempotent. */
export function startCensus(): void {
    if (timer) return;
    installCanvasProbe();

    // A lost WebGL context is often the last thing that happens before the
    // WebContent process goes away, so this must record SYNCHRONOUSLY rather
    // than wait for the next 5 s tick — by then there may be no next tick.
    // Capture phase because the event does not bubble off a canvas.
    try {
        window.addEventListener(
            'webglcontextlost',
            () => {
                glContextLost = true;
                const last = readLastCensus();
                if (last) persist({ ...last, glContextLost: true });
            },
            true,
        );
    } catch {
        /* no window in this environment */
    }

    const tick = () => {
        void takeCensus()
            .then(persist)
            .catch((err) => log.warn('census failed', err));
    };
    tick();
    // Fast phase first, then settle. setTimeout-chained rather than two
    // intervals so there is never a window with both running.
    let fast = true;
    const schedule = () => {
        const elapsed = Date.now() - bootAt;
        if (fast && elapsed >= CENSUS_FAST_WINDOW_MS) fast = false;
        timer = setTimeout(
            () => {
                tick();
                schedule();
            },
            fast ? CENSUS_FAST_INTERVAL_MS : CENSUS_INTERVAL_MS,
        );
    };
    schedule();
}

export function stopCensus(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
