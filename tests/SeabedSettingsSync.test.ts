/**
 * Seabed settings across devices: the owner's cloud row is the record, each
 * device's local copy follows it, and a device only ever sends what its
 * skipper changed on it. A fresh device (a second phone, an iPad, a reinstall)
 * must never blank the privacy zones the boat already has. FICTIONAL data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { SEABED_CONSENT_VERSION } from '../services/seabed/seabedCore';

const OWNER = '00000000-0000-4000-8000-000000000001';
const BOAT = '00000000-0000-4000-8000-0000000000b1';
const ZONE = { id: 'home-1', kind: 'home' as const, lat: -30.5, lon: 160.2, radius_m: 1000, jitter_m: 250 };

const db = vi.hoisted(() => ({
    row: null as Record<string, unknown> | null,
    fail: false,
    /** Row-level security refuses writes: the boat is not the caller's any more. */
    notOwner: false,
    writes: [] as Array<{ op: 'update' | 'insert'; payload: Record<string, unknown> }>,
    clock: Date.UTC(2030, 0, 1),
}));

const pi = vi.hoisted(() => ({
    request: vi.fn(async (_req: { data?: Record<string, unknown> }) => ({ status: 200, data: '{}' })),
}));

/** One seabed_platforms row behind a supabase-js shaped builder. */
vi.mock('../services/supabase', () => {
    const from = () => {
        let op: 'select' | 'update' | 'insert' = 'select';
        let payload: Record<string, unknown> = {};
        const result = () => {
            if (db.fail) return { data: null, error: { code: 'PGRST205', message: 'relation not found' } };
            if (op === 'select') return { data: db.row, error: null };
            if (db.notOwner) return { data: null, error: { code: '42501', message: 'row-level security' } };
            db.writes.push({ op, payload });
            db.clock += 1000;
            const stamp = new Date(db.clock).toISOString();
            db.row =
                op === 'insert'
                    ? {
                          enabled: false,
                          consent_version: null,
                          capture_device_id: null,
                          privacy_zones: [],
                          sounder_note: null,
                          ...payload,
                          updated_at: stamp,
                      }
                    : { ...db.row, ...payload, updated_at: stamp };
            return { data: null, error: null };
        };
        const builder: Record<string, unknown> = {
            select: () => builder,
            eq: () => builder,
            update: (p: Record<string, unknown>) => {
                op = 'update';
                payload = p;
                return builder;
            },
            insert: (p: Record<string, unknown>) => {
                op = 'insert';
                payload = p;
                return builder;
            },
            maybeSingle: async () => result(),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve(result()).then(resolve, reject),
        };
        return builder;
    };
    return {
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key',
        supabase: {
            from,
            rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }),
        },
    };
});

vi.mock('../services/PiPairingService', () => ({ getPairing: () => ({ publicKeySpki: 'fictional-spki' }) }));
vi.mock('../services/PiCacheService', () => ({ piCache: { baseUrl: 'https://pi.invalid:3001' } }));
vi.mock('../services/piTls', () => ({
    isPinnedTransportAvailable: () => true,
    piRequest: pi.request,
}));

import { readSeabedLocal, saveSeabed, syncSeabedPlatform } from '../services/seabed/SeabedSettingsService';

function cloudRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        boat_id: BOAT,
        enabled: false,
        consent_version: SEABED_CONSENT_VERSION,
        capture_device_id: null,
        privacy_zones: [],
        sounder_note: null,
        updated_at: '2030-01-01T00:00:00.000Z',
        ...over,
    };
}

const lastPiPush = () => pi.request.mock.calls.at(-1)?.[0].data as Record<string, unknown>;

