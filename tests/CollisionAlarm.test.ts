/**
 * Collision alarm delivery (125-01 scope items 7-9).
 *
 *  - Sound through AlarmAudioService under its own lease, so the anchor alarm
 *    keeps priority: releasing the collision lease can never silence an
 *    anchor alarm, and the collision path never force-stops.
 *  - The lock-screen alert goes through the shared safety-notification path
 *    with the COLLISION kind and its own ids; it never touches the anchor's
 *    scheduleAlarm/cancelAlarm.
 *  - A per-target mute lasts 30 minutes and never silences close quarters.
 *  - Honest notices: 'paused' when the app goes to the background without a
 *    keep-alive, 'blind' when no AIS has arrived for 60 s while armed.
 *  - Encounters are latched: a card is relabelled 'passed' only on evidence
 *    (an opening CPA from known motion, held 30 s), never because the watch
 *    lost the data (review finding, both reviewers, HIGH).
 *
 * Fictional MMSIs only (MID 123 is unallocated).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    audio: {
        startAlarm: vi.fn().mockResolvedValue({ playing: true }),
        stopAlarm: vi.fn().mockResolvedValue({ stopped: true }),
        isAlarmPlaying: vi.fn().mockResolvedValue({ playing: true }),
    },
    notify: {
        checkReadiness: vi.fn(),
        scheduleAlarm: vi.fn(),
        cancelAlarm: vi.fn(),
        scheduleSafetyAlert: vi.fn().mockResolvedValue({ scheduled: 3, interruptionLevel: 'timeSensitive' }),
        cancelSafetyAlert: vi.fn().mockResolvedValue({ cancelled: true }),
    },
    local: { schedule: vi.fn().mockResolvedValue({ notifications: [] }) },
    app: { listeners: new Map<string, () => void>(), addListener: vi.fn() },
    bgGeo: { getLeaseState: vi.fn() },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: (name: string) => (name === 'AlarmAudio' ? mocks.audio : mocks.notify),
}));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: mocks.local }));
vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.app.addListener } }));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: mocks.bgGeo }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AlarmAudioService } from '../services/AlarmAudioService';
import { CollisionAlarmService, type CollisionAlarmCandidate } from '../services/CollisionAlarmService';
import {
    AisGuardAlertStore,
    COLLISION_BLIND_NOTICE,
    COLLISION_PAUSED_NOTICE,
    COLLISION_STOPPED_NOTICE,
} from '../services/aisGuardAlertStore';
import type { CollisionAssessment } from '../utils/collisionRule';

const T0 = Date.UTC(2026, 9, 9, 6, 0, 0);

function candidate(mmsi: number, closeQuarters = false, name = 'FICTIONAL TRADER'): CollisionAlarmCandidate {
    const assessment: CollisionAssessment = {
        rangeNm: closeQuarters ? 0.3 : 1.4,
        bearingDeg: 44,
        cpaNm: closeQuarters ? 0.04 : 0.2,
        tcpaMin: closeQuarters ? 2.1 : 7.5,
        risk: 'DANGER',
        closeQuarters,
        pair: 'offshore',
        rangeOnly: false,
        reason: null,
        alarm: true,
    };
    return { mmsi, name, assessment, reportAgeSec: 12, source: 'local', sogKn: 11.5 };
}

const armed = (nowMs: number, lastAisAt = nowMs) => ({ nowMs, lastAisAt });

/** The same vessel graded with known motion, no longer alarming. */
function graded(
    mmsi: number,
    over: Partial<CollisionAssessment> & { opening: boolean },
    name = 'FICTIONAL TRADER',
): CollisionAlarmCandidate {
    const { opening, ...assessment } = over;
    const base = candidate(mmsi, false, name);
    return {
        ...base,
        opening,
        assessment: { ...base.assessment, risk: 'SAFE', alarm: false, closeQuarters: false, ...assessment },
    };
}

/** The same vessel, range only: the watch can no longer compute her CPA. */
function rangeOnly(mmsi: number, reason: CollisionAssessment['reason']): CollisionAlarmCandidate {
    const base = candidate(mmsi);
    return {
        ...base,
        assessment: {
            ...base.assessment,
            cpaNm: null,
            tcpaMin: null,
            risk: 'NONE',
            alarm: false,
            closeQuarters: false,
            rangeOnly: true,
            reason,
        },
    };
}

const opening = (mmsi: number) => graded(mmsi, { tcpaMin: -2, cpaNm: 0.2, risk: 'NONE', opening: true });

