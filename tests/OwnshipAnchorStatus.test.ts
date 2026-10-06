import { describe, expect, it } from 'vitest';
import {
    OWNSHIP_STOPPED_BELOW_KTS,
    ownshipStatus,
    ownshipStatusLabel,
    type OwnshipAnchorSources,
    type OwnshipMarkerIdentity,
} from '../components/map/ownshipStatus';
import { gpsFixState, PHONE_LIVE_FIX_MAX_AGE_MS } from '../components/gpsFixState';
import type { PositionBroadcast } from '../services/AnchorWatchSyncService';

const now = 1_800_000_000_000;
const position = { latitude: -20.25, longitude: 148.75, speed: 0 };
const broadcast: PositionBroadcast = {
    type: 'position',
    vessel: { ...position, accuracy: 5, heading: 0, timestamp: now },
    anchor: { ...position, timestamp: now },
    distance: 10,
    swingRadius: 35,
    isAlarm: false,
    timestamp: now,
};

const IDLE_LOCAL: OwnshipAnchorSources['local'] = {
    state: 'idle',
    gpsSource: null,
    distanceFromAnchor: 0,
    swingRadius: 0,
    alarmTriggeredAt: null,
    alarmCause: null,
    vesselPosition: null,
};
const NO_SHORE: OwnshipAnchorSources['shore'] = {
    sessionCode: null,
    position: null,
    stale: true,
    cause: null,
    lastContactAt: null,
};
const OTHER_SHORE: OwnshipAnchorSources['shore'] = {
    sessionCode: 'current-watch',
    position: broadcast,
    stale: false,
    cause: null,
    lastContactAt: now,
};

/** The own boat on her bus, the boat crewed on by her cloud row, a phone-only punter's phone. */
const OWN_BUS: OwnshipMarkerIdentity = { owner: 'own', lane: 'bus' };
const OWN_CLOUD: OwnshipMarkerIdentity = { owner: 'own', lane: 'cloud' };
const CREW_CLOUD: OwnshipMarkerIdentity = { owner: 'crew', lane: 'cloud' };
const PHONE: OwnshipMarkerIdentity = { owner: 'phone', lane: 'phone' };

const sources = (overrides: Partial<OwnshipAnchorSources> = {}): OwnshipAnchorSources => ({
    local: IDLE_LOCAL,
    shore: NO_SHORE,
    piSessionCode: null,
    ...overrides,
});
const watching = (overrides: Partial<OwnshipAnchorSources['local']> = {}): OwnshipAnchorSources['local'] => ({
    ...IDLE_LOCAL,
    state: 'watching',
    gpsSource: 'native',
    distanceFromAnchor: 10,
    swingRadius: 35,
    vesselPosition: { latitude: position.latitude, longitude: position.longitude },
    ...overrides,
});

