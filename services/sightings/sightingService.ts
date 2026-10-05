/**
 * Sightings on the phone: log, refine, add a photo, delete, list. Every
 * change lands in the local outbox first (sightingStore), so logging works
 * at sea, signed out, and before the server has the table; sightingSync sends
 * it when it can.
 *
 * One tap logs (Shane hates toasts; the sheet confirms in place): the group
 * tile writes the sighting straight away with the event time of the sheet
 * opening and whatever context has arrived. A position that arrives later is
 * attached; with none after 60 s the record stays 'needs position' and never
 * syncs without coordinates. Everything after the tap edits the saved
 * sighting. Where and when never change after the server has it.
 *
 * Visibility rules (the server enforces them too): fish are never Public;
 * Crew needs a boat; a sighting logged ashore has no boat; signed out is
 * Private and stays on the phone until adopted at sign-in.
 */
import { getAuthIdentityScope } from '../authIdentityScope';
import { captureSightingContext, type CloudOwner, type SightingContext } from './sightingContext';
import {
    deleteLocalSighting,
    getLocalSighting,
    getSightingMeta,
    listLocalSightings,
    putLocalSighting,
    putSightingMeta,
    savePhotoBlob,
    deletePhotoBlob,
} from './sightingStore';
import { ensureSightingSyncTriggers, isSightingInFlight, photoPath, scheduleSightingDrain } from './sightingSync';
import {
    OBSERVED_DISTANCES_M,
    SIGHTING_GROUPS,
    SIGHTING_LIMITS,
    VESSEL_PROTOCOL,
    type LocalSighting,
    type ObservedDistanceM,
    type SightingEdit,
    type SightingGroup,
    type SightingRow,
    type SightingVisibility,
} from './types';

export const SIGHTINGS_CLIENT_VERSION = `thalassa/${String(import.meta.env?.VITE_APP_VERSION || 'dev').slice(0, 30)}`;
export const NEEDS_POSITION_AFTER_MS = 60_000;

export interface SightingVesselChoice {
    /** The skipper whose boat it was seen from (yourself for your own boat); null = no boat. */
    vesselOwnerId: string | null;
    /** A hint: the server resolves the skipper's live hull when this is not one. */
    boatId: string | null;
    voyageId: string | null;
}

export const NO_VESSEL: SightingVesselChoice = { vesselOwnerId: null, boatId: null, voyageId: null };

/** A v4 uuid: the row's id, made here so a retried insert is idempotent. */
export function newSightingId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The visibility a sighting may have: fish never Public (Crew with a boat,
 * else Private); Crew needs a boat.
 */
export function clampVisibility(
    group: SightingGroup,
    visibility: SightingVisibility,
    hasVessel: boolean,
): SightingVisibility {
    let v = visibility;
    if (group === 'fish' && v === 'public') v = hasVessel ? 'crew' : 'private';
    if (v === 'crew' && !hasVessel) v = 'private';
    return v;
}

/**
 * First time for a group: Crew when there is a boat with people on it (you
 * have accepted crew, or you are crew), otherwise Private; never Public until
 * chosen. Fish always start Private (Shane's pick: catch spots are yours);
 * they can be made Crew, never Public. After that the last choice for the
 * group sticks, clamped.
 */
export function chooseDefaultVisibility(input: {
    group: SightingGroup;
    hasVessel: boolean;
    boatHasCrew: boolean;
    lastChoice: SightingVisibility | null;
}): SightingVisibility {
    const share = input.group !== 'fish' && input.hasVessel && input.boatHasCrew;
    const start = input.lastChoice ?? (share ? 'crew' : 'private');
    return clampVisibility(input.group, start, input.hasVessel);
}

export async function loadVisibilityChoice(group: SightingGroup): Promise<SightingVisibility | null> {
    const value = await getSightingMeta<string>(getAuthIdentityScope().userId, `visibility:${group}`);
    return value === 'private' || value === 'crew' || value === 'public' ? value : null;
}

export async function rememberVisibilityChoice(group: SightingGroup, visibility: SightingVisibility): Promise<void> {
    await putSightingMeta(getAuthIdentityScope().userId, `visibility:${group}`, visibility);
}

