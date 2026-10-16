import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/radar-relay137.json';
const f = vi.hoisted(() => ({
    rpc: vi.fn(),
    user: vi.fn(),
    generation: 1,
    owner: '11111111-1111-4111-8111-111111111111' as string | null,
    pair: { deviceId: '22222222-2222-4222-8222-222222222222', publicKeySpki: 'generated-pin', pairedAt: 'generated' },
    satellite: false,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ userId: f.owner, generation: f.generation }),
    isAuthIdentityScopeCurrent: (s: { generation: number }) => s.generation === f.generation,
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => f.pair }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => null } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => true }));
vi.mock('../services/supabase', () => ({ supabase: { rpc: f.rpc }, getCurrentUserId: f.user }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => f.satellite }));
import {
    decodeRadarCloudSnapshot,
    readCloudPiRadarWatch,
    acknowledgeCloudPiRadarWatch,
} from '../services/radar/piRadarCloud';
const T = fixture.alarm.raisedAt;
function packet() {
    const b = fixture.context.binding;
    return {
        schema: 1,
        checkedAt: Date.now(),
        owner: { ownerId: b.ownerId, piDeviceId: b.piDeviceId, pairingId: b.pairingId, feedId: b.feedId },
        context: structuredClone(fixture.context),
        contextRevision: '99999999-9999-4999-8999-999999999999',
        retired: false,
        evaluatedAt: Date.now(),
        more: false,
        alarms: [{ ...fixture.alarm, ackedAt: null as number | null }],
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.generation = 1;
    f.owner = fixture.context.binding.ownerId;
    f.pair = { deviceId: fixture.context.binding.piDeviceId, publicKeySpki: 'generated-pin', pairedAt: 'generated' };
    f.satellite = false;
    f.user.mockReset().mockResolvedValue(f.owner);
    f.rpc.mockReset().mockImplementation(() => ({ abortSignal: async () => ({ data: packet(), error: null }) }));
});
afterEach(() => vi.useRealTimers());
describe('bounded owner radar cloud facts', () => {
    it('reads only the fixed selected-Pi owner snapshot and never turns a heartbeat into feed proof', async () => {
        const result = await readCloudPiRadarWatch();
        expect(f.rpc).toHaveBeenCalledWith('pi_radar_owner_snapshot', { p_pi_device_id: f.pair.deviceId });
        expect(result).toMatchObject({
            source: 'cloud',
            view: {
                running: false,
                configured: false,
                state: 'blind',
                alarms: [{ sourceAt: fixture.alarm.sourceAt, reportAt: T, unknown: true, cpaNm: null, cleared: null }],
            },
        });
        expect(JSON.stringify(f.rpc.mock.calls)).not.toMatch(/lat|lon|nmea|position/);
    });
    it('ages the original DB ACK; a later fresh poll cannot renew a 30-minute mute', async () => {
        const raw = packet();
        raw.alarms[0].ackedAt = T;
        expect((await decodeRadarCloudSnapshot(raw, T))?.view.alarms).toHaveLength(0);
        raw.checkedAt = T + 1800000;
        raw.evaluatedAt = raw.checkedAt;
        expect((await decodeRadarCloudSnapshot(raw, T + 1800000))?.view.alarms).toHaveLength(1);
    });
    it('requires exact episode/severity canonical keys and rejects duplicate/extra raw geometry fields', async () => {
        const raw = packet();
        raw.alarms[0].kind = 'radar-close-quarters';
        expect(await decodeRadarCloudSnapshot(raw, T)).toBeNull();
        const duplicate = packet();
        duplicate.alarms.push({ ...duplicate.alarms[0] });
        expect(await decodeRadarCloudSnapshot(duplicate, T)).toBeNull();
        expect(
            await decodeRadarCloudSnapshot({ ...packet(), alarms: [{ ...packet().alarms[0], lat: 0 }] }, T),
        ).toBeNull();
    });
    it('requires explicit fresh owned retirement to report off; an empty/unavailable envelope is never clear', async () => {
        expect(await decodeRadarCloudSnapshot({ ...packet(), owner: null, context: null, alarms: [] }, T)).toBeNull();
        const result = await decodeRadarCloudSnapshot({ ...packet(), retired: true, evaluatedAt: null, alarms: [] }, T);
        expect(result?.view).toMatchObject({ context: null, state: 'off', alarms: [] });
        expect(await decodeRadarCloudSnapshot({ ...packet(), checkedAt: T - 5001 }, T)).toBeNull();
    });
    it('blocks automatic cloud reads in Satellite Mode; explicit refresh is bounded and allowed', async () => {
        f.satellite = true;
        await expect(readCloudPiRadarWatch()).rejects.toMatchObject({ code: 'unavailable' });
        expect(f.rpc).not.toHaveBeenCalled();
        expect((await readCloudPiRadarWatch({ allowCloud: true })).source).toBe('cloud');
    });
    it.each(['account', 'pair', 'intent'] as const)(
        'rejects an async %s change and cannot install old owner cards',
        async (change) => {
            let finish!: (r: unknown) => void;
            f.rpc.mockImplementation(() => ({
                abortSignal: () =>
                    new Promise((r) => {
                        finish = r;
                    }),
            }));
            let live = true;
            const pending = readCloudPiRadarWatch({ isCurrent: () => live });
            await vi.waitFor(() => expect(f.rpc).toHaveBeenCalled());
            if (change === 'account') f.generation++;
            if (change === 'pair') f.pair = { ...f.pair, pairedAt: 'replacement' };
            if (change === 'intent') live = false;
            finish({ data: packet(), error: null });
            await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
        },
    );
    it('aborts its query at the whole deadline and refuses a late auth lookup before sending', async () => {
        let finish!: (v: string) => void;
        f.user.mockReturnValue(
            new Promise((r) => {
                finish = r;
            }),
        );
        const pending = readCloudPiRadarWatch().catch((e) => e);
        await vi.advanceTimersByTimeAsync(6001);
        expect(await pending).toMatchObject({ code: 'unavailable' });
        finish(f.owner!);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.rpc).not.toHaveBeenCalled();
    });
    it('acknowledges only the exact current owner context and waits for authoritative readback', async () => {
        const proof = await readCloudPiRadarWatch(),
            key = proof.view.alarms[0].key;
        f.rpc.mockImplementation((name: string) => ({
            abortSignal: async () => ({
                data:
                    name === 'acknowledge_pi_radar_alarm'
                        ? 1
                        : { ...packet(), alarms: [{ ...packet().alarms[0], ackedAt: T }] },
                error: null,
            }),
        }));
        const result = await acknowledgeCloudPiRadarWatch(proof, key);
        expect(f.rpc).toHaveBeenCalledWith('acknowledge_pi_radar_alarm', {
            p_alarm_key: key,
            p_context_revision: proof.cloudRevision,
        });
        expect(result.view.alarms).toHaveLength(0);
        expect(proof.view.alarms).toHaveLength(1);
    });
    it('a rejected or replaced-context ACK cannot hide the held card optimistically', async () => {
        const proof = await readCloudPiRadarWatch();
        f.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: 0, error: null }) }));
        await expect(acknowledgeCloudPiRadarWatch(proof, proof.view.alarms[0].key)).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(proof.view.alarms).toHaveLength(1);
    });
    it('does not read on behalf of an absent or different authenticated account', async () => {
        f.user.mockResolvedValue('other');
        await expect(readCloudPiRadarWatch()).rejects.toMatchObject({ code: 'cancelled' });
        expect(f.rpc).not.toHaveBeenCalled();
        f.owner = null;
        await expect(readCloudPiRadarWatch()).rejects.toMatchObject({ code: 'unavailable' });
    });
});
