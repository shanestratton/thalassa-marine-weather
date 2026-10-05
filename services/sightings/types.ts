/**
 * Sightings — shared types (Shane 2026-10-05: "go with your picks, call it
 * sightings").
 *
 * A sighting is stored on the phone first (sightingStore) and synced to
 * public.sightings (migration 20261005150000) by sightingSync. The row shape
 * here is the table's own snake_case, Darwin Core shaped, so the outbox sends
 * exactly what it stored.
 *
 * Pure types and constants: no imports, safe for the main chunk.
 */

export const SIGHTING_GROUPS = [
    'whale',
    'dolphin',
    'dugong',
    'turtle',
    'seabird',
    'shark_ray',
    'fish',
    'other',
] as const;
export type SightingGroup = (typeof SIGHTING_GROUPS)[number];

export const SIGHTING_GROUP_LABELS: Record<SightingGroup, string> = {
    whale: 'Whale',
    dolphin: 'Dolphin',
    dugong: 'Dugong',
    turtle: 'Turtle',
    seabird: 'Seabird',
    shark_ray: 'Shark or ray',
    fish: 'Fish',
    other: 'Other',
};

export function isSightingGroup(value: unknown): value is SightingGroup {
    return typeof value === 'string' && (SIGHTING_GROUPS as readonly string[]).includes(value);
}

export type SightingVisibility = 'private' | 'crew' | 'public';

/** Which receiver gave the position: the boat's bus, the Pi, the Pi's cloud row, or this phone. */
export type SightingPositionSource = 'bus' | 'pi' | 'cloud' | 'phone';

export const VESSEL_PROTOCOL = 'opportunistic vessel-based observation';
export const SHORE_PROTOCOL = 'opportunistic shore-based observation';
export type SightingSamplingProtocol = typeof VESSEL_PROTOCOL | typeof SHORE_PROTOCOL;

export type ContextSource = 'instrument' | 'forecast';
export type DepthReference = 'below-transducer' | 'below-waterline' | 'below-keel';

/** The distances a punter can pick for "how far off". */
export const OBSERVED_DISTANCES_M = [100, 500, 1000, 3000] as const;
export type ObservedDistanceM = (typeof OBSERVED_DISTANCES_M)[number];

/** Server limits mirrored here so the phone never queues a row the server must refuse. */
export const SIGHTING_LIMITS = {
    countMax: 10_000,
    behaviorMax: 60,
    remarksMax: 1_000,
    photosMax: 4,
    observerDisplayMax: 60,
    voyageIdMax: 80,
    /** event_date may be at most this old when the row reaches the server. */
    maxAgeMs: 60 * 24 * 60 * 60 * 1000,
} as const;

/**
 * One row of public.sightings as the phone writes it. Server-owned columns
 * (created_at, updated_at, vernacular_name, taxon_rank, basis_of_record) are
 * not here: the trigger sets them.
 */
export interface SightingRow {
    id: string;
    observer_id: string | null;
    vessel_owner_id: string | null;
    boat_id: string | null;
    voyage_id: string | null;
    visibility: SightingVisibility;

    taxon_group: SightingGroup;
    scientific_name: string | null;
    individual_count: number;
    count_is_estimate: boolean;
    has_calf: boolean;
    behavior: string | null;
    observed_distance_m: ObservedDistanceM | null;

    event_date: string;

    /** Null only while the record waits for a fix ('needs-position'); never sent so. */
    decimal_latitude: number | null;
    decimal_longitude: number | null;
    position_accuracy_m: number | null;
    coordinate_uncertainty_in_meters: number | null;
    position_source: SightingPositionSource | null;
    position_fix_at: string | null;
    sampling_protocol: SightingSamplingProtocol;

    sea_temp_c: number | null;
    sea_temp_source: ContextSource | null;
    water_depth_m: number | null;
    depth_reference: DepthReference | null;
    wind_speed_kts: number | null;
    wind_dir_deg: number | null;
    wind_source: ContextSource | null;
    wave_height_m: number | null;
    wx_model: string | null;
    sog_kts: number | null;
    cog_deg: number | null;
    heading_deg: number | null;

