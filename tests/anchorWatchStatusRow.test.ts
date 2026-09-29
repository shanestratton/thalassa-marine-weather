import { describe, expect, it } from 'vitest';
import {
    anchorSwingGeometry,
    presentAnchorTile,
    presentAnchorWatchRow,
    shoreSwingKey,
    shoreWatchTileKey,
} from '../components/anchor-watch/anchorWatchStatusRow';
import type { ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';

const NOW = 1_790_000_000_000;

type Local = Parameters<typeof presentAnchorWatchRow>[0];

const local = (patch: Partial<NonNullable<Local>> = {}): Local => ({
    state: 'watching',
    distanceFromAnchor: 12,
    swingRadius: 45,
    alarmTriggeredAt: null,
    alarmCause: null,
    ...patch,
});

const noShore: ShoreAlarmSnapshot = {
    sessionCode: null,
    position: null,
    lastContactAt: null,
    stale: true,
    cause: null,
    muted: false,
    audioError: null,
};

const shore = (patch: Partial<ShoreAlarmSnapshot> = {}): ShoreAlarmSnapshot => ({
    ...noShore,
    sessionCode: 'PISESSION',
    stale: false,
    lastContactAt: NOW,
    position: {
        type: 'position',
        vessel: { latitude: -20.27, longitude: 148.72, accuracy: 3, heading: 0, speed: 0, timestamp: NOW },
        anchor: { latitude: -20.27, longitude: 148.72, timestamp: NOW },
        distance: 18,
        swingRadius: 50,
        isAlarm: false,
        timestamp: NOW,
    },
    ...patch,
});

describe('presentAnchorWatchRow', () => {
    it('says Not deployed only when nothing anywhere is keeping a watch', () => {
        expect(presentAnchorWatchRow(null, noShore, null)).toMatchObject({
            active: false,
            detail: 'Not deployed',
            tone: 'off',
            urgent: false,
        });
        expect(presentAnchorWatchRow(local({ state: 'idle' }), noShore, null).detail).toBe('Not deployed');
    });

    // Shane 2026-09-29: the anchor was down, the Pi had the watch, and the
    // System status box said "Not deployed".
    it('reports a watch the Pi keeps, with its distance, while this phone is idle', () => {
        const row = presentAnchorWatchRow(local({ state: 'idle' }), shore(), 'PISESSION');
        expect(row).toMatchObject({ active: true, keeper: 'pi', tone: 'green', urgent: false });
        expect(row.detail).toBe('Holding · 18m / 50m radius · watched by the Pi');
    });

    it('names another device when the shore session is not the one handed to the Pi', () => {
        const row = presentAnchorWatchRow(null, shore(), null);
        expect(row).toMatchObject({ active: true, keeper: 'other', tone: 'green' });
        expect(row.detail).toBe('Holding · 18m / 50m radius · watched from another device');
    });

    it('turns red for a remote drag alarm, a remote drift and lost contact', () => {
        expect(presentAnchorWatchRow(null, shore({ cause: 'drag' }), 'PISESSION')).toMatchObject({
            tone: 'red',
            urgent: true,
            detail: 'ALARM · 18m / 50m radius · watched by the Pi',
        });
        const drifting = shore();
        drifting.position = { ...drifting.position!, distance: 62 };
        expect(presentAnchorWatchRow(null, drifting, 'PISESSION')).toMatchObject({
            tone: 'red',
            urgent: true,
            detail: 'Drifting · 62m / 50m radius · watched by the Pi',
        });
        expect(presentAnchorWatchRow(null, shore({ cause: 'contact-lost' }), 'PISESSION')).toMatchObject({
            tone: 'red',
            detail: 'Down · watched by the Pi · no current data',
        });
    });

    // A session_expiring push sounds the phone and raises the expiring
    // dialog. With fresh data the row used to fall through to green Holding.
    it('flags an expiring watch authorisation even while the data is fresh', () => {
        expect(presentAnchorWatchRow(null, shore({ cause: 'session-expiring' }), 'PISESSION')).toMatchObject({
            active: true,
            keeper: 'pi',
            tone: 'amber',
            urgent: true,
            detail: 'Down · 18m / 50m radius · watched by the Pi · watch authorisation expiring',
        });
        expect(
            presentAnchorWatchRow(null, shore({ cause: 'session-expiring', stale: true }), 'PISESSION'),
        ).toMatchObject({
            tone: 'amber',
            urgent: true,
            detail: 'Down · watched by the Pi · watch authorisation expiring',
        });
        // A drag alarm still wins over an expiring authorisation.
        expect(presentAnchorWatchRow(null, shore({ cause: 'drag' }), 'PISESSION').tone).toBe('red');
    });

    it('waits in amber, without distances, while the remote data is stale', () => {
        const row = presentAnchorWatchRow(null, shore({ stale: true }), 'PISESSION');
        expect(row).toMatchObject({ active: true, tone: 'amber', urgent: false });
        expect(row.detail).toBe('Down · watched by the Pi · waiting for data');
    });

    it('keeps the anchor down when the Pi has the watch but this phone never joined as shore', () => {
        const row = presentAnchorWatchRow(null, noShore, 'PISESSION');
        expect(row).toMatchObject({ active: true, keeper: 'pi', tone: 'amber' });
        expect(row.detail).toBe('Down · watched by the Pi · no updates on this phone');
    });

    it("keeps this phone's own watch as it was: holding, drifting and alarm", () => {
        expect(presentAnchorWatchRow(local(), noShore, null)).toMatchObject({
            keeper: 'phone',
            tone: 'green',
            detail: 'Holding · 12m / 45m radius',
        });
        expect(presentAnchorWatchRow(local({ distanceFromAnchor: 51 }), noShore, null)).toMatchObject({
            tone: 'red',
            urgent: true,
            detail: 'Drifting · 51m / 45m radius',
        });
        expect(
            presentAnchorWatchRow(local({ state: 'alarm', alarmTriggeredAt: NOW, alarmCause: 'drag' }), noShore, null),
        ).toMatchObject({ tone: 'red', urgent: true, detail: 'ALARM · 12m / 45m radius' });
    });

    it('says why a GPS-lost alarm fired instead of a distance the watch could not measure', () => {
        expect(
            presentAnchorWatchRow(
                local({ state: 'alarm', alarmTriggeredAt: NOW, alarmCause: 'gps-lost', distanceFromAnchor: 0 }),
                noShore,
                null,
            ).detail,
        ).toBe('ALARM · GPS lost');
    });

    // A paused watch is not watching. It used to read "Holding · 0m / 0m".
    it('never calls a paused or half-set watch Holding', () => {
        expect(presentAnchorWatchRow(local({ state: 'paused', distanceFromAnchor: 0 }), noShore, null)).toMatchObject({
            active: true,
            tone: 'amber',
            urgent: true,
            detail: 'Paused · not watching. Open Anchor watch to resume.',
        });
        expect(presentAnchorWatchRow(local({ state: 'setting' }), noShore, null)).toMatchObject({
            active: true,
            tone: 'amber',
            urgent: false,
            detail: 'Setting the watch…',
        });
    });

    it("prefers this phone's own watch over a shore session", () => {
        expect(presentAnchorWatchRow(local(), shore(), 'PISESSION')).toMatchObject({
            keeper: 'phone',
            detail: 'Holding · 12m / 45m radius',
        });
    });
});

// The Vessel page's Anchor tile is worded from the same row, so it can never
// tell a different story from the System status box.
describe('presentAnchorTile', () => {
    const tile = (...args: Parameters<typeof presentAnchorWatchRow>) =>
        presentAnchorTile(presentAnchorWatchRow(...args));

    it('keeps DRAGGING for a real alarm, and does not call lost contact or a drift a drag alarm', () => {
        expect(tile(null, shore({ cause: 'drag' }), 'PISESSION')).toMatchObject({
            status: 'alarm',
            label: 'DRAGGING',
            tone: 'red',
        });
        expect(tile(null, shore({ cause: 'contact-lost' }), 'PISESSION')).toMatchObject({
            status: 'armed',
            label: 'No data',
            tone: 'red',
            spoken: 'down, watched by the Pi, no current data',
        });
        const drifting = shore();
        drifting.position = { ...drifting.position!, distance: 62 };
        expect(tile(null, drifting, 'PISESSION')).toMatchObject({ status: 'armed', label: 'Drifting', tone: 'red' });
    });

    it('goes amber, keeping who has the watch, while waiting or expiring', () => {
        expect(tile(null, shore({ stale: true }), 'PISESSION')).toMatchObject({
            label: 'Down · Pi',
            tone: 'amber',
            spoken: 'down, watched by the Pi, waiting for data',
        });
        expect(tile(null, shore({ cause: 'session-expiring' }), null)).toMatchObject({
            label: 'Down · Remote',
            tone: 'amber',
            spoken: 'down, watched from another device, watch authorisation expiring',
        });
        expect(tile(local({ state: 'setting' }), noShore, null)).toMatchObject({ label: 'Setting', tone: 'amber' });
    });

    it("says Down for this phone's own healthy watch and Up when nothing keeps one", () => {
        expect(tile(local(), noShore, null)).toMatchObject({
            status: 'armed',
            label: 'Down',
            tone: 'cyan',
            spoken: 'down',
        });
        expect(tile(null, noShore, null)).toMatchObject({ status: 'disarmed', label: 'Up', tone: 'off', spoken: 'up' });
    });

    it("draws the hero's swing arc from whichever device keeps the watch", () => {
        const phone = { radiusM: 45, offsetM: 12, bearingDeg: 90 };
        const pi = shore();
        pi.position = {
            ...pi.position!,
            distance: 62,
            swingRadius: 50,
            vessel: { ...pi.position!.vessel, latitude: -20.27, longitude: 148.72 },
            anchor: { ...pi.position!.anchor, latitude: -20.2695, longitude: 148.72 },
        };
        // This phone's own watch: its own numbers.
        expect(anchorSwingGeometry({ keeper: 'phone' }, phone, pi)).toBe(phone);
        // The Pi's watch: the Pi's report, never the phone's leftovers. The
        // anchor lies due north of the boat, so the bearing to it is ~0°.
        const remote = anchorSwingGeometry({ keeper: 'pi' }, phone, pi);
        expect(remote.radiusM).toBe(50);
        expect(remote.offsetM).toBe(62);
        expect(Math.min(remote.bearingDeg, 360 - remote.bearingDeg)).toBeLessThan(0.5);
        // No fresh report, or no watch at all: no arc.
        expect(anchorSwingGeometry({ keeper: 'pi' }, phone, { ...pi, stale: true })).toEqual({
            radiusM: 0,
            offsetM: 0,
            bearingDeg: 0,
        });
        expect(anchorSwingGeometry({ keeper: null }, phone, pi).radiusM).toBe(0);
    });

    it('keys the swing arc on whole metres, so it follows the Pi without churning', () => {
        const moved = shore();
        moved.position = { ...moved.position!, distance: 31 };
        expect(shoreSwingKey(moved, 'PISESSION')).not.toBe(shoreSwingKey(shore(), 'PISESSION'));
        const jitter = shore();
        jitter.position = { ...jitter.position!, distance: 18.2, timestamp: NOW + 10_000 };
        expect(shoreSwingKey(jitter, 'PISESSION')).toBe(shoreSwingKey(shore(), 'PISESSION'));
    });

    // The Vessel page subscribes to this key, not to every Pi position.
    it('keys the shore watch on what the tile shows, not on its distances', () => {
        const moved = shore();
        moved.position = { ...moved.position!, distance: 31, timestamp: NOW + 10_000 };
        expect(shoreWatchTileKey(moved, 'PISESSION')).toBe(shoreWatchTileKey(shore(), 'PISESSION'));
        expect(shoreWatchTileKey(shore({ cause: 'drag' }), 'PISESSION')).not.toBe(
            shoreWatchTileKey(shore(), 'PISESSION'),
        );
        expect(shoreWatchTileKey(shore(), null)).not.toBe(shoreWatchTileKey(shore(), 'PISESSION'));
    });
});
