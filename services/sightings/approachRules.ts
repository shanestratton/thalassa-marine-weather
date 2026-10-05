/**
 * "Keep your distance": the legal approach distances shown when a whale or
 * dolphin is logged.
 *
 * Every number below was read on 2026-10-05 from the two official pages
 * cited in APPROACH_SOURCES, never from memory:
 *   - Queensland Government, "Rules for watching marine mammals" (last
 *     updated 5 March 2026): caution zone 300 m (whale) / 150 m (dolphin) at
 *     6 knots or less; no-approach zone 100 m round a whale and 300 m ahead
 *     and astern, 50 m round a dolphin and 150 m ahead and astern; the
 *     3-boat rule; people in or entering the water 100 m (whale) / 50 m
 *     (dolphin); in the Marine Park and other Commonwealth waters 300 m from a
 *     whale calf and 150 m from a dolphin calf; a predominantly white
 *     humpback (Migaloo) 500 m for boats; a bow-riding dolphin may be left to
 *     it, changing speed or course gradually.
 *   - GBRMPA, "Whale, dolphin and dugong watching regulations" (updated 31
 *     July 2025, Great Barrier Reef Marine Park Regulations 2019): boats at
 *     least 100 m from whales, always 300 m from a whale calf; constant slow
 *     speed within 300 m of a whale or 150 m of a dolphin; in the Whale
 *     Protection Area (most of the Whitsundays Planning Area) boats at least
 *     300 m from whales.
 *
 * The numbers are shown only inside the Queensland / Great Barrier Reef box.
 * Elsewhere the card says "keep your distance, check local rules" and links
 * the Australian national guidelines, without a number. Dugongs and turtles
 * get no card: Queensland applies dugong distances only under a special
 * management declaration. No boundary polygon for the Whale Protection Area
 * was found as data, so its 300 m line is worded conditionally and only
 * promoted to the top inside a rough Whitsundays box.
 */
import type { SightingGroup } from './types';

export const APPROACH_RULES_CHECKED_ON = '2026-10-05';

export const APPROACH_SOURCES = {
    qld: {
        label: 'Queensland Government: rules for watching marine mammals',
        url: 'https://www.qld.gov.au/environment/plants-animals/animals/discovering-wildlife/watching-wildlife/watching-marine-mammals/rules-for-watching-marine-mammals',
        pageUpdated: '2026-03-05',
    },
    gbrmpa: {
        label: 'GBRMPA: whale, dolphin and dugong watching regulations',
        url: 'https://www.gbrmpa.gov.au/about-us/legislation-and-polices/whale-dolphin-dugong-watching-regulations',
        pageUpdated: '2025-07-31',
    },
    national: {
        label: 'Australian National Guidelines for Whale and Dolphin Watching 2017',
        url: 'https://www.dcceew.gov.au/environment/marine/marine-species/cetaceans/australian-national-guidelines-whale-and-dolphin-watching-2017',
        pageUpdated: null,
    },
} as const;

export interface LatLonBox {
    south: number;
    north: number;
    west: number;
    east: number;
}

/** Queensland's coast and the Marine Park, generously: where the numbers apply. */
export const QLD_GBR_BOX: LatLonBox = { south: -28.2, north: -9.0, west: 137.9, east: 155.5 };

/** Roughly the Whitsundays, where the Whale Protection Area's 300 m line is promoted. Not the legal boundary. */
export const WHITSUNDAYS_BOX: LatLonBox = { south: -20.6, north: -19.7, west: 148.4, east: 149.3 };

export function inBox(box: LatLonBox, lat: number, lon: number): boolean {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= box.south &&
        lat <= box.north &&
        lon >= box.west &&
        lon <= box.east
    );
}

export interface DistanceRow {
    /** The big number, e.g. '100 m' or '6 kn'. */
    value: string;
    text: string;
    /** Lit up when the sighting has a calf. */
    calf?: boolean;
}

export type DistanceCard =
    | {
          kind: 'rules';
          animal: 'whale' | 'dolphin';
          title: string;
          rows: DistanceRow[];
          footer: string;
          sources: Array<{ label: string; url: string }>;
      }
    | {
          kind: 'generic';
          animal: 'whale' | 'dolphin';
          title: string;
          text: string;
          sources: Array<{ label: string; url: string }>;
      };

const WHALE_ROWS: DistanceRow[] = [
    { value: '100 m', text: 'Your boat from any whale, and 300 m ahead of it or astern' },
    { value: '300 m', text: 'From a whale calf (Marine Park and Commonwealth waters)', calf: true },
    { value: '6 kn', text: 'Top speed within 300 m. Three boats already there: wait outside' },
    { value: '100 m', text: 'No one in or entering the water' },
    { value: '500 m', text: 'From a white humpback such as Migaloo' },
];

const WHALE_PROTECTION_ROW: DistanceRow = {
    value: '300 m',
    text: "From any whale if you're in the Whitsundays Whale Protection Area",
};

const DOLPHIN_ROWS: DistanceRow[] = [
    { value: '50 m', text: 'Your boat from any dolphin, and 150 m ahead of it or astern' },
    { value: '150 m', text: 'From a dolphin calf (Marine Park and Commonwealth waters)', calf: true },
    { value: '6 kn', text: 'Top speed within 150 m' },
    { value: '50 m', text: 'No one in or entering the water' },
    { value: 'Bow-riding', text: 'Carry on; change speed or course gradually' },
];

const FOOTER = 'Queensland & Marine Park rules · checked 5 Oct 2026';

/** Which card a group gets: whales (orca and pilot whales included, by the catalogue's grouping) and dolphins. */
export function distanceCardAnimal(group: SightingGroup): 'whale' | 'dolphin' | null {
    if (group === 'whale') return 'whale';
    if (group === 'dolphin') return 'dolphin';
    return null;
}

/**
 * The card for a sighting at (lat, lon), or null for groups with no card.
 * An unknown position counts as outside the box: no number without knowing
 * which rules apply.
 */
export function distanceCardFor(
    group: SightingGroup,
    lat: number | null | undefined,
    lon: number | null | undefined,
): DistanceCard | null {
    const animal = distanceCardAnimal(group);
    if (!animal) return null;
    const title = animal === 'whale' ? 'Keep your distance from whales' : 'Keep your distance from dolphins';
    const known = typeof lat === 'number' && typeof lon === 'number';
    if (!known || !inBox(QLD_GBR_BOX, lat, lon)) {
        return {
            kind: 'generic',
            animal,
            title,
            text: 'Keep your distance and go slow. Approach distances differ by state: check the local rules.',
            sources: [{ label: APPROACH_SOURCES.national.label, url: APPROACH_SOURCES.national.url }],
        };
    }
    let rows: DistanceRow[];
    if (animal === 'whale') {
        rows = inBox(WHITSUNDAYS_BOX, lat, lon)
            ? [WHALE_PROTECTION_ROW, ...WHALE_ROWS]
            : [...WHALE_ROWS.slice(0, 2), WHALE_PROTECTION_ROW, ...WHALE_ROWS.slice(2)];
    } else {
        rows = [...DOLPHIN_ROWS];
    }
    return {
        kind: 'rules',
        animal,
        title,
        rows,
        footer: FOOTER,
        sources: [
            { label: APPROACH_SOURCES.qld.label, url: APPROACH_SOURCES.qld.url },
            { label: APPROACH_SOURCES.gbrmpa.label, url: APPROACH_SOURCES.gbrmpa.url },
        ],
    };
}
