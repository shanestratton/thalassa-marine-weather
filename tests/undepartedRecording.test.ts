import { describe, expect, it } from 'vitest';
import type { ShipLogEntry } from '../types';
import { isUndepartedRecording } from '../services/shiplog/undepartedRecording';

const START = Date.parse('2026-09-23T00:00:00Z');
const VOYAGE = `voyage_${START}_abc123xyz`;
const OWNER = 'owner-a';
const timestamp = (seconds: number) => new Date(START + seconds * 1000).toISOString();

function stationaryRecording(): ShipLogEntry[] {
    return Array.from({ length: 7 }, (_, index) => ({
        id: `entry-${index}`,
        userId: OWNER,
        voyageId: VOYAGE,
        timestamp: timestamp(index * 10),
        latitude: -20 + (index % 2 ? 3 : -3) / 111195,
        longitude: 148,
        positionFormatted: '',
        distanceNM: 0.001,
        cumulativeDistanceNM: 0,
        speedKts: 0.4,
        source: 'device',
        entryType: index === 0 || index >= 5 ? 'waypoint' : 'auto',
        waypointName:
            index === 0 ? 'Voyage Start' : index === 6 ? 'Voyage End' : index === 5 ? 'Latest Position' : undefined,
    }));
}

function qualifies(entries: readonly ShipLogEntry[]) {
    return isUndepartedRecording(entries, VOYAGE, OWNER);
}

function acquiringStart(): ShipLogEntry {
    return {
        ...stationaryRecording()[0],
        latitude: 0,
        longitude: 0,
        positionFormatted: 'Acquiring position...',
        speedKts: 0,
        distanceNM: 0,
        cumulativeDistanceNM: 0,
    };
}

