/**
 * What the night watch keeps across a restart (build 126, 126-04a): that it
 * is armed, which devices armed it and with which thresholds, and our own
 * MMSI. Nothing else: no alarms, no positions, no acknowledgements. A
 * restarted Pi grades afresh, and a watch that was armed stays armed until
 * the last device that armed it stands it down (or one aboard stands it down
 * for everyone).
 *
 * Written only when one of those changes (an SD card is not a log), and read
 * strictly: anything odd reads as no watch, never as armed with made-up
 * thresholds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { COLLISION_PREF_LIMITS, type CollisionPair, type CollisionPrefs } from './collisionRule/collisionRule.js';

/** One device that armed the watch, and the thresholds it armed it with. */
export interface AisWatchArmer {
    id: string;
    prefs: CollisionPrefs;
}

export interface SavedAisWatch {
    armed: true;
    /** The thresholds the watch grades with: the strictest of its armers'. */
    prefs: CollisionPrefs;
    /** Our own transponder, as a phone sent it; null when none has. */
    ownMmsi: number | null;
    /** Every device that armed it, first armed first. */
    devices: AisWatchArmer[];
}

export interface AisWatchStore {
    read(): SavedAisWatch | null;
    save(watch: SavedAisWatch): void;
    clear(): void;
}

const MAX_BYTES = 4 * 1024;
/** The most devices kept as armers: a phone, a tablet and a few crew. */
export const AIS_WATCH_MAX_DEVICES = 8;
/** A request that names no device (or a file from before devices were kept). */
export const AIS_WATCH_UNNAMED_DEVICE = 'unnamed';

export function isMmsi(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1_000_000 && value <= 999_999_999;
}

/** A phone's install id (services/skipperDevice.ts getDeviceId: 'dev-' and a UUID). */
export function isDeviceId(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function within(value: unknown, limits: { min: number; max: number }): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= limits.min && value <= limits.max;
}

function pairOf(raw: unknown): CollisionPair | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (!within(r.cpaNm, COLLISION_PREF_LIMITS.cpaNm) || !within(r.tcpaMin, COLLISION_PREF_LIMITS.tcpaMin)) return null;
    return { cpaNm: r.cpaNm, tcpaMin: r.tcpaMin };
}

function prefsOf(raw: unknown): CollisionPrefs | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const p = raw as Record<string, unknown>;
    const offshore = pairOf(p.offshore);
    const inshore = pairOf(p.inshore);
    return offshore && inshore ? { offshore, inshore } : null;
}

/** A saved watch, checked field by field; null for anything that is not one. */
export function readSavedAisWatch(raw: unknown): SavedAisWatch | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.armed !== true) return null;
    const prefs = prefsOf(r.prefs);
    if (!prefs) return null;
    if (r.ownMmsi !== null && r.ownMmsi !== undefined && !isMmsi(r.ownMmsi)) return null;
    // No list: one armer, unnamed. A list with anything odd in it: no watch.
    let devices: AisWatchArmer[] = [{ id: AIS_WATCH_UNNAMED_DEVICE, prefs }];
    if (r.devices !== undefined) {
        if (!Array.isArray(r.devices) || r.devices.length === 0 || r.devices.length > AIS_WATCH_MAX_DEVICES) {
            return null;
        }
        devices = [];
        for (const item of r.devices as unknown[]) {
            const d = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
            const armerPrefs = d ? prefsOf(d.prefs) : null;
            if (!d || !isDeviceId(d.id) || !armerPrefs || devices.some((x) => x.id === d.id)) return null;
            devices.push({ id: d.id, prefs: armerPrefs });
        }
    }
    return { armed: true, prefs, ownMmsi: isMmsi(r.ownMmsi) ? r.ownMmsi : null, devices };
}

/** `CACHE_DIR/ais-watch.json`, written atomically and private to the service user. */
export function fileAisWatchStore(cacheDir: string): AisWatchStore {
    const filename = path.join(cacheDir, 'ais-watch.json');
    return {
        read() {
            try {
                const info = fs.lstatSync(filename);
                if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
                return readSavedAisWatch(JSON.parse(fs.readFileSync(filename, 'utf8')));
            } catch {
                return null;
            }
        },
        save(watch) {
            fs.mkdirSync(cacheDir, { recursive: true });
            // Explicit fields: nothing else can ride along into the file.
            const { prefs, ownMmsi } = watch;
            const devices = watch.devices.map((d) => ({ id: d.id, prefs: d.prefs }));
            const temporary = `${filename}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ armed: true, prefs, ownMmsi, devices }), { mode: 0o600 });
            fs.renameSync(temporary, filename);
        },
        clear() {
            fs.rmSync(filename, { force: true });
        },
    };
}
