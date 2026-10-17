/** Display choices only. The collision alarm must never import this module. */
import type { FilterSpecification } from 'mapbox-gl';
import { aisSogKn } from '../../utils/collisionRule';

export const AIS_VESSEL_TYPES = [
    'all',
    'sailing',
    'pleasure',
    'fishing',
    'cargo',
    'tanker',
    'passenger',
    'other',
] as const;
export interface AisDisplayFilters {
    vesselType: (typeof AIS_VESSEL_TYPES)[number];
    hideMoored: boolean;
    minSpeedKn: number;
    source: 'all' | 'local' | 'internet';
}

export function normaliseAisDisplayFilters(input?: Partial<AisDisplayFilters> | null): AisDisplayFilters {
    return {
        vesselType: AIS_VESSEL_TYPES.includes(input?.vesselType ?? 'all') ? (input?.vesselType ?? 'all') : 'all',
        hideMoored: input?.hideMoored === true,
        minSpeedKn: Number.isFinite(input?.minSpeedKn) ? Math.max(0, Math.min(50, Number(input?.minSpeedKn))) : 0,
        source: input?.source === 'local' || input?.source === 'internet' ? input.source : 'all',
    };
}

export function aisVesselType(shipType: unknown): AisDisplayFilters['vesselType'] {
    const type = Number(shipType);
    if (type === 36) return 'sailing';
    if (type === 37) return 'pleasure';
    if (type === 30) return 'fishing';
    if (type >= 60 && type < 70) return 'passenger';
    if (type >= 70 && type < 80) return 'cargo';
    if (type >= 80 && type < 90) return 'tanker';
    return 'other';
}

export function aisDisplayPasses(
    properties: Record<string, unknown> | null,
    input?: Partial<AisDisplayFilters> | null,
    risk?: string,
): boolean {
    const p = properties ?? {};
    const grade = risk ?? p.collisionRisk;
    // Fixed safety overrides precede EVERY display choice, including source.
    if (grade === 'DANGER' || grade === 'CAUTION' || /^97\d{7}$/.test(String(p.mmsi))) return true;
    const prefs = normaliseAisDisplayFilters(input);
    if (prefs.source === 'local' && p.source !== 'local') return false;
    if (prefs.source === 'internet' && p.source !== 'cloud') return false;
    if (prefs.vesselType !== 'all' && aisVesselType(p.shipType ?? p.ship_type) !== prefs.vesselType) return false;
    if (prefs.hideMoored && [1, 5].includes(Number(p.navStatus ?? p.nav_status))) return false;
    const speed = aisSogKn(p.sog);
    return prefs.minSpeedKn === 0 || (speed !== null && speed >= prefs.minSpeedKn);
}

/** A source remains complete: Mapbox alone hides the chosen MMSIs. */
export function aisDisplayMmsiFilter(
    features: GeoJSON.Feature[],
    prefs?: Partial<AisDisplayFilters> | null,
    riskByMmsi?: ReadonlyMap<number, string>,
): FilterSpecification {
    const mmsis = features.flatMap((f) => {
        const mmsi = Number(f.properties?.mmsi);
        return Number.isFinite(mmsi) && aisDisplayPasses(f.properties, prefs, riskByMmsi?.get(mmsi)) ? [mmsi] : [];
    });
    return ['in', ['to-number', ['get', 'mmsi']], ['literal', mmsis]];
}
