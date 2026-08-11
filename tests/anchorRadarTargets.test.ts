/**
 * The anchor radar's merge politics (2026-08-13, "ais from the yacht AND ais
 * from the internet"): the boat's receiver always wins an MMSI collision,
 * internet fills what the receiver can't hear, stale internet positions are
 * dropped rather than drawn as live dots in the anchorage, and ownship's
 * echo never renders as a neighbour.
 */
import { describe, expect, it } from 'vitest';
import { mergeAnchorRadarTargets } from '../components/anchor-watch/anchorRadarTargets';
import type { AisTarget } from '../types/navigation';

const NOW = Date.parse('2026-08-13T02:00:00.000Z');
const ANCHOR = { latitude: -27.2, longitude: 153.1 };

const localTarget = (over: Partial<AisTarget> = {}): AisTarget => ({
    mmsi: 503111222,
    name: 'Local Trawler',
    lat: -27.201,
    lon: 153.101,
    cog: 45,
    sog: 2.5,
    heading: 44,
    navStatus: 0,
    shipType: 30,
    callSign: 'VK1',
    destination: '',
    lastUpdated: NOW - 5_000,
    ...over,
});

const internetFeature = (props: Record<string, unknown> = {}, coords: [number, number] = [153.102, -27.202]) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: coords },
    properties: {
        mmsi: 503333444,
        name: 'Internet Yacht',
        nav_status: 0,
        sog: 0.1,
        cog: 0,
        updated_at: new Date(NOW - 5 * 60_000).toISOString(),
        ...props,
    },
});

const asMap = (...targets: AisTarget[]) => new Map(targets.map((t) => [t.mmsi, t]));

describe('mergeAnchorRadarTargets', () => {
    it('receiver wins an MMSI collision; internet fills distinct vessels', () => {
        const local = localTarget();
        const sameVesselFromInternet = internetFeature({ mmsi: local.mmsi, name: 'Stale Twin' }, [153.9, -27.9]);
        const distinct = internetFeature();
        const dots = mergeAnchorRadarTargets(ANCHOR, asMap(local), [sameVesselFromInternet, distinct], NOW);
        expect(dots.map((d) => d.name)).toEqual(['Local Trawler', 'Internet Yacht']);
        // The winning position is the receiver's, not the internet copy's.
        expect(dots[0].lat).toBeCloseTo(-27.201);
    });

    it('drops internet positions older than the live cutoff', () => {
        const stale = internetFeature({ updated_at: new Date(NOW - 45 * 60_000).toISOString() });
        expect(mergeAnchorRadarTargets(ANCHOR, new Map(), [stale], NOW)).toEqual([]);
    });

    it('clips receiver targets to the radar radius', () => {
        const farAway = localTarget({ mmsi: 503999888, lat: -27.5, lon: 153.5 });
        expect(mergeAnchorRadarTargets(ANCHOR, asMap(farAway), [], NOW)).toEqual([]);
    });

    it('never renders ownship as a neighbour, from either source', () => {
        const OWN = 503000111;
        const ownEcho = localTarget({ mmsi: OWN });
        const ownFromInternet = internetFeature({ mmsi: OWN });
        expect(mergeAnchorRadarTargets(ANCHOR, asMap(ownEcho), [ownFromInternet], NOW, OWN)).toEqual([]);
    });
});
