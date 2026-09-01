/**
 * memoryGauge — the process-memory reading WKWebView refuses to give JS.
 *
 * Bridges ios/App/App/MemoryGaugePlugin.swift: os_proc_available_memory()
 * (how much this app may still allocate before jetsam) plus UIKit's
 * memory-warning notification. On-demand only — no idle polling: callers
 * that are about to do something heavy call refreshAvailableMemory(); the
 * crumb tag reads whatever is recent enough to be honest.
 *
 * Why (Lady Musgrave kill, 2026-08-21): the ENC merge brake was a documented
 * no-op on iOS — the one platform where the WebContent process actually gets
 * jetsammed. This is the gauge that makes it real there.
 *
 * KNOW WHAT IT MEASURES (kill #27, 2026-08-25): os_proc_available_memory
 * answers for the HOST APP process. The page runs in WKWebView's separate
 * WebContent process with its own smaller ceiling, invisible from either
 * side of the bridge — kill #27 died mid-merge with this gauge reading
 * 3,339 MB available. Treat readings as a device-pressure signal, never as
 * proof the page has room; see services/enc/mergeSettle.ts for the death
 * class this cannot brake.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

interface MemoryGaugePlugin {
    read(): Promise<{ availableMB: number }>;
    addListener(eventName: 'warning', listener: () => void): Promise<PluginListenerHandle>;
}

const MemoryGauge = registerPlugin<MemoryGaugePlugin>('MemoryGauge');

/** A reading older than this is not evidence — pressure moves fast. */
const READING_FRESH_MS = 10_000;
/** How long one system memory warning keeps the pressure flag raised. */
const WARNING_HOLD_MS = 10_000;

let last: { availableMB: number; at: number } | null = null;
let warningUntil = 0;
let listenerArmed = false;

function armWarningListener(): void {
    if (listenerArmed || !Capacitor.isNativePlatform()) return;
    listenerArmed = true;
    void MemoryGauge.addListener('warning', () => {
        warningUntil = Date.now() + WARNING_HOLD_MS;
        // iOS says the ceiling is close: parked route grids are the
        // biggest thing we can shed instantly (up to ~48 MB of typed
        // arrays; the Airlie Jetsam hunt, 2026-09-02). Dynamic import so
        // this display-layer module never pulls the routing engine into
        // bundles that only wanted a gauge.
        void import('../engine/navGrid').then(({ trimNavGridCache }) => trimNavGridCache(0)).catch(() => {});
    }).catch(() => {
        // Plugin absent (old native build) — the gauge stays silent and the
        // brake keeps its historical no-op behaviour rather than guessing.
        listenerArmed = false;
    });
}

/** Fresh native reading; null off-device or when the plugin is unavailable. */
export async function refreshAvailableMemory(): Promise<{ availableMB: number; warning: boolean } | null> {
    if (!Capacitor.isNativePlatform()) return null;
    armWarningListener();
    try {
        const { availableMB } = await MemoryGauge.read();
        if (typeof availableMB !== 'number' || !Number.isFinite(availableMB)) return null;
        last = { availableMB, at: Date.now() };
        return { availableMB, warning: Date.now() < warningUntil };
    } catch {
        return null;
    }
}

/** Last reading if it is recent enough to mean anything; never triggers IO. */
export function recentAvailableMemory(): { availableMB: number; warning: boolean } | null {
    const warning = Date.now() < warningUntil;
    if (last && Date.now() - last.at < READING_FRESH_MS) {
        return { availableMB: last.availableMB, warning };
    }
    // A live warning is evidence even without a fresh number.
    return warning ? { availableMB: 0, warning } : null;
}

/** Test seam. */
export function __resetMemoryGaugeForTest(): void {
    last = null;
    warningUntil = 0;
    listenerArmed = false;
}
