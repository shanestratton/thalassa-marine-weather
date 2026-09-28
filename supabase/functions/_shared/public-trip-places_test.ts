import {
    createPublicTimeZoneAt,
    derivePublicTripPlaces,
    derivePublicTripPlacesFromReads,
    distanceNm,
    inPublicPlaceBatches,
    publicDiaryPlaceName,
    type PublicPlaceDiaryEntry,
    publicPlaceMarksFromRows,
    publicPlaceSearchBoxes,
    type PublicPlaceWaypoint,
    publicTrackworthyFix,
    type PublicTripPlaces,
    type PublicTripPlaceTrip,
    publicTripStartMayBeClipped,
    recoveredWaypointPlace,
} from './public-trip-places.ts';

function equal(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function ok(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

/** A point `nm` nautical miles due north of (lat, lon). */
function north(lat: number, lon: number, nm: number): { lat: number; lon: number } {
    return { lat: lat + nm / 60, lon };
}

const brisbane = () => 'Australia/Brisbane';

const HOME = { lat: -20.3477, lon: 148.9515 };
const AWAY = { lat: -20.2701, lon: 148.7232 };

function trip(id: string, first: typeof HOME | null, last: typeof HOME | null, active = false): PublicTripPlaceTrip {
    return { id, active, first_fix: first, last_fix: last };
}

function mark(
    voyageId: string,
    name: string,
    at: { lat: number; lon: number },
    timestamp?: string,
): PublicPlaceWaypoint {
    return { voyage_id: voyageId, name, lat: at.lat, lon: at.lon, timestamp };
}

function diary(name: string, at: { lat: number; lon: number }, isPublic: unknown = true): PublicPlaceDiaryEntry {
    return { location_name: name, lat: at.lat, lon: at.lon, is_public: isPublic };
}

Deno.test('the trip’s own recovered departure and arrival win over nearer neighbours and diary names', () => {
    const places = derivePublicTripPlaces(
        [trip('a', HOME, AWAY), trip('b', AWAY, HOME)],
        [
            // Own marks, a little way off the endpoints.
            mark('a', 'Hamilton Island · recovered departure', north(HOME.lat, HOME.lon, 0.2)),
            mark('a', 'Airlie Beach · recovered arrival', north(AWAY.lat, AWAY.lon, 0.2)),
            // An authorised neighbour sits exactly on both endpoints.
            mark('b', 'Somewhere Else · recovered arrival', HOME),
            mark('b', 'Another Place · recovered departure', AWAY),
        ],
        [diary('Closer Diary, Queensland', HOME), diary('Also Closer, Queensland', AWAY)],
        brisbane,
    );
    equal(places.get('a'), { from_name: 'Hamilton Island', to_name: 'Airlie Beach', time_zone: 'Australia/Brisbane' });
});

Deno.test('an own recovered mark names its end even when the endpoint fix is unknown', () => {
    const places = derivePublicTripPlaces(
        [trip('a', null, null)],
        [
            mark('a', 'Tongue Bay · recovered departure', HOME),
            mark('a', 'Butterfly Bay · recovered arrival', AWAY),
        ],
        [],
        brisbane,
    );
    // No first fix: no zone either, rather than a zone from somewhere else.
    equal(places.get('a'), { from_name: 'Tongue Bay', to_name: 'Butterfly Bay', time_zone: null });
});

Deno.test('an authorised neighbour’s recovered mark within 0.25 nm names the end, nearest first', () => {
    const places = derivePublicTripPlaces(
        [trip('yesterday', AWAY, HOME), trip('today', HOME, AWAY)],
        [
            mark('today', 'Hamilton Island · recovered departure', north(HOME.lat, HOME.lon, 0.09)),
            mark('today', 'Farther Mark · recovered departure', north(HOME.lat, HOME.lon, 0.2)),
        ],
        // A diary name closer than either mark does not outrank rule 2.
        [diary('Diary Name, Queensland', north(HOME.lat, HOME.lon, 0.01))],
    );
    equal(places.get('yesterday')?.to_name, 'Hamilton Island');
    equal(places.get('yesterday')?.from_name, null);
});

Deno.test('diary fallback strips ", Queensland", drops bare Queensland/Australia, and takes the nearest', () => {
    const start = { lat: -21.112085, lon: 149.226772 };
    const end = { lat: -20.23896, lon: 149.017925 };
    const places = derivePublicTripPlaces(
        [trip('mackay-tongue', start, end)],
        [mark('mackay-tongue', 'Voyage Start', start), mark('mackay-tongue', 'Voyage End', end)],
        [
            // Nearer, but region-only: skipped.
            diary('Queensland', north(start.lat, start.lon, 0.05)),
            diary('Australia', north(start.lat, start.lon, 0.06)),
            diary('Mackay Harbour, Queensland', north(start.lat, start.lon, 0.19)),
            diary('Queensland, Australia', north(end.lat, end.lon, 0.01)),
            diary('Anchored in 6m of water — Tongue Bay, Queensland', north(end.lat, end.lon, 0.1)),
        ],
    );
    equal(places.get('mackay-tongue'), { from_name: 'Mackay Harbour', to_name: 'Tongue Bay', time_zone: null });

    equal(publicDiaryPlaceName('Airlie Beach, Queensland'), 'Airlie Beach');
    equal(publicDiaryPlaceName('  Callemondah,   Queensland '), 'Callemondah');
    equal(publicDiaryPlaceName('Hamilton Island, Queensland, Australia'), 'Hamilton Island');
    equal(publicDiaryPlaceName('Whitsundays, Queensland'), 'Whitsundays');
    equal(publicDiaryPlaceName('Queensland'), null);
    equal(publicDiaryPlaceName('queensland'), null);
    equal(publicDiaryPlaceName('Australia'), null);
    equal(publicDiaryPlaceName('Anchored in 5m of water'), null);
    equal(publicDiaryPlaceName('20.2701°S, 148.7232°E'), null);
    equal(publicDiaryPlaceName(''), null);
    equal(publicDiaryPlaceName(null), null);
});

Deno.test('nothing beyond 0.25 nm names an end', () => {
    const places = derivePublicTripPlaces(
        [trip('a', HOME, AWAY), trip('b', AWAY, AWAY)],
        [mark('b', 'Too Far Mark · recovered departure', north(HOME.lat, HOME.lon, 0.26))],
        [diary('Too Far Diary, Queensland', north(AWAY.lat, AWAY.lon, 0.3))],
    );
    equal(places.get('a')?.from_name, null);
    equal(places.get('a')?.to_name, null);

    const inside = derivePublicTripPlaces(
        [trip('a', HOME, AWAY), trip('b', AWAY, AWAY)],
        [mark('b', 'Just Inside · recovered departure', north(HOME.lat, HOME.lon, 0.24))],
        [],
    );
    equal(inside.get('a')?.from_name, 'Just Inside');
    ok(Math.abs(distanceNm(HOME, north(HOME.lat, HOME.lon, 0.25)) - 0.25) < 0.001, 'distance is in nautical miles');
});

Deno.test('a hidden or unauthorised trip’s waypoint, and an unpublished diary entry, are never used', () => {
    const places = derivePublicTripPlaces(
        [trip('public', HOME, AWAY)],
        [
            // Exactly on the endpoints, but its voyage is not in the authorised catalogue.
            mark('hidden-voyage', 'Secret Anchorage · recovered departure', HOME),
            mark('hidden-voyage', 'Secret Anchorage · recovered arrival', AWAY),
            mark('planned_route_1', 'Planned Place · recovered arrival', AWAY),
            { voyage_id: null, name: 'Orphan · recovered departure', lat: HOME.lat, lon: HOME.lon },
        ],
        [
            diary('Private Diary, Queensland', HOME, false),
            // Visibility unknown is not published.
            { location_name: 'Unknown Visibility, Queensland', lat: AWAY.lat, lon: AWAY.lon, is_public: null },
            diary('String Truthy, Queensland', AWAY, 'true'),
        ],
    );
    equal(places.get('public'), { from_name: null, to_name: null, time_zone: null });
});

Deno.test('nulls when nothing qualifies: system pins and prose are not places', () => {
    const newport = { lat: -27.203983, lon: 153.092973 };
    const places = derivePublicTripPlaces(
        [trip('recovered', newport, AWAY)],
        [
            mark('recovered', 'Recovered GPS track · Newport to Gladstone', newport),
            mark('recovered', 'Voyage Start', newport),
            mark('recovered', 'App recording began · original mark', newport),
            mark('recovered', 'Voyage End', AWAY),
            mark('recovered', 'Latest Position', AWAY),
        ],
        [],
    );
    equal(places.get('recovered'), { from_name: null, to_name: null, time_zone: null });
    equal(derivePublicTripPlaces([], [], []).size, 0);

    equal(recoveredWaypointPlace('Hamilton Island · recovered departure'), {
        place: 'Hamilton Island',
        role: 'departure',
    });
    equal(recoveredWaypointPlace('Daydream Island · Recovered Arrival'), { place: 'Daydream Island', role: 'arrival' });
    equal(recoveredWaypointPlace('Recovered GPS track · Newport to Gladstone'), null);
    equal(recoveredWaypointPlace('A · B · recovered departure'), null);
    equal(recoveredWaypointPlace(' · recovered departure'), null);
    equal(recoveredWaypointPlace(42), null);
});

Deno.test('a trip still under way has a From but never a To', () => {
    const places = derivePublicTripPlaces(
        [trip('live', HOME, AWAY, true)],
        [mark('live', 'Hamilton Island · recovered departure', HOME)],
        [diary('Airlie Beach, Queensland', AWAY)],
        brisbane,
    );
    equal(places.get('live'), { from_name: 'Hamilton Island', to_name: null, time_zone: 'Australia/Brisbane' });
});

Deno.test('time_zone comes from the first fix through a safe, memoised lookup', () => {
    const calls: Array<[number, number]> = [];
    const timeZoneAt = createPublicTimeZoneAt((lat, lon) => {
        calls.push([lat, lon]);
        if (lat > 0) return 'Not/AZone';
        if (lon > 170) throw new Error('outside the shapes');
        return lon > 150 ? 'Australia/Sydney' : 'Australia/Brisbane';
    });
    equal(timeZoneAt(-20.27, 148.72), 'Australia/Brisbane');
    equal(timeZoneAt(-20.27, 148.72), 'Australia/Brisbane');
    equal(calls.length, 1);
    equal(timeZoneAt(10, 148), null); // a zone the runtime cannot format
    equal(timeZoneAt(-20, 175), null); // a lookup that throws
    equal(timeZoneAt(Number.NaN, 148), null);
    equal(timeZoneAt(0, 0), null); // null island is not a fix
    equal(calls.length, 3);

    const places = derivePublicTripPlaces(
        [
            trip('qld', { lat: -20.3477, lon: 148.9515 }, { lat: -33.86, lon: 151.2 }),
            trip('nsw', { lat: -33.86, lon: 151.2 }, { lat: -20.3477, lon: 148.9515 }),
            trip('no-fix', null, { lat: -33.86, lon: 151.2 }),
        ],
        [],
        [],
        timeZoneAt,
    );
    equal(places.get('qld')?.time_zone, 'Australia/Brisbane');
    equal(places.get('nsw')?.time_zone, 'Australia/Sydney');
    equal(places.get('no-fix')?.time_zone, null);
});

Deno.test('endpoint fixes obey the public trackworthy rules', () => {
    const row = { voyage_id: 'v', latitude: -20.3, longitude: 148.9, entry_type: 'auto', source: 'gps' };
    equal(publicTrackworthyFix(row), { lat: -20.3, lon: 148.9 });
    equal(publicTrackworthyFix({ ...row, entry_type: 'manual' }), null);
    equal(publicTrackworthyFix({ ...row, source: 'planned_route' }), null);
    equal(publicTrackworthyFix({ ...row, voyage_id: 'planned_123' }), null);
    equal(publicTrackworthyFix({ ...row, voyage_id: '' }), null);
    equal(publicTrackworthyFix({ ...row, waypoint_name: 'COG 045°' }), null);
    equal(publicTrackworthyFix({ ...row, notes: 'Auto: COG change' }), null);
    equal(publicTrackworthyFix({ ...row, latitude: 0.0001, longitude: 0.0002 }), null);
    equal(publicTrackworthyFix({ ...row, latitude: '-20.3' }), null);
});

Deno.test('diary search boxes cover the radius, dedupe, and never miss across the antimeridian', () => {
    const boxes = publicPlaceSearchBoxes([HOME, HOME, { lat: -17.0, lon: 179.999 }, { lat: 0, lon: 0 }]);
    equal(boxes.length, 2);
    ok(boxes[0].startsWith('and(latitude.gte.-20.35') && boxes[0].includes('longitude.lte.'), boxes[0]);
    ok(!boxes[1].includes('longitude'), `antimeridian box keeps no longitude bound: ${boxes[1]}`);
    const [, latMin, latMax, lonMin, lonMax] = boxes[0].match(
        /latitude\.gte\.(-?[\d.]+),latitude\.lte\.(-?[\d.]+),longitude\.gte\.(-?[\d.]+),longitude\.lte\.(-?[\d.]+)/,
    ) ?? [];
    const radius = 0.25;
    ok(distanceNm(HOME, { lat: Number(latMin), lon: HOME.lon }) > radius, 'south edge outside the radius');
    ok(distanceNm(HOME, { lat: Number(latMax), lon: HOME.lon }) > radius, 'north edge outside the radius');
    ok(distanceNm(HOME, { lat: HOME.lat, lon: Number(lonMin) }) > radius, 'west edge outside the radius');
    ok(distanceNm(HOME, { lat: HOME.lat, lon: Number(lonMax) }) > radius, 'east edge outside the radius');
    equal(inPublicPlaceBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    equal(inPublicPlaceBatches([], 20), []);
});

// First/last fixes, waypoints and published diary entries as served live on
// 2026-09-28 (voyage-log?trip=all-diary), coordinates to 6 dp.
const LIVE_TRIPS = [
    trip('hamilton_airlie', { lat: -20.347748, lon: 148.951515 }, { lat: -20.270157, lon: 148.723188 }),
    trip('daydream_hamilton', { lat: -20.254322, lon: 148.815017 }, { lat: -20.347503, lon: 148.949891 }),
    trip('butterfly_daydream', { lat: -20.071738, lon: 148.930427 }, { lat: -20.254275, lon: 148.81503 }),
    trip('tongue_butterfly', { lat: -20.239045, lon: 149.017953 }, { lat: -20.071562, lon: 148.930085 }),
    trip('mackay_tongue', { lat: -21.112085, lon: 149.226772 }, { lat: -20.23896, lon: 149.017925 }),
    trip('gladstone_mackay', { lat: -23.832873, lon: 151.245307 }, { lat: -21.112078, lon: 149.226763 }),
    trip('newport_gladstone', { lat: -27.203983, lon: 153.092973 }, { lat: -23.832875, lon: 151.245318 }),
];
const LIVE_WAYPOINTS = [
    mark('newport_gladstone', 'Recovered GPS track · Newport to Gladstone', { lat: -27.203983, lon: 153.092973 }),
    mark('gladstone_mackay', 'Voyage End', { lat: -21.112078, lon: 149.226763 }),
    mark('mackay_tongue', 'Voyage End', { lat: -20.23896, lon: 149.017925 }),
    mark('tongue_butterfly', 'Tongue Bay · recovered departure', { lat: -20.239045, lon: 149.017953 }),
    mark('tongue_butterfly', 'App recording began · original mark', { lat: -20.16633, lon: 148.997177 }),
    mark('tongue_butterfly', 'Voyage End', { lat: -20.071562, lon: 148.930085 }),
    mark('butterfly_daydream', 'Butterfly Bay · recovered departure', { lat: -20.071738, lon: 148.930427 }),
    mark('butterfly_daydream', 'Daydream Island · recovered arrival', { lat: -20.254275, lon: 148.81503 }),
    mark('daydream_hamilton', 'Voyage End', { lat: -20.347503, lon: 148.949891 }),
    mark('hamilton_airlie', 'Hamilton Island · recovered departure', { lat: -20.347748, lon: 148.951515 }),
    mark('hamilton_airlie', 'Airlie Beach · recovered arrival', { lat: -20.270157, lon: 148.723188 }),
];
const LIVE_DIARY = [
    diary('Airlie Beach, Queensland', { lat: -20.270086, lon: 148.723039 }),
    diary('Hamilton Island, Queensland', { lat: -20.347491, lon: 148.950311 }),
    diary('Daydream Island, Queensland', { lat: -20.253912, lon: 148.814438 }),
    diary('Whitsundays, Queensland', { lat: -20.116302, lon: 148.983233 }),
    diary('Queensland', { lat: -20.676975, lon: 149.171678 }),
    diary('Queensland', { lat: -21.068458, lon: 149.238419 }),
    diary('Mackay Harbour, Queensland', { lat: -21.111858, lon: 149.223427 }),
    diary('Queensland', { lat: -21.848937, lon: 150.187857 }),
    diary('Queensland', { lat: -21.931733, lon: 150.283081 }),
    diary('Callemondah, Queensland', { lat: -23.832865, lon: 151.245305 }),
    diary('Gladstone Central, Queensland', { lat: -23.837954, lon: 151.252477 }),
    diary('Australia', { lat: -24.773411, lon: 153.334883 }),
    diary('Caloundra, Queensland', { lat: -26.781831, lon: 153.185394 }),
];
const LIVE_FULL_LADDER = [
    'Hamilton Island → Airlie Beach',
    'Daydream Island → Hamilton Island',
    'Butterfly Bay → Daydream Island',
    'Tongue Bay → Butterfly Bay',
    'Mackay Harbour → Tongue Bay',
    'Callemondah → Mackay Harbour',
    '— → Callemondah',
];

function fromTo(trips: readonly PublicTripPlaceTrip[], places: Map<string, PublicTripPlaces>): string[] {
    return trips.map((candidate) => {
        const place = places.get(candidate.id);
        return `${place?.from_name ?? '—'} → ${place?.to_name ?? '—'}`;
    });
}

Deno.test('replaying the live Serene Summer log names 6 of 7 departures and 7 of 7 arrivals', () => {
    const places = derivePublicTripPlaces(LIVE_TRIPS, LIVE_WAYPOINTS, LIVE_DIARY, brisbane);
    equal(fromTo(LIVE_TRIPS, places), LIVE_FULL_LADDER);
    ok([...places.values()].every((place) => place.time_zone === 'Australia/Brisbane'), 'every trip has its zone');
});

Deno.test('a failed diary read keeps every name the marks gave and never swaps one', () => {
    const places = derivePublicTripPlacesFromReads(LIVE_TRIPS, LIVE_WAYPOINTS, LIVE_DIARY, brisbane, {
        fixes: true,
        diary: false,
    });
    // Only the ends rule 3 named (Mackay Harbour ×2, Callemondah ×2) go null.
    const names = fromTo(LIVE_TRIPS, places);
    equal(names, [
        'Hamilton Island → Airlie Beach',
        'Daydream Island → Hamilton Island',
        'Butterfly Bay → Daydream Island',
        'Tongue Bay → Butterfly Bay',
        '— → Tongue Bay',
        '— → —',
        '— → —',
    ]);
    // Wherever the diary-less ladder names an end, the full ladder names it the same.
    names.forEach((line, index) => {
        const [from, to] = line.split(' → ');
        const [fullFrom, fullTo] = LIVE_FULL_LADDER[index].split(' → ');
        ok(from === '—' || from === fullFrom, `from ${index}`);
        ok(to === '—' || to === fullTo, `to ${index}`);
    });
    ok([...places.values()].every((place) => place.time_zone === 'Australia/Brisbane'), 'zones stay');

    const all = derivePublicTripPlacesFromReads(LIVE_TRIPS, LIVE_WAYPOINTS, LIVE_DIARY, brisbane, {
        fixes: true,
        diary: true,
    });
    equal(fromTo(LIVE_TRIPS, all), LIVE_FULL_LADDER);
});

Deno.test('failed endpoint rows blank every name but keep the zone of a fix already held', () => {
    const places = derivePublicTripPlacesFromReads(LIVE_TRIPS, LIVE_WAYPOINTS, LIVE_DIARY, brisbane, {
        fixes: false,
        diary: true,
    });
    equal(fromTo(LIVE_TRIPS, places), LIVE_TRIPS.map(() => '— → —'));
    ok([...places.values()].every((place) => place.time_zone === 'Australia/Brisbane'), 'zones stay');
});

Deno.test('a start clipped by the history edge keeps only its own departure mark', () => {
    // 15 Oct: the 15 Sep trip straddles a 30-day edge, and its first fix
    // inside the window lies on the diary's Caloundra entry.
    const caloundra = { lat: -26.781831, lon: 153.185394 };
    const clipped = { ...trip('newport_gladstone', caloundra, LIVE_TRIPS[6].last_fix), start_may_be_clipped: true };
    const neighbour = trip('earlier', AWAY, caloundra);
    const waypoints = [mark('earlier', 'Mooloolaba · recovered arrival', caloundra)];
    const diaryEntries = [diary('Caloundra, Queensland', caloundra), ...LIVE_DIARY];
    const places = derivePublicTripPlaces([clipped, neighbour], waypoints, diaryEntries, brisbane);
    equal(places.get('newport_gladstone'), {
        from_name: null,
        to_name: 'Callemondah',
        time_zone: 'Australia/Brisbane',
    });
    // Unclipped, the same fix would take the neighbour's mark.
    const unclipped = derivePublicTripPlaces(
        [{ ...clipped, start_may_be_clipped: false }, neighbour],
        waypoints,
        diaryEntries,
    );
    equal(unclipped.get('newport_gladstone')?.from_name, 'Mooloolaba');
    // Its own departure mark still names it.
    const own = derivePublicTripPlaces(
        [clipped],
        [mark('newport_gladstone', 'Newport · recovered departure', north(caloundra.lat, caloundra.lon, 3))],
        diaryEntries,
    );
    equal(own.get('newport_gladstone')?.from_name, 'Newport');

    const since = '2026-10-15T02:28:41.000Z';
    ok(publicTripStartMayBeClipped('2026-10-15T02:28:41.640Z', since), 'the first row after the edge');
    ok(publicTripStartMayBeClipped('2026-10-15T09:15:00.000Z', since), 'an overnight logging gap');
    ok(!publicTripStartMayBeClipped('2026-10-16T02:28:41.000Z', since), 'a day inside the window');
    ok(!publicTripStartMayBeClipped(null, since), 'no start');
    ok(!publicTripStartMayBeClipped('2026-10-15T02:28:41.640Z', 'not a date'), 'no edge');
});

Deno.test('recovered marks come from the endpoint rows the handler already reads', () => {
    const marks = publicPlaceMarksFromRows([
        {
            voyage_id: 'a',
            entry_type: 'waypoint',
            waypoint_name: 'Hamilton Island · recovered departure',
            latitude: HOME.lat,
            longitude: HOME.lon,
            timestamp: '2026-09-25T22:42:58.38+00:00',
            source: 'device',
        },
        { voyage_id: 'a', entry_type: 'auto', waypoint_name: null, latitude: HOME.lat, longitude: HOME.lon },
        { voyage_id: 'a', entry_type: 'waypoint', waypoint_name: '  ', latitude: HOME.lat, longitude: HOME.lon },
        {
            voyage_id: 'a',
            entry_type: 'waypoint',
            waypoint_name: 'Planned · recovered arrival',
            latitude: AWAY.lat,
            longitude: AWAY.lon,
            source: 'planned_route',
        },
    ]);
    equal(marks, [{
        voyage_id: 'a',
        name: 'Hamilton Island · recovered departure',
        lat: HOME.lat,
        lon: HOME.lon,
        timestamp: '2026-09-25T22:42:58.38+00:00',
    }]);
    equal(derivePublicTripPlaces([trip('a', HOME, AWAY)], marks, []).get('a')?.from_name, 'Hamilton Island');
});
