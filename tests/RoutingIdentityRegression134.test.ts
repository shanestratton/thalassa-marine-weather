import { describe, expect, it } from 'vitest';
import { isochroneRoutingContext, routingComfortConfig } from '../services/routing/isochronePolicy';
import { vesselDraftIsAssumed } from '../services/units';

const departure = '2026-10-16T00:00:00Z';
type RoutingSettings = Parameters<typeof isochroneRoutingContext>[1];

describe('routing identity includes derived hull safety limits', () => {
    it('invalidates comparison/precompute context when a hull change tightens a derived wave ceiling', () => {
        const cat = {
            vessel: {
                type: 'sail' as const,
                length: 40,
                hullType: 'catamaran' as const,
                maxWaveHeight: 0,
                cruisingSpeed: 0,
            },
            comfortParams: { maxWaveM: 6 },
        };
        const mono = { ...cat, vessel: { ...cat.vessel, hullType: 'monohull' as const } };
        const oldLimit = routingComfortConfig(cat.vessel, cat.comfortParams).comfortParams!.maxWaveM!;
        const newLimit = routingComfortConfig(mono.vessel, mono.comfortParams).comfortParams!.maxWaveM!;
        expect(oldLimit).toBeCloseTo(5.4864, 3);
        expect(newLimit).toBeCloseTo(4.2672, 3);
        expect(newLimit).toBeLessThan(oldLimit);
        expect(isochroneRoutingContext(departure, cat)).not.toBe(isochroneRoutingContext(departure, mono));
    });

    it.each<[string, RoutingSettings]>([
        ['database versus user-supplied polar scaling', { polarSource_type: 'database' }],
        ['factory versus learned polar selection', { polarSource: 'smart' }],
        ['routing polar scale', { routingPolarScale: 1.15 }],
        ['learning switch', { smartPolarsEnabled: true }],
        ['selected polar identity', { polarBoatModel: 'Another hull' }],
    ])('invalidates a stored comparison when %s changes', (_reason, changed) => {
        const initial: RoutingSettings = {
            vessel: { type: 'sail', draft: 8, length: 40, estimatedFields: [] },
            polarSource_type: 'manual',
            polarSource: 'factory',
            routingPolarScale: 1,
            smartPolarsEnabled: false,
            polarBoatModel: 'Original hull',
        };
        expect(isochroneRoutingContext(departure, initial)).not.toBe(
            isochroneRoutingContext(departure, { ...initial, ...changed }),
        );
    });

    it('invalidates verified clearance when the same numeric draft becomes an estimate', () => {
        const measured = { vessel: { draft: 8, estimatedFields: [] } };
        const estimated = { vessel: { draft: 8, estimatedFields: ['draft'] } };
        expect(vesselDraftIsAssumed(measured.vessel)).toBe(false);
        expect(vesselDraftIsAssumed(estimated.vessel)).toBe(true);
        expect(isochroneRoutingContext(departure, measured)).not.toBe(isochroneRoutingContext(departure, estimated));
    });
});
