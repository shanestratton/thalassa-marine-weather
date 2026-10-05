/**
 * Seabed mapping settings: the owner's switch, privacy zones and note, kept on
 * this device first and in the owner's seabed_platforms row second, and
 * pushed to the boat's Pi over the pinned LAN transport.
 *
 * LOCAL FIRST. The switch works before the migration is pushed, offline, and
 * at sea: the local copy (auth-scoped localStorage, so a mate signing in on
 * the boat tablet never inherits it) is the truth on this device, marked
 * pendingSync until the cloud row agrees. The Pi takes whichever of the LAN
 * push and the cloud row is newer.
 *
 * THE CLOUD ROW IS THE RECORD. A device with nothing pending takes the row as
 * it is (syncSeabedPlatform, on the setting's mount and every upload cycle),
 * so a second phone, an iPad or a reinstall shows what the boat already has,
 * and a phone the skipper moved logging away from stands down. A device that
 * changed something sends ONLY what its skipper changed (`dirty`), and tells
 * the Pi zones and the note only when it knows them: a device that never saw
 * the row can never blank the home berth (review 2026-10-05).
 *
 * ONE LOGGER PER BOAT. captureDeviceId names the one phone that logs; null
 * means the boat's Pi does. A phone with a Pi paired never logs.
 *
 * Nothing here throws to the UI: a Pi that is asleep or a cloud that is not
 * there yet is the ordinary case on a boat.
 */
import { createLogger } from '../../utils/createLogger';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { draftConfirmation } from '../draftConfirmation';
import { getPairing } from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { isPinnedTransportAvailable, piRequest } from '../piTls';
import { supabase } from '../supabase';
import { FEET_PER_METRE } from '../units';
import type { VesselProfile } from '../../types/vessel';
import {
    HOME_DEFAULT_RADIUS_M,
    MARKED_DEFAULT_RADIUS_M,
    SEABED_CONSENT_VERSION,
    ZONE_JITTER_FRACTION,
    jitterZoneCentre,
    parseSeabedZones,
    type SeabedZone,
} from './seabedCore';
import { SEABED_LOCAL_KEY } from './seabedSink';

const log = createLogger('Seabed');

const DEVICE_KEY = 'seabed_device_id_v1';
const SUMMARY_KEY = 'seabed_summary_v1';

/** The settings a skipper changes; each maps to one or more platform columns. */
export type SeabedSetting = 'enabled' | 'captureDeviceId' | 'zones' | 'sounderNote';
const SETTINGS: readonly SeabedSetting[] = ['enabled', 'captureDeviceId', 'zones', 'sounderNote'];

export interface SeabedLocal {
    boatId: string;
    enabled: boolean;
    consentVersion: string | null;
    /** The one phone that logs; null = the boat's Pi. */
    captureDeviceId: string | null;
    zones: SeabedZone[];
    sounderNote: string | null;
    /** When this device last changed the settings (ms). */
    updatedAt: number;
    /** True until the owner's cloud row has caught up. */
    pendingSync: boolean;
    /** What this device changed that the cloud has not taken yet: only these are ever sent. */
    dirty: SeabedSetting[];
    /** This copy came from, or was confirmed by, the cloud row: its zones and note are the boat's. */
    known: boolean;
}

export type SeabedVessel = Record<string, string | number | boolean>;

const listeners = new Set<() => void>();