describe('own-vessel anchor status is explicit, not inferred from speed', () => {
    it('labels a stationary yacht Stopped with no watch', () => {
        expect(ownshipStatusLabel(position, OWN_BUS, sources(), now)).toBe('Stopped');
    });
    it('does not present unknown or invalid speed as anchored or stopped', () => {
        for (const speed of [null, NaN, -1]) {
            expect(ownshipStatusLabel({ ...position, speed }, PHONE, sources(), now)).toBe('SOG —');
        }
    });
    it('says Stopped below half a knot, the berth noise floor, and the speed from there', () => {
        const ms = (kts: number) => kts / 1.94384;
        expect(OWNSHIP_STOPPED_BELOW_KTS).toBe(0.5);
        expect(ownshipStatusLabel({ ...position, speed: ms(0.4) }, OWN_CLOUD, sources(), now)).toBe('Stopped');
        expect(ownshipStatusLabel({ ...position, speed: ms(0.49) }, OWN_CLOUD, sources(), now)).toBe('Stopped');
        expect(ownshipStatusLabel({ ...position, speed: ms(0.6) }, OWN_CLOUD, sources(), now)).toBe('0.6 kts');
        expect(ownshipStatusLabel({ ...position, speed: ms(6.2) }, OWN_CLOUD, sources(), now)).toBe('6.2 kts');
    });
    it('uses the watch only while it is on, not while it is being set; a paused watch reads Anchored', () => {
        for (const state of ['idle', 'setting'] as const) {
            expect(ownshipStatusLabel(position, OWN_BUS, sources({ local: watching({ state }) }), now)).toBe('Stopped');
        }
        // Shane 2026-10-07 ("Yes to amber"): the anchor is down but nothing is
        // watching it, so the badge says Anchored in amber, as the row does.
        expect(ownshipStatusLabel(position, OWN_BUS, sources({ local: watching({ state: 'paused' }) }), now)).toBe(
            'Anchored',
        );
        expect(ownshipStatusLabel(position, OWN_BUS, sources({ local: watching() }), now)).toBe('Anchored');
        expect(ownshipStatusLabel(position, OWN_BUS, sources({ local: watching({ state: 'alarm' }) }), now)).toBe(
            'Anchor alarm',
        );
    });
    it("reads 'Drifting' outside the swing circle, never a calm 'Anchored' (the row says Drifting too)", () => {
        expect(
            ownshipStatusLabel(position, OWN_BUS, sources({ local: watching({ distanceFromAnchor: 50 }) }), now),
        ).toBe('Drifting');
    });
    it('does not attach a boat-receiver watch to the phone ashore', () => {
        expect(ownshipStatusLabel(position, PHONE, sources({ local: watching({ gpsSource: 'nmea' }) }), now)).toBe(
            'Stopped',
        );
    });
    it("a phone-only punter's own watch is her own ship's", () => {
        expect(ownshipStatusLabel(position, PHONE, sources({ local: watching() }), now)).toBe('Anchored');
    });
    it("the phone's watch on her bus is hers wherever the watch thinks the phone is", () => {
        const local = watching({ gpsSource: 'nmea', vesselPosition: null });
        expect(ownshipStatusLabel(position, OWN_BUS, sources({ local }), now)).toBe('Anchored');
    });
    it('a watch the phone runs on its own GPS far from her is not hers', () => {
        const local = watching({ vesselPosition: { latitude: -27.2, longitude: 153.1 } });
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ local }), now)).toBe('Stopped');
        expect(ownshipStatusLabel(position, CREW_CLOUD, sources({ local }), now)).toBe('Stopped');
    });
});

