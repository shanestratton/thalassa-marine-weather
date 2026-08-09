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
}

let timer: ReturnType<typeof setInterval> | null = null;
let plotting = false;

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
    } catch {
        /* leave at zero */
    }

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
    return (
        `${age}s before the end, on '${c.view ?? 'unknown'}'${c.plotting ? ' (plotting)' : ''}: ` +
        `ENC ${c.encCells} cells/${c.encTextMB}MB text, ${c.merges} merges pinning ${c.pinnedCells} cells, ` +
        `glaze ${c.glaze}, contours ${c.contours}, indexes ${c.indexes}, DOM ${c.domNodes}`
    );
}

/** Begin taking readings. Idempotent. */
export function startCensus(): void {
    if (timer) return;
    const tick = () => {
        void takeCensus()
            .then(persist)
            .catch((err) => log.warn('census failed', err));
    };
    tick();
    timer = setInterval(tick, CENSUS_INTERVAL_MS);
}

export function stopCensus(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