export function subscribeSeabed(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(): void {
    for (const fn of listeners) {
        try {
            fn();
        } catch {
            /* a listener must never break the others */
        }
    }
}

function readJson(key: string): Record<string, unknown> | null {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(key));
        const v = raw ? (JSON.parse(raw) as unknown) : null;
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export function readSeabedLocal(): SeabedLocal | null {
    const v = readJson(SEABED_LOCAL_KEY);
    if (!v || typeof v.boatId !== 'string') return null;
    return {
        boatId: v.boatId,
        enabled: v.enabled === true,
        consentVersion: typeof v.consentVersion === 'string' ? v.consentVersion : null,
        captureDeviceId: typeof v.captureDeviceId === 'string' ? v.captureDeviceId : null,
        zones: parseSeabedZones(v.zones) ?? [],
        sounderNote: typeof v.sounderNote === 'string' ? v.sounderNote.slice(0, 120) : null,
        updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
        pendingSync: v.pendingSync === true,
        dirty: Array.isArray(v.dirty) ? SETTINGS.filter((k) => (v.dirty as unknown[]).includes(k)) : [],
        known: v.known === true,
    };
}

function blankLocal(boatId: string): SeabedLocal {
    return {
        boatId,
        enabled: false,
        consentVersion: null,
        captureDeviceId: null,
        zones: [],
        sounderNote: null,
        updatedAt: 0,
        pendingSync: false,
        dirty: [],
        known: false,
    };
}

function sameSettings(a: SeabedLocal, b: SeabedLocal): boolean {
    return (
        a.boatId === b.boatId &&
        a.enabled === b.enabled &&
        a.consentVersion === b.consentVersion &&
        a.captureDeviceId === b.captureDeviceId &&
        a.sounderNote === b.sounderNote &&
        JSON.stringify(a.zones) === JSON.stringify(b.zones)
    );
}

export function writeSeabedLocal(next: SeabedLocal | null): void {
    try {
        const key = authScopedStorageKey(SEABED_LOCAL_KEY);
        if (next) localStorage.setItem(key, JSON.stringify(next));
        else localStorage.removeItem(key);
    } catch {
        /* storage unavailable: the cloud row stays the record */
    }
    notify();
}

/** This device's random id for "which phone logs". Never derived from anything about the boat. */
export function seabedDeviceId(): string {
    try {
        const key = authScopedStorageKey(DEVICE_KEY);
        const existing = localStorage.getItem(key);
        if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const id = btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        localStorage.setItem(key, id);
        return id;
    } catch {
        return 'unavailable-device-id';
    }
}

/** The vessel snapshot kept on the platform row for phase 3: never the name or MMSI. */
export function seabedVesselSnapshot(profile: VesselProfile | null | undefined): SeabedVessel {
    if (!profile) return {};
    const draft = draftConfirmation(profile);
    const out: SeabedVessel = { type: profile.type };
    if (Number.isFinite(profile.length) && profile.length > 0) {
        out.length_m = Math.round((profile.length / FEET_PER_METRE) * 100) / 100;
    }
    if (draft.draftM !== null) out.draft_m = Math.round(draft.draftM * 100) / 100;
    out.draft_confirmed = draft.status === 'confirmed';
    return out;
}

// ── The owner's cloud row ─────────────────────────────────────────────────

interface PlatformRow {
    boat_id: string;
    enabled: boolean;
    consent_version: string | null;
    capture_device_id: string | null;
    privacy_zones: unknown;
    sounder_note: string | null;
    updated_at: string;
}

const PLATFORM_COLUMNS =
    'boat_id, enabled, consent_version, capture_device_id, privacy_zones, sounder_note, updated_at';

/** The owner's row for this boat; 'none' when there is none; null when it could not be asked. */
export async function fetchCloudPlatform(boatId: string): Promise<SeabedLocal | 'none' | null> {
    const scope = getAuthIdentityScope();
    if (!supabase || !scope.userId) return null;
    try {
        const { data, error } = await supabase
            .from('seabed_platforms')
            .select(PLATFORM_COLUMNS)
            .eq('boat_id', boatId)
            .maybeSingle();
        if (error || !isAuthIdentityScopeCurrent(scope)) return null;
        const row = data as PlatformRow | null;
        if (!row) return 'none';
        return {
            boatId: row.boat_id,
            enabled: row.enabled === true,
            consentVersion: row.consent_version,
            captureDeviceId: row.capture_device_id,
            zones: parseSeabedZones(row.privacy_zones) ?? [],
            sounderNote: row.sounder_note,
            updatedAt: Date.parse(row.updated_at) || 0,
            pendingSync: false,
            dirty: [],
            known: true,
        };
    } catch {
        return null;
    }
}

/** The platform columns for the settings this device changed, and nothing else. */
function changedColumns(local: SeabedLocal): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of local.dirty) {
        if (key === 'enabled') {
            out.enabled = local.enabled;
            if (local.enabled) {
                out.consent_version = local.consentVersion;
                out.consented_at = new Date(local.updatedAt || Date.now()).toISOString();
            }
        } else if (key === 'captureDeviceId') out.capture_device_id = local.captureDeviceId;
        else if (key === 'zones') out.privacy_zones = local.zones;
        else out.sounder_note = local.sounderNote;
    }
    return out;
}

