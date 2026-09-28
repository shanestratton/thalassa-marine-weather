/**
 * Read-only client for the shared cruising catalogue (schema deployed 2026-09-28).
 * Planner integration is opt-in; this client never accesses private tracks.
 * Pass the application's authenticated Supabase client to the factory.
 */
export const CRUISING_CATALOGUE_LIMITS = {
    radiusNM: 100,
    summaries: 50,
    variants: 32,
    checkpoints: 256,
    summaryBytes: 128 * 1024,
    detailBytes: 256 * 1024,
} as const;

export const CRUISING_CATALOGUE_LIMITATION =
    'Reviewed catalogue references do not establish a safe route, navigable approach, current access, depth, clearance or weather suitability.';

export interface CatalogueVersionRef {
    id: string;
    version: number;
}

export interface CataloguePosition {
    lat: number;
    lon: number;
}

export interface CatalogueReview {
    reviewedAt: string;
    reviewDueAt: string;
}

export interface CatalogueSummary extends CatalogueVersionRef {
    kind: 'destination' | 'trip';
    name: string;
    summary: string;
    position: CataloguePosition;
    distanceNM: number;
    review: CatalogueReview;
}

export interface CatalogueEvidence {
    sourceUrl: string;
    sourceLabel: string;
    retrievedAt: string;
    licence: string;
    licenceUrl: string;
    attribution: string;
    scope: string;
}

export interface CatalogueCheckpoint extends CataloguePosition {
    sequence: number;
    name: string;
    required: true;
    evidenceNote: string;
}

export interface CatalogueVariantRef extends CatalogueVersionRef {
    direction: 'outbound' | 'return';
    name: string;
}

interface CatalogueDetailBase extends CatalogueVersionRef {
    name: string;
    summary: string;
    position: CataloguePosition;
    review: CatalogueReview & { reviewerLabel: string; scope: string };
    evidence: CatalogueEvidence[];
    limitations: string[];
    activities: string[];
}

export type CatalogueDetail =
    | (CatalogueDetailBase & { kind: 'destination' })
    | (CatalogueDetailBase & {
          kind: 'trip';
          origin: CatalogueVersionRef;
          destination: CatalogueVersionRef;
          variants: CatalogueVariantRef[];
          variantsTruncated: boolean;
      })
    | (CatalogueDetailBase & {
          kind: 'route_variant';
          trip: CatalogueVersionRef;
          direction: 'outbound' | 'return';
          checkpoints: CatalogueCheckpoint[];
      });

/** Structural subset of SupabaseClient: deliberately exposes no mutation API. */
export interface CatalogueRpcClient {
    rpc(
        name: string,
        args: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: unknown }> & {
        abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
    };
}

type Row = Record<string, unknown>;
const invalid = () => new Error('Cruising catalogue response is invalid, stale or outside the requested bounds.');

function row(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value as Row;
}

function text(value: unknown, max = 2000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
    return value;
}

function finite(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid();
    return value;
}

function version(value: unknown): number {
    const result = finite(value, 1, 2147483647);
    if (!Number.isInteger(result)) throw invalid();
    return result;
}

function identity(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw invalid();
    return value.toLowerCase();
}

function ref(id: unknown, revision: unknown): CatalogueVersionRef {
    return { id: identity(id), version: version(revision) };
}

function position(value: Row): CataloguePosition {
    return { lat: finite(value.latitude, -90, 90), lon: finite(value.longitude, -180, 180) };
}

function timestamp(value: unknown): string {
    const result = text(value, 40);
    if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(result) ||
        !Number.isFinite(Date.parse(result))
    )
        throw invalid();
    return result;
}

function reviewed(value: Row, now: number): CatalogueReview {
    if (value.status !== 'published' || value.review_status !== 'reviewed' || !Number.isFinite(now)) throw invalid();
    const reviewedAt = timestamp(value.reviewed_at);
    const reviewDueAt = timestamp(value.review_due_at);
    if (
        Date.parse(reviewedAt) > now ||
        Date.parse(reviewDueAt) <= now ||
        Date.parse(reviewDueAt) <= Date.parse(reviewedAt)
    )
        throw invalid();
    return { reviewedAt, reviewDueAt };
}

