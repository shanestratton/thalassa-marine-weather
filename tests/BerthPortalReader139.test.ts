import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const h = vi.hoisted(() => ({
    version: 1,
    live: true,
    consent: true,
    protected: false,
    lan: 'https://fictional-boat.local',
    missing: false,
    schema: 2,
    count: 1,
    query: vi.fn(),
    ensure: vi.fn(),
    read: vi.fn(),
    release: vi.fn(),
    order: [] as string[],
}));
vi.mock('../services/GebcoDepthService', () => ({ GebcoDepthService: { queryDepths: h.query } }));
vi.mock('../services/enc/piCellSync', () => ({ ensureBoatCells: h.ensure, boatLanBaseNow: () => h.lan }));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => ({ deviceId: 'fictional-pi' }) }));
vi.mock('../services/enc/noaaAgreement', () => ({ noaaAgreementAccepted: async () => h.consent }));
vi.mock('../services/enc/chartLicence', () => ({ isProtectedChart: () => h.protected }));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => h.version,
    getRegistryFingerprint: (b: number[]) => 'fictional-cohort-' + b.join(','),
    cellsForBBox: (bbox: number[]) =>
        Array.from({ length: h.count }, (_, i) => ({ id: 'US5TEST' + i, bbox, sizeBytes: 1000 })),
}));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: h.read }));
vi.mock('../services/enc/noaaPackageWindow', () => ({
    loadNoaaPackageCohort: async () => ({ blobs: new Map(), check: () => {}, authority: () => {}, release: h.release }),
}));
vi.mock('../services/routing/leadCompiler', () => ({
    mergeLeadCells: () => ({}),
    compileLeadGraph: (_layers: unknown, _draft: number, options: { window: number[] }) => {
        const b = options.window,
            lon = (b[0] + b[2]) / 2,
            lat = (b[1] + b[3]) / 2;
        return {
            edges: [
                {
                    id: 'fictional-clear-lead',
                    trust: 'chart',
                    coordinates: [
                        [lon, lat],
                        [lon + 0.0001, lat],
                    ],
                    sourceLandM: 0,
                    depth: { class: 'clear', review: [], minDepthM: 50, uncoveredM: 0 },
                },
            ],
        };
    },
}));
import { prepareBerthPortalLeases } from '../services/routing/berthPortals';
const input = () => ({
    origin: { lat: 0, lon: 0 },
    destination: { lat: 0, lon: 5 },
    draftM: 2,
    airDraftM: 15,
    draftAssumed: false,
    signal: new AbortController().signal,
    current: () => h.live,
    remaining: () => 5000,
});
beforeEach(() => {
    setAuthIdentityScope('fictional-chart-owner');
    h.version = 1;
    h.live = true;
    h.consent = true;
    h.protected = false;
    h.lan = 'https://fictional-boat.local';
    h.missing = false;
    h.schema = 2;
    h.count = 1;
    h.order = [];
    h.query.mockReset().mockImplementation(async (points) => points.map((p: object) => ({ ...p, depth_m: -100 })));
    h.ensure.mockReset().mockImplementation(async () => {
        h.order.push('ensure');
        return { state: 'loaded', missing: 0 };
    });
    h.read.mockReset().mockImplementation(async () => {
        h.order.push('read');
        return h.missing ? null : { extractorSchema: h.schema, layers: {} };
    });
    h.release.mockReset();
});
describe('complete per-end borrowed portal cohorts', () => {
    it('finishes bounded boat chart opens before reading either source cohort and retires both endpoint facts', async () => {
        const leases = await prepareBerthPortalLeases(input());
        expect(h.query.mock.calls.map((c) => c[0].length)).toEqual([48, 48]);
        expect(h.order.lastIndexOf('ensure')).toBeLessThan(h.order.indexOf('read'));
        expect(h.ensure.mock.calls.every((c) => c[1].maxCells === 14)).toBe(true);
        expect(leases.every((l) => l.candidates.length > 0 && l.candidates.length <= 4 && l.current())).toBe(true);
        h.version++;
        expect(leases.every((l) => !l.current())).toBe(true);
        leases.forEach((l) => l.release());
        expect(leases.every((l) => l.candidates.length === 0 && !l.current())).toBe(true);
        expect(h.release).toHaveBeenCalledTimes(8);
    });
    it.each(['missing', 'schema', 'oversize', 'consent', 'away'] as const)(
        'refuses %s instead of silently trimming or promoting incomplete chart coverage',
        async (reason) => {
            if (reason === 'missing') h.missing = true;
            if (reason === 'schema') h.schema = 1;
            if (reason === 'oversize') h.count = 15;
            if (reason === 'consent') h.consent = false;
            if (reason === 'away') {
                h.protected = true;
                h.lan = '';
            }
            await expect(prepareBerthPortalLeases(input())).rejects.toThrow(/cohort|consent|LAN/);
            if (['oversize', 'consent', 'away'].includes(reason)) expect(h.read).not.toHaveBeenCalled();
            else expect(h.release).toHaveBeenCalledOnce();
        },
    );
    it('releases the raw cohort after a same-owner chart revision during an asynchronous read', async () => {
        h.read.mockImplementation(async () => {
            h.version++;
            return { extractorSchema: 2, layers: {} };
        });
        await expect(prepareBerthPortalLeases(input())).rejects.toThrow('cohort changed');
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('never substitutes a guessed gate when relief is absent', async () => {
        h.query.mockImplementation(async (points) => points.map((p: object) => ({ ...p, depth_m: null })));
        await expect(prepareBerthPortalLeases(input())).rejects.toThrow('no guessed gate');
        expect(h.ensure).not.toHaveBeenCalled();
        expect(h.read).not.toHaveBeenCalled();
    });
});