/** What the cloud row will hold once this device's changes are on it. */
function withChanges(base: SeabedLocal, local: SeabedLocal): SeabedLocal {
    const out: SeabedLocal = { ...base, boatId: local.boatId };
    for (const key of local.dirty) {
        if (key === 'enabled') {
            out.enabled = local.enabled;
            out.consentVersion = local.consentVersion;
        } else if (key === 'captureDeviceId') out.captureDeviceId = local.captureDeviceId;
        else if (key === 'zones') out.zones = local.zones;
        else out.sounderNote = local.sounderNote;
    }
    return out;
}

/** Send this device's pending changes, only those, onto the row as it is now. */
async function pushPending(local: SeabedLocal, vessel?: SeabedVessel): Promise<'synced' | 'pending' | 'refused'> {
    const scope = getAuthIdentityScope();
    if (!supabase || !scope.userId) return 'pending';
    const cloud = await fetchCloudPlatform(local.boatId);
    if (cloud === null) return 'pending';
    const payload = changedColumns(local);
    if (vessel) payload.vessel = vessel;
    try {
        const table = () => supabase!.from('seabed_platforms');
        let error: { code?: string; message: string } | null = null;
        if (cloud !== 'none') {
            if (Object.keys(payload).length) error = (await table().update(payload).eq('boat_id', local.boatId)).error;
        } else {
            error = (await table().insert({ owner_id: scope.userId, boat_id: local.boatId, ...payload })).error;
            // Two devices creating the row at once: the second becomes an update.
            if (error?.code === '23505') error = (await table().update(payload).eq('boat_id', local.boatId)).error;
        }
        if (error?.code === '42501' && isAuthIdentityScopeCurrent(scope)) {
            // Row-level security: the boat is no longer this account's (released or
            // sold). A change it can never make must not stay pending and block
            // every later pull: this device stops logging for it, here.
            log.warn('seabed platform refused: the boat is no longer yours; logging off on this device');
            const now = readSeabedLocal();
            if (now && now.boatId === local.boatId) {
                writeSeabedLocal({ ...now, enabled: false, pendingSync: false, dirty: [] });
            }
            return 'refused';
        }
        if (error || !isAuthIdentityScopeCurrent(scope)) {
            if (error) log.warn(`seabed platform not saved yet: ${error.message}`);
            return 'pending';
        }
        const merged = withChanges(cloud === 'none' ? blankLocal(local.boatId) : cloud, local);
        const now = readSeabedLocal();
        if (now && now.boatId === local.boatId && now.updatedAt === local.updatedAt) {
            writeSeabedLocal({ ...merged, updatedAt: local.updatedAt, pendingSync: false, dirty: [], known: true });
        }
        return 'synced';
    } catch {
        return 'pending';
    }
}

/**
 * Bring this device and the cloud row into line. A change still pending here
 * goes up first (only what changed). Then, with nothing pending, the row for
 * the owner's active boat comes down as it is: the switch, the zones, the
 * note and which device logs. Quiet before the migration is pushed (the read
 * fails, and the local copy stays as it is).
 *
 * activeBoatId: the owner's active boat; undefined = not known (this copy's
 * boat is used); null = the account has no boat of its own, so nothing comes
 * down (a released boat's row is not this device's to follow).
 */