describe('seabed settings across devices', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(OWNER);
        db.row = null;
        db.fail = false;
        db.notOwner = false;
        db.writes = [];
        pi.request.mockClear();
    });

    it("a device with no copy of its own takes the owner's cloud row: the switch, the zones and the logger", async () => {
        db.row = cloudRow({ enabled: true, capture_device_id: null, privacy_zones: [ZONE] });
        expect(readSeabedLocal()).toBeNull();
        await syncSeabedPlatform({ activeBoatId: BOAT });
        const local = readSeabedLocal();
        expect(local).toMatchObject({ boatId: BOAT, enabled: true, captureDeviceId: null, pendingSync: false });
        expect(local?.known).toBe(true);
        expect(local?.zones).toEqual([ZONE]);
        expect(db.writes).toEqual([]);
    });

    it('a change made with no copy of its own starts from the cloud row and sends only what changed', async () => {
        db.row = cloudRow({ enabled: true, privacy_zones: [ZONE], sounder_note: 'fictional sounder' });
        const local = await saveSeabed(BOAT, { captureDeviceId: 'deviceBBBBBBBBBBBBBBBB' });
        expect(db.writes).toHaveLength(1);
        expect(db.writes[0].op).toBe('update');
        expect(Object.keys(db.writes[0].payload)).toEqual(['capture_device_id']);
        expect(db.row?.privacy_zones).toEqual([ZONE]);
        expect(local.zones).toEqual([ZONE]);
        expect(local.sounderNote).toBe('fictional sounder');
        expect(local.pendingSync).toBe(false);
    });

    it('the Pi is never sent zones or a note this device does not know', async () => {
        db.fail = true; // offline, or before the migration is pushed
        await saveSeabed(BOAT, { enabled: true, captureDeviceId: null });
        const data = lastPiPush();
        expect(data.enabled).toBe(true);
        expect(data.logger).toBe('pi');
        expect('zones' in data).toBe(false);
        expect('sounder_note' in data).toBe(false);
        expect(readSeabedLocal()?.pendingSync).toBe(true);
    });

    it('zones the skipper changed on this device go to the Pi and the cloud', async () => {
        db.row = cloudRow({ enabled: true });
        await syncSeabedPlatform({ activeBoatId: BOAT });
        await saveSeabed(BOAT, { zones: [ZONE] });
        expect(db.writes.at(-1)?.payload).toEqual({ privacy_zones: [ZONE] });
        expect(lastPiPush().zones).toEqual([ZONE]);
    });

    it('a device with nothing pending takes a new logger from the cloud, so the older logger stands down', async () => {
        db.row = cloudRow({ enabled: true, capture_device_id: 'deviceAAAAAAAAAAAAAAAA' });
        await syncSeabedPlatform({ activeBoatId: BOAT });
        expect(readSeabedLocal()?.captureDeviceId).toBe('deviceAAAAAAAAAAAAAAAA');
        db.row = { ...db.row, capture_device_id: 'deviceBBBBBBBBBBBBBBBB', updated_at: '2030-01-02T00:00:00.000Z' };
        await syncSeabedPlatform({ activeBoatId: BOAT });
        expect(readSeabedLocal()?.captureDeviceId).toBe('deviceBBBBBBBBBBBBBBBB');
    });

    it('a change still waiting to go up is never overwritten, and goes up alone', async () => {
        db.fail = true;
        await saveSeabed(BOAT, { enabled: false });
        db.fail = false;
        db.row = cloudRow({ enabled: true, privacy_zones: [ZONE] });
        await syncSeabedPlatform({ activeBoatId: BOAT });
        expect(db.writes).toHaveLength(1);
        expect(db.writes[0].payload).toEqual({ enabled: false });
        expect(readSeabedLocal()).toMatchObject({ enabled: false, pendingSync: false, zones: [ZONE] });
    });

    it('a change the boat is no longer ours to make is dropped, not kept pending for ever', async () => {
        db.row = cloudRow({ enabled: true, capture_device_id: 'deviceAAAAAAAAAAAAAAAA', privacy_zones: [ZONE] });
        db.notOwner = true; // released since: RLS refuses the write
        await saveSeabed(BOAT, { sounderNote: 'fictional' });
        expect(readSeabedLocal()).toMatchObject({ enabled: false, pendingSync: false, dirty: [] });
        // ...so the next pull is not blocked behind it.
        expect(await syncSeabedPlatform({ activeBoatId: BOAT })).toBe('synced');
    });

    it('switching on records the current consent with the switch', async () => {
        db.row = cloudRow();
        await saveSeabed(BOAT, { enabled: true, captureDeviceId: null });
        expect(db.writes.at(-1)?.payload).toMatchObject({
            enabled: true,
            consent_version: SEABED_CONSENT_VERSION,
            capture_device_id: null,
        });
        expect(typeof db.writes.at(-1)?.payload.consented_at).toBe('string');
    });
});