export type VesselChipChoice = 'own' | 'none' | string;

/**
 * Which boat a sighting is logged against:
 *   - signed out, or ashore: none;
 *   - you are crew and have no boat of your own, or chose the skipper's last
 *     time: the skipper's boat (the server picks the hull), with the voyage
 *     this phone is recording if it is (your own track of that passage);
 *   - this phone is recording your own log: your boat and that voyage;
 *   - your own active vessel;
 *   - none.
 * An explicit 'none' last time stays none unless you are recording.
 */
export function chooseSightingVessel(input: {
    userId: string | null;
    ashore: boolean;
    recording: { voyageId: string | null; boatId: string | null } | null;
    ownActiveVesselId: string | null;
    crewingOwnerId: string | null;
    lastChoice: VesselChipChoice | null;
}): SightingVesselChoice {
    const { userId } = input;
    if (!userId || input.ashore) return NO_VESSEL;
    const crewingHere =
        !!input.crewingOwnerId && (!input.ownActiveVesselId || input.lastChoice === input.crewingOwnerId);
    if (input.recording?.voyageId) {
        // Crew recording the passage on their own phone, with no boat of
        // their own bound to it: still the skipper's boat, so the boat's crew
        // feed sees it.
        if (crewingHere && !input.recording.boatId) {
            return { vesselOwnerId: input.crewingOwnerId, boatId: null, voyageId: input.recording.voyageId };
        }
        return {
            vesselOwnerId: userId,
            boatId: input.recording.boatId ?? input.ownActiveVesselId,
            voyageId: input.recording.voyageId,
        };
    }
    if (input.lastChoice === 'none') return NO_VESSEL;
    if (crewingHere) {
        return { vesselOwnerId: input.crewingOwnerId, boatId: null, voyageId: null };
    }
    if (input.ownActiveVesselId) return { vesselOwnerId: userId, boatId: input.ownActiveVesselId, voyageId: null };
    return NO_VESSEL;
}

/** The cloud row to read for a sighting's boat: 'self', the skipper's id, or null (no boat). */
export function cloudOwnerFor(vesselOwnerId: string | null, userId: string | null): CloudOwner {
    if (!vesselOwnerId) return null;
    return vesselOwnerId === userId ? 'self' : vesselOwnerId;
}

function trimTo(value: string | null | undefined, max: number): string | null {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    return t ? t.slice(0, max) : null;
}

function clampCount(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1;
    return Math.max(1, Math.min(SIGHTING_LIMITS.countMax, n));
}

/**
 * How far the boat may have gone between the sighting and a later fix: a
 * position found after the moment is wider by speed times the gap (a Retry
 * long after the tap is honest about it). Capped at the table's 100 km.
 */
function uncertaintyAtEvent(row: SightingRow, context: SightingContext): number | null {
    const p = context.position;
    if (!p) return row.coordinate_uncertainty_in_meters;
    const eventAt = Date.parse(row.event_date);
    const gapS = Number.isFinite(eventAt) ? Math.max(0, (p.fixAt - eventAt) / 1000) : 0;
    const sog = typeof context.sogKts === 'number' && context.sogKts > 0 ? context.sogKts : 0;
    const drift = (sog / 1.943844) * gapS;
    return Math.min(100_000, Math.max(1, Math.ceil(p.uncertaintyM + drift)));
}

/** Put a context's position and readings onto a row (only while the server does not have it yet). */
export function applyContext(row: SightingRow, context: SightingContext | null): SightingRow {
    if (!context) return row;
    const p = context.position;
    const next: SightingRow = {
        ...row,
        decimal_latitude: p ? p.latitude : row.decimal_latitude,
        decimal_longitude: p ? p.longitude : row.decimal_longitude,
        position_accuracy_m: p ? p.accuracyM : row.position_accuracy_m,
        coordinate_uncertainty_in_meters: uncertaintyAtEvent(row, context),
        position_source: p ? p.source : row.position_source,
        position_fix_at: p ? new Date(p.fixAt).toISOString() : row.position_fix_at,
        sampling_protocol: context.samplingProtocol,
        sea_temp_c: context.seaTempC,
        sea_temp_source: context.seaTempSource,
        water_depth_m: context.waterDepthM,
        depth_reference: context.depthReference,
        wind_speed_kts: context.windSpeedKts,
        wind_dir_deg: context.windDirDeg,
        wind_source: context.windSource,
        wave_height_m: context.waveHeightM,
        wx_model: context.wxModel,
        sog_kts: context.sogKts,
        cog_deg: context.cogDeg,
        heading_deg: context.headingDeg,
    };
    if (p?.ashore) {
        // Ashore: no boat, no voyage; the boat's crew are not watching from here.
        next.vessel_owner_id = null;
        next.boat_id = null;
        next.voyage_id = null;
        next.visibility = clampVisibility(next.taxon_group, next.visibility, false);
    }
    return next;
}

