import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const fixture = vi.hoisted(() => ({
    scope: { key: 'user:fictional-a', userId: 'fictional-a' as string | null, generation: 1 },
    pair: { deviceId: 'fictional-pi', publicKeySpki: 'fictional-public-key', pairedAt: '2026-10-16' },
    base: 'https://fictional-pi.local:3443',
    native: true,
    follow: {
        isFollowing: true,
        startedAt: '2026-10-16T00:00:00Z',
        voyageId: 'voyage-a',
        voyagePlan: { origin: 'Fictional A', destination: 'Fictional B' },
        routeCoords: [
            { lat: 30, lon: 179.9 },
            { lat: 30.1, lon: -179.8 },
        ],
    },
    device: vi.fn(),
    request: vi.fn(),
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ ...fixture.scope }),
    isAuthIdentityScopeCurrent: (scope: typeof fixture.scope) =>
        scope.key === fixture.scope.key && scope.generation === fixture.scope.generation,
    authScopedStorageKey: (key: string, scope: typeof fixture.scope) => `${key}::${scope.key}`,
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => fixture.pair,
    getChartDevice: fixture.device,
    pinnedPiRequest: fixture.request,
}));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => fixture.base } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => fixture.native }));
vi.mock('../stores/followRouteStore', () => ({ useFollowRouteStore: { getState: () => fixture.follow } }));
import {
    activateFollowedCourse,
    clearSavedCourseReceipts,
    clearUnfollowedCourse,
    previewFollowedCourse,
} from '../services/piCourse';
const digest = 'a'.repeat(64),
    token = 'b'.repeat(32);
