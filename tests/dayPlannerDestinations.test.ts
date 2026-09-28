import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnchorageProps } from '../services/anchorages/AnchorageService';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';

const tile = JSON.parse(readFileSync('public/anchorages/qld/t-22e148.geojson', 'utf8')) as GeoJSON.FeatureCollection<
    GeoJSON.Point,
    AnchorageProps
>;

describe('Whitsundays day-planner destination provenance', () => {
    it('keeps every position and identity tied to an existing non-marina anchorage record', () => {
        // This cross-file check catches invented coordinates and drift after tile refreshes.
        for (const destination of WHITSUNDAYS_DAY_DESTINATIONS) {
            const feature = tile.features.find((f) => f.properties.id === destination.anchorageId);
            expect(feature, destination.id).toBeDefined();
            expect(feature!.properties.name).toBe(destination.anchorageName);
            expect(feature!.properties.kind).toBe('anchorage');
            expect(feature!.geometry.coordinates).toEqual([destination.lon, destination.lat]);
            expect(destination.referencePosition).toBe('existing-anchorage');
        }
    });

    it('retains source attribution, review dates and access uncertainty for every candidate', () => {
        expect(new Set(WHITSUNDAYS_DAY_DESTINATIONS.map((d) => d.id)).size).toBe(WHITSUNDAYS_DAY_DESTINATIONS.length);
        for (const destination of WHITSUNDAYS_DAY_DESTINATIONS) {
            expect(new URL(destination.sourceUrl).hostname).toBe('parks.qld.gov.au');
            expect(destination.sourceLabel).toContain('Queensland Parks');
            expect(destination.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(Number.isFinite(Date.parse(destination.verifiedAt))).toBe(true);
            expect(destination.accessNotes.length).toBeGreaterThan(0);
            expect(destination.uncertaintyNotes.join(' ')).toContain('not a verified approach');
        }
    });

    it('does not offer Cid Harbour as a snorkelling or swimming-beach activity', () => {
        const cid = WHITSUNDAYS_DAY_DESTINATIONS.find((d) => d.anchorageName === 'Cid Harbour')!;
        expect(cid.activities).not.toContain('snorkel');
        expect(cid.activities).not.toContain('beach');
        expect(cid.accessNotes.join(' ')).toMatch(/Do not swim in Cid Harbour.*sharks/);
        expect(cid.supportingSources).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ url: 'https://parks.qld.gov.au/parks/whitsunday-islands/camping' }),
            ]),
        );
    });

    it('qualifies picnic, quiet and snorkelling tags rather than promising current conditions', () => {
        for (const destination of WHITSUNDAYS_DAY_DESTINATIONS) {
            if (destination.activities.includes('lunch'))
                expect(destination.accessNotes.join(' ')).toContain('bring-your-own picnic');
            if (destination.activities.includes('quiet'))
                expect(destination.uncertaintyNotes.join(' ')).toContain(
                    'crowd levels and calm water are not verified',
                );
            if (destination.activities.includes('snorkel'))
                expect(destination.uncertaintyNotes.join(' ')).toContain('Snorkelling visibility');
        }
    });

    it('preserves the known Nara access closure as a machine-readable date interval', () => {
        const nara = WHITSUNDAYS_DAY_DESTINATIONS.find((d) => d.anchorageName === 'Nara Inlet')!;
        expect(nara.knownClosures).toEqual([
            expect.objectContaining({
                fromDate: '2026-10-06',
                throughDate: '2026-10-15',
                sourceUrl: 'https://parks.qld.gov.au/park-alerts/26934',
            }),
        ]);
    });
});