export interface NewSighting {
    group: SightingGroup;
    /** Epoch ms: when the sheet opened (the moment of the sighting). */
    eventAt: number;
    context: SightingContext | null;
    vessel: SightingVesselChoice;
    visibility: SightingVisibility;
    observerDisplay?: string | null;
    id?: string;
}

/** The tap: save the sighting on the phone now. */
export async function logSighting(input: NewSighting): Promise<LocalSighting> {
    const userId = getAuthIdentityScope().userId;
    const vessel = userId ? input.vessel : NO_VESSEL;
    const hasVessel = !!vessel.vesselOwnerId;
    const now = Date.now();
    const base: SightingRow = {
        id: input.id ?? newSightingId(),
        observer_id: userId,
        vessel_owner_id: vessel.vesselOwnerId,
        boat_id: vessel.vesselOwnerId ? vessel.boatId : null,
        voyage_id: trimTo(vessel.voyageId, SIGHTING_LIMITS.voyageIdMax),
        visibility: userId ? clampVisibility(input.group, input.visibility, hasVessel) : 'private',
        taxon_group: input.group,
        scientific_name: null,
        individual_count: 1,
        count_is_estimate: false,
        has_calf: false,
        behavior: null,
        observed_distance_m: null,
        event_date: new Date(input.eventAt).toISOString(),
        decimal_latitude: null,
        decimal_longitude: null,
        position_accuracy_m: null,
        coordinate_uncertainty_in_meters: null,
        position_source: null,
        position_fix_at: null,
        sampling_protocol: VESSEL_PROTOCOL,
        sea_temp_c: null,
        sea_temp_source: null,
        water_depth_m: null,
        depth_reference: null,
        wind_speed_kts: null,
        wind_dir_deg: null,
        wind_source: null,
        wave_height_m: null,
        wx_model: null,
        sog_kts: null,
        cog_deg: null,
        heading_deg: null,
        occurrence_remarks: null,
        photo_paths: [],
        observer_display: trimTo(input.observerDisplay, SIGHTING_LIMITS.observerDisplayMax),
        credit_public: false,
        client_version: SIGHTINGS_CLIENT_VERSION,
    };
    const row = applyContext(base, input.context);
    const hasPosition = row.decimal_latitude !== null && row.decimal_longitude !== null;
    const record: LocalSighting = {
        id: row.id,
        ownerUserId: userId,
        row,
        photos: [],
        sync: {
            state: hasPosition ? (userId ? 'pending' : 'held') : 'needs-position',
            op: 'insert',
            serverKnown: false,
            attempts: 0,
            lastError: userId ? null : 'signed-out',
            nextAttemptAt: null,
        },
        vernacularName: null,
        createdAtLocal: now,
        updatedAtLocal: now,
    };
    await putLocalSighting(record);
    if (userId) {
        ensureSightingSyncTriggers();
        scheduleSightingDrain();
    }
    return record;
}

async function mutate(
    id: string,
    change: (record: LocalSighting) => LocalSighting | null,
): Promise<LocalSighting | null> {
    const userId = getAuthIdentityScope().userId;
    const record = await getLocalSighting(id, userId);
    if (!record || record.sync.op === 'delete') return null;
    const next = change(record);
    if (!next) return record;
    next.updatedAtLocal = Math.max(Date.now(), record.updatedAtLocal + 1);
    if (next.sync.state !== 'needs-position') {
        if (record.sync.serverKnown) next.sync = { ...next.sync, op: 'update', state: 'pending' };
        else next.sync = { ...next.sync, op: 'insert', state: userId ? 'pending' : 'held' };
        next.sync.nextAttemptAt = null;
        if (next.sync.state === 'pending') next.sync.lastError = null;
    }
    await putLocalSighting(next);
    if (userId) {
        ensureSightingSyncTriggers();
        scheduleSightingDrain();
    }
    return next;
}

