/**
 * Plan Your Day, places worldwide (131-PYD-10): Overpass answers as the two
 * one-degree cell queries return them (cruisingReference.ts's referenceQuery
 * and namedPlacesQuery), for a start at Tromsø and one in southern Brittany.
 * Invented ids and invented place names (the roadmap's "Baie du Dervin"
 * included), at made-up spots round real starts; nothing here came from
 * OpenStreetMap or any chart, and no test sends it anywhere.
 */
import type { LatLon } from '../../services/dayPlanner/places';

/** Overpass's JSON shape: an element list, ways with their centre. */
interface Element {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
}
const node = (id: number, at: LatLon, tags: Record<string, string>): Element => ({ type: 'node', id, ...at, tags });
const way = (id: number, at: LatLon, tags: Record<string, string>): Element => ({ type: 'way', id, center: at, tags });
const body = (elements: Element[]) => ({ version: 0.6, generator: 'fixture', elements });

/** NM north and east of a point, near enough for a fixture. */
export function offset(from: LatLon, northNm: number, eastNm: number): LatLon {
    const lat = from.lat + northNm / 60;
    const lon = from.lon + eastNm / (60 * Math.cos((from.lat * Math.PI) / 180));
    return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

// ── Tromsø: no anchorage charted in OpenStreetMap, only named bays ──

/** Tromsø's harbour, where the 127 test said "No anchorages mapped near here". */
export const TROMSO: LatLon = { lat: 69.6496, lon: 18.956 };

export const TROMSO_NAMES = body([
    node(990000001, offset(TROMSO, -0.03, -0.02), { place: 'city', name: 'Tromsø' }),
    way(990000002, offset(TROMSO, 0.1, 0.3), { leisure: 'marina', name: 'Fixture Båthavn' }),
    node(990000003, offset(TROMSO, 5, 0), { natural: 'bay', name: 'Fixture Vika' }),
    node(990000004, offset(TROMSO, 0, 8), { natural: 'bay', name: 'Fixture Bukta' }),
    node(990000005, offset(TROMSO, -8.5, -8.5), { natural: 'bay', name: 'Fixture Hamna' }),
    way(990000006, offset(TROMSO, 0.6, -15), { natural: 'bay', name: 'Fixture Kjosen' }),
    // A sound and a fjord, by their names: no place to stop.
    node(990000007, offset(TROMSO, -4, 0), { natural: 'bay', name: 'Fixture Sundet' }),
    node(990000008, offset(TROMSO, 20, 0), { natural: 'bay', name: 'Fixturfjorden' }),
    // Beyond any day's reach.
    node(990000009, offset(TROMSO, 40, 0), { natural: 'bay', name: 'Fixture Langtvekk' }),
    // Not what was asked for, or not usable: dropped by the parser (a hamlet is not asked for at all).
    node(990000010, offset(TROMSO, 5.5, 1), { place: 'hamlet', name: 'Fixture Grend' }),
    node(990000011, offset(TROMSO, 3, 3), { natural: 'bay' }),
    {
        type: 'relation',
        id: 990000012,
        center: offset(TROMSO, 6, 6),
        tags: { natural: 'bay', name: 'Fixture Relasjon' },
    },
    node(990000013, offset(TROMSO, 2, 2), { place: 'locality', name: 'Fixture Lokalitet' }),
]);

/** The reference cells round Tromsø: no anchorage charted, as in 127's test. */
export const TROMSO_ANCHORAGES = body([]);

// ── Southern Brittany: charted anchorages, one unnamed, one an area ──

export const BRITTANY: LatLon = { lat: 47.585, lon: -3.03 };
export const DERVIN = offset(BRITTANY, -6, 0);

export const BRITTANY_NAMES = body([
    node(991000001, offset(BRITTANY, 0, 0.8), { place: 'village', name: 'Fixture-sur-Mer' }),
    node(991000002, offset(BRITTANY, 2, 0), { leisure: 'marina', name: 'Port Fixture' }),
    node(991000003, DERVIN, { natural: 'bay', name: 'Baie du Dervin' }),
    node(991000004, offset(BRITTANY, 0, -9), { natural: 'bay', name: 'Anse de Fixture' }),
    node(991000005, offset(BRITTANY, 0, 10), { natural: 'bay', name: 'Baie Interdite' }),
    node(991000006, offset(BRITTANY, -3, 5), { natural: 'bay', name: 'Passage du Fixture' }),
    node(991000007, offset(BRITTANY, 14, 0), { place: 'village', name: 'Bourg Fixture' }),
]);

export const BRITTANY_ANCHORAGES = body([
    // Unnamed, 0.4 NM off Baie du Dervin.
    node(991100001, offset(DERVIN, 0.4, 0), { 'seamark:type': 'anchorage' }),
    // An anchorage area, at its centre.
    way(991100002, offset(BRITTANY, -8.5, -8.5), { 'seamark:type': 'anchorage', name: 'Zone de mouillage Fixture' }),
    // No anchoring, beside Baie Interdite.
    node(991100003, offset(BRITTANY, 0.3, 10), {
        'seamark:type': 'anchorage',
        name: 'Mouillage Interdit Fixture',
        anchoring: 'no',
    }),
    // Unnamed, half a mile off a village and a mile from no bay.
    node(991100004, offset(BRITTANY, 14.5, 0), { 'seamark:type': 'anchorage' }),
    // Unnamed, and nothing named within a mile.
    node(991100005, offset(BRITTANY, 0, 20), { 'seamark:type': 'anchorage' }),
]);
