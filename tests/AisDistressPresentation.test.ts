/**
 * A distress beacon on the chart (build 125, package 125-02): the IEC 62288
 * AIS-SART symbol, a red circle with a cross, never a boat or a dot, whatever
 * else the target reports; a test beacon the same shape, labelled test, not
 * red; a 97x with an unclear status the same shape in caution amber. Each
 * carries its own label with its age. Status 14 joins the danger statuses.
 *
 * Display filters must never hide a beacon (the rule 128-02's filters must
 * keep): the viewport clip keeps one wherever it is.
 *
 * Fictional MMSIs only (970/972/974 with manufacturer 00; MID 123).
 */
import { describe, expect, it } from 'vitest';
import {
    AIS_DISTRESS_CAUTION_COLOR,
    AIS_DISTRESS_COLOR,
    AIS_DISTRESS_TEST_COLOR,
} from '../components/map/aisPresentationPalette';
import {
    AIS_DANGER_COLOR,
    DANGER_NAV_STATUS,
    distressFeatureNeverHidden,
    targetPresentation,
} from '../components/map/useAisStreamLayer';
import { AIS_TARGET_ICON_IMAGE, AIS_DISTRESS_ICON } from '../components/map/aisDistressSymbol';

describe('the beacon symbol', () => {
    it('an active SART is the red circle-and-cross, upright, labelled', () => {
        const p = targetPresentation({
            mmsi: 970_000_501,
            navStatus: 14,
            sog: 1.2,
            cog: 80,
            heading: 511,
            shipType: 0,
            source: 'local',
            staleMinutes: 0,
        });
        expect(p).toEqual({
            typeColor: AIS_DISTRESS_COLOR,
            iconKind: 'sart',
            orientation: 0,
            distressLabel: 'SART ACTIVE',
        });
    });

    it('relayed over the internet it is the same red symbol (the card says it was relayed)', () => {
        const p = targetPresentation({ mmsi: 974_000_502, navStatus: 14, source: 'cloud', staleMinutes: 6 });
        expect(p).toMatchObject({
            typeColor: AIS_DISTRESS_COLOR,
            iconKind: 'sart',
            distressLabel: 'EPIRB ACTIVE · 6 min',
        });
    });

    it('a test beacon: the same shape, test green, labelled test, never red', () => {
        const p = targetPresentation({ mmsi: 970_000_503, navStatus: 15, source: 'local', staleMinutes: 0.2 });
        expect(p).toMatchObject({ typeColor: AIS_DISTRESS_TEST_COLOR, iconKind: 'sart', distressLabel: 'SART TEST' });
    });

    it('a message 14 TEST text on the feature makes it a test', () => {
        const p = targetPresentation({
            mmsi: 972_000_504,
            navStatus: 15,
            lastUpdated: 1_000,
            safetyText: 'MOB TEST',
            safetyTextAt: 2_000,
            source: 'local',
        });
        expect(p).toMatchObject({ typeColor: AIS_DISTRESS_TEST_COLOR, distressLabel: 'MOB TEST' });
    });

    it('a 97x with another status: the same shape in caution amber', () => {
        const p = targetPresentation({ mmsi: 972_000_505, navStatus: 0, sog: 0.4, source: 'local', staleMinutes: 75 });
        expect(p).toMatchObject({
            typeColor: AIS_DISTRESS_CAUTION_COLOR,
            iconKind: 'sart',
            distressLabel: 'MOB: UNCLEAR · 1 h 15 min',
        });
    });

    it('status 14 from any MMSI is a beacon, and 14 is a danger status', () => {
        expect(DANGER_NAV_STATUS.has(14)).toBe(true);
        expect(targetPresentation({ mmsi: 123_400_506, navStatus: 14, sog: 0 })).toMatchObject({
            iconKind: 'sart',
            typeColor: AIS_DISTRESS_COLOR,
        });
        // The danger colour itself is still magenta for the other hazards.
        expect(targetPresentation({ navStatus: 2, sog: 3, heading: 90 }).typeColor).toBe(AIS_DANGER_COLOR);
    });

    it('an ordinary ship keeps its boat and no beacon label', () => {
        const p = targetPresentation({ mmsi: 123_400_507, navStatus: 0, sog: 12, heading: 78, shipType: 70 });
        expect(p.iconKind).toBe('boat');
        expect(p).not.toHaveProperty('distressLabel');
    });

    it("the chart layer draws 'sart' with the beacon image", () => {
        expect(AIS_DISTRESS_ICON).toBe('ais-sart');
        expect(AIS_TARGET_ICON_IMAGE).toEqual([
            'match',
            ['coalesce', ['get', 'iconKind'], 'boat'],
            'dot',
            'ais-stopped',
            'sart',
            'ais-sart',
            'ais-boat',
        ]);
    });
});

describe('never hidden', () => {
    it('a beacon passes any display filter; an ordinary ship does not get that pass', () => {
        expect(distressFeatureNeverHidden({ mmsi: 970_000_508, navStatus: 15 })).toBe(true);
        expect(distressFeatureNeverHidden({ mmsi: 123_400_509, navStatus: 14 })).toBe(true);
        expect(distressFeatureNeverHidden({ mmsi: 123_400_510, navStatus: 0 })).toBe(false);
    });
});