/**
 * A position (and context) arrived after the tap. Only while the server does
 * not have the sighting: after that, where and when are fixed.
 */
export async function attachSightingContext(id: string, context: SightingContext): Promise<LocalSighting | null> {
    if (!context.position) return null;
    return mutate(id, (record) => {
        if (record.sync.serverKnown) return null;
        const row = applyContext(record.row, context);
        return {
            ...record,
            row,
            sync: { ...record.sync, state: 'pending', lastError: null },
        };
    });
}

/**
 * Wait for the context the sheet started capturing, attach its position, or
 * leave the record as 'needs position' after 60 s. The sheet offers Retry.
 */
export async function awaitSightingPosition(
    id: string,
    contextPromise: Promise<SightingContext>,
    timeoutMs = NEEDS_POSITION_AFTER_MS,
): Promise<'attached' | 'needs-position'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
        const context = await Promise.race([contextPromise.catch(() => null), timeout]);
        if (context?.position) {
            const saved = await attachSightingContext(id, context);
            if (saved && saved.row.decimal_latitude !== null) return 'attached';
        }
        return 'needs-position';
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * A sighting still waiting for a position (no fix at the tap, or the app was
 * closed during the 60 s wait): find the boat's position now, the same chain
 * as the tap, from THIS sighting's boat. The caller says so when the moment
 * is long past; the uncertainty grows with the boat's speed over the gap.
 */
export async function retrySightingPosition(
    id: string,
    capture: (owner: CloudOwner) => Promise<SightingContext> = (owner) =>
        captureSightingContext(undefined, { vesselOwner: async () => owner }),
): Promise<'attached' | 'needs-position'> {
    const userId = getAuthIdentityScope().userId;
    const record = await getLocalSighting(id, userId);
    if (!record || record.sync.op === 'delete') return 'needs-position';
    if (record.row.decimal_latitude !== null && record.row.decimal_longitude !== null) return 'attached';
    const context = await capture(cloudOwnerFor(record.row.vessel_owner_id, record.ownerUserId)).catch(() => null);
    if (!context?.position) return 'needs-position';
    const saved = await attachSightingContext(id, context);
    return saved && saved.row.decimal_latitude !== null ? 'attached' : 'needs-position';
}

/** A sighting the server refused ('failed'): queue it again as it stands. */
export async function retrySendingSighting(id: string): Promise<LocalSighting | null> {
    return mutate(id, (record) =>
        record.sync.state === 'failed' ? { ...record, sync: { ...record.sync, attempts: 0 } } : null,
    );
}

/** Refine a sighting: species, count, calf, behaviour, distance, notes, visibility, credit. */
export async function editSighting(id: string, edit: SightingEdit): Promise<LocalSighting | null> {
    return mutate(id, (record) => {
        const row: SightingRow = { ...record.row };
        if (edit.taxon_group && (SIGHTING_GROUPS as readonly string[]).includes(edit.taxon_group)) {
            row.taxon_group = edit.taxon_group;
        }
        if (edit.scientific_name !== undefined) row.scientific_name = trimTo(edit.scientific_name, 120);
        if (edit.individual_count !== undefined) row.individual_count = clampCount(edit.individual_count);
        if (edit.count_is_estimate !== undefined) row.count_is_estimate = !!edit.count_is_estimate;
        if (edit.has_calf !== undefined) row.has_calf = !!edit.has_calf;
        if (edit.behavior !== undefined) row.behavior = trimTo(edit.behavior, SIGHTING_LIMITS.behaviorMax);
        if (edit.observed_distance_m !== undefined) {
            row.observed_distance_m = (OBSERVED_DISTANCES_M as readonly number[]).includes(
                edit.observed_distance_m as number,
            )
                ? (edit.observed_distance_m as ObservedDistanceM)
                : null;
        }
        if (edit.occurrence_remarks !== undefined) {
            row.occurrence_remarks = trimTo(edit.occurrence_remarks, SIGHTING_LIMITS.remarksMax);
        }
        if (edit.observer_display !== undefined) {
            row.observer_display = trimTo(edit.observer_display, SIGHTING_LIMITS.observerDisplayMax);
        }
        if (edit.credit_public !== undefined) row.credit_public = !!edit.credit_public;
        const chosen = edit.visibility !== undefined || !!record.visibilityChosen;
        if (edit.visibility !== undefined) row.visibility = edit.visibility;
        else if (row.taxon_group === 'fish' && record.row.taxon_group !== 'fish' && !chosen) {
            // Regrouped to fish with a default visibility: fish start Private,
            // as the Fish tile does (catch spots are yours).
            row.visibility = 'private';
        }
        row.visibility = record.ownerUserId
            ? clampVisibility(row.taxon_group, row.visibility, !!row.vessel_owner_id)
            : 'private';
        row.client_version = SIGHTINGS_CLIENT_VERSION;
        const vernacularName = edit.scientific_name !== undefined ? null : record.vernacularName;
        return { ...record, row, vernacularName, visibilityChosen: chosen };
    });
}

