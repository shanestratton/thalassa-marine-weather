import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    createCruisingCatalogueClient,
    CRUISING_CATALOGUE_LIMITATION,
    type CatalogueRpcClient,
} from '../services/dayPlanner/catalogue';

const NOW = Date.parse('2026-09-28T00:00:00Z');
const DESTINATION = '00000000-0000-4000-8000-000000000001';
const ARRIVAL = '00000000-0000-4000-8000-000000000002';
const TRIP = '00000000-0000-4000-8000-000000000003';
const VARIANT = '00000000-0000-4000-8000-000000000004';
const signal = () => new AbortController().signal;

function summary() {
    return {
        entry_id: DESTINATION,
        version: 1,
        kind: 'destination',
        name: 'Synthetic test destination',
        summary: 'Test fixture only; not a route or location recommendation.',
        latitude: 0,
        longitude: 0,
        distance_nm: 0,
        status: 'published',
        review_status: 'reviewed',
        reviewed_at: '2026-09-27T00:00:00Z',
        review_due_at: '2026-10-27T00:00:00Z',
    };
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const { distance_nm: _distance, ...base } = summary();
    return {
        ...base,
        reviewer_label: 'Synthetic fixture editor',
        review_scope: 'Fixture validation only',
        evidence: [
            {
                source_url: 'https://example.com/test',
                source_label: 'Synthetic evidence',
                retrieved_at: '2026-09-26T00:00:00Z',
                licence: 'Synthetic fixture licence',
                licence_url: 'https://example.com/licence',
                attribution: 'Test fixture',
                scope: 'Fixture only',
            },
        ],
        limitations: ['Synthetic test fixture; not a navigation reference.'],
        activities: [],
        origin_destination_id: null,
        origin_destination_version: null,
        destination_id: null,
        destination_version: null,
        trip_id: null,
        trip_version: null,
        direction: null,
        checkpoints: null,
        variants: [],
        variants_truncated: false,
        ...overrides,
    };
}

function route() {
    return detail({
        entry_id: VARIANT,
        kind: 'route_variant',
        trip_id: TRIP,
        trip_version: 3,
        direction: 'outbound',
        checkpoints: [
            { sequence: 1, name: 'Start', latitude: 0, longitude: 0, required: true, evidence_note: 'Fixture start' },
            {
                sequence: 2,
                name: 'Required bend',
                latitude: 0.01,
                longitude: 0,
                required: true,
                evidence_note: 'Fixture control',
            },
            { sequence: 3, name: 'End', latitude: 0.01, longitude: 0.01, required: true, evidence_note: 'Fixture end' },
        ],
    });
}

function transport(data: unknown, error: unknown = null, clock = () => NOW) {
    const response = Promise.resolve({ data, error });
    const abortSignal = vi.fn().mockReturnValue(response);
    const rpc = vi.fn().mockReturnValue(Object.assign(response, { abortSignal }));
    return { api: createCruisingCatalogueClient({ rpc }, clock), rpc, abortSignal };
}

