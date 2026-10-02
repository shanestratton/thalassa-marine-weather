/**
 * LocalEngineHoursService — the engine-hours reading R&M counts hour-based
 * tasks from, shared like the rest of the R&M binder.
 *
 * Shane, 2026-10-02: "the engine hours are not going across to the invitee".
 * The figure lived only in one device's localStorage, so the skipper's other
 * devices and crew on his shared R&M never saw it. It is now one row per
 * skipper in vessel_engine_hours (20261002190000), synced like the binder
 * tables (SyncService, register 'maintenance'): written here local-first with
 * an outbox entry that pushes within seconds, read back on every device by
 * pull and realtime, and filtered to the R&M binder on show, so crew on a
 * skipper's shared R&M see (and, where they may edit R&M, change) HIS reading.
 * R&M has no view-only split today (can_access_vessel_register narrows writes
 * for 'stores' only), so every crew member he shares R&M with may change it,
 * as they already edit and log his tasks; the read-only path is defensive.
 *
 * Deploy order: an app build can reach a phone before the migration is
 * pushed. Until SyncService has read the table from the server once on this
 * device (SyncMeta.optionalTablesReadAt), everything here behaves as before:
 * the reading is this device's own localStorage figure, and nothing is ever
 * queued for a table the server does not have.
 */
import { getById, getLocalDatabaseSession, getSyncMeta, insertLocal, query, updateLocal } from './LocalDatabase';
import { assertBinderWritable, binderInsertOwner, canSeedOwnBinder, getBinderSource } from './sharedBinders';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { DATA_EVENTS, dispatchDataChange } from '../../utils/dataChangeEvents';

export const ENGINE_HOURS_TABLE = 'vessel_engine_hours';
/** The largest figure the field takes (the column is a 32-bit integer). */
export const MAX_ENGINE_HOURS = 999_999;

const REGISTER = 'maintenance' as const;
/** This device's own figure: the only store before the table, a fallback after. */
const DEVICE_KEY = 'thalassa_engine_hours';
/** Set once this device's figure has gone to the server, or never needs to. */
const CARRIED_KEY = 'thalassa_engine_hours_carried_v1';

export interface EngineHoursRow {
    id: string;
    /** The skipper whose reading this is: one row per owner. */
    user_id: string;
    hours: number;
    created_at: string;
    updated_at: string;
}

export interface EngineHoursReading {
    /** null until someone has entered a figure. */
    hours: number | null;
    /**
     * 'shared': the synced reading every device sees. 'device': this device's
     * own figure, because the server table is not live here yet.
     */
    source: 'shared' | 'device';
    /** The skipper's reading, on the R&M binder he shares with this sailor. */
    skipper: boolean;
    /** May this sailor change it? False on a view-only share. */
    canEdit: boolean;
}

function readStorage(key: string): string | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
        /* storage unavailable: the synced row still carries the reading */
    }
}

function validHours(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ENGINE_HOURS
        ? value
        : null;
}

/** This device's own figure for the account, as the page always stored it. */
function readDeviceHours(scope: AuthIdentityScope): number | null {
    const saved = readStorage(authScopedStorageKey(DEVICE_KEY, scope));
    if (!saved) return null;
    return validHours(parseInt(saved, 10));
}

function removeStorage(key: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
        /* storage unavailable: nothing to clear */
    }
}

/**
 * Is this device's figure settled, never to be carried up? Set once it has
 * gone to the server (or the server already held it or a later one), once a
 * figure is typed on the live table, and when the figure was typed before the
 * table while this device showed a skipper's shared R&M: that is his boat's
 * engine, never the sailor's own.
 */
function carried(scope: AuthIdentityScope): boolean {
    return readStorage(authScopedStorageKey(CARRIED_KEY, scope)) === '1';
}

function markCarried(scope: AuthIdentityScope): void {
    writeStorage(authScopedStorageKey(CARRIED_KEY, scope), '1');
}