/** Passes every 5 s from `from` to `to` inclusive, all with the same targets. */
function passes(
    targets: () => CollisionAlarmCandidate[],
    from: number,
    to: number,
    own?: 'moving' | 'no-fix' | 'unknown',
) {
    for (let t = from; t <= to; t += 5_000) CollisionAlarmService.update(targets(), { nowMs: t, lastAisAt: t, own });
}

beforeEach(async () => {
    mocks.app.listeners.clear();
    mocks.app.addListener.mockReset();
    mocks.app.addListener.mockImplementation(async (event: string, cb: () => void) => {
        mocks.app.listeners.set(event, cb);
        return { remove: vi.fn() };
    });
    mocks.bgGeo.getLeaseState.mockReset();
    mocks.bgGeo.getLeaseState.mockResolvedValue({ active: false });
    CollisionAlarmService.__resetForTests();
    AisGuardAlertStore.clear();
    for (const fn of [...Object.values(mocks.audio), ...Object.values(mocks.notify), mocks.local.schedule]) {
        fn.mockClear();
    }
    await AlarmAudioService.forceStop();
    mocks.audio.stopAlarm.mockClear();
});

describe('sound and lock-screen alert', () => {
    it('sounds, names the vessel and schedules the COLLISION safety alert for a DANGER target', async () => {
        CollisionAlarmService.update([candidate(123400010)], armed(T0));
        await CollisionAlarmService.whenIdle();

        expect(mocks.audio.startAlarm).toHaveBeenCalledOnce();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledOnce();
        const [args] = mocks.notify.scheduleSafetyAlert.mock.calls[0];
        expect(args.kind).toBe('collision');
        expect(args.title).toContain('FICTIONAL TRADER');
        expect(args.body).toMatch(/CPA 0\.20 NM in 8 min/);
        expect(args.body).toMatch(/12 s old/);

        const card = AisGuardAlertStore.get().find((a) => a.mmsi === 123400010)!;
        expect(card.collision).toMatchObject({ cpaNm: 0.2, tcpaMin: 7.5, closeQuarters: false, reportAgeSec: 12 });
    });

    it('keeps the anchor alarm in charge: clearing the collision never silences an anchor alarm', async () => {
        const anchorLease = await AlarmAudioService.acquire('anchor-watch');
        CollisionAlarmService.update([candidate(123400011)], armed(T0));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(2);

        passes(() => [opening(123400011)], T0 + 5_000, T0 + 40_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(mocks.audio.stopAlarm).not.toHaveBeenCalled();
        expect(AlarmAudioService.getIsPlaying()).toBe(true);

        CollisionAlarmService.disarm();
        await CollisionAlarmService.whenIdle();
        expect(mocks.audio.stopAlarm).not.toHaveBeenCalled();

        await AlarmAudioService.release(anchorLease);
        expect(mocks.audio.stopAlarm).toHaveBeenCalledOnce();

        // The anchor's own notification set is never touched by this path.
        expect(mocks.notify.scheduleAlarm).not.toHaveBeenCalled();
        expect(mocks.notify.cancelAlarm).not.toHaveBeenCalled();
        for (const [args] of mocks.notify.cancelSafetyAlert.mock.calls) expect(args.kind).toBe('collision');
    });

    it('stops sound and withdraws the alert once she is shown opening for 30 s, but keeps the card', async () => {
        CollisionAlarmService.update([candidate(123400012)], armed(T0));
        await CollisionAlarmService.whenIdle();
        // Opening, but not yet for 30 s: still sounding, still live.
        passes(() => [opening(123400012)], T0 + 5_000, T0 + 30_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(AisGuardAlertStore.get().find((a) => a.mmsi === 123400012)!.collision?.cleared).toBeUndefined();

        CollisionAlarmService.update([opening(123400012)], armed(T0 + 35_000));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'collision' });
        const card = AisGuardAlertStore.get().find((a) => a.mmsi === 123400012)!;
        expect(card.collision?.cleared).toBe(true);
        expect(card.collision?.lost).toBeUndefined();
    });

    it('stays latched while she merely stops alarming without being shown clear (CAUTION band)', async () => {
        CollisionAlarmService.update([candidate(123400017)], armed(T0));
        passes(
            () => [graded(123400017, { cpaNm: 0.6, tcpaMin: 9, risk: 'CAUTION', opening: false })],
            T0 + 5_000,
            T0 + 120_000,
        );
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        const card = AisGuardAlertStore.get().find((a) => a.mmsi === 123400017)!;
        expect(card.collision?.cleared).toBeUndefined();
        // The card shows her latest numbers.
        expect(card.collision?.cpaNm).toBe(0.6);
    });
});

