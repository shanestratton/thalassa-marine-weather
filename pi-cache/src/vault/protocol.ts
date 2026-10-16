/**
 * The chart vault's socket protocol, v1 (127-C-d decision 1): what
 * thalassa-cache and the vault say to each other over
 * /run/thalassa-chart-vault/vault.sock. Plain HTTP on a unix socket, JSON
 * except a cell's bytes. Versioned (/v1/...) because in 128-129 the same
 * process becomes the brain (routing, answers).
 *
 *   GET  /v1/status            VaultStatusWire
 *   GET  /v1/index             { cells: VaultCellMeta[] }, or 503 {code}
 *   GET  /v1/cells/:cellId     the cell's bytes; X-Vault-Sha256 is the hash the
 *                              vault checked; or 404/503 {code} (+ Retry-After)
 *   POST /v1/rescan            { cellIds? } → VaultRescanWire
 *   POST /v1/remove            { cellId } → { removed }
 *   POST /v1/hint              { lat?, lon?, watching? } → 204
 *
 * Types only, plus the header name: thalassa-cache imports this, and it must
 * never pull the parser into the watch's process (watchIsolation.test.mts).
 */

export const VAULT_SHA_HEADER = 'x-vault-sha256';

/** The vault returns generic danger state only. Chart facts stay in its process. */
export interface VaultLookaheadRequest {
    fix: { lat: number; lon: number; at: number; sogKn: number; cogDeg: number };
    draftM: number;
    ukcM: number;
    windowMin: number;
    onLine: boolean;
    tide?: { datum: 'LAT'; expires: number; points: { dt: number; height: number }[] };
}
export interface VaultLookaheadResponse {
    coverage: 'charted' | 'partial' | 'unavailable';
    danger: boolean;
}

/** Boat-local safety query. Chart facts never cross back to the watch. */
export interface VaultLookaheadRequest {
    fix: { lat: number; lon: number; at: number; sogKn: number; cogDeg: number };
    draftM: number;
    ukcM: number;
    windowMin: number;
    onLine: boolean;
    tide?: { datum: 'LAT'; points: { dt: number; height: number }[]; expires: number };
}
export interface VaultLookaheadResponse {
    coverage: 'charted' | 'partial' | 'unavailable';
    danger: boolean;
}

/** starting: no index yet; indexing: a pass runs, the last index is served; decoder-down: oexserverd or the dongle. */
export type VaultState = 'starting' | 'indexing' | 'ready' | 'decoder-down';

/** Refusals, as the phone hears them (services/enc/piChartAccessWords.ts), plus the vault's own. */
export type VaultRefusalCode =
    | 'vault-starting'
    | 'vault-busy'
    | 'vault-decoder-down'
    | 'cell-not-found'
    | 'vault-cell-unreadable';

export interface VaultStatusWire {
    v: 1;
    state: VaultState;
    /** Cells served (the newest edition of each, removals left out). */
    cells: number;
    /** Files the current pass has opened, and how many it must open. */
    opened: number;
    toOpen: number;
    lruBytes: number;
    lruCells: number;
    /** Requests waiting for a decode. */
    waiting: number;
    /** What thalassa-cache last said about the watch; null until it has. */
    watching: boolean | null;
    /** A rescan asked for during a watch, run after it. */
    rescanPending: boolean;
    decoder: 'up' | 'down' | 'idle';
    /** Delivered sets that were not indexed, and why (shape rules: decision 6). */
    skippedSets: { set: string; reason: string }[];
}

/** One served cell, in the shape GET /api/enc/installed lists (the app's PiInstalledCell). */
export interface VaultCellMeta {
    cellId: string;
    sourceCellId?: string;
    sourceHO: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    contentSha256: string;
    /** When the encrypted file arrived on the Pi (its modification time). */
    installedAt: string;
    source: 'pi-decrypt';
    licence: 'protected';
}

export interface VaultRescanSummary {
    new: number;
    updated: number;
    unchanged: number;
    total: number;
}

export interface VaultRescanWire {
    /** True when the rescan waits: for the end of a watch, or for a vault that is down. */
    queued: boolean;
    reason?: 'watch' | 'vault-down';
    /** For the cells asked about (or all), against the served index before the rescan. */
    summary?: VaultRescanSummary;
}