const resourceId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
    vi.clearAllMocks();
    fixture.scope = { key: 'user:fictional-a', userId: 'fictional-a', generation: 1 };
    fixture.pair = { deviceId: 'fictional-pi', publicKeySpki: 'fictional-public-key', pairedAt: '2026-10-16' };
    fixture.base = 'https://fictional-pi.local:3443';
    fixture.native = true;
    fixture.follow = {
        isFollowing: true,
        startedAt: '2026-10-16T00:00:00Z',
        voyageId: 'voyage-a',
        voyagePlan: { origin: 'Fictional A', destination: 'Fictional B' },
        routeCoords: [
            { lat: 30, lon: 179.9 },
            { lat: 30.1, lon: -179.8 },
        ],
    };
    fixture.device.mockResolvedValue({ chartDeviceId: 'fictional-device' });
    fixture.request.mockImplementation(async (options) => {
        if (!options.isCurrent()) throw Error('Cancelled before native dispatch');
        const body = options.url.endsWith('/preview')
            ? {
                  schema: 1,
                  token,
                  digest,
                  expiresAt: Date.now() + 30_000,
                  pointCount: 2,
                  replacesDestination: false,
                  pilotState: 'standby',
              }
            : options.url.endsWith('/activate')
              ? { schema: 1, active: true, digest, resourceId }
              : { schema: 1, cleared: true };
        return { status: 200, data: JSON.stringify(body) };
    });
});
afterEach(() => vi.unstubAllGlobals());
describe('explicit followed-course phone lane', () => {
    it('sends the exact dateline geometry, keeps only an owned receipt and clears it on unfollow', async () => {
        const original = structuredClone(fixture.follow);
        const scope = { ...fixture.scope };
        const preview = await previewFollowedCourse();
        expect(fixture.request.mock.calls[0][0].data.route.points).toEqual(original.routeCoords);
        await activateFollowedCourse(preview, true, false);
        const raw = localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')!;
        expect(JSON.parse(raw)).toEqual([
            { pi: fixture.pair.deviceId, key: fixture.pair.publicKeySpki, routeKey: preview.routeKey },
        ]);
        expect(raw).not.toMatch(/179|coordinates|token|digest/);
        fixture.follow.isFollowing = false;
        await clearUnfollowedCourse(original as never, scope);
        expect(fixture.request.mock.calls[2][0].data).toEqual({ routeKey: preview.routeKey });
        expect(JSON.parse(localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')!)).toEqual([]);
        await clearUnfollowedCourse(original as never, scope);
        expect(fixture.request).toHaveBeenCalledTimes(3);
    });
    it('never activates without standby confirmation or with a changed exact follow/account/pair', async () => {
        const preview = await previewFollowedCourse();
        await expect(activateFollowedCourse(preview, false, false)).rejects.toThrow(/standby/);
        fixture.follow.routeCoords[1].lon = -179.7;
        await expect(activateFollowedCourse(preview, true, false)).rejects.toThrow();
        fixture.follow.routeCoords[1].lon = -179.8;
        fixture.scope.generation++;
        await expect(activateFollowedCourse(preview, true, false)).rejects.toThrow();
        fixture.scope.generation--;
        fixture.pair.publicKeySpki = 'new-key';
        await expect(activateFollowedCourse(preview, true, false)).rejects.toThrow();
        expect(fixture.request).toHaveBeenCalledTimes(1);
    });
    it('rechecks pairing after asynchronous enrollment loading before any native request', async () => {
        fixture.device.mockImplementationOnce(async () => {
            fixture.pair.pairedAt = 'changed';
            return { chartDeviceId: 'x' };
        });
        await expect(previewFollowedCourse()).rejects.toThrow();
        expect(fixture.request).not.toHaveBeenCalled();
    });
    it('refuses browser lanes, missing enrollment and oversized exact routes without thinning', async () => {
        fixture.native = false;
        await expect(previewFollowedCourse()).rejects.toThrow(/enrolled/);
        fixture.native = true;
        fixture.device.mockResolvedValueOnce(null);
        await expect(previewFollowedCourse()).rejects.toThrow(/code/);
        fixture.follow.routeCoords = Array.from({ length: 1001 }, () => ({ lat: 30, lon: 179.9 }));
        await expect(previewFollowedCourse()).rejects.toThrow(/1000/);
        expect(fixture.follow.routeCoords).toHaveLength(1001);
        expect(fixture.request).not.toHaveBeenCalled();
    });
    it('rejects changed counts, expired tokens and oversized or malformed preview bodies', async () => {
        for (const body of [
            {
                schema: 1,
                token,
                digest,
                expiresAt: Date.now() + 30_000,
                pointCount: 3,
                replacesDestination: false,
                pilotState: 'standby',
            },
            {
                schema: 1,
                token,
                digest,
                expiresAt: Date.now() - 1,
                pointCount: 2,
                replacesDestination: false,
                pilotState: 'standby',
            },
            'x'.repeat(8193),
            '{broken',
        ]) {
            fixture.request.mockResolvedValueOnce({
                status: 200,
                data: typeof body === 'string' ? body : JSON.stringify(body),
            });
            await expect(previewFollowedCourse()).rejects.toThrow();
        }
    });
    it('retains an uncertain send across a fresh clear call and never retries activation', async () => {
        const previous = structuredClone(fixture.follow),
            scope = { ...fixture.scope };
        const preview = await previewFollowedCourse();
        fixture.request.mockRejectedValueOnce(Error('Lost reply'));
        await expect(activateFollowedCourse(preview, true, false)).rejects.toThrow('Lost reply');
        expect(localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')).toContain(preview.routeKey);
        fixture.follow.isFollowing = false;
        await clearUnfollowedCourse(previous as never, scope);
        expect(fixture.request.mock.calls.filter((c) => c[0].url.endsWith('/activate'))).toHaveLength(1);
    });
    it('unfollow while the native activation reply is pending sends an owned clear and discards late success', async () => {
        const previous = structuredClone(fixture.follow),
            scope = { ...fixture.scope };
        const preview = await previewFollowedCourse();
        let finish!: (value: unknown) => void;
        fixture.request.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const sending = activateFollowedCourse(preview, true, false);
        const refused = expect(sending).rejects.toThrow(/stopped/);
        fixture.follow.isFollowing = false;
        await clearUnfollowedCourse(previous as never, scope);
        finish({ status: 200, data: JSON.stringify({ schema: 1, active: true, digest, resourceId }) });
        await refused;
        expect(fixture.request.mock.calls.map((c) => c[0].url.split('/').pop())).toEqual([
            'preview',
            'activate',
            'clear',
        ]);
    });
    it('an account switch sends no old receipt to a new identity or boat', async () => {
        const previous = structuredClone(fixture.follow),
            scope = { ...fixture.scope };
        const preview = await previewFollowedCourse();
        await activateFollowedCourse(preview, true, false);
        fixture.scope = { key: 'user:fictional-b', userId: 'fictional-b', generation: 2 };
        await clearUnfollowedCourse(previous as never, scope);
        await clearUnfollowedCourse(previous as never, { ...fixture.scope });
        expect(fixture.request).toHaveBeenCalledTimes(2);
    });
    it('unavailable Wi-Fi preserves the receipt and requires a plotter check', async () => {
        const previous = structuredClone(fixture.follow),
            scope = { ...fixture.scope };
        const preview = await previewFollowedCourse();
        await activateFollowedCourse(preview, true, false);
        fixture.base = '';
        await expect(clearUnfollowedCourse(previous as never, scope)).rejects.toThrow(/unconfirmed/);
        expect(localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')).toContain(preview.routeKey);
        expect(fixture.request).toHaveBeenCalledTimes(2);
    });
    it('cannot send if the durable phone receipt cannot be written', async () => {
        const preview = await previewFollowedCourse();
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw Error('quota');
        });
        try {
            await expect(activateFollowedCourse(preview, true, false)).rejects.toThrow(/No route/);
        } finally {
            spy.mockRestore();
        }
        expect(fixture.request).toHaveBeenCalledTimes(1);
    });
    it('explicit recovery works after cold unfollow and touches only receipts for the currently paired boat', async () => {
        const preview = await previewFollowedCourse();
        await activateFollowedCourse(preview, true, false);
        fixture.follow.isFollowing = false;
        expect(await clearSavedCourseReceipts()).toBe(1);
        expect(fixture.request.mock.calls[2][0].data).toEqual({ routeKey: preview.routeKey });
        localStorage.setItem(
            'thalassa_course_claims_v1::user:fictional-a',
            JSON.stringify([{ pi: 'different-boat', key: 'other-key', routeKey: 'other-route' }]),
        );
        expect(await clearSavedCourseReceipts()).toBe(0);
        expect(fixture.request).toHaveBeenCalledTimes(3);
        expect(localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')).toContain('different-boat');
    });
    it('an unconfirmed clear preserves the receipt instead of silently claiming success', async () => {
        const preview = await previewFollowedCourse();
        await activateFollowedCourse(preview, true, false);
        fixture.request.mockResolvedValueOnce({ status: 200, data: JSON.stringify({ schema: 1, cleared: 'maybe' }) });
        await expect(clearSavedCourseReceipts()).rejects.toThrow(/unconfirmed/);
        expect(localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')).toContain(preview.routeKey);
    });
    it('an old geometry clear cannot own a newly activated revision with the same voyage and start time', async () => {
        const previous = structuredClone(fixture.follow),
            scope = { ...fixture.scope };
        const oldPreview = await previewFollowedCourse();
        await activateFollowedCourse(oldPreview, true, false);
        let release!: () => void, entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const delayed = new Promise<void>((resolve) => {
            release = resolve;
        });
        fixture.request.mockImplementationOnce(async (options) => {
            expect(options.url).toMatch(/\/clear$/);
            expect(options.data.routeKey).toBe(oldPreview.routeKey);
            entered();
            await delayed;
            return { status: 200, data: JSON.stringify({ schema: 1, cleared: false, reason: 'course-changed' }) };
        });
        const oldClear = clearUnfollowedCourse(previous as never, scope);
        await started;
        fixture.follow.routeCoords = [{ ...previous.routeCoords[0] }, { lat: 30.2, lon: -179.7 }];
        const nextPreview = await previewFollowedCourse();
        expect(nextPreview.routeKey).not.toBe(oldPreview.routeKey);
        await activateFollowedCourse(nextPreview, true, false);
        release();
        await oldClear;
        const retained = JSON.parse(localStorage.getItem('thalassa_course_claims_v1::user:fictional-a')!);
        expect(retained).toEqual([
            { pi: fixture.pair.deviceId, key: fixture.pair.publicKeySpki, routeKey: nextPreview.routeKey },
        ]);
        expect(
            fixture.request.mock.calls.filter((c) => c[0].url.endsWith('/clear')).map((c) => c[0].data.routeKey),
        ).toEqual([oldPreview.routeKey]);
    });
});
