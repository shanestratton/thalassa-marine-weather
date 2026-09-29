/**
 * The SHIPPED Newport records, unmocked. Shane (2026-09-29, Phase 0 "Fix
 * now"): Newport stays on a manual canal exit until the new inshore router
 * lands. The automatic exit profile and the RECTRC 407 track policy are
 * retired, so they never resolve again at any clock — including a phone whose
 * clock is set back into the old review window — and their lapse no longer
 * forces a manual exit anywhere else.
 */
import { describe, expect, it } from 'vitest';
import { resolveAutomaticCanalExit, VERIFIED_CANAL_EXIT_PROFILES } from '../services/automaticCanalExit';
import { createNewportChannelTrackCandidate, NEWPORT_CHANNEL_TRACK_ID } from '../services/channelTrackGuidance';
import { isCompleteRetirement } from '../services/curatedDataLifecycle';
import { NEWPORT_CANAL_EXIT_PROFILE } from '../services/newportCanalExitProfile';
import { NEWPORT_CHANNEL_TRACK_POLICY } from '../services/newportChannelTrackPolicy';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import { encCell } from './helpers/encCells';

const INSIDE_REVIEW_WINDOW = Date.parse('2026-09-13T01:00:00Z');
const berth = { lon: 153.0897666667, lat: -27.2145 };
const offshore = { lat: -27.44, lon: 153.1 };
const airlie = { lat: -20.2675, lon: 148.7156 };
const whitsundaysOffshore = { lat: -20.24, lon: 148.78 };

describe('retired Newport automatic exit', () => {
    it('carries a complete retirement on the record', () => {
        expect(isCompleteRetirement(NEWPORT_CANAL_EXIT_PROFILE.retirement)).toBe(true);
        expect(isCompleteRetirement(NEWPORT_CHANNEL_TRACK_POLICY.retirement)).toBe(true);
    });

    it.each([
        ['the real clock', undefined],
        ['a clock set back inside the old review window', INSIDE_REVIEW_WINDOW],
    ])('a Newport departure needs a manual canal exit on %s, and is told why', (_clock, now) => {
        expect(resolveAutomaticCanalExit(berth, offshore, VERIFIED_CANAL_EXIT_PROFILES, now)).toEqual({
            status: 'manual-required',
            reason: 'The automatic Newport Waterways canal exit is retired. Choose Canal exit on the chart.',
            code: 'retired',
            profileLabel: 'Newport Waterways',
        });
    });

    it('does not make a departure anywhere else "out of date" (real clock)', () => {
        expect(resolveAutomaticCanalExit(airlie, whitsundaysOffshore, VERIFIED_CANAL_EXIT_PROFILES)).toEqual({
            status: 'manual-required',
            reason: 'No reviewed channel exit covers this departure. Choose Canal Exit on the chart.',
        });
    });
});

describe('retired Newport RECTRC 407 track policy', () => {
    const metadata = (): EncCell => ({
        id: 'OC-61-10RCS5',
        edition: 1,
        issued: '2022-03-07',
        sourceHO: 'OC',
        usage: 'navigation',
        importedAt: '2026-09-12T00:00:00Z',
        geojsonPath: 'enc/OC-61-10RCS5.json',
        bbox: [153.083335, -27.221665, 153.111665, -27.166665],
        hazardCount: 100,
    });
    const chart = () =>
        ({ ...structuredClone(encCell('OC-61-10RCS5')), ...metadata(), cellId: 'OC-61-10RCS5' }) as EncConversionResult;

    it('yields no guidance candidate, even with the clock set back into the review window', () => {
        expect(
            createNewportChannelTrackCandidate({
                metadata: metadata(),
                chart: chart(),
                policy: NEWPORT_CHANNEL_TRACK_POLICY,
                now: INSIDE_REVIEW_WINDOW,
            }),
        ).toBeNull();
    });

    it('a fresh policy cannot ride on the retired parent canal review', () => {
        const { retirement: _retired, ...unretired } = NEWPORT_CHANNEL_TRACK_POLICY;
        expect(unretired.id).toBe(NEWPORT_CHANNEL_TRACK_ID);
        expect(
            createNewportChannelTrackCandidate({
                metadata: metadata(),
                chart: chart(),
                policy: { ...unretired, sourceRevision: 'test-only-fresh-policy', reviewedAt: '2026-09-13T00:00:00Z' },
                now: INSIDE_REVIEW_WINDOW,
            }),
        ).toBeNull();
    });
});