/**
 * Has SyncService read vessel_engine_hours from the server on this device,
 * for this account? Only then is the local mirror a complete copy, writes
 * have somewhere to go, and the reading is the shared one. Any doubt (the
 * database still switching accounts, or not open yet) is "not yet".
 */
export function isEngineHoursTableLive(scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
    try {
        if (getLocalDatabaseSession().identity !== scope.userId) return false;
        return typeof getSyncMeta().optionalTablesReadAt?.[ENGINE_HOURS_TABLE] === 'string';
    } catch {
        return false;
    }
}

/** The owner's row in the local mirror (there is one per owner). */
function rowFor(ownerId: string): EngineHoursRow | null {
    const rows = query<EngineHoursRow>(ENGINE_HOURS_TABLE, (row) => row?.user_id === ownerId);
    if (rows.length === 0) return null;
    return rows.reduce((newest, row) => ((row.updated_at ?? '') > (newest.updated_at ?? '') ? row : newest));
}

/**
 * The row id for an owner's reading, derived from the owner. Two devices
 * that each create the row (both carrying an old figure up at once, or an
 * edit on a device that has not pulled the row yet) then write the SAME row,
 * and the second INSERT is ignored as a duplicate instead of failing the
 * one-per-owner rule forever. A one-way hash rather than the owner id
 * itself: realtime sends a DELETE's primary key to every subscriber of the
 * table. RFC 9562 version 8 (custom) layout.
 */
export async function engineHoursRowId(ownerId: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`thalassa:${ENGINE_HOURS_TABLE}:v1:${ownerId}`),
    );
    const bytes = new Uint8Array(digest).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NO_READING: EngineHoursReading = Object.freeze({
    hours: null,
    source: 'device' as const,
    skipper: false,
    canEdit: false,
});

const carryOvers = new Map<string, Promise<boolean>>();

