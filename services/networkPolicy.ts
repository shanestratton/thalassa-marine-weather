/**
 * One place that answers "is this a metered link the skipper wants us to spare?"
 *
 * Satellite Mode is a PROMISE on the Account screen — "~200 KB/day, weather
 * only, for Iridium GO! & metered connections". Three behaviours already
 * honoured it (weather cadence, ship-log queueing, diary relay), but the heavy
 * automatic fetchers did not: GRIB grids, radar rasters, the AIS aggregate and
 * bulk offline downloads all ran exactly as on WiFi. An audit on 2026-09-05
 * called that out. This module is the single policy every fetcher consults, so
 * the promise means the same thing everywhere and the Account screen can render
 * its list FROM the same source the fetchers enforce.
 *
 * WHAT IT GATES: automatic, background, discretionary network. It does NOT gate
 * an explicit skipper action of a different kind — a point weather refresh, a
 * tap to Inspect. The kinds below are the discretionary heavies.
 *
 * NOTE (2026-09-05): reconstructed after a shared-worktree Write collision
 * clobbered the in-flight original. The exports match every live call site
 * verbatim — satelliteModeBlocks('raster'|'grib'|'ais-internet'|'offline-download'),
 * assertNetworkAllowed for the throwing GRIB path, and SATELLITE_MODE_ENFORCED
 * for the UI list.
 */
import { useSettingsStore } from '../stores/settingsStore';

/** The discretionary network channels Satellite Mode governs. */
export type NetworkKind = 'grib' | 'raster' | 'ais-internet' | 'offline-download';

/**
 * True when Satellite Mode is on. Reads the live setting so a toggle takes
 * effect on the next fetch. Never throws — a store that cannot be read is
 * treated as normal (un-metered) network, because failing the other way would
 * silently strand a coastal user with no data.
 */
export function satelliteModeActive(): boolean {
    try {
        return useSettingsStore.getState().settings.satelliteMode === true;
    } catch {
        return false;
    }
}

/**
 * Should a fetch of this KIND be blocked right now? Today every kind is blocked
 * whenever Satellite Mode is on; the kind is carried so the reason is legible
 * at the call site and so a future policy can spare one channel without the
 * others.
 */
export function satelliteModeBlocks(_kind: NetworkKind): boolean {
    return satelliteModeActive();
}

/** Thrown by assertNetworkAllowed when a metered link forbids a fetch. */
export class NetworkPolicyBlockedError extends Error {
    readonly kind: NetworkKind;
    constructor(kind: NetworkKind, label: string) {
        super(`Satellite Mode — ${label} not fetched (${kind})`);
        this.name = 'NetworkPolicyBlockedError';
        this.kind = kind;
    }
}

/**
 * Throw when this kind is blocked. For a fetch buried deep enough that an
 * early boolean return is awkward — the GRIB path is shared by the overlay and
 * the passage planner, and each already has a try/catch that turns a throw
 * into a graceful "no wind this pass".
 */
export function assertNetworkAllowed(kind: NetworkKind, label: string): void {
    if (satelliteModeBlocks(kind)) throw new NetworkPolicyBlockedError(kind, label);
}

/**
 * What the Account screen tells the skipper Satellite Mode does — rendered from
 * here so the words and the enforcement are one thing. Each entry names a kind
 * the fetchers above actually block.
 */
export const SATELLITE_MODE_ENFORCED: ReadonlyArray<{ kind: NetworkKind; label: string }> = [
    { kind: 'grib', label: 'Wind & pressure GRIB grids pause (the biggest download)' },
    { kind: 'raster', label: 'Rain radar and precip imagery pause' },
    { kind: 'ais-internet', label: 'Internet AIS pauses — your own VHF AIS still shows' },
    { kind: 'offline-download', label: 'Bulk offline chart downloads are blocked' },
];