describe('a lost contact is never a passed one (review: fix loss mid-alarm)', () => {
    async function alarmThen(mmsi: number) {
        CollisionAlarmService.update([candidate(mmsi)], armed(T0));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        mocks.notify.cancelSafetyAlert.mockClear();
    }

    function expectStillLive(mmsi: number, reason: string) {
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(mocks.notify.cancelSafetyAlert).not.toHaveBeenCalled();
        const card = AisGuardAlertStore.get().find((a) => a.mmsi === mmsi)!;
        expect(card.collision?.cleared).toBeUndefined();
        expect(card.collision?.lost?.reason).toBe(reason);
    }

    it('no position fix mid-alarm: keeps sounding, keeps the lock-screen alert, card reads CPA unknown', async () => {
        await alarmThen(123400020);
        for (let t = T0 + 5_000; t <= T0 + 120_000; t += 5_000) CollisionAlarmService.noFix(t);
        await CollisionAlarmService.whenIdle();
        expectStillLive(123400020, 'no-fix');
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('no-fix');
    });

    it('our own course or speed unknown mid-alarm: the same, and the strip says why', async () => {
        await alarmThen(123400021);
        passes(() => [rangeOnly(123400021, 'own-motion-unknown')], T0 + 5_000, T0 + 120_000, 'unknown');
        await CollisionAlarmService.whenIdle();
        expectStillLive(123400021, 'own-motion-unknown');
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('no-motion');
    });

    it('her report over ten minutes old, or her course unknown: the same', async () => {
        await alarmThen(123400022);
        passes(() => [rangeOnly(123400022, 'report-too-old')], T0 + 5_000, T0 + 120_000);
        await CollisionAlarmService.whenIdle();
        expectStillLive(123400022, 'report-too-old');

        CollisionAlarmService.__resetForTests();
        AisGuardAlertStore.clear();
        await AlarmAudioService.forceStop();
        await alarmThen(123400023);
        passes(() => [rangeOnly(123400023, 'target-motion-unknown')], T0 + 5_000, T0 + 60_000);
        await CollisionAlarmService.whenIdle();
        expectStillLive(123400023, 'target-motion-unknown');
    });

    it('her feature vanishing (network AIS TTL, a swept list) mid-alarm: the same', async () => {
        await alarmThen(123400024);
        passes(() => [], T0 + 5_000, T0 + 120_000);
        await CollisionAlarmService.whenIdle();
        expectStillLive(123400024, 'gone');
    });

    it('resumes from where it was when the data comes back, and clears only on evidence then', async () => {
        await alarmThen(123400025);
        passes(() => [], T0 + 5_000, T0 + 60_000);
        passes(() => [opening(123400025)], T0 + 65_000, T0 + 100_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        const card = AisGuardAlertStore.get().find((a) => a.mmsi === 123400025)!;
        expect(card.collision).toMatchObject({ cleared: true });
        expect(card.collision?.lost).toBeUndefined();
    });

    it('gives up ten minutes after her CPA was due: silent, NOT SHOWN CLEAR, and the lock-screen alert stays', async () => {
        await alarmThen(123400026); // TCPA 7.5 min
        passes(() => [], T0 + 5_000, T0 + 17 * 60_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        passes(() => [], T0 + 17 * 60_000 + 5_000, T0 + 18 * 60_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.cancelSafetyAlert).not.toHaveBeenCalled();
        const card = AisGuardAlertStore.get().find((a) => a.mmsi === 123400026)!;
        expect(card.collision).toMatchObject({ cleared: true, lost: { reason: 'gone' } });
    });
});

describe('no flicker', () => {
    it('an encounter that flickers in and out of alarm never re-announces or drops its alert', async () => {
        // Review probe: '....AAA...A..A.A..AA.A.A.AAAAA..A.....AA' from SOG jitter across 3 kn.
        const pattern = '....AAA...A..A.A..AA.A.A.AAAAA..A.....AA';
        let t = T0;
        for (const p of pattern) {
            const target =
                p === 'A'
                    ? candidate(123400030)
                    : graded(123400030, { cpaNm: 0.01, tcpaMin: 9, risk: 'CAUTION', opening: false });
            CollisionAlarmService.update([target], armed(t));
            await CollisionAlarmService.whenIdle();
            t += 5_000;
        }
        await CollisionAlarmService.whenIdle();
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledOnce();
        expect(mocks.notify.cancelSafetyAlert).not.toHaveBeenCalled();
        expect(mocks.audio.startAlarm).toHaveBeenCalledOnce();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
    });

    it('boats in company inside 0.1 NM keep a close-quarters acknowledgement while TCPA flips sign', async () => {
        const abeam = (positive: boolean): CollisionAlarmCandidate =>
            positive
                ? {
                      ...candidate(123400031, true),
                      assessment: {
                          ...candidate(123400031, true).assessment,
                          rangeNm: 0.08,
                          cpaNm: 0.08,
                          tcpaMin: 0.4,
                      },
                  }
                : graded(123400031, { rangeNm: 0.08, cpaNm: 0.08, tcpaMin: -0.3, risk: 'NONE', opening: true });
        CollisionAlarmService.update([abeam(true)], armed(T0));
        await CollisionAlarmService.whenIdle();
        AisGuardAlertStore.muteCollision(123400031, T0 + 1_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        for (let i = 1; i <= 60; i++) {
            // Mostly negative (one boat creeping ahead, over a minute at a time),
            // now and then positive: still inside 0.1 NM, so never 'passed'.
            CollisionAlarmService.update([abeam(i % 13 === 0)], armed(T0 + i * 5_000));
            // Five seconds between passes: every side effect lands before the next.
            await CollisionAlarmService.whenIdle();
        }
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledOnce();
    });
});

describe('mute and close quarters', () => {
    it('mutes a DANGER target for 30 minutes', async () => {
        CollisionAlarmService.update([candidate(123400013)], armed(T0));
        await CollisionAlarmService.whenIdle();
        AisGuardAlertStore.muteCollision(123400013, T0 + 1_000);
        await CollisionAlarmService.whenIdle();

        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(AisGuardAlertStore.get().some((a) => a.mmsi === 123400013)).toBe(false);

        CollisionAlarmService.update([candidate(123400013)], armed(T0 + 10 * 60_000));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);

        // 31 minutes on, the mute has lapsed.
        CollisionAlarmService.update([candidate(123400013)], armed(T0 + 31 * 60_000));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
    });

    it('close quarters breaks through a mute', async () => {
        CollisionAlarmService.update([candidate(123400014)], armed(T0));
        await CollisionAlarmService.whenIdle();
        AisGuardAlertStore.muteCollision(123400014, T0 + 1_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);

        CollisionAlarmService.update([candidate(123400014, true)], armed(T0 + 60_000));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(AisGuardAlertStore.get().find((a) => a.mmsi === 123400014)?.collision?.closeQuarters).toBe(true);
    });

    it('close quarters can be acknowledged, never muted: it sounds again on its next approach', async () => {
        CollisionAlarmService.update([candidate(123400015, true)], armed(T0));
        await CollisionAlarmService.whenIdle();
        AisGuardAlertStore.muteCollision(123400015, T0 + 1_000);
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);

        // Still in close quarters: acknowledged, quiet.
        CollisionAlarmService.update([candidate(123400015, true)], armed(T0 + 5_000));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);

        // She passes clear of close quarters (opening, beyond 0.1 NM, for 30 s),
        // then comes round again: no 30-minute mute applies.
        passes(
            () => [{ ...opening(123400015), assessment: { ...opening(123400015).assessment, rangeNm: 0.4 } }],
            T0 + 10_000,
            T0 + 45_000,
        );
        CollisionAlarmService.update([candidate(123400015)], armed(T0 + 90_000));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
    });

    it('ignores anything that is not an alarm', async () => {
        const quiet = candidate(123400016);
        quiet.assessment = { ...quiet.assessment, alarm: false, risk: 'CAUTION' };
        CollisionAlarmService.update([quiet], armed(T0));
        await CollisionAlarmService.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
    });
});

