import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PositionBroadcast, SyncBroadcast, SyncState } from '../services/AnchorWatchSyncService';

const mocks = vi.hoisted(() => ({
    states: new Set<(s: SyncState) => void>(),
    broadcasts: new Set<(s: SyncBroadcast) => void>(),
    state: {
        connected: true,
        role: 'shore',
        sessionCode: 'ABCDEFGHJKLM',
        peerConnected: true,
        lastPeerUpdate: null,
        peerDisconnectedAt: null,
    } as SyncState,
    latest: null as PositionBroadcast | null,
    acquire: vi.fn(),
    release: vi.fn(),
    releaseEventually: vi.fn(),
    publish: vi.fn(),
    boat: vi.fn(),
    acknowledge: vi.fn(),
}));
vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        acquire: mocks.acquire,
        release: mocks.release,
        releaseEventually: mocks.releaseEventually,
    },
}));
vi.mock('../services/AnchorWatchService', () => ({ AnchorWatchService: { getSnapshot: mocks.boat } }));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        onStateChange: (fn: (s: SyncState) => void) => {
            mocks.states.add(fn);
            fn(mocks.state);
            return () => mocks.states.delete(fn);
        },
        onBroadcast: (fn: (s: SyncBroadcast) => void) => {
            mocks.broadcasts.add(fn);
            return () => mocks.broadcasts.delete(fn);
        },
        getState: () => mocks.state,
        getLatestBroadcast: () => mocks.latest,
        getLatestPosition: () => mocks.latest,
        broadcastPosition: mocks.publish,
        acknowledgeAlarmReminders: mocks.acknowledge,
    },
}));
import { ShoreWatchAlarmServiceClass } from '../services/ShoreWatchAlarmService';