describe('shared cruising catalogue read client', () => {
    it('loads bounded summaries without fetching detail or carrying checkpoints', async () => {
        const { api, rpc, abortSignal } = transport([summary()]);
        const controller = new AbortController();
        const results = await api.nearby({ position: { lat: 0, lon: 0 }, signal: controller.signal });
        expect(rpc).toHaveBeenCalledExactlyOnceWith('nearby_cruising_catalogue', {
            p_latitude: 0,
            p_longitude: 0,
            p_radius_nm: 30,
            p_limit: 24,
        });
        expect(abortSignal).toHaveBeenCalledWith(controller.signal);
        expect(results).toEqual([expect.objectContaining({ id: DESTINATION, version: 1, kind: 'destination' })]);
        expect(results[0]).not.toHaveProperty('checkpoints');
        expect(CRUISING_CATALOGUE_LIMITATION).toContain('do not establish a safe route');
    });

    it.each([
        { position: { lat: 91, lon: 0 } },
        { position: { lat: 0, lon: -181 } },
        { position: { lat: NaN, lon: 0 } },
        { radiusNM: 0 },
        { radiusNM: -1 },
        { radiusNM: 101 },
        { radiusNM: Infinity },
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
    ])('rejects invalid request bounds before making a request: %j', async (overrides) => {
        const { api, rpc } = transport([]);
        await expect(api.nearby({ position: { lat: 0, lon: 0 }, signal: signal(), ...overrides })).rejects.toThrow();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('accepts worldwide coordinates including poles and searches across the dateline', async () => {
        const pole = transport([]);
        await expect(pole.api.nearby({ position: { lat: 90, lon: 180 }, signal: signal() })).resolves.toEqual([]);
        const dateline = transport([{ ...summary(), longitude: -179.99, distance_nm: 1.21 }]);
        await expect(
            dateline.api.nearby({ position: { lat: 0, lon: 179.99 }, radiusNM: 2, signal: signal() }),
        ).resolves.toHaveLength(1);
    });

    it.each([
        { review_status: 'pending' },
        { status: 'withdrawn' },
        { status: 'draft' },
        { reviewed_at: '2026-10-01T00:00:00Z' },
        { review_due_at: '2026-09-28T00:00:00Z' },
        { review_due_at: 'not-a-date' },
        { review_due_at: null },
        { kind: 'route_variant' },
        { latitude: 90 },
        { distance_nm: 31 },
        { longitude: Infinity },
        { version: 1.5 },
        { name: '' },
        { entry_id: 'malformed' },
        { checkpoints: [] },
        { geometry: {} },
    ])('fails closed on invalid or stale summary data: %j', async (overrides) => {
        const { api } = transport([{ ...summary(), ...overrides }]);
        await expect(api.nearby({ position: { lat: 0, lon: 0 }, signal: signal() })).rejects.toThrow();
    });

    it('rejects duplicates, excess rows, malformed lists and oversized responses', async () => {
        for (const data of [
            [summary(), summary()],
            Array(25).fill(summary()),
            {},
            [null],
            [{ ...summary(), extra: 'x'.repeat(140_000) }],
        ]) {
            await expect(
                transport(data).api.nearby({ position: { lat: 0, lon: 0 }, signal: signal() }),
            ).rejects.toThrow();
        }
    });

    it('loads a requested exact version and preserves provenance separately from review', async () => {
        const { api, rpc } = transport(detail());
        const result = await api.detail({ id: DESTINATION, version: 1 }, { signal: signal() });
        expect(rpc).toHaveBeenCalledExactlyOnceWith('cruising_catalogue_detail', { p_id: DESTINATION, p_version: 1 });
        expect(result).toMatchObject({
            kind: 'destination',
            review: { reviewedAt: '2026-09-27T00:00:00Z' },
            evidence: [{ retrievedAt: '2026-09-26T00:00:00Z', licence: 'Synthetic fixture licence' }],
        });
    });

    it('keeps exact trip endpoint versions and directional variant references', async () => {
        const { api } = transport(
            detail({
                entry_id: TRIP,
                kind: 'trip',
                origin_destination_id: DESTINATION,
                origin_destination_version: 1,
                destination_id: ARRIVAL,
                destination_version: 2,
                variants: [{ entry_id: VARIANT, version: 4, direction: 'return', name: 'Explicit return' }],
                variants_truncated: true,
            }),
        );
        await expect(api.detail({ id: TRIP, version: 1 }, { signal: signal() })).resolves.toMatchObject({
            origin: { id: DESTINATION, version: 1 },
            destination: { id: ARRIVAL, version: 2 },
            variants: [{ id: VARIANT, version: 4, direction: 'return' }],
            variantsTruncated: true,
        });
    });

    it('preserves every required checkpoint in supplied order without inventing a reverse', async () => {
        const { api } = transport(route());
        const result = await api.detail({ id: VARIANT, version: 1 }, { signal: signal() });
        expect(result?.kind).toBe('route_variant');
        if (result?.kind !== 'route_variant') throw new Error('Expected route variant');
        expect(result.checkpoints.map((point) => point.name)).toEqual(['Start', 'Required bend', 'End']);
        expect(result.checkpoints.every((point) => point.required)).toBe(true);
        expect(result.direction).toBe('outbound');
        expect(result.trip).toEqual({ id: TRIP, version: 3 });
        expect(result).not.toHaveProperty('returnRoute');
    });

    it.each([
        { sequence: 3 },
        { sequence: '2' },
        { required: false },
        { required: null },
        { latitude: -91 },
        { longitude: NaN },
        { evidence_note: '' },
        { name: '' },
        { latitude: 0, longitude: 0 },
    ])('rejects malformed, missing, duplicate or optional checkpoints: %j', async (change) => {
        const data = route();
        const checkpoints = data.checkpoints as Record<string, unknown>[];
        checkpoints[1] = { ...checkpoints[1], ...change };
        await expect(transport(data).api.detail({ id: VARIANT, version: 1 }, { signal: signal() })).rejects.toThrow();
    });

    it('rejects wrong departure, missing checkpoints and excess checkpoint counts', async () => {
        const original = route();
        const points = original.checkpoints as Record<string, unknown>[];
        for (const checkpoints of [null, [points[0]], [points[1], points[2]], Array(257).fill(points[0])]) {
            await expect(
                transport({ ...original, checkpoints }).api.detail({ id: VARIANT, version: 1 }, { signal: signal() }),
            ).rejects.toThrow();
        }
    });

    it.each([
        { source_url: 'javascript:alert(1)' },
        { source_url: 'https://user:secret@example.com' },
        { licence_url: 'http://example.com' },
        { licence: '' },
        { attribution: '' },
        { scope: null },
        { retrieved_at: '2026-09-28T00:00:00Z' },
        { retrieved_at: 'yesterday' },
    ])('rejects unusable evidence and licensing: %j', async (change) => {
        const data = detail();
        const evidence = data.evidence as Record<string, unknown>[];
        evidence[0] = { ...evidence[0], ...change };
        await expect(
            transport(data).api.detail({ id: DESTINATION, version: 1 }, { signal: signal() }),
        ).rejects.toThrow();
    });

    it.each([
        { version: 2 },
        { entry_id: ARRIVAL },
        { status: 'withdrawn' },
        { review_status: 'pending' },
        { review_due_at: '2026-09-28T00:00:00Z' },
        { limitations: [] },
        { evidence: [] },
        { trip_id: TRIP },
        { variants_truncated: true },
        { variants_truncated: 'false' },
        { variants: Array(33).fill({ entry_id: VARIANT, version: 1, direction: 'return', name: 'Variant' }) },
        { extra: 'x'.repeat(270_000) },
    ])('rejects invalid details or silently substituted versions: %j', async (change) => {
        await expect(
            transport(detail(change)).api.detail({ id: DESTINATION, version: 1 }, { signal: signal() }),
        ).rejects.toThrow();
    });

    it('returns null for unavailable versions and never falls back to another RPC or cache', async () => {
        const missing = transport(null);
        await expect(missing.api.detail({ id: DESTINATION, version: 1 }, { signal: signal() })).resolves.toBeNull();
        expect(missing.rpc).toHaveBeenCalledTimes(1);
        const failing = transport(null, { message: 'Internal database detail should not leak' });
        await expect(failing.api.detail({ id: DESTINATION, version: 1 }, { signal: signal() })).rejects.toThrow(
            'Cruising catalogue is unavailable',
        );
        expect(failing.rpc).toHaveBeenCalledTimes(1);
    });

    it('aborts before requesting and after an in-flight response', async () => {
        const before = new AbortController();
        before.abort();
        const first = transport(detail());
        await expect(
            first.api.detail({ id: DESTINATION, version: 1 }, { signal: before.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(first.rpc).not.toHaveBeenCalled();
        let complete!: (value: { data: unknown; error: unknown }) => void;
        const response = new Promise<{ data: unknown; error: unknown }>((resolve) => {
            complete = resolve;
        });
        const client: CatalogueRpcClient = { rpc: () => Object.assign(response, { abortSignal: () => response }) };
        const during = new AbortController();
        const pending = createCruisingCatalogueClient(client, () => NOW).detail(
            { id: DESTINATION, version: 1 },
            { signal: during.signal },
        );
        during.abort();
        complete({ data: detail(), error: null });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('checks freshness when the response arrives', async () => {
        const { api } = transport(detail(), null, () => Date.parse('2026-10-27T00:00:00Z'));
        await expect(api.detail({ id: DESTINATION, version: 1 }, { signal: signal() })).rejects.toThrow();
    });
});

describe('UNDEPLOYED catalogue SQL source contract (not database integration)', () => {
    const sql = readFileSync('supabase/migrations/20260928120000_cruising_trip_catalogue.sql', 'utf8');
    it('enables RLS and explicitly removes client writes and inherited service-role privileges', () => {
        for (const table of ['cruising_catalogue_entries', 'cruising_catalogue_versions']) {
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
        }
        expect(sql).toMatch(
            /REVOKE ALL ON TABLE public\.cruising_catalogue_entries, public\.cruising_catalogue_versions FROM PUBLIC, anon, authenticated, service_role/,
        );
        expect(sql).toMatch(
            /GRANT SELECT ON TABLE public\.cruising_catalogue_entries, public\.cruising_catalogue_versions TO authenticated/,
        );
        expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE public\.cruising_catalogue_versions TO service_role/);
        expect(sql).not.toMatch(/CREATE POLICY[\s\S]*?FOR (?:INSERT|UPDATE|DELETE|ALL)/);
        expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]*TO (?:anon|authenticated)/);
    });

    it('requires current published versions, fresh review and exact readable dependencies', () => {
        expect(sql).toContain('ce.current_version = cv.version');
        expect(sql).toContain("ce.status = 'published'");
        expect(sql).toContain("cv.review_status = 'reviewed'");
        expect(sql).toContain('cv.review_due_at > statement_timestamp()');
        expect(sql).toContain('cruising_catalogue_is_readable(v.origin_destination_id, v.origin_destination_version)');
        expect(sql).toContain('cruising_catalogue_is_readable(v.destination_id, v.destination_version)');
        expect(sql).toContain('cruising_catalogue_is_readable(v.trip_id, v.trip_version)');
        expect(sql).toMatch(/cruising_catalogue_immutable_versions BEFORE INSERT OR UPDATE OR DELETE/);
        expect(sql).toContain('Catalogue versions are immutable; insert a new version');
    });

    it('fences every withdrawal exit with a newer non-null version and prohibits pointer rollback', () => {
        const guard = sql.match(/CREATE FUNCTION public\.cruising_catalogue_guard_entry\(\)[\s\S]+?\$\$;/)?.[0];
        expect(guard).toBeDefined();
        // This is a SQL source regression check, not execution of the trigger.
        // Checking every exit closes the withdrawn -> draft -> published path.
        expect(guard).toContain("OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn'");
        expect(guard).toContain(
            'NEW.current_version IS NULL OR NEW.current_version <= COALESCE(OLD.current_version, 0)',
        );
        expect(guard).toContain('Leaving withdrawal requires a strictly newer catalogue version');
        expect(guard).toContain(
            'OLD.current_version IS NOT NULL AND (NEW.current_version IS NULL OR NEW.current_version < OLD.current_version)',
        );
    });

    it('keeps geospatial queries bounded and imports no private sailed tracks or seeds', () => {
        expect(sql).toContain('USING gist (location)');
        expect(sql).toContain('ST_DWithin(v.location, query_location, p_radius_nm * 1852.0)');
        expect(sql).toContain('p_radius_nm <= 100');
        expect(sql).toContain('p_limit NOT BETWEEN 1 AND 50');
        expect(sql).toContain('LIMIT p_limit');
        expect(sql).toContain('LIMIT 32');
        expect(sql).not.toMatch(
            /(?:FROM|JOIN|REFERENCES)\s+(?:public\.)?(?:voyages|ship_logs|shared_tracks|traced_routes|community_tracks)\b/i,
        );
        expect(sql).not.toMatch(/INSERT\s+INTO/i);
    });
});