    occurrence_remarks: string | null;
    photo_paths: string[];
    observer_display: string | null;
    credit_public: boolean;
    client_version: string | null;
}

/**
 * The columns an observer may change after the insert — exactly the
 * migration's GRANT UPDATE list (a test keeps the two equal). Where and when,
 * the context and the boat are fixed: a wrong pin is deleted and logged again.
 */
export const SIGHTING_MUTABLE_COLUMNS = [
    'taxon_group',
    'scientific_name',
    'individual_count',
    'count_is_estimate',
    'has_calf',
    'behavior',
    'observed_distance_m',
    'occurrence_remarks',
    'photo_paths',
    'visibility',
    'credit_public',
    'observer_display',
    'client_version',
] as const satisfies ReadonlyArray<keyof SightingRow>;
export type SightingMutableColumn = (typeof SIGHTING_MUTABLE_COLUMNS)[number];
export type SightingEdit = Partial<Pick<SightingRow, Exclude<SightingMutableColumn, 'photo_paths' | 'client_version'>>>;

/** A row as the server returns it (own, crew feed). */
export interface ServerSightingRow extends Omit<
    SightingRow,
    'decimal_latitude' | 'decimal_longitude' | 'position_source'
> {
    decimal_latitude: number;
    decimal_longitude: number;
    position_source: SightingPositionSource;
    vernacular_name: string | null;
    taxon_rank: string | null;
    created_at: string;
    updated_at: string;
    basis_of_record: 'HumanObservation';
}

/** One row of get_public_sightings(): fuzzed, delayed, no photos or remarks. */
export interface PublicSighting {
    sighting_id: string;
    taxon_group: SightingGroup;
    scientific_name: string | null;
    vernacular_name: string | null;
    taxon_rank: string | null;
    individual_count: number;
    has_calf: boolean;
    event_time: string;
    latitude: number;
    longitude: number;
    uncertainty_m: number;
    generalised: boolean;
    /** The observer's own voyage-log handle when they opted in; null reads 'A Thalassa sailor'. */
    credit: string | null;
}

export const ANONYMOUS_CREDIT = 'A Thalassa sailor';

export type SightingSyncState =
    /** Waiting to send (or to send a change). */
    | 'pending'
    /** The server has this version. */
    | 'synced'
    /** Waiting on something outside the phone (rate cap, account deletion, a sign-in). */
    | 'held'
    /** The server refused it for good (bad species, too old); kept on the phone. */
    | 'failed'
    /** No position yet: never sent without coordinates. */
    | 'needs-position';

export type SightingSyncOp = 'insert' | 'update' | 'delete';

export interface SightingPhotoRef {
    /** Slot 0-3: the storage path is <observer>/<sighting>/<slot>.jpg. */
    slot: number;
    /** Key of the stripped JPEG in the local photo store; null once uploaded and released. */
    blobKey: string | null;
    /** Set once uploaded. */
    path: string | null;
}

export interface LocalSighting {
    id: string;
    /** The signed-in user who logged it on this phone; null = logged signed out (Private, local only). */
    ownerUserId: string | null;
    row: SightingRow;
    photos: SightingPhotoRef[];
    sync: {
        state: SightingSyncState;
        /** What the server still needs: an insert, an update of the mutable columns, or a delete. */
        op: SightingSyncOp | null;
        /** True once an insert landed (or was found already there). */
        serverKnown: boolean;
        attempts: number;
        lastError: string | null;
        nextAttemptAt: number | null;
    };
    /** The server row's updated_at when this copy came from the server (pulls skip unchanged rows). */
    serverUpdatedAt?: string | null;
    /** Storage paths dropped from the row, removed from storage once the server row no longer lists them. */
    removedPhotoPaths?: string[];
    /** Display-only names the server would copy from the catalogue. */
    vernacularName: string | null;
    /** The punter chose who sees it (not a default): a regroup keeps the choice. */
    visibilityChosen?: boolean;
    /**
     * Named as a threatened species at some point: a public copy stays on the
     * coarse grid whatever it is renamed to (the server's ever_sensitive).
     */
    everSensitive?: boolean;
    createdAtLocal: number;
    updatedAtLocal: number;
}