/**
 * Display name the UI has from the catalogue (the server copies its own),
 * and whether that species is threatened: once it was, a public copy stays
 * coarse (sticky, like the server's ever_sensitive).
 */
export async function setSightingDisplayName(
    id: string,
    vernacularName: string | null,
    sensitive = false,
): Promise<LocalSighting | null> {
    const userId = getAuthIdentityScope().userId;
    const record = await getLocalSighting(id, userId);
    if (!record) return null;
    const next = { ...record, vernacularName, everSensitive: !!record.everSensitive || sensitive };
    await putLocalSighting(next);
    return next;
}

/**
 * Add a photo: stripped of every metadata segment (photoStrip) before it is
 * stored, so nothing with a position is ever kept or sent. Throws
 * PhotoStripError when the photo cannot be cleaned; the sighting is unchanged.
 */
export async function addSightingPhoto(id: string, file: Blob): Promise<LocalSighting | null> {
    const userId = getAuthIdentityScope().userId;
    const record = await getLocalSighting(id, userId);
    if (!record || record.sync.op === 'delete') return null;
    const slot = freePhotoSlot(record);
    if (slot === null) return record;
    const { stripAndCompressPhoto } = await import('./photoStrip');
    const clean = await stripAndCompressPhoto(file);
    const blobKey = await savePhotoBlob(clean);
    const saved = await mutate(id, (fresh) => {
        if (freePhotoSlot(fresh) !== slot) return null;
        return { ...fresh, photos: [...fresh.photos, { slot, blobKey, path: null }] };
    });
    if (!saved || !saved.photos.some((p) => p.blobKey === blobKey)) await deletePhotoBlob(blobKey);
    return saved;
}

/**
 * The lowest slot (0-3) neither holding a photo nor waiting for its old
 * object to be removed: reusing that path could serve, or delete, the wrong
 * photo. Null when all four are taken.
 */
export function freePhotoSlot(record: LocalSighting): number | null {
    const taken = new Set(record.photos.map((p) => p.slot));
    for (const path of record.removedPhotoPaths ?? []) {
        const m = /\/([0-3])\.jpg$/.exec(path);
        if (m) taken.add(Number(m[1]));
    }
    const slot = [0, 1, 2, 3].find((s) => !taken.has(s));
    return slot === undefined ? null : slot;
}

/** Remove a photo; a stored copy goes from storage once the row stops listing it. */
export async function removeSightingPhoto(id: string, slot: number): Promise<LocalSighting | null> {
    const dropped: { blobKey: string | null } = { blobKey: null };
    const saved = await mutate(id, (record) => {
        const photo = record.photos.find((p) => p.slot === slot);
        if (!photo) return null;
        dropped.blobKey = photo.blobKey;
        const path = photo.path ?? (record.row.observer_id ? photoPath(record.row.observer_id, record.id, slot) : null);
        return {
            ...record,
            photos: record.photos.filter((p) => p.slot !== slot),
            // Even an upload not yet confirmed may have landed: clean its path up too.
            removedPhotoPaths: path ? [...(record.removedPhotoPaths ?? []), path] : record.removedPhotoPaths,
        };
    });
    if (dropped.blobKey) await deletePhotoBlob(dropped.blobKey);
    return saved;
}