export const LocalEngineHoursService = {
    /**
     * The reading R&M shows and counts from: the skipper's while this sailor
     * is crew on a shared R&M, otherwise the sailor's own. Synchronous, so an
     * account switch shows the new account's figure at once.
     */
    getReading(scope: AuthIdentityScope = getAuthIdentityScope()): EngineHoursReading {
        if (!isAuthIdentityScopeCurrent(scope)) return NO_READING;
        if (!isEngineHoursTableLive(scope)) {
            // Exactly as before the table: this device's figure, editable.
            return { hours: readDeviceHours(scope), source: 'device', skipper: false, canEdit: true };
        }
        const binder = getBinderSource(REGISTER);
        if (binder.mode === 'shared') {
            const row = rowFor(binder.ownerId);
            return {
                hours: validHours(row?.hours),
                source: 'shared',
                skipper: true,
                canEdit: binder.canWrite,
            };
        }
        // Own binder. Until this device's figure has gone up (or found the
        // server already has one), it stands in for the missing row; a figure
        // that will never go up (typed while crewing) does not.
        const own = scope.userId ? rowFor(scope.userId) : null;
        return {
            hours: own ? validHours(own.hours) : carried(scope) ? null : readDeviceHours(scope),
            source: 'shared',
            skipper: false,
            canEdit: true,
        };
    },

    /**
     * Save a new reading: the R&M binder owner's row (the skipper's when this
     * sailor is crew on his shared R&M), local-first and queued, so the other
     * devices see it within seconds. Throws SharedBinderReadOnlyError on a
     * view-only share, before anything is queued.
     */
    async setReading(hours: number, scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
        if (validHours(hours) === null) {
            throw new RangeError(`Engine hours must be a whole number from 0 to ${MAX_ENGINE_HOURS.toLocaleString()}`);
        }
        if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while saving engine hours');
        if (!isEngineHoursTableLive(scope)) {
            writeStorage(authScopedStorageKey(DEVICE_KEY, scope), String(hours));
            // Typed while showing a skipper's shared R&M: his boat's figure,
            // so it never goes up as this sailor's own once the table is live.
            // Typed on the sailor's own R&M: it is theirs to carry up.
            if (getBinderSource(REGISTER).mode === 'shared') markCarried(scope);
            else removeStorage(authScopedStorageKey(CARRIED_KEY, scope));
            dispatchDataChange(DATA_EVENTS.MAINTENANCE);
            return;
        }

        const binder = getBinderSource(REGISTER);
        const owner = binderInsertOwner(REGISTER);
        const existing = rowFor(owner);
        if (existing) {
            assertBinderWritable(REGISTER, existing);
            await updateLocal<EngineHoursRow>(ENGINE_HOURS_TABLE, existing.id, { hours });
        } else {
            const id = await engineHoursRowId(owner);
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while saving engine hours');
            const stamp = new Date().toISOString();
            // If another device created the row first, the server ignores this
            // INSERT as a duplicate; the UPDATE queued behind it still sets the
            // figure just entered.
            if (!getById<EngineHoursRow>(ENGINE_HOURS_TABLE, id)) {
                await insertLocal<EngineHoursRow>(ENGINE_HOURS_TABLE, {
                    id,
                    user_id: owner,
                    hours,
                    created_at: stamp,
                    updated_at: stamp,
                });
            }
            await updateLocal<EngineHoursRow>(ENGINE_HOURS_TABLE, id, { hours });
        }
        if (binder.mode === 'own') {
            // A figure typed now supersedes any older one this device held.
            writeStorage(authScopedStorageKey(DEVICE_KEY, scope), String(hours));
            markCarried(scope);
        }
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
    },

    /**
     * One-time carry-over of this device's own figure from before the table.
     * Engine hours only go up, so the higher figure wins whichever device
     * syncs first: with no reading on the server it goes up as an INSERT
     * (ignored by the server if another device's row got there first), and
     * over a LOWER reading it goes up as an UPDATE. Never over an equal or
     * higher one. Only on the account's own R&M, once its shares are
     * confirmed: a crew device's figure may have been typed while it showed
     * the skipper's binder. Settled for good once the server holds this figure
     * or a later one, or once a figure is typed on the live table. Safe to
     * call on every sync cycle; true when it queued a change.
     */
    async carryOverDeviceReading(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<boolean> {
        const ownerId = scope.userId;
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const deviceHours = readDeviceHours(scope);
        if (deviceHours === null || carried(scope) || !isEngineHoursTableLive(scope)) return false;
        const settledBy = (row: EngineHoursRow | null) => {
            const hours = row ? validHours(row.hours) : null;
            return hours !== null && hours >= deviceHours;
        };
        if (settledBy(rowFor(ownerId))) {
            markCarried(scope);
            return false;
        }
        if (getBinderSource(REGISTER).mode !== 'own' || !canSeedOwnBinder(REGISTER)) return false;

        const key = `${scope.key}#${scope.generation}`;
        const running = carryOvers.get(key);
        if (running) return running;
        const run = (async () => {
            const id = await engineHoursRowId(ownerId);
            if (!isAuthIdentityScopeCurrent(scope) || !isEngineHoursTableLive(scope) || carried(scope)) {
                return false;
            }
            const existing = rowFor(ownerId) ?? getById<EngineHoursRow>(ENGINE_HOURS_TABLE, id);
            if (settledBy(existing)) {
                markCarried(scope);
                return false;
            }
            if (existing) {
                // A lower reading: another device carried an older figure up
                // first, or created the row at the same moment as this one.
                await updateLocal<EngineHoursRow>(ENGINE_HOURS_TABLE, existing.id, { hours: deviceHours });
                markCarried(scope);
            } else {
                const stamp = new Date().toISOString();
                await insertLocal<EngineHoursRow>(ENGINE_HOURS_TABLE, {
                    id,
                    user_id: ownerId,
                    hours: deviceHours,
                    created_at: stamp,
                    updated_at: stamp,
                });
                // Not settled yet: if another device's INSERT reached the
                // server first, the pull brings its row back over this one,
                // and the next cycle raises it if it is lower.
            }
            dispatchDataChange(DATA_EVENTS.MAINTENANCE);
            return true;
        })().finally(() => carryOvers.delete(key));
        carryOvers.set(key, run);
        return run;
    },
};