describe('a watch kept elsewhere: the one anchor-watch truth (presentAnchorWatchRow)', () => {
    it('the Pi this phone handed the watch to keeps it for the own boat', () => {
        const shore = { ...OTHER_SHORE, sessionCode: 'pi-watch' };
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ shore, piSessionCode: 'pi-watch' }), now)).toBe(
            'Anchored',
        );
        // No Shore Watch on this phone yet: the anchor is still down.
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ piSessionCode: 'pi-watch' }), now)).toBe('Anchored');
        // Stale reports are still her watch: the row says 'waiting', the anchor is down.
        expect(
            ownshipStatusLabel(
                position,
                OWN_CLOUD,
                sources({ shore: { ...shore, stale: true }, piSessionCode: 'pi-watch' }),
                now,
            ),
        ).toBe('Anchored');
    });
    it("the Pi's drag is an alarm on her, and never the phone-only marker's", () => {
        const shore = { ...OTHER_SHORE, sessionCode: 'pi-watch', cause: 'drag' as const };
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ shore, piSessionCode: 'pi-watch' }), now)).toBe(
            'Anchor alarm',
        );
        expect(ownshipStatusLabel(position, PHONE, sources({ shore, piSessionCode: 'pi-watch' }), now)).toBe('Stopped');
    });
    it("a Pi report somewhere else entirely is another boat's watch", () => {
        const far = { ...broadcast, vessel: { ...broadcast.vessel, latitude: -19.1, longitude: 147.6 } };
        const shore = { ...OTHER_SHORE, sessionCode: 'pi-watch', position: far };
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ shore, piSessionCode: 'pi-watch' }), now)).toBe(
            'Stopped',
        );
    });
    it("accepts another device's fresh report within 50 m of her fix, for the boat, never the phone", () => {
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: OTHER_SHORE }), now)).toBe('Anchored');
        expect(ownshipStatusLabel(position, CREW_CLOUD, sources({ shore: OTHER_SHORE }), now)).toBe('Anchored');
        expect(ownshipStatusLabel(position, PHONE, sources({ shore: OTHER_SHORE }), now)).toBe('Stopped');
    });
    it('fails closed for ended or unconfirmed sessions from another device', () => {
        expect(
            ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: { ...OTHER_SHORE, sessionCode: null } }), now),
        ).toBe('Stopped');
        expect(
            ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: { ...OTHER_SHORE, position: null } }), now),
        ).toBe('Stopped');
    });
    it("does not borrow another vessel's position or old remote data", () => {
        expect(
            ownshipStatusLabel({ ...position, latitude: -21 }, OWN_CLOUD, sources({ shore: OTHER_SHORE }), now),
        ).toBe('Stopped');
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: { ...OTHER_SHORE, stale: true } }), now)).toBe(
            'Stopped',
        );
        expect(ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: OTHER_SHORE }), now + 35_000)).toBe('Stopped');
    });
    it("shows another device's alarm distinctly instead of a reassuring anchored label", () => {
        expect(
            ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: { ...OTHER_SHORE, cause: 'drag' } }), now),
        ).toBe('Anchor alarm');
    });
    it('keeps numeric speed for a moving vessel without a watch', () => {
        expect(ownshipStatusLabel({ ...position, speed: 3 }, OWN_BUS, sources(), now)).toBe('5.8 kts');
    });
});

// UX referee run 8 (gps-one-truth): 'Stopped' off a 46 s old fix read as
// live while MOB, Radio and Anchor Watch said NO FIX.
describe('own-vessel status is fix-age aware', () => {
    const fixAged = (ageMs: number) => gpsFixState(now - ageMs, PHONE_LIVE_FIX_MAX_AGE_MS, now);

    it("says 'Last fix 46 s' instead of 'Stopped' or a speed once the fix is not live", () => {
        expect(ownshipStatusLabel(position, PHONE, sources(), now, fixAged(46_000))).toBe('Last fix 46 s');
        expect(ownshipStatusLabel({ ...position, speed: 3 }, PHONE, sources(), now, fixAged(46_000))).toBe(
            'Last fix 46 s',
        );
        expect(ownshipStatusLabel({ ...position, speed: null }, PHONE, sources(), now, fixAged(46_000))).toBe(
            'Last fix 46 s',
        );
        expect(ownshipStatusLabel(position, PHONE, sources(), now, fixAged(7 * 60_000))).toBe('Last fix 7 min');
    });

    it("a held fix is history: 'Last fix 3 h', never a live-looking 'Stopped'", () => {
        const held = gpsFixState(now - 3 * 3_600_000, -1, now);
        expect(ownshipStatusLabel(position, { owner: 'own', lane: 'held' }, sources(), now, held)).toBe('Last fix 3 h');
    });

    it('keeps Stopped and speed for a live fix, exactly as without a fix state', () => {
        expect(ownshipStatusLabel(position, PHONE, sources(), now, fixAged(5_000))).toBe('Stopped');
        expect(ownshipStatusLabel({ ...position, speed: 3 }, PHONE, sources(), now, fixAged(0))).toBe('5.8 kts');
        expect(ownshipStatusLabel(position, PHONE, sources(), now, fixAged(PHONE_LIVE_FIX_MAX_AGE_MS))).toBe('Stopped');
    });

    it('never hides an anchor alarm or the armed watch behind a fix age', () => {
        const stale = fixAged(46_000);
        expect(
            ownshipStatusLabel(position, OWN_BUS, sources({ local: watching({ state: 'alarm' }) }), now, stale),
        ).toBe('Anchor alarm');
        expect(ownshipStatusLabel(position, OWN_BUS, sources({ local: watching() }), now, stale)).toBe('Anchored');
        expect(
            ownshipStatusLabel(position, OWN_CLOUD, sources({ shore: { ...OTHER_SHORE, cause: 'drag' } }), now, stale),
        ).toBe('Anchor alarm');
    });
});