describe('conservative undeparted recording classification', () => {
    it('recognises seven stationary generated records without mutating them', () => {
        const entries = stationaryRecording().reverse();
        const before = structuredClone(entries);
        expect(qualifies(entries)).toBe(true);
        expect(entries).toEqual(before);
    });

    it('accepts the two-fix minimum and local automatic entries without a source field', () => {
        const entries = stationaryRecording();
        const minimum = [entries[0], { ...entries[1], source: undefined }, entries[5], entries[6]];
        expect(qualifies(minimum)).toBe(true);
    });

    it('accepts the exact local-only cold-GPS Start placeholder with prompt stationary measurements', () => {
        // captureImmediate waits 30s, then queues this marker without GPS.
        // Its background GPS retry is online-only. Later measured fixes are
        // valid evidence, but the placeholder must never enter the footprint.
        const entries = [acquiringStart(), ...stationaryRecording().slice(1)].map((entry, index) => ({
            ...entry,
            timestamp: timestamp(index === 0 ? 0 : 30 + index * 10),
        }));
        const before = structuredClone(entries);
        expect(qualifies(entries)).toBe(true);
        expect(entries).toEqual(before);
    });

    it.each([
        ['unknown source', { source: undefined }],
        ['other placeholder text', { positionFormatted: '' }],
        ['nonzero speed', { speedKts: 0.1 }],
        ['nonzero distance', { distanceNM: 0.001 }],
        ['nonzero accumulated distance', { cumulativeDistanceNM: 0.001 }],
        ['direction assertion', { courseDeg: 90 }],
        ['water assertion', { isOnWater: true }],
        ['a note', { notes: 'Waiting for crew' }],
        ['an event', { eventCategory: 'departure' }],
        ['a saved route', { savedRouteId: 'route-a' }],
        ['another owner', { userId: 'owner-b' }],
    ] as Array<[string, Partial<ShipLogEntry>]>)('does not excuse a zero-GPS Start with %s', (_reason, change) => {
        expect(qualifies([{ ...acquiringStart(), ...change }, ...stationaryRecording().slice(1)])).toBe(false);
    });

    it('never treats an invalid raw fix or Voyage End as a harmless startup placeholder', () => {
        for (const index of [2, 6]) {
            const entries = stationaryRecording();
            entries[index] = {
                ...acquiringStart(),
                id: entries[index].id,
                timestamp: entries[index].timestamp,
                entryType: entries[index].entryType,
                waypointName: entries[index].waypointName,
            };
            expect(qualifies(entries)).toBe(false);
        }
    });

    it('preserves movement evidence after a no-fix Start', () => {
        const entries = [acquiringStart(), ...stationaryRecording().slice(1)];
        for (const change of [
            { speedKts: 0.8 },
            { distanceNM: 0.02 },
            { cumulativeDistanceNM: 0.02 },
            { latitude: -20 + 50 / 111195 },
        ]) {
            expect(qualifies(entries.map((entry, index) => (index === 3 ? { ...entry, ...change } : entry)))).toBe(
                false,
            );
        }
    });

    it('accepts a selected startup fix timestamped before the asynchronously launched Start marker', () => {
        const entries = stationaryRecording();
        entries[0].timestamp = timestamp(15);
        expect(qualifies(entries)).toBe(true);
    });

    it('retains startup uncertainty outside the first minute or before the voyage was created', () => {
        const lateFixes = [acquiringStart(), ...stationaryRecording().slice(1)].map((entry, index) => ({
            ...entry,
            timestamp: timestamp(index === 0 ? 0 : 60 + index * 10),
        }));
        expect(qualifies(lateFixes)).toBe(false);

        const lateStart = stationaryRecording();
        lateStart[0].timestamp = timestamp(61);
        lateStart[6].timestamp = timestamp(70);
        expect(qualifies(lateStart)).toBe(false);

        const preVoyage = stationaryRecording();
        preVoyage[0] = acquiringStart();
        preVoyage[1].timestamp = timestamp(-1);
        expect(qualifies(preVoyage)).toBe(false);
    });

    it('requires both a tiny footprint and negligible unrounded cumulative distance', () => {
        const wide = stationaryRecording();
        wide[3].latitude += 50 / 111195;
        expect(qualifies(wide)).toBe(false); // zero distance cannot disguise movement

        const distance = stationaryRecording();
        distance[3].cumulativeDistanceNM = 0.02; // still displays as 0.0 NM
        expect(qualifies(distance)).toBe(false); // small footprint cannot erase a real total

        const boundary = stationaryRecording();
        boundary[6].cumulativeDistanceNM = 0.01;
        expect(qualifies(boundary)).toBe(true);
    });

    it.each([
        ['manual note', { entryType: 'manual' }],
        ['custom waypoint', { entryType: 'waypoint', waypointName: 'Checked mooring' }],
        ['named automatic row', { waypointName: 'Fishing mark' }],
        ['written note', { notes: 'Checked the bilge' }],
        ['recorded event', { eventCategory: 'equipment' }],
        ['linked passage', { linkedPlanId: 'passage-a' }],
        ['saved route', { savedRouteId: 'route-a' }],
        ['imported GPX', { source: 'gpx_import' }],
        ['community track', { source: 'community_download' }],
        ['planned route', { source: 'planned_route' }],
    ] as Array<[string, Partial<ShipLogEntry>]>)('preserves %s', (_reason, change) => {
        const entries = stationaryRecording();
        entries[3] = { ...entries[3], ...change };
        expect(qualifies(entries)).toBe(false);
    });

    it.each([
        ['missing speed', { speedKts: undefined }],
        ['invalid speed', { speedKts: NaN }],
        ['negative speed', { speedKts: -0.1 }],
        ['departure speed', { speedKts: 0.8 }],
        ['moving fix', { speedKts: 4 }],
        ['unknown leg distance', { distanceNM: undefined }],
        ['invalid leg distance', { distanceNM: Infinity }],
        ['negative leg distance', { distanceNM: -1 }],
        ['moving leg despite zero cumulative distance', { distanceNM: 0.5 }],
        ['unknown cumulative distance', { cumulativeDistanceNM: undefined }],
        ['invalid cumulative distance', { cumulativeDistanceNM: NaN }],
        ['negative cumulative distance', { cumulativeDistanceNM: -1 }],
        ['invalid latitude', { latitude: 91 }],
        ['invalid longitude', { longitude: 181 }],
        ['unknown position', { latitude: 0, longitude: 0 }],
        ['invalid time', { timestamp: 'invalid' }],
        ['missing entry id', { id: '' }],
        ['another owner', { userId: 'owner-b' }],
        ['another voyage', { voyageId: 'voyage_1780000000000_other' }],
    ] as Array<[string, Partial<ShipLogEntry>]>)('retains uncertain evidence: %s', (_reason, change) => {
        const entries = stationaryRecording();
        entries[3] = { ...entries[3], ...change };
        expect(qualifies(entries)).toBe(false);
    });

    it.each(['default_voyage', 'planned_1780000000000_abc', '349e15f5-e1fd-435f-8cdf-282dc0d57f2b', 'voyage_named'])(
        'excludes non-casual voyage id %s',
        (voyageId) => {
            const entries = stationaryRecording().map((entry) => ({ ...entry, voyageId }));
            expect(isUndepartedRecording(entries, voyageId, OWNER)).toBe(false);
        },
    );

    it('cannot infer non-departure from lifecycle pins or a partial stationary tail', () => {
        const entries = stationaryRecording();
        expect(qualifies([])).toBe(false);
        expect(qualifies([entries[0], entries[6]])).toBe(false);
        expect(qualifies([entries[0], entries[1], entries[6]])).toBe(false);
        expect(qualifies(entries.slice(2))).toBe(false);
        expect(qualifies(entries.slice(0, -1))).toBe(false);
    });

    it('requires exactly one start and end with no pre-voyage or post-end fixes', () => {
        const entries = stationaryRecording();
        expect(qualifies([...entries, { ...entries[0], id: 'second-start', timestamp: timestamp(-1) }])).toBe(false);
        expect(qualifies([...entries, { ...entries[6], id: 'second-end', timestamp: timestamp(61) }])).toBe(false);
        expect(
            qualifies(entries.map((entry, index) => (index === 1 ? { ...entry, timestamp: timestamp(-1) } : entry))),
        ).toBe(false);
        expect(
            qualifies(entries.map((entry, index) => (index === 1 ? { ...entry, timestamp: timestamp(61) } : entry))),
        ).toBe(false);
    });

    it('does not count duplicate ids or timestamps as independent stationary samples', () => {
        const entries = stationaryRecording();
        expect(qualifies([entries[0], entries[1], entries[1], entries[6]])).toBe(false);
        expect(qualifies([entries[0], entries[1], { ...entries[1], id: 'duplicate-time' }, entries[6]])).toBe(false);
        expect(qualifies([entries[0], entries[1], { ...entries[1], timestamp: timestamp(20) }, entries[6]])).toBe(
            false,
        );
    });

    it('retains recordings with a gap long enough to conceal a departure', () => {
        const entries = stationaryRecording().map((entry, index) => ({
            ...entry,
            timestamp: timestamp(index * 10 + (index >= 3 ? 1200 : 0)),
        }));
        expect(qualifies(entries)).toBe(false);
    });

    it('does not mistake a wrapped geographic bounding box for a tiny footprint', () => {
        const entries = stationaryRecording().map((entry, index) => ({
            ...entry,
            longitude: index === 3 ? 0 : index % 2 ? -179.99999 : 179.99999,
        }));
        expect(qualifies(entries)).toBe(false);
    });
});