describe('honest notices', () => {
    it("says 'blind' once no AIS has arrived for 60 s while armed — a swept list is not a clear sea", async () => {
        CollisionAlarmService.update([], armed(T0, T0));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('watching');
        CollisionAlarmService.update([], armed(T0 + 59_000, T0));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('watching');
        CollisionAlarmService.update([], armed(T0 + 61_000, T0));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('blind');
        expect(COLLISION_BLIND_NOTICE).toBe('Collision watch blind: no AIS for 60 s');

        // Never heard anything since arming: blind after 60 s too.
        CollisionAlarmService.__resetForTests();
        CollisionAlarmService.update([], armed(T0, 0));
        CollisionAlarmService.update([], armed(T0 + 61_000, 0));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('blind');

        // AIS again: watching.
        CollisionAlarmService.update([], armed(T0 + 62_000, T0 + 62_000));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('watching');
    });

    it('a blind receiver while backgrounded posts its lock-screen notice at most every 30 min', async () => {
        CollisionAlarmService.update([], armed(T0, T0));
        await CollisionAlarmService.onBackground(true, T0 + 1_000);
        // An anchored Class B neighbour reporting every 180 s, nothing else, for an hour under way.
        for (let t = T0; t <= T0 + 3_600_000; t += 5_000) {
            const lastHeard = T0 + Math.floor((t - T0) / 180_000) * 180_000;
            CollisionAlarmService.update([], armed(t, lastHeard));
        }
        // The notices post through a lazily imported plugin: let every one land.
        let settled = -1;
        while (settled !== mocks.local.schedule.mock.calls.length) {
            settled = mocks.local.schedule.mock.calls.length;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const blindPosts = mocks.local.schedule.mock.calls.filter(([{ notifications }]) =>
            String(notifications[0].title).includes('blind'),
        );
        expect(blindPosts.length).toBeGreaterThanOrEqual(1);
        expect(blindPosts.length).toBeLessThanOrEqual(2);
    });

    it('stopped: no blind notice and no lock-screen post, and the strip says it will stay quiet', async () => {
        await CollisionAlarmService.onBackground(true, T0);
        for (let t = T0; t <= T0 + 3_600_000; t += 5_000) {
            const lastHeard = T0 + Math.floor((t - T0) / 180_000) * 180_000;
            CollisionAlarmService.update([], { nowMs: t, lastAisAt: lastHeard, own: 'stopped' });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mocks.local.schedule).not.toHaveBeenCalled();
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('stopped');
        expect(COLLISION_STOPPED_NOTICE).toMatch(/stopped.*0\.5 kn/);
    });

    it("says 'paused' when Thalassa goes to the background with nothing keeping it awake", async () => {
        CollisionAlarmService.update([], armed(T0));
        await CollisionAlarmService.onBackground(false, T0 + 1_000);
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('paused');
        expect(mocks.local.schedule).toHaveBeenCalledOnce();
        const [{ notifications }] = mocks.local.schedule.mock.calls[0];
        expect(`${notifications[0].title}: ${notifications[0].body}`).toBe(COLLISION_PAUSED_NOTICE);
        expect(COLLISION_PAUSED_NOTICE).toBe(
            'Collision watch paused: Thalassa is in the background without a track or anchor watch',
        );

        CollisionAlarmService.onForeground(T0 + 600_000);
        const notice = AisGuardAlertStore.getWatchNotice()!;
        expect(notice.state).toBe('resumed');
        expect(notice.pausedFrom).toBe(T0 + 1_000);
        expect(notice.resumedAt).toBe(T0 + 600_000);
    });

    it('does not cry paused while a voyage track or anchor watch keeps the app awake', async () => {
        CollisionAlarmService.update([], armed(T0));
        await CollisionAlarmService.onBackground(true, T0 + 1_000);
        expect(mocks.local.schedule).not.toHaveBeenCalled();
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('watching');
    });

    it('listens for real backgrounding (pause/resume), never willResignActive (appStateChange)', async () => {
        CollisionAlarmService.update([], armed(T0));
        await vi.waitFor(() => expect(mocks.app.listeners.has('pause')).toBe(true));
        expect(mocks.app.listeners.has('resume')).toBe(true);
        expect(mocks.app.addListener.mock.calls.map(([event]) => event)).not.toContain('appStateChange');
    });

    it('drops a late background answer once the app is back: never paused while open', async () => {
        let answer: (v: { active: boolean }) => void = () => undefined;
        mocks.bgGeo.getLeaseState.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        CollisionAlarmService.update([], armed(T0));
        await vi.waitFor(() => expect(mocks.app.listeners.has('pause')).toBe(true));
        mocks.app.listeners.get('pause')!();
        mocks.app.listeners.get('resume')!();
        answer({ active: false });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('watching');
        expect(mocks.local.schedule).not.toHaveBeenCalled();
        // And a later real blind spell still shows.
        CollisionAlarmService.update([], armed(T0 + 120_000, T0));
        expect(AisGuardAlertStore.getWatchNotice()?.state).toBe('blind');
    });

    it('disarming drops its cards (never relabelled as passed) and stands the watch down', async () => {
        CollisionAlarmService.update([candidate(123400040)], armed(T0));
        await CollisionAlarmService.whenIdle();
        CollisionAlarmService.disarm();
        await CollisionAlarmService.whenIdle();
        expect(AisGuardAlertStore.get().some((a) => a.mmsi === 123400040)).toBe(false);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(AisGuardAlertStore.getWatchNotice()).toBeNull();
    });

    it('says nothing at all while disarmed', async () => {
        await CollisionAlarmService.onBackground(false, T0);
        expect(mocks.local.schedule).not.toHaveBeenCalled();
        expect(AisGuardAlertStore.getWatchNotice()).toBeNull();
    });
});