// The one anchor-watch truth, in its own colour. Every active row condition but
// alarm, drifting, setting and idle reads 'Anchored' (paused too, in amber); only a watch that
// is holding may wear the calm green, or a watch that has lost its data reads
// green on the chart while System status shows it red (review, 2026-10-07).
describe("the badge's anchor colour is the anchor watch row's own", () => {
    const pi = (shore: Partial<OwnshipAnchorSources['shore']>, piSessionCode: string | null = 'pi-watch') =>
        sources({ shore: { ...OTHER_SHORE, sessionCode: 'pi-watch', ...shore }, piSessionCode });

    it('holding: green', () => {
        expect(ownshipStatus(position, OWN_CLOUD, pi({}), now)).toEqual({
            label: 'Anchored',
            anchorTone: 'green',
            anchorNote: null,
        });
        expect(ownshipStatus(position, OWN_BUS, sources({ local: watching() }), now).anchorTone).toBe('green');
    });

    it('no current data (contact or GPS lost): red, and says so', () => {
        for (const cause of ['contact-lost', 'gps-lost'] as const) {
            expect(ownshipStatus(position, OWN_CLOUD, pi({ cause }), now)).toEqual({
                label: 'Anchored',
                anchorTone: 'red',
                anchorNote: 'anchor watch has no current data',
            });
        }
    });

    it('paused (anchor down, nothing watching): amber, and says so (Shane 2026-10-07)', () => {
        expect(ownshipStatus(position, OWN_BUS, sources({ local: watching({ state: 'paused' }) }), now)).toEqual({
            label: 'Anchored',
            anchorTone: 'amber',
            anchorNote: 'anchor watch paused, not watching',
        });
    });

    it('authorisation expiring: amber', () => {
        expect(ownshipStatus(position, OWN_CLOUD, pi({ cause: 'session-expiring' }), now)).toEqual({
            label: 'Anchored',
            anchorTone: 'amber',
            anchorNote: 'anchor watch authorisation expiring',
        });
    });

    it('waiting for data: amber', () => {
        expect(ownshipStatus(position, OWN_CLOUD, pi({ position: null, lastContactAt: null }), now)).toEqual({
            label: 'Anchored',
            anchorTone: 'amber',
            anchorNote: 'anchor watch waiting for data',
        });
    });

    it('the Pi keeping a watch this phone has no updates from: amber', () => {
        expect(ownshipStatus(position, OWN_CLOUD, sources({ piSessionCode: 'pi-watch' }), now)).toEqual({
            label: 'Anchored',
            anchorTone: 'amber',
            anchorNote: 'no anchor watch updates on this phone',
        });
    });

    it('alarm and drifting: red', () => {
        expect(ownshipStatus(position, OWN_CLOUD, pi({ cause: 'drag' }), now).anchorTone).toBe('red');
        expect(ownshipStatus(position, OWN_BUS, sources({ local: watching({ distanceFromAnchor: 50 }) }), now)).toEqual(
            { label: 'Drifting', anchorTone: 'red', anchorNote: null },
        );
    });

    it('no watch on this boat: no anchor colour at all', () => {
        expect(ownshipStatus(position, OWN_BUS, sources(), now)).toEqual({
            label: 'Stopped',
            anchorTone: null,
            anchorNote: null,
        });
    });
});