export async function syncSeabedPlatform(
    opts: { activeBoatId?: string | null; vessel?: SeabedVessel } = {},
): Promise<'synced' | 'pending'> {
    const local = readSeabedLocal();
    if (local?.pendingSync) {
        const pushed = await pushPending(local, opts.vessel);
        if (pushed === 'pending') return 'pending';
        if (pushed === 'refused') return 'synced'; // not ours to change, nor to follow
    }
    if (opts.activeBoatId === null) return 'synced';
    const boatId = opts.activeBoatId ?? readSeabedLocal()?.boatId;
    if (!boatId) return 'synced';
    const cloud = await fetchCloudPlatform(boatId);
    if (cloud === null) return 'synced';
    const now = readSeabedLocal();
    if (now?.pendingSync) return 'pending'; // a change landed while we asked: it goes up next time
    if (cloud === 'none') {
        // A row this device had seen is gone: nothing may log for it from here.
        if (now && now.boatId === boatId && now.enabled) writeSeabedLocal({ ...now, enabled: false, known: true });
        // Another boat's copy, kept in the cloud: this device follows the active boat.
        else if (now && now.boatId !== boatId) writeSeabedLocal(null);
        return 'synced';
    }
    if (!now || !sameSettings(now, cloud) || !now.known) writeSeabedLocal(cloud);
    return 'synced';
}

/** Change the settings here, now, then tell the Pi and the cloud. Returns the new local copy. */
export async function saveSeabed(
    boatId: string,
    change: Partial<Pick<SeabedLocal, SeabedSetting>>,
    vessel?: SeabedVessel,
): Promise<SeabedLocal> {
    let current = readSeabedLocal();
    // Another boat's change still waiting: give it its chance to go up first.
    if (current?.pendingSync && current.boatId !== boatId) await syncSeabedPlatform();
    current = readSeabedLocal();
    if (!current || current.boatId !== boatId) {
        // No copy of this boat here: start from the cloud row, never from blank zones.
        const cloud = await fetchCloudPlatform(boatId);
        current = cloud && cloud !== 'none' ? cloud : blankLocal(boatId);
    }
    const changed = SETTINGS.filter((key) => key in change);
    const next: SeabedLocal = {
        ...current,
        ...change,
        boatId,
        updatedAt: Date.now(),
        pendingSync: true,
        dirty: SETTINGS.filter((key) => current!.dirty.includes(key) || changed.includes(key)),
    };
    if (next.enabled) next.consentVersion = SEABED_CONSENT_VERSION;
    writeSeabedLocal(next);
    void pushSeabedToPi(next, vessel);
    await syncSeabedPlatform({ vessel });
    return readSeabedLocal() ?? next;
}

