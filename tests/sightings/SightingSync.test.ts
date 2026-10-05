/**
 * The sightings outbox: logged on the phone, sent when it can be, quiet
 * before the migration is pushed, and only ever sent by the account that
 * logged it. Fictional people and boat: Wren Hollis (skipper of Kittiwake
 * Run), Tamsin Reyes (her accepted crew), Odo Varga (another account).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSupabaseState } from './sightingsFakeSupabase';

const h = vi.hoisted(() => ({ state: null as unknown as FakeSupabaseState }));

vi.mock('../../services/supabase', async () => {
    const { fakeSupabase, newFakeState } = await import('./sightingsFakeSupabase');
    h.state = newFakeState();
    return { supabase: fakeSupabase(h.state) };
});
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../services/sightings/photoStrip', () => ({
    // The real one re-encodes through a canvas (tests/sightings/PhotoStrip.test.ts).
    stripAndCompressPhoto: async (file: Blob) => file,
}));

import { newFakeState } from './sightingsFakeSupabase';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import {
    memoryBackend,
    setSightingStoreBackend,
    getLocalSighting,
    listLocalSightings,
    putLocalSighting,
} from '../../services/sightings/sightingStore';
import {
    drainSightings,
    fetchBoatSpecies,
    fetchCrewSightings,
    fetchPublicSightings,
    pullMySightings,
    resetSightingSyncState,
    sightingsServerUnavailable,
    subscribeCrewSightings,
    type CrewSightingChange,
} from '../../services/sightings/sightingSync';
import {
    addSightingPhoto,
    deleteSighting,
    editSighting,
    logSighting,
    attachSightingContext,
} from '../../services/sightings/sightingService';
import type { SightingContext } from '../../services/sightings/sightingContext';
import type { LocalSighting } from '../../services/sightings/types';
import { sightingsOutboxFlagged } from '../../services/sightings/outboxFlag';

const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const TAMSIN = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const ODO = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5c';

function context(lat = -20.2567, lon = 148.9512): SightingContext {
    return {
        capturedAt: Date.now(),
        position: {
            latitude: lat,
            longitude: lon,
            source: 'bus',
            fixAt: Date.now() - 2_000,
            accuracyM: 5,
            uncertaintyM: 9,
            ashore: false,
        },
        boatSilent: false,
        samplingProtocol: 'opportunistic vessel-based observation',
        seaTempC: 22.4,
        seaTempSource: 'instrument',
        waterDepthM: 31.5,
        depthReference: 'below-transducer',
        windSpeedKts: 14,
        windDirDeg: 120,
        windSource: 'instrument',
        waveHeightM: 1.2,
        wxModel: 'ecmwf_ifs025',
        sogKts: 5.6,
        cogDeg: 350,
        headingDeg: 352,
    };
}

async function logWhale(owner: string | null = WREN, extra: Partial<Parameters<typeof logSighting>[0]> = {}) {
    return logSighting({
        group: 'whale',
        eventAt: Date.now() - 60_000,
        context: context(),
        vessel: { vesselOwnerId: owner, boatId: null, voyageId: owner ? 'voyage_1790000000000_kittiwake' : null },
        visibility: 'crew',
        ...extra,
    });
}

async function local(id: string, user: string | null = WREN): Promise<LocalSighting> {
    const record = await getLocalSighting(id, user);
    if (!record) throw new Error('missing');
    return record;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    localStorage.clear();
    Object.assign(h.state, newFakeState());
    h.state.sessionUserId = WREN;
    setSightingStoreBackend(memoryBackend());
    resetSightingSyncState();
    setAuthIdentityScope(WREN);
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('sending', () => {
    it('logs on the phone at once, then inserts the Darwin Core row as the observer', async () => {
        const record = await logWhale();
        expect(record.sync).toMatchObject({ state: 'pending', op: 'insert', serverKnown: false });
        expect(h.state.calls).toEqual([]);

        const result = await drainSightings();
        expect(result).toMatchObject({ sent: 1, stopped: null });
        const row = h.state.rows.get(record.id);
        expect(row).toMatchObject({
            id: record.id,
            observer_id: WREN,
            vessel_owner_id: WREN,
            visibility: 'crew',
            taxon_group: 'whale',
            decimal_latitude: -20.2567,
            position_source: 'bus',
            sampling_protocol: 'opportunistic vessel-based observation',
            photo_paths: [],
        });
        // Server-owned columns are never sent.
        for (const column of ['created_at', 'updated_at', 'vernacular_name', 'taxon_rank', 'basis_of_record']) {
            expect(Object.keys(record.row)).not.toContain(column);
        }
        expect((await local(record.id)).sync).toMatchObject({ state: 'synced', op: null, serverKnown: true });
    });

    it('holds quietly before the migration is pushed, and keeps logging', async () => {
        const record = await logWhale();
        h.state.insertErrors.push({ code: 'PGRST205', message: "Could not find the table 'public.sightings'" });
        const result = await drainSightings();
        expect(result.stopped).toBe('not-pushed');
        expect(sightingsServerUnavailable()).toBe(true);
        expect((await local(record.id)).sync).toMatchObject({ state: 'pending', op: 'insert', attempts: 0 });

        // The session remembers: no more server calls, logging still works.
        h.state.calls.length = 0;
        const second = await logWhale();
        expect((await drainSightings()).stopped).toBe('not-pushed');
        expect(h.state.calls).toEqual([]);
        expect((await local(second.id)).sync.state).toBe('pending');
    });

    it('treats a duplicate insert (an earlier try that landed) as success, then sends the content', async () => {
        const record = await logWhale();
        h.state.rows.set(record.id, { ...record.row, individual_count: 1 });
        await editSighting(record.id, { individual_count: 3 });
        await drainSightings();
        expect(h.state.calls).toEqual(['sightings.insert', 'sightings.update']);
        expect(h.state.rows.get(record.id)?.individual_count).toBe(3);
        expect((await local(record.id)).sync.state).toBe('synced');
    });

    it('sends a sighting even when its photo fails, and adds the photo later', async () => {
        const record = await logWhale();
        await addSightingPhoto(record.id, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
        h.state.uploadErrors.push({ message: 'gateway timeout', statusCode: '504' });
        await drainSightings();
        expect(h.state.rows.get(record.id)?.photo_paths).toEqual([]);
        const after = await local(record.id);
        expect(after.sync).toMatchObject({ serverKnown: true, op: 'update', state: 'pending' });

        // Later: the photo goes up, then the row lists it.
        await local(record.id).then((r) =>
            import('../../services/sightings/sightingStore').then(({ putLocalSighting }) =>
                putLocalSighting({ ...r, sync: { ...r.sync, nextAttemptAt: null } }),
            ),
        );
        await drainSightings();
        const path = `${WREN}/${record.id}/0.jpg`;
        expect(h.state.objects.has(path)).toBe(true);
        expect(h.state.rows.get(record.id)?.photo_paths).toEqual([path]);
        expect((await local(record.id)).sync.state).toBe('synced');
    });

    it('updates only the mutable columns after the insert', async () => {
        const record = await logWhale();
        await drainSightings();
        await editSighting(record.id, {
            scientific_name: 'Megaptera novaeangliae',
            has_calf: true,
            visibility: 'public',
        });
        h.state.calls.length = 0;
        await drainSightings();
        expect(h.state.calls).toEqual(['sightings.update']);
        expect(h.state.rows.get(record.id)).toMatchObject({
            scientific_name: 'Megaptera novaeangliae',
            has_calf: true,
            visibility: 'public',
            decimal_latitude: -20.2567,
        });
    });

    it('inserts again when the server no longer has the row', async () => {
        const record = await logWhale();
        await drainSightings();
        h.state.rows.clear();
        await editSighting(record.id, { individual_count: 2 });
        await drainSightings();
        expect(h.state.rows.get(record.id)?.individual_count).toBe(2);
        expect((await local(record.id)).sync).toMatchObject({ state: 'synced', serverKnown: true });
    });

    it('keeps an edit made while the insert was in flight, and sends it next', async () => {
        const record = await logWhale();
        h.state.onInsert = async () => {
            h.state.onInsert = null;
            await editSighting(record.id, { individual_count: 5 });
        };
        await drainSightings();
        expect(h.state.rows.get(record.id)?.individual_count).toBe(1);
        expect((await local(record.id)).sync).toMatchObject({ serverKnown: true, op: 'update', state: 'pending' });
        await drainSightings();
        expect(h.state.rows.get(record.id)?.individual_count).toBe(5);
    });

    it('deletes photos from storage before the row', async () => {
        const record = await logWhale();
        await addSightingPhoto(record.id, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
        await drainSightings();
        h.state.calls.length = 0;
        expect(await deleteSighting(record.id)).toBe(true);
        await drainSightings();
        expect(h.state.calls).toEqual([`sighting-photos.remove ${WREN}/${record.id}/0.jpg`, 'sightings.delete']);
        expect(h.state.rows.has(record.id)).toBe(false);
        expect(await getLocalSighting(record.id, WREN)).toBeNull();
    });

    it('deletes a never-sent sighting (Undo) without touching the server', async () => {
        const record = await logWhale();
        await deleteSighting(record.id);
        expect(await getLocalSighting(record.id, WREN)).toBeNull();
        await drainSightings();
        expect(h.state.calls).toEqual([]);
    });
});

describe('the outbox hint for app start', () => {
    it('is up while a sighting waits, and comes down once the drain has sent everything', async () => {
        const record = await logWhale();
        expect(sightingsOutboxFlagged(WREN)).toBe(true);
        h.state.insertErrors.push({ code: '', message: 'TypeError: Failed to fetch' });
        await drainSightings();
        // Offline: still waiting (backing off), so app start must still drain it.
        expect(sightingsOutboxFlagged(WREN)).toBe(true);
        const waiting = await local(record.id);
        await putLocalSighting({ ...waiting, sync: { ...waiting.sync, nextAttemptAt: null } });
        expect((await drainSightings()).sent).toBe(1);
        expect(sightingsOutboxFlagged(WREN)).toBe(false);
    });
});

describe('refusals', () => {
    it('keeps a sighting as your own, Private and boat-less, when you are no longer crew on that boat', async () => {
        setAuthIdentityScope(TAMSIN);
        h.state.sessionUserId = TAMSIN;
        const record = await logWhale(WREN);
        h.state.insertErrors.push({ code: '42501', message: 'new row violates row-level security policy' });
        await drainSightings();
        expect(h.state.rows.get(record.id)).toMatchObject({
            observer_id: TAMSIN,
            vessel_owner_id: null,
            boat_id: null,
            visibility: 'private',
        });
    });

    it('marks a refused row failed and keeps it on the phone', async () => {
        const record = await logWhale();
        h.state.insertErrors.push({ code: '23514', message: 'That species is not in the catalogue for that group' });
        await drainSightings();
        expect((await local(record.id)).sync).toMatchObject({ state: 'failed' });
        expect((await local(record.id)).sync.lastError).toMatch(/23514/);
    });

    it('holds a rate-limited sighting for an hour', async () => {
        const record = await logWhale();
        h.state.insertErrors.push({ code: 'P0001', message: 'Too many sightings in one hour' });
        await drainSightings();
        const after = await local(record.id);
        expect(after.sync.state).toBe('held');
        expect((after.sync.nextAttemptAt ?? 0) - Date.now()).toBeGreaterThan(55 * 60_000);
    });

    it('backs off after a network failure and stops the round', async () => {
        const first = await logWhale();
        const second = await logWhale();
        h.state.insertErrors.push({ code: '', message: 'TypeError: Failed to fetch' });
        const result = await drainSightings();
        expect(result.stopped).toBe('offline');
        expect((await local(first.id)).sync).toMatchObject({ attempts: 1 });
        expect((await local(second.id)).sync.attempts).toBe(0);
    });
});

describe('the account fence', () => {
    it("never sends another account's sightings, and needs a real session for this one", async () => {
        const wrens = await logWhale();
        setAuthIdentityScope(ODO);
        h.state.sessionUserId = ODO;
        await drainSightings();
        expect(h.state.rows.has(wrens.id)).toBe(false);
        expect(await getLocalSighting(wrens.id, ODO)).toBeNull();

        // Back as Wren, but the stored session is someone else's (a provisional boot scope).
        setAuthIdentityScope(WREN);
        h.state.sessionUserId = ODO;
        expect((await drainSightings()).stopped).toBe('signed-out');
        expect(h.state.rows.has(wrens.id)).toBe(false);
    });

    it('logs signed out as Private, on the phone only', async () => {
        setAuthIdentityScope(null);
        const record = await logWhale(WREN, { visibility: 'public' });
        expect(record.row).toMatchObject({ observer_id: null, vessel_owner_id: null, visibility: 'private' });
        expect(record.sync.state).toBe('held');
        expect(await listLocalSightings(WREN)).toEqual([]);
    });

    it('never sends a sighting without a position', async () => {
        const record = await logSighting({
            group: 'turtle',
            eventAt: Date.now(),
            context: null,
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        expect(record.sync.state).toBe('needs-position');
        await drainSightings();
        expect(h.state.calls).toEqual([]);
        await attachSightingContext(record.id, context());
        await drainSightings();
        expect(h.state.rows.get(record.id)?.decimal_latitude).toBe(-20.2567);
    });
});

describe('reads', () => {
    it("pulls this account's rows from other devices and drops ones deleted elsewhere", async () => {
        const kept = await logWhale();
        const gone = await logWhale();
        await drainSightings();
        h.state.rows.delete(gone.id);
        const remote = {
            ...h.state.rows.get(kept.id),
            id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
            vernacular_name: null,
        };
        h.state.rows.set(String(remote.id), remote);
        const result = await pullMySightings();
        // The other device's row, and this phone's own row once (to learn its server version).
        expect(result.pulled).toBe(2);
        expect(await getLocalSighting(gone.id, WREN)).toBeNull();
        expect((await getLocalSighting('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', WREN))?.sync.state).toBe('synced');
        expect((await pullMySightings()).pulled).toBe(0);

        // A change waiting on this phone is never overwritten by a pull.
        await editSighting(kept.id, { individual_count: 7 });
        h.state.rows.set(kept.id, {
            ...h.state.rows.get(kept.id),
            individual_count: 2,
            updated_at: '2026-08-15T00:00:00.000Z',
        });
        await pullMySightings();
        expect((await local(kept.id)).row.individual_count).toBe(7);
    });

    it("reads the boat's crew feed, and serves the last copy when offline", async () => {
        const record = await logWhale();
        await drainSightings();
        const live = await fetchCrewSightings(WREN);
        expect(live).toMatchObject({ unavailable: false, fromCache: false });
        expect(live.rows.map((r) => r.id)).toEqual([record.id]);
        h.state.selectErrors.push({ code: '', message: 'TypeError: Failed to fetch' });
        const offline = await fetchCrewSightings(WREN);
        expect(offline.fromCache).toBe(true);
        expect(offline.rows.map((r) => r.id)).toEqual([record.id]);
    });

    it("reads the boat's named sightings all time for its life list, and serves the last copy offline", async () => {
        const humpback = await logWhale();
        await editSighting(humpback.id, { scientific_name: 'Megaptera novaeangliae' });
        await logWhale(); // group only: not a species
        const hidden = await logWhale(WREN, { visibility: 'private' });
        await editSighting(hidden.id, { scientific_name: 'Megaptera novaeangliae' });
        await drainSightings();
        await drainSightings();
        const life = await fetchBoatSpecies(WREN);
        expect(life).toMatchObject({ unavailable: false, fromCache: false, complete: true });
        expect(life.rows.map((r) => r.id)).toEqual([humpback.id]);
        h.state.selectErrors.push({ code: '', message: 'TypeError: Failed to fetch' });
        const offline = await fetchBoatSpecies(WREN);
        expect(offline).toMatchObject({ fromCache: true, complete: false });
        expect(offline.rows.map((r) => r.id)).toEqual([humpback.id]);
    });

    it('asks the server for public sightings by box, and is quiet before the push', async () => {
        h.state.rpcResult = { data: [{ sighting_id: 'x' }], error: null };
        const box = { south: -21, west: 148, north: -20, east: 149.5 };
        const first = await fetchPublicSightings(box, { before: '2026-08-14T00:00:00Z', beforeId: 'abc' }, 50);
        expect(first.rows).toHaveLength(1);
        expect(h.state.rpcCalls[0]).toEqual({
            name: 'get_public_sightings',
            args: {
                p_south: -21,
                p_west: 148,
                p_north: -20,
                p_east: 149.5,
                p_before: '2026-08-14T00:00:00Z',
                p_before_id: 'abc',
                p_limit: 50,
            },
        });
        h.state.rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        expect((await fetchPublicSightings(box)).unavailable).toBe(true);
    });

    it('subscribes to one boat, passes inserts and deletes, and closes when the account changes', async () => {
        const changes: CrewSightingChange[] = [];
        const stop = subscribeCrewSightings(WREN, (c) => changes.push(c));
        const channel = h.state.channels[0];
        expect(channel.filter).toMatchObject({ table: 'sightings', filter: `vessel_owner_id=eq.${WREN}` });
        channel.handler?.({ eventType: 'INSERT', new: { id: 'row-1', taxon_group: 'dolphin' } });
        channel.handler?.({ eventType: 'DELETE', old: { id: 'row-1' } });
        expect(changes).toEqual([
            { type: 'upsert', row: { id: 'row-1', taxon_group: 'dolphin' } },
            { type: 'delete', id: 'row-1' },
        ]);
        setAuthIdentityScope(ODO);
        expect(channel.removed).toBe(true);
        channel.handler?.({ eventType: 'INSERT', new: { id: 'row-2' } });
        expect(changes).toHaveLength(2);
        stop();
    });
});
