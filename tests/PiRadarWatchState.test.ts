import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/radar/piRadarWatch', () => ({
    readPiRadarWatch: vi.fn(),
    armPiRadarWatch: vi.fn(),
    stopPiRadarWatch: vi.fn(),
    acknowledgePiRadarWatch: vi.fn(),
    reviewPiRadarRelay: vi.fn(),
}));
import { PiRadarWatchController } from '../services/radar/piRadarWatchState';
import type { PiRadarWatchProof } from '../services/radar/piRadarWatch';
import { DEFAULT_COLLISION_PREFS } from '../utils/collisionRule';
import fixture from './fixtures/radar-relay137.json';
const T = Date.UTC(2026, 0, 2, 12),
    b = fixture.context.binding;
function setup() {
    let current = true,
        shield = true;
    const proof = (armed = true): PiRadarWatchProof => ({
        deviceId: b.deviceId,
        isCurrent: () => current,
        view: {
            owner: { ownerId: b.ownerId, piDeviceId: b.piDeviceId, pairingId: b.pairingId, feedId: b.feedId },
            ownerRevision: 'a'.repeat(64),
            context: armed ? structuredClone(fixture.context) : null,
            contextRevision: 1,
            servedAt: Date.now(),
            evaluatedAt: armed ? T : null,
            configured: true,
            running: armed,
            state: armed ? 'armed' : 'off',
            prefs: armed ? DEFAULT_COLLISION_PREFS : null,
            alarms: armed
                ? [
                      {
                          key: 'original',
                          contactKey: 'radar:pi:' + 'a'.repeat(32) + ':RA:1',
                          episodeId: fixture.context.watchEpoch + ':1',
                          targetNumber: 1,
                          talker: 'RA',
                          name: 'Generated',
                          sourceAt: T,
                          reportAt: T,
                          raisedAt: T,
                          closeQuarters: false,
                          cpaNm: 0,
                          tcpaMin: 6,
                          rangeNm: 1,
                          bearingDeg: 0,
                          unknown: false,
                          cleared: null,
                      },
                  ]
                : [],
            more: false,
            capacity: false,
            push: { state: 'unavailable', checkedAt: null },
        },
    });
    const read = vi.fn().mockImplementation(async () => proof()),
        arm = vi.fn().mockImplementation(async () => proof()),
        off = vi.fn().mockImplementation(async () => proof(false)),
        ack = vi.fn().mockImplementation(async () => {
            const p = proof();
            p.view.alarms = [];
            return p;
        }),
        review = vi.fn().mockImplementation(async () => proof());
    const state = new PiRadarWatchController({
        read,
        arm,
        off,
        ack,
        review,
        shield: () => shield,
        prefs: () => DEFAULT_COLLISION_PREFS,
        now: Date.now,
    });
    return {
        state,
        read,
        arm,
        off,
        ack,
        review,
        proof,
        identity: () => {
            current = false;
        },
        shield: (s: boolean) => {
            shield = s;
        },
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());
describe('passive Pi watch state and explicit phone consent', () => {
    it('an empty cloud cohort or truncated LAN view cannot erase an unresolved LAN latch', async () => {
        const s = setup();
        await s.state.refresh();
        const cloud = s.proof();
        cloud.source = 'cloud';
        cloud.view.alarms = [];
        cloud.view.running = false;
        s.read.mockResolvedValue(cloud);
        await s.state.refresh();
        expect(s.state.get().view?.alarms).toMatchObject([
            { key: 'original', unknown: true, actionable: false, sourceAt: T, cleared: null },
        ]);
        const partial = s.proof();
        partial.view.alarms = [];
        partial.view.more = true;
        s.read.mockResolvedValue(partial);
        await s.state.refresh();
        expect(s.state.get().view?.alarms).toHaveLength(1);
        cloud.acknowledgedKeys = ['original'];
        s.read.mockResolvedValue(cloud);
        await s.state.refresh();
        expect(s.state.get().view?.alarms).toHaveLength(0);
    });
    it('bounds accumulated partial cohorts without evicting an already held encounter', async () => {
        const s = setup();
        await s.state.refresh();
        for (let n = 0; n < 22; n++) {
            const next = s.proof();
            next.source = 'cloud';
            next.view.alarms = Array.from({ length: 20 }, (_, i) => ({ ...next.view.alarms[0], key: `new-${n}-${i}` }));
            next.view.more = true;
            s.read.mockResolvedValue(next);
            await s.state.refresh();
        }
        const view = s.state.get().view!;
        expect(view.alarms).toHaveLength(400);
        expect(view.alarms.some((c) => c.key === 'original')).toBe(true);
        expect(view.capacity).toBe(true);
        expect(view.more).toBe(true);
    });
    it('never arms or stands down on cold start, status refresh, lease changes or a persisted armed shield', async () => {
        const s = setup(),
            release = s.state.retain();
        await vi.advanceTimersByTimeAsync(10000);
        release();
        expect(s.read).toHaveBeenCalled();
        expect(s.arm).not.toHaveBeenCalled();
        expect(s.off).not.toHaveBeenCalled();
    });
    it('refuses arm without checked shield and only writes on a deliberate intent', async () => {
        const s = setup();
        s.shield(false);
        await s.state.armDeliberately();
        expect(s.arm).not.toHaveBeenCalled();
        s.shield(true);
        await s.state.armDeliberately();
        expect(s.arm).toHaveBeenCalledTimes(1);
    });
    it('keeps an unresolved encounter unknown after read failure rather than showing it clear', async () => {
        const s = setup();
        await s.state.refresh();
        s.read.mockRejectedValue(Error('offline'));
        await s.state.refresh();
        expect(s.state.get()).toMatchObject({ fresh: false, view: { alarms: [{ key: 'original', cleared: null }] } });
    });
    it('hides old owner facts synchronously even before identity notifications', async () => {
        const s = setup();
        await s.state.refresh();
        s.identity();
        expect(s.state.get().view).toBeNull();
        expect(s.off).not.toHaveBeenCalled();
    });
    it('fences late same-account status after reset and cancels its native request intent', async () => {
        const s = setup();
        let finish!: (p: PiRadarWatchProof) => void;
        s.read.mockReturnValue(
            new Promise((r) => {
                finish = r;
            }),
        );
        const pending = s.state.refresh();
        const options = s.read.mock.calls[0][0];
        s.state.reset();
        finish(s.proof());
        await pending;
        expect(options.isCurrent()).toBe(false);
        expect(options.signal.aborted).toBe(true);
        expect(s.state.get().view).toBeNull();
    });
    it('requires explicit current-context takeover and does not silently adopt another controller', async () => {
        const s = setup(),
            other = s.proof();
        other.view.context!.binding.deviceId = '99999999-9999-4999-8999-999999999999';
        s.read.mockResolvedValue(other);
        await s.state.armDeliberately();
        expect(s.arm).not.toHaveBeenCalled();
        expect(s.state.get().fresh).toBe(true);
        await s.state.armDeliberately(true);
        expect(s.arm).toHaveBeenCalledWith(other, DEFAULT_COLLISION_PREFS, true, expect.any(Object));
    });
    it('refuses stale reviewed takeover and never stands down another controller', async () => {
        const s = setup(),
            other = s.proof();
        other.view.context!.binding.deviceId = '99999999-9999-4999-8999-999999999999';
        s.read.mockResolvedValue(other);
        await s.state.refresh();
        vi.setSystemTime(T + 5001);
        await s.state.armDeliberately(true);
        expect(s.arm).not.toHaveBeenCalled();
        await s.state.standDownDeliberately();
        expect(s.off).not.toHaveBeenCalled();
    });
    it('a delayed severity/context ACK never acknowledges a replacement episode', async () => {
        const s = setup();
        await s.state.refresh();
        const changed = s.proof();
        changed.view.alarms[0].key = 'escalated';
        s.read.mockResolvedValue(changed);
        await s.state.acknowledge('original');
        expect(s.ack).not.toHaveBeenCalled();
        expect(s.state.get().error).toContain('episode changed');
    });
    it('queues deliberate off behind an in-flight arm and reads current truth before standing down', async () => {
        const s = setup();
        let finish!: (p: PiRadarWatchProof) => void;
        s.arm.mockReturnValue(
            new Promise((r) => {
                finish = r;
            }),
        );
        const pending = s.state.armDeliberately();
        await vi.waitFor(() => expect(s.arm).toHaveBeenCalled());
        s.shield(false);
        await s.state.standDownDeliberately();
        expect(s.off).not.toHaveBeenCalled();
        finish(s.proof());
        await pending;
        await vi.waitFor(() => expect(s.state.get().view?.state).toBe('off'));
        expect(s.off).toHaveBeenCalledTimes(1);
    });
    it('does not multiply passive pollers when an aborted old lease completes after a replacement', async () => {
        const s = setup();
        let finish!: (p: PiRadarWatchProof) => void;
        s.read.mockReturnValueOnce(
            new Promise((r) => {
                finish = r;
            }),
        );
        const release = s.state.retain();
        release();
        const next = s.state.retain();
        await vi.advanceTimersByTimeAsync(0);
        finish(s.proof());
        await vi.advanceTimersByTimeAsync(9000);
        next();
        expect(s.read).toHaveBeenCalledTimes(5);
        expect(s.arm).not.toHaveBeenCalled();
    });
});