/**
 * Delete (also the sheet's Undo). Never sent: gone at once. Otherwise a
 * tombstone the outbox removes from the server, photos first.
 */
export async function deleteSighting(id: string): Promise<boolean> {
    const userId = getAuthIdentityScope().userId;
    const record = await getLocalSighting(id, userId);
    if (!record) return false;
    if (!record.sync.serverKnown && !isSightingInFlight(id)) {
        await deleteLocalSighting(record);
        return true;
    }
    await putLocalSighting({
        ...record,
        updatedAtLocal: Math.max(Date.now(), record.updatedAtLocal + 1),
        sync: { ...record.sync, op: 'delete', state: 'pending', nextAttemptAt: null, lastError: null },
    });
    if (userId) {
        ensureSightingSyncTriggers();
        scheduleSightingDrain(0);
    }
    return true;
}

/** This account's sightings on this phone, newest first; deletions waiting to send are hidden. */
export async function listMySightings(): Promise<LocalSighting[]> {
    const userId = getAuthIdentityScope().userId;
    return (await listLocalSightings(userId)).filter((r) => r.sync.op !== 'delete');
}

/** How many sightings were logged signed out on this phone (offered for adoption at sign-in). */
export async function signedOutSightingCount(): Promise<number> {
    return (await listLocalSightings(null)).filter((r) => r.sync.op !== 'delete').length;
}

/**
 * "Add the N sightings you logged signed out to your account": they become
 * yours, Private, with no boat, and sync.
 */
export async function adoptSignedOutSightings(): Promise<number> {
    const userId = getAuthIdentityScope().userId;
    if (!userId) return 0;
    let adopted = 0;
    for (const record of await listLocalSightings(null)) {
        if (record.sync.op === 'delete') continue;
        const hasPosition = record.row.decimal_latitude !== null && record.row.decimal_longitude !== null;
        await putLocalSighting({
            ...record,
            ownerUserId: userId,
            row: {
                ...record.row,
                observer_id: userId,
                vessel_owner_id: null,
                boat_id: null,
                visibility: 'private',
            },
            updatedAtLocal: Math.max(Date.now(), record.updatedAtLocal + 1),
            sync: {
                ...record.sync,
                state: hasPosition ? 'pending' : 'needs-position',
                op: 'insert',
                serverKnown: false,
                lastError: null,
                nextAttemptAt: null,
            },
        });
        adopted += 1;
    }
    if (adopted > 0) {
        ensureSightingSyncTriggers();
        scheduleSightingDrain(0);
    }
    return adopted;
}

export interface LifeListEntry {
    scientificName: string;
    vernacularName: string | null;
    group: SightingGroup;
    firstSeen: string;
    sightings: number;
}

/**
 * Species seen, by first sighting: "<Boat>'s species: N". Group-only
 * sightings are not species and do not count.
 */
export function lifeList(
    rows: ReadonlyArray<{
        scientific_name: string | null;
        taxon_group: SightingGroup;
        event_date: string;
        vernacular_name?: string | null;
    }>,
): LifeListEntry[] {
    const byName = new Map<string, LifeListEntry>();
    for (const row of rows) {
        if (!row.scientific_name) continue;
        const entry = byName.get(row.scientific_name);
        if (!entry) {
            byName.set(row.scientific_name, {
                scientificName: row.scientific_name,
                vernacularName: row.vernacular_name ?? null,
                group: row.taxon_group,
                firstSeen: row.event_date,
                sightings: 1,
            });
        } else {
            entry.sightings += 1;
            if (row.event_date < entry.firstSeen) entry.firstSeen = row.event_date;
            if (!entry.vernacularName && row.vernacular_name) entry.vernacularName = row.vernacular_name;
        }
    }
    return [...byName.values()].sort((a, b) =>
        a.firstSeen < b.firstSeen
            ? -1
            : a.firstSeen > b.firstSeen
              ? 1
              : a.scientificName.localeCompare(b.scientificName),
    );
}