/** A private place, its centre moved once by up to a quarter of its radius. The true spot never leaves here. */
export function makeSeabedZone(
    kind: SeabedZone['kind'],
    lat: number,
    lon: number,
    radiusM?: number,
    idPrefix: string = kind,
): SeabedZone {
    const radius = radiusM ?? (kind === 'home' ? HOME_DEFAULT_RADIUS_M : MARKED_DEFAULT_RADIUS_M);
    const centre = jitterZoneCentre(lat, lon, radius, Math.random);
    const id = `${idPrefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return {
        id,
        kind,
        lat: Math.round(centre.lat * 1e6) / 1e6,
        lon: Math.round(centre.lon * 1e6) / 1e6,
        radius_m: radius,
        jitter_m: radius * ZONE_JITTER_FRACTION,
    };
}

/** The boat is no longer the owner's to log: off on this device, whatever the cloud can still be told. */
export function retireSeabedLocal(): void {
    const local = readSeabedLocal();
    if (local) writeSeabedLocal({ ...local, enabled: false, pendingSync: false, dirty: [] });
}

// ── The Pi ────────────────────────────────────────────────────────────────

export interface PiSeabedStatus {
    enabled: boolean;
    underway: boolean;
    capturing: boolean;
    full: boolean;
    pending: { batches: number; rows: number; bytes: number };
    /** Hours closed in the trip under way, held until it ends. */
    parked?: { batches: number; rows: number };
    uploaded: { batches: number; rows: number; trackM: number };
    lastUploadAt: number | null;
}

/** The Pi's own view. 'old' when its software has no seabed routes; null when it could not be asked. */
export async function piSeabedStatus(): Promise<PiSeabedStatus | 'old' | null> {
    if (!isPinnedTransportAvailable()) return null;
    const pinnedSpki = getPairing()?.publicKeySpki;
    if (!pinnedSpki) return null;
    try {
        const res = await piRequest({
            url: `${piCache.baseUrl}/api/seabed/status`,
            method: 'GET',
            pinnedSpki,
            connectTimeout: 3_000,
            readTimeout: 5_000,
            responseType: 'text',
        });
        if (res.status === 404) return 'old';
        if (res.status < 200 || res.status >= 300) return null;
        return JSON.parse(res.data) as PiSeabedStatus;
    } catch {
        return null;
    }
}

/**
 * Tell the boat's Pi now, over the LAN. It logs only while switched on with
 * the Pi as the logger. Zones and the note go only when this device knows
 * them (they came from the cloud row, or its skipper set them here): a Pi
 * told nothing about them keeps its own.
 */
export async function pushSeabedToPi(local: SeabedLocal, vessel?: SeabedVessel): Promise<boolean> {
    if (!isPinnedTransportAvailable()) return false;
    const pinnedSpki = getPairing()?.publicKeySpki;
    const owner = getAuthIdentityScope().userId;
    if (!pinnedSpki || !owner) return false;
    const draft = typeof vessel?.draft_m === 'number' ? vessel.draft_m : null;
    const data: Record<string, unknown> = {
        enabled: local.enabled,
        logger: local.captureDeviceId === null ? 'pi' : 'phone',
        consent_version: local.consentVersion,
        vessel_draft_m: draft,
        draft_confirmed: typeof vessel?.draft_confirmed === 'boolean' ? vessel.draft_confirmed : null,
        owner_id: owner,
        updated_at: local.updatedAt,
    };
    if (local.known || local.dirty.includes('zones')) data.zones = local.zones;
    if (local.known || local.dirty.includes('sounderNote')) data.sounder_note = local.sounderNote;
    try {
        const res = await piRequest({
            url: `${piCache.baseUrl}/api/seabed/config`,
            method: 'POST',
            data,
            headers: { 'content-type': 'application/json' },
            pinnedSpki,
            connectTimeout: 3_000,
            readTimeout: 5_000,
            responseType: 'text',
        });
        if (res.status >= 200 && res.status < 300) return true;
        if (res.status !== 404) log.warn(`seabed config to the Pi → ${res.status}`);
        return false;
    } catch {
        return false;
    }
}

// ── The contribution line ─────────────────────────────────────────────────

export interface SeabedContribution {
    soundings: number;
    trackM: number;
}

export function cachedSeabedSummary(): SeabedContribution | null {
    const v = readJson(SUMMARY_KEY);
    return v && typeof v.soundings === 'number' && typeof v.trackM === 'number'
        ? { soundings: v.soundings, trackM: v.trackM }
        : null;
}

/** What the cloud holds for this account; the cached figure when it cannot be asked. */
export async function fetchSeabedSummary(): Promise<SeabedContribution | null> {
    if (!supabase || !getAuthIdentityScope().userId) return cachedSeabedSummary();
    try {
        const { data, error } = await supabase.rpc('seabed_contribution_summary');
        const row = (Array.isArray(data) ? data[0] : data) as { soundings?: unknown; track_m?: unknown } | null;
        if (error || !row) return cachedSeabedSummary();
        const summary = { soundings: Number(row.soundings) || 0, trackM: Number(row.track_m) || 0 };
        localStorage.setItem(authScopedStorageKey(SUMMARY_KEY), JSON.stringify(summary));
        return summary;
    } catch {
        return cachedSeabedSummary();
    }
}

/** "Seabed mapping: 12,345 soundings logged, 87 km of track · 1,203 waiting to upload". */
export function formatSeabedContribution(uploaded: SeabedContribution | null, waiting: SeabedContribution): string {
    const soundings = (uploaded?.soundings ?? 0) + waiting.soundings;
    if (soundings === 0) {
        return "Seabed mapping: no soundings yet. They start once you're under way with the sounder on.";
    }
    const km = ((uploaded?.trackM ?? 0) + waiting.trackM) / 1000;
    const kmText = km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString();
    const queue = waiting.soundings > 0 ? ` · ${waiting.soundings.toLocaleString()} waiting to upload` : '';
    return `Seabed mapping: ${soundings.toLocaleString()} soundings logged, ${kmText} km of track${queue}`;
}