function list(value: unknown, min: number, max: number): unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw invalid();
    return value;
}

function httpsUrl(value: unknown): string {
    const result = text(value);
    let url: URL;
    try {
        url = new URL(result);
    } catch {
        throw invalid();
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /\s/.test(result))
        throw invalid();
    return result;
}

function boundedPayload(value: unknown, maxBytes: number): void {
    // Supabase has already parsed JSON. This bounds accepted data and subsequent
    // work, not bytes downloaded; server-side row/field bounds provide that gate.
    const serialized = JSON.stringify(value);
    if (
        serialized === undefined ||
        serialized.length > maxBytes ||
        new TextEncoder().encode(serialized).byteLength > maxBytes
    )
        throw invalid();
}

function direction(value: unknown): 'outbound' | 'return' {
    if (value !== 'outbound' && value !== 'return') throw invalid();
    return value;
}

function requireNull(value: Row, fields: string[]): void {
    if (fields.some((field) => value[field] !== null)) throw invalid();
}

function approximateDistanceNM(a: CataloguePosition, b: CataloguePosition): number {
    const radians = Math.PI / 180;
    const h =
        Math.sin(((b.lat - a.lat) * radians) / 2) ** 2 +
        Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(((b.lon - a.lon) * radians) / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function parseDetail(value: unknown, expected: CatalogueVersionRef, now: number): CatalogueDetail {
    boundedPayload(value, CRUISING_CATALOGUE_LIMITS.detailBytes);
    const data = row(value);
    const reference = ref(data.entry_id, data.version);
    if (reference.id !== expected.id || reference.version !== expected.version) throw invalid();
    const review = reviewed(data, now);
    const evidence = list(data.evidence, 1, 12).map((item): CatalogueEvidence => {
        const source = row(item);
        const retrievedAt = timestamp(source.retrieved_at);
        if (Date.parse(retrievedAt) > Date.parse(review.reviewedAt)) throw invalid();
        return {
            sourceUrl: httpsUrl(source.source_url),
            sourceLabel: text(source.source_label),
            retrievedAt,
            licence: text(source.licence),
            licenceUrl: httpsUrl(source.licence_url),
            attribution: text(source.attribution),
            scope: text(source.scope),
        };
    });
    const common: CatalogueDetailBase = {
        ...reference,
        name: text(data.name, 160),
        summary: text(data.summary, 1000),
        position: position(data),
        review: { ...review, reviewerLabel: text(data.reviewer_label, 160), scope: text(data.review_scope, 1000) },
        evidence,
        limitations: list(data.limitations, 1, 20).map((item) => text(item, 1000)),
        activities: list(data.activities, 0, 12).map((item) => text(item, 1000)),
    };
    const variants = list(data.variants, 0, CRUISING_CATALOGUE_LIMITS.variants).map((item): CatalogueVariantRef => {
        const variant = row(item);
        return {
            ...ref(variant.entry_id, variant.version),
            direction: direction(variant.direction),
            name: text(variant.name, 160),
        };
    });
    if (
        new Set(variants.map((variant) => variant.id)).size !== variants.length ||
        typeof data.variants_truncated !== 'boolean'
    )
        throw invalid();
    if (data.kind !== 'trip' && (variants.length || data.variants_truncated)) throw invalid();
    if (data.kind === 'destination') {
        requireNull(data, [
            'origin_destination_id',
            'origin_destination_version',
            'destination_id',
            'destination_version',
            'trip_id',
            'trip_version',
            'direction',
            'checkpoints',
        ]);
        return { ...common, kind: 'destination' };
    }
    if (data.kind === 'trip') {
        requireNull(data, ['trip_id', 'trip_version', 'direction', 'checkpoints']);
        const origin = ref(data.origin_destination_id, data.origin_destination_version);
        const destination = ref(data.destination_id, data.destination_version);
        if (origin.id === destination.id || origin.id === reference.id || destination.id === reference.id)
            throw invalid();
        return { ...common, kind: 'trip', origin, destination, variants, variantsTruncated: data.variants_truncated };
    }
    if (data.kind === 'route_variant') {
        requireNull(data, [
            'origin_destination_id',
            'origin_destination_version',
            'destination_id',
            'destination_version',
        ]);
        const trip = ref(data.trip_id, data.trip_version);
        if (trip.id === reference.id) throw invalid();
        const checkpoints = list(data.checkpoints, 2, CRUISING_CATALOGUE_LIMITS.checkpoints).map(
            (item, index): CatalogueCheckpoint => {
                const point = row(item);
                if (point.sequence !== index + 1 || point.required !== true) throw invalid();
                return {
                    sequence: index + 1,
                    name: text(point.name, 160),
                    ...position(point),
                    required: true,
                    evidenceNote: text(point.evidence_note, 1000),
                };
            },
        );
        if (
            checkpoints[0].lat !== common.position.lat ||
            checkpoints[0].lon !== common.position.lon ||
            checkpoints.some(
                (point, i) => i > 0 && point.lat === checkpoints[i - 1].lat && point.lon === checkpoints[i - 1].lon,
            )
        )
            throw invalid();
        return { ...common, kind: 'route_variant', trip, direction: direction(data.direction), checkpoints };
    }
    throw invalid();
}

export function createCruisingCatalogueClient(client: CatalogueRpcClient, clock: () => number = Date.now) {
    async function read(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted();
        const { data, error } = await client.rpc(name, args).abortSignal(signal);
        signal.throwIfAborted();
        if (error) throw new Error('Cruising catalogue is unavailable. No catalogue references were loaded.');
        return data;
    }

    return {
        async nearby(request: {
            position: CataloguePosition;
            radiusNM?: number;
            limit?: number;
            signal: AbortSignal;
        }): Promise<CatalogueSummary[]> {
            const queryPosition = position({ latitude: request.position.lat, longitude: request.position.lon });
            const radiusNM = finite(request.radiusNM ?? 30, Number.MIN_VALUE, CRUISING_CATALOGUE_LIMITS.radiusNM);
            const limit = finite(request.limit ?? 24, 1, CRUISING_CATALOGUE_LIMITS.summaries);
            if (!Number.isInteger(limit)) throw invalid();
            const data = await read(
                'nearby_cruising_catalogue',
                {
                    p_latitude: queryPosition.lat,
                    p_longitude: queryPosition.lon,
                    p_radius_nm: radiusNM,
                    p_limit: limit,
                },
                request.signal,
            );
            boundedPayload(data, CRUISING_CATALOGUE_LIMITS.summaryBytes);
            const now = clock();
            const result = list(data, 0, limit).map((item): CatalogueSummary => {
                const value = row(item);
                if (value.kind !== 'destination' && value.kind !== 'trip') throw invalid();
                // Summaries cannot smuggle route geometry into the eager path.
                if ('checkpoints' in value || 'location' in value || 'geometry' in value) throw invalid();
                const point = position(value);
                // PostGIS uses an ellipsoid; allow its small difference from this
                // independent spherical bound, including at poles/dateline.
                if (approximateDistanceNM(queryPosition, point) > radiusNM * 1.006 + 0.01) throw invalid();
                return {
                    ...ref(value.entry_id, value.version),
                    kind: value.kind,
                    name: text(value.name, 160),
                    summary: text(value.summary, 1000),
                    position: point,
                    distanceNM: finite(value.distance_nm, 0, radiusNM),
                    review: reviewed(value, now),
                };
            });
            if (new Set(result.map((item) => item.id)).size !== result.length) throw invalid();
            return result;
        },

        async detail(
            reference: CatalogueVersionRef,
            options: { signal: AbortSignal },
        ): Promise<CatalogueDetail | null> {
            const expected = ref(reference.id, reference.version);
            const data = await read(
                'cruising_catalogue_detail',
                { p_id: expected.id, p_version: expected.version },
                options.signal,
            );
            // No fallback to latest or cache: withdrawn/stale/superseded refs
            // return null, and a transport failure remains a failure.
            return data === null ? null : parseDetail(data, expected, clock());
        },
    };
}
