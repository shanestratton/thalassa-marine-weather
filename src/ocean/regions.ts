/**
 * Regions the map can fly to. DATA, not code: the page works anywhere, and a
 * new region is one more row. bbox is [west, south, east, north]; a west
 * greater than east crosses the antimeridian (fitBounds then uses east + 360).
 * contextRegion names the context file of historical records for that area.
 */
export interface Region {
    id: string;
    name: string;
    /** The chip's label, short enough for one row of chips on a phone. */
    short: string;
    country: string | null;
    bbox: [number, number, number, number];
    /** Which context file (public/ocean-data/context/<id>.v1.json) covers it, if any. */
    contextRegion: string | null;
    /** Which "year in the life" captions (stories.ts) belong to it, if any. */
    story: string | null;
}

export const REGIONS: readonly Region[] = [
    {
        id: 'au-east',
        name: 'East coast of Australia',
        short: 'Whole coast',
        country: 'AU',
        bbox: [141, -44, 161, -9],
        contextRegion: 'au-east',
        story: 'humpback-au-east',
    },
    {
        id: 'gbr',
        name: 'Great Barrier Reef',
        short: 'Reef',
        country: 'AU',
        bbox: [142.5, -24.5, 153.5, -10.5],
        contextRegion: 'au-east',
        story: 'humpback-au-east',
    },
    {
        id: 'moreton',
        name: 'Moreton Bay',
        short: 'Moreton Bay',
        country: 'AU',
        bbox: [152.9, -27.75, 153.6, -26.9],
        contextRegion: 'au-east',
        story: 'humpback-au-east',
    },
    {
        id: 'hervey',
        name: 'Hervey Bay & K’gari',
        short: 'K’gari',
        country: 'AU',
        bbox: [152.6, -25.9, 153.5, -24.6],
        contextRegion: 'au-east',
        story: 'humpback-au-east',
    },
    {
        id: 'whitsundays',
        name: 'Whitsundays',
        short: 'Whitsundays',
        country: 'AU',
        bbox: [148.4, -20.6, 149.4, -19.9],
        contextRegion: 'au-east',
        story: 'humpback-au-east',
    },
    {
        id: 'cairns',
        name: 'Cairns & Port Douglas',
        short: 'Cairns',
        country: 'AU',
        bbox: [145.4, -17.2, 146.3, -16.2],
        contextRegion: 'au-east',
        story: 'humpback-au-east',
    },
    {
        id: 'world',
        name: 'The world',
        short: 'World',
        country: null,
        bbox: [-180, -85, 180, 85],
        contextRegion: null,
        story: null,
    },
];

export const START_REGION = REGIONS[0];

export const regionById = (id: string): Region => REGIONS.find((r) => r.id === id) ?? START_REGION;

/** True when the point lies in the box, including a box that crosses the antimeridian. */
export function inBox(lat: number, lon: number, bbox: readonly [number, number, number, number]): boolean {
    const [w, s, e, n] = bbox;
    if (lat < s || lat > n) return false;
    return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}
