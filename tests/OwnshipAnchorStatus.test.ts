import { describe, expect, it } from 'vitest';
import { ownshipStatusLabel } from '../components/map/ownshipStatus';
import { gpsFixState, PHONE_LIVE_FIX_MAX_AGE_MS } from '../components/gpsFixState';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';
import type { PositionBroadcast, SyncState } from '../services/AnchorWatchSyncService';
import type { ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';

const now = 1_800_000_000_000;
const position = { latitude: -20.25, longitude: 148.75, speed: 0 };
const local: Pick<AnchorWatchSnapshot, 'state' | 'gpsSource'> = { state: 'idle', gpsSource: null };
const sync: Pick<SyncState, 'role' | 'sessionCode'> = { role: 'shore', sessionCode: 'current-watch' };
const broadcast: PositionBroadcast = {
    type: 'position',
    vessel: { ...position, accuracy: 5, heading: 0, timestamp: now },
    anchor: { ...position, timestamp: now },
    distance: 10,
    swingRadius: 35,
    isAlarm: false,
    timestamp: now,
};
const shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause'> = {
    sessionCode: 'current-watch',
    position: broadcast,
    stale: false,
    cause: null,
};
const noShore = { ...shore, sessionCode: null, position: null, stale: true };

describe('own-vessel anchor status is explicit, not inferred from speed', () => {
    it('labels a stationary yacht Stopped with no watch', () => {
        expect(ownshipStatusLabel(position, true, local, sync, noShore, now)).toBe('Stopped');
    });
    it('does not present unknown or invalid speed as anchored or stopped', () => {
        for (const speed of [null, NaN, -1]) {
            expect(ownshipStatusLabel({ ...position, speed }, false, local, sync, noShore, now)).toBe('SOG —');
        }
    });
    it('uses the active local watch only, not setup or paused cleanup', () => {
        for (const state of ['idle', 'setting', 'paused'] as const) {
            expect(ownshipStatusLabel(position, true, { ...local, state }, sync, noShore, now)).toBe('Stopped');
        }
        expect(ownshipStatusLabel(position, true, { ...local, state: 'watching' }, sync, noShore, now)).toBe(
            'Anchored',
        );
        expect(ownshipStatusLabel(position, true, { ...local, state: 'alarm' }, sync, noShore, now)).toBe(
            'Anchor alarm',
        );
    });
    it('does not attach a boat-receiver watch to the phone ashore', () => {
        expect(ownshipStatusLabel(position, false, { state: 'watching', gpsSource: 'nmea' }, sync, noShore, now)).toBe(
            'Stopped',
        );
    });
    it('accepts fresh matched shore-watch data for the vessel, never the phone', () => {
        expect(ownshipStatusLabel(position, true, local, sync, shore, now)).toBe('Anchored');
        expect(ownshipStatusLabel(position, false, local, sync, shore, now)).toBe('Stopped');
    });
    it('fails closed for ended, foreign-session, or unconfirmed shore watches', () => {
        for (const state of [
            { ...sync, sessionCode: null },
            { ...sync, sessionCode: 'different-watch' },
            { ...sync, role: 'vessel' as const },
        ]) {
            expect(ownshipStatusLabel(position, true, local, state, shore, now)).toBe('Stopped');
        }
        expect(ownshipStatusLabel(position, true, local, sync, { ...shore, position: null }, now)).toBe('Stopped');
    });
    it('does not borrow another vessel position or old remote data', () => {
        expect(ownshipStatusLabel({ ...position, latitude: -21 }, true, local, sync, shore, now)).toBe('Stopped');
        expect(ownshipStatusLabel(position, true, local, sync, { ...shore, stale: true }, now)).toBe('Stopped');
        expect(ownshipStatusLabel(position, true, local, sync, shore, now + 35_000)).toBe('Stopped');
    });
    it('shows a remote alarm distinctly instead of a reassuring anchored label', () => {
        expect(ownshipStatusLabel(position, true, local, sync, { ...shore, cause: 'drag' }, now)).toBe('Anchor alarm');
    });
    it('keeps numeric speed for a moving vessel without a watch', () => {
        expect(ownshipStatusLabel({ ...position, speed: 3 }, true, local, sync, noShore, now)).toBe('5.8 kts');
    });
});

// UX referee run 8 (gps-one-truth): 'Stopped' off a 46 s old fix read as
// live while MOB, Radio and Anchor Watch said NO FIX.
describe('own-vessel status is fix-age aware', () => {
    const fixAged = (ageMs: number) => gpsFixState(now - ageMs, PHONE_LIVE_FIX_MAX_AGE_MS, now);

    it("says 'Last fix 46 s' instead of 'Stopped' or a speed once the fix is not live", () => {
        expect(ownshipStatusLabel(position, false, local, sync, noShore, now, fixAged(46_000))).toBe('Last fix 46 s');
        expect(ownshipStatusLabel({ ...position, speed: 3 }, false, local, sync, noShore, now, fixAged(46_000))).toBe(
            'Last fix 46 s',
        );
        expect(
            ownshipStatusLabel({ ...position, speed: null }, false, local, sync, noShore, now, fixAged(46_000)),
        ).toBe('Last fix 46 s');
        expect(ownshipStatusLabel(position, false, local, sync, noShore, now, fixAged(7 * 60_000))).toBe(
            'Last fix 7 min',
        );
    });

    it('keeps Stopped and speed for a live fix, exactly as without a fix state', () => {
        expect(ownshipStatusLabel(position, false, local, sync, noShore, now, fixAged(5_000))).toBe('Stopped');
        expect(ownshipStatusLabel({ ...position, speed: 3 }, false, local, sync, noShore, now, fixAged(0))).toBe(
            '5.8 kts',
        );
        expect(ownshipStatusLabel(position, false, local, sync, noShore, now, fixAged(PHONE_LIVE_FIX_MAX_AGE_MS))).toBe(
            'Stopped',
        );
    });

    it('never hides an anchor alarm or the armed watch behind a fix age', () => {
        const stale = fixAged(46_000);
        expect(ownshipStatusLabel(position, true, { ...local, state: 'alarm' }, sync, noShore, now, stale)).toBe(
            'Anchor alarm',
        );
        expect(ownshipStatusLabel(position, true, { ...local, state: 'watching' }, sync, noShore, now, stale)).toBe(
            'Anchored',
        );
        expect(ownshipStatusLabel(position, true, local, sync, { ...shore, cause: 'drag' }, now, stale)).toBe(
            'Anchor alarm',
        );
    });
});