const now = Date.parse('2026-09-23T06:00:00Z');
function position(isAlarm = false, timestamp = Date.now()): PositionBroadcast {
    return {
        type: 'position',
        timestamp,
        isAlarm,
        distance: isAlarm ? 70 : 10,
        swingRadius: 40,
        vessel: { latitude: -20, longitude: 148, timestamp, accuracy: 2, heading: 0, speed: 0 },
        anchor: { latitude: -20, longitude: 148, timestamp },
    };
}
function broadcast(data: SyncBroadcast) {
    mocks.broadcasts.forEach((fn) => fn(data));
}
function state(patch: Partial<SyncState>) {
    mocks.state = { ...mocks.state, ...patch };
    mocks.states.forEach((fn) => fn(mocks.state));
}
const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    mocks.states.clear();
    mocks.broadcasts.clear();
    mocks.latest = null;
    mocks.state = {
        connected: true,
        role: 'shore',
        sessionCode: 'ABCDEFGHJKLM',
        peerConnected: true,
        lastPeerUpdate: null,
        peerDisconnectedAt: null,
    };
    mocks.acquire.mockResolvedValue('shore-lease');
    mocks.release.mockResolvedValue(undefined);
    mocks.boat.mockReturnValue({ state: 'idle' });
    mocks.acknowledge.mockResolvedValue(['00000000-0000-0000-0000-000000000001']);
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('app-lifetime Shore Watch alarms', () => {
    it('does not stop its continuous audio lease after two rings or after 24 seconds', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mocks.acquire).toHaveBeenCalledTimes(1);
        expect(mocks.release).not.toHaveBeenCalled();
        expect(mocks.releaseEventually).not.toHaveBeenCalled();
        expect(service.getSnapshot()).toMatchObject({ cause: 'drag', muted: false });
    });

    it('mutes audio even offline, but exposes failed remote acknowledgement and retries the original cutoff', async () => {
        mocks.acknowledge.mockRejectedValueOnce(new Error('offline'));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        await service.mute();
        await settle();
        expect(service.getSnapshot()).toMatchObject({ muted: true, reminderPending: false });
        expect(service.getSnapshot().reminderError).toContain('not confirmed silenced');
        expect(mocks.acknowledge).toHaveBeenLastCalledWith('drag', now);
        await vi.advanceTimersByTimeAsync(5_000);
        await service.retryReminderAcknowledgement();
        expect(mocks.acknowledge).toHaveBeenLastCalledWith('drag', now);
        expect(service.getSnapshot().reminderError).toBeNull();
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('times out remote ACK without claiming it succeeded or keeping the speaker sounding', async () => {
        mocks.acknowledge.mockReturnValueOnce(new Promise(() => {}));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        await service.mute();
        expect(service.getSnapshot()).toMatchObject({ muted: true, reminderPending: true });
        await vi.advanceTimersByTimeAsync(8_000);
        expect(service.getSnapshot()).toMatchObject({ muted: true, reminderPending: false });
        expect(service.getSnapshot().reminderError).toContain('not confirmed silenced');
    });

    it('rearms for a new server incident but not repeats of the muted incident', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        await service.mute();
        const push = (started: number) =>
            service.receivePush({
                notification_type: 'anchor_alarm',
                session_code: mocks.state.sessionCode,
                alarm_kind: 'drag',
                observed_at: new Date().toISOString(),
                incident_started_at: new Date(started).toISOString(),
            });
        await vi.advanceTimersByTimeAsync(1_000);
        push(now - 1_000);
        expect(service.getSnapshot().muted).toBe(true);
        push(Date.now());
        await settle();
        expect(service.getSnapshot().muted).toBe(false);
        expect(mocks.acquire).toHaveBeenCalledTimes(2);
    });

    it('does not let a pending native stop mute a newer same-kind incident', async () => {
        let finishStop!: () => void;
        mocks.release.mockReturnValueOnce(new Promise<void>((resolve) => (finishStop = resolve)));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        const oldMute = service.mute();
        await vi.advanceTimersByTimeAsync(1_000);
        service.receivePush({
            notification_type: 'anchor_alarm',
            session_code: mocks.state.sessionCode,
            alarm_kind: 'drag',
            observed_at: new Date().toISOString(),
            incident_started_at: new Date().toISOString(),
        });
        await settle();
        finishStop();
        await oldMute;
        expect(service.getSnapshot()).toMatchObject({ cause: 'drag', muted: false });
        expect(mocks.acquire).toHaveBeenCalledTimes(2);
        expect(mocks.acknowledge).not.toHaveBeenCalled();
    });

    it('waits for an in-flight native start and confirms release before reporting silence', async () => {
        let finishStart!: (lease: string) => void;
        let finishStop!: () => void;
        mocks.acquire.mockReturnValueOnce(new Promise<string>((resolve) => (finishStart = resolve)));
        mocks.release.mockReturnValueOnce(new Promise<void>((resolve) => (finishStop = resolve)));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        const mute = service.mute();
        await settle();
        expect(service.getSnapshot().muted).toBe(false);
        expect(mocks.release).not.toHaveBeenCalled();
        finishStart('late-lease');
        await settle();
        expect(mocks.release).toHaveBeenCalledWith('late-lease');
        expect(service.getSnapshot().muted).toBe(false);
        expect(mocks.releaseEventually).not.toHaveBeenCalled();
        finishStop();
        await mute;
        expect(service.getSnapshot().muted).toBe(true);
        expect(mocks.acknowledge).toHaveBeenCalledWith('drag', now);
    });

    it('does not claim silence when a late-started native alarm cannot stop', async () => {
        let finishStart!: (lease: string) => void;
        mocks.acquire.mockReturnValueOnce(new Promise<string>((resolve) => (finishStart = resolve)));
        mocks.release.mockRejectedValueOnce(new Error('Native stop failed'));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        const mute = service.mute();
        const failure = expect(mute).rejects.toThrow('Native stop failed');
        finishStart('late-lease');
        await failure;
        expect(service.getSnapshot().muted).toBe(false);
        expect(mocks.releaseEventually).not.toHaveBeenCalled();
        expect(mocks.acknowledge).not.toHaveBeenCalled();
        await service.mute();
        expect(service.getSnapshot().muted).toBe(true);
        expect(mocks.release).toHaveBeenCalledTimes(2);
    });

    it('bounds a hung native start without claiming mute or duplicating the start', async () => {
        let finishStart!: (lease: string) => void;
        mocks.acquire.mockReturnValueOnce(new Promise<string>((resolve) => (finishStart = resolve)));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        const mute = service.mute();
        const failure = expect(mute).rejects.toThrow('not confirmed');
        await vi.advanceTimersByTimeAsync(8_000);
        await failure;
        expect(service.getSnapshot().muted).toBe(false);
        const retry = service.mute();
        finishStart('late-lease');
        await retry;
        expect(mocks.acquire).toHaveBeenCalledTimes(1);
        expect(mocks.release).toHaveBeenCalledTimes(1);
        expect(service.getSnapshot().muted).toBe(true);
        expect(mocks.acknowledge).toHaveBeenCalledWith('drag', now);
    });

    it('keeps a new incident armed when it arrives before an old start or mute completes', async () => {
        let finishStart!: (lease: string) => void;
        mocks.acquire.mockReturnValueOnce(new Promise<string>((resolve) => (finishStart = resolve)));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        const oldMute = service.mute();
        await vi.advanceTimersByTimeAsync(1_000);
        service.receivePush({
            notification_type: 'anchor_alarm',
            session_code: mocks.state.sessionCode,
            alarm_kind: 'drag',
            observed_at: new Date().toISOString(),
            incident_started_at: new Date().toISOString(),
        });
        await settle();
        finishStart('old-late-lease');
        await oldMute;
        expect(service.getSnapshot()).toMatchObject({ cause: 'drag', muted: false });
        expect(mocks.releaseEventually).toHaveBeenCalledWith('old-late-lease');
        expect(mocks.acquire).toHaveBeenCalledTimes(2);
        expect(mocks.release).not.toHaveBeenCalled();
        expect(mocks.acknowledge).not.toHaveBeenCalled();
    });

    it('does not apply a late acknowledgement failure to a new watch', async () => {
        let fail!: (e: Error) => void;
        mocks.acknowledge.mockReturnValueOnce(
            new Promise((_, reject) => {
                fail = reject;
            }),
        );
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        await service.mute();
        state({ sessionCode: 'BCDEFGHJKLMN' });
        fail(new Error('old account offline'));
        await settle();
        expect(service.getSnapshot()).toMatchObject({ reminderError: null, reminderPending: false, muted: false });
    });

    it('immediately reports GPS loss without refreshing the last real position', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position());
        await vi.advanceTimersByTimeAsync(5_000);
        broadcast({
            type: 'status',
            gpsAvailable: false,
            reason: 'gps_unavailable',
            source: 'pi',
            timestamp: Date.now(),
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(service.getSnapshot()).toMatchObject({ cause: 'gps-lost', stale: true, lastContactAt: now });
        broadcast(position());
        expect(service.getSnapshot()).toMatchObject({ cause: null, stale: false });
    });
    it('rejects invalid GPS coordinates and never downgrades drag on GPS loss', () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast({ ...position(), vessel: { ...position().vessel, latitude: NaN } });
        expect(service.getSnapshot().lastContactAt).toBeNull();
        broadcast(position(true));
        broadcast({ type: 'status', gpsAvailable: false, reason: 'gps_unavailable', source: 'pi', timestamp: now + 1 });
        expect(service.getSnapshot()).toMatchObject({ cause: 'drag', stale: true });
    });
    it('cannot clear a newer push alarm with a delayed holding packet', () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        service.receivePush({
            notification_type: 'anchor_alarm',
            session_code: mocks.state.sessionCode,
            alarm_kind: 'drag',
            observed_at: new Date(now).toISOString(),
        });
        broadcast(position(false, now - 5_000));
        expect(service.getSnapshot().cause).toBe('drag');
        broadcast(position(false, now + 1));
        expect(service.getSnapshot().cause).toBeNull();
    });
    it('does not claim silence when the native stop hangs, or enqueue repeated stops', async () => {
        let finish!: () => void;
        mocks.release.mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        const attempt = service.mute();
        const check = expect(attempt).rejects.toThrow('not confirmed');
        await vi.advanceTimersByTimeAsync(8_000);
        await check;
        expect(service.getSnapshot().muted).toBe(false);
        const retry = service.mute();
        expect(mocks.release).toHaveBeenCalledTimes(1);
        finish();
        await retry;
        expect(service.getSnapshot().muted).toBe(true);
    });
    it('keeps sounding and receiving after the page unsubscribes', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        const off = service.subscribe(vi.fn());
        broadcast(position(true));
        await settle();
        off();
        expect(mocks.releaseEventually).not.toHaveBeenCalled();
        expect(service.getSnapshot().cause).toBe('drag');
        broadcast(position(false, Date.now() + 1));
        await settle();
        expect(mocks.releaseEventually).toHaveBeenCalledWith('shore-lease');
    });
    it('starts an alarm with no page subscriber and initializes only once', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        service.start();
        broadcast(position(true));
        await settle();
        expect(mocks.acquire).toHaveBeenCalledTimes(1);
        expect(mocks.broadcasts.size).toBe(1);
    });
    it('recovers the most recent current alarm on app coordinator mount', async () => {
        mocks.latest = position(true);
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        await settle();
        expect(service.getSnapshot().cause).toBe('drag');
    });
    it('warns at 35 seconds and alarms at 60 seconds without fresh position', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position());
        await vi.advanceTimersByTimeAsync(36_000);
        expect(service.getSnapshot()).toMatchObject({ stale: true, cause: null });
        await vi.advanceTimersByTimeAsync(24_000);
        expect(service.getSnapshot().cause).toBe('contact-lost');
        expect(mocks.acquire).toHaveBeenCalledWith('shore-watch');
    });
    it('does not use repeated packets or stale GPS to keep the watch green', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position());
        await vi.advanceTimersByTimeAsync(34_000);
        broadcast(position(false, now));
        await vi.advanceTimersByTimeAsync(20_000);
        broadcast({ ...position(), vessel: { ...position().vessel, timestamp: now } });
        await vi.advanceTimersByTimeAsync(6_000);
        expect(service.getSnapshot().cause).toBe('contact-lost');
    });
    it('preserves confirmed drag when the contact subsequently disappears', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await vi.advanceTimersByTimeAsync(65_000);
        expect(service.getSnapshot()).toMatchObject({ cause: 'drag', stale: true });
    });
    it('silences only this phone until recovery, then rearms on a new incident', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        await service.mute();
        broadcast(position(true, now + 1));
        await settle();
        expect(service.getSnapshot().muted).toBe(true);
        expect(mocks.acquire).toHaveBeenCalledTimes(1);
        broadcast(position(false, now + 2));
        broadcast(position(true, now + 3));
        await settle();
        expect(service.getSnapshot().muted).toBe(false);
        expect(mocks.acquire).toHaveBeenCalledTimes(2);
    });
    it('retains a retry control when audio fails and keeps alarm active if mute fails', async () => {
        mocks.acquire.mockRejectedValueOnce(new Error('No audio'));
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        expect(service.getSnapshot().audioError).toMatch(/could not sound/);
        service.retryAudio();
        await settle();
        expect(service.getSnapshot().audioError).toBeNull();
        mocks.release.mockRejectedValueOnce(new Error('cannot stop'));
        await expect(service.mute()).rejects.toThrow();
        expect(service.getSnapshot().muted).toBe(false);
    });
    it('releases only its own alarm lease on explicit leave or account reset', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        await settle();
        state({ role: 'vessel', sessionCode: null });
        expect(service.getSnapshot()).toMatchObject({ cause: null, sessionCode: null });
        expect(mocks.releaseEventually).toHaveBeenCalledWith('shore-lease');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mocks.acquire).toHaveBeenCalledTimes(1);
    });
    it('releases a late audio acquisition after leaving rather than sounding in the new session', async () => {
        let resolve!: (lease: string) => void;
        mocks.acquire.mockReturnValueOnce(
            new Promise<string>((done) => {
                resolve = done;
            }),
        );
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position(true));
        state({ sessionCode: null });
        resolve('late-lease');
        await settle();
        expect(mocks.releaseEventually).toHaveBeenCalledWith('late-lease');
        expect(service.getSnapshot().cause).toBeNull();
    });
    it('accepts matching foreground push alarms without a Realtime connection', async () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        state({ connected: false });
        service.receivePush({
            notification_type: 'anchor_alarm',
            session_code: 'ABCDEFGHJKLM',
            alarm_kind: 'gps_lost',
            observed_at: new Date().toISOString(),
        });
        await settle();
        expect(service.getSnapshot().cause).toBe('gps-lost');
    });
    it('ignores other sessions and older pushes after receiving newer vessel data', () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        broadcast(position());
        service.receivePush({ notification_type: 'anchor_alarm', session_code: 'other', alarm_kind: 'drag' });
        service.receivePush({
            notification_type: 'anchor_alarm',
            session_code: 'ABCDEFGHJKLM',
            alarm_kind: 'drag',
            observed_at: new Date(now - 1_000).toISOString(),
        });
        expect(service.getSnapshot().cause).toBeNull();
    });
    it('keeps expiry warning when fresh holding reports arrive', () => {
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        service.receivePush({
            notification_type: 'anchor_alarm',
            session_code: 'ABCDEFGHJKLM',
            alarm_kind: 'session_expiring',
        });
        broadcast(position());
        expect(service.getSnapshot().cause).toBe('session-expiring');
    });
    it('publishes vessel positions without mounting the anchor page', async () => {
        mocks.state.role = 'vessel';
        const data = position();
        mocks.boat.mockReturnValue({
            state: 'watching',
            anchorPosition: data.anchor,
            vesselPosition: data.vessel,
            distanceFromAnchor: 10,
            swingRadius: 40,
            config: undefined,
        });
        const service = new ShoreWatchAlarmServiceClass();
        service.start();
        expect(mocks.publish).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mocks.publish).toHaveBeenCalledTimes(2);
        expect(service.getSnapshot().sessionCode).toBeNull();
    });
});
