import type { Polygon, MultiPolygon, Position } from 'geojson';
import { ringContains, unwrapRing } from './model';

export interface EntryArea {
    key: string;
    label: string;
    source: 'user overlay' | 'displayed chart aboard';
    geometry: Polygon | MultiPolygon;
}
export interface EntryFix {
    lat: number;
    lon: number;
    at: number;
    identity: string;
    accuracyM: number | null;
    source: string;
}
export interface EntryNotice {
    key: string;
    label: string;
    source: EntryArea['source'];
    at: number;
    fixSource: string;
}
export function entryFixUsable(fix: EntryFix | null, now: number): fix is EntryFix {
    return (
        !!fix &&
        Number.isFinite(fix.lat) &&
        Number.isFinite(fix.lon) &&
        Math.abs(fix.lat) <= 90 &&
        Math.abs(fix.lon) <= 180 &&
        Number.isFinite(fix.at) &&
        fix.at > 0 &&
        fix.at <= now &&
        now - fix.at <= 15000 &&
        !!fix.identity &&
        fix.identity.length <= 1024 &&
        (fix.accuracyM === null || (Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0 && fix.accuracyM <= 100))
    );
}
function distance(ring: Position[], lon: number, lat: number): number {
    const points = unwrapRing(ring, lon),
        scale = Math.cos((lat * Math.PI) / 180),
        mx = 111195 * scale,
        my = 111195;
    let nearest = Infinity;
    for (let i = 1; i < points.length; i++) {
        const a = [(points[i - 1][0] - lon) * mx, (points[i - 1][1] - lat) * my],
            b = [(points[i][0] - lon) * mx, (points[i][1] - lat) * my],
            dx = b[0] - a[0],
            dy = b[1] - a[1],
            t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1)));
        nearest = Math.min(nearest, Math.hypot(a[0] + dx * t, a[1] + dy * t));
    }
    return nearest;
}
/** Boundary/accuracy band is unknown; noise does not repeatedly rearm an episode. */
export function areaRelation(area: EntryArea, fix: EntryFix): 'inside' | 'outside' | 'unknown' {
    if (Math.abs(fix.lat) > 85) return 'unknown';
    const polygons = area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates;
    const margin = Math.max(10, fix.accuracyM ?? 25);
    let inside = false;
    for (const rings of polygons) {
        if (rings.some((r) => distance(r, fix.lon, fix.lat) <= margin)) return 'unknown';
        if (ringContains(rings[0], fix.lon, fix.lat) && !rings.slice(1).some((r) => ringContains(r, fix.lon, fix.lat)))
            inside = true;
    }
    return inside ? 'inside' : 'outside';
}
/** RAM only, bounded; unknown/missing/stale never mean outside or clear. */
export class AreaEntryTracker {
    private states = new Map<string, 'inside' | 'outside'>();
    private identity = '';
    private lastAt = 0;
    private capacityUnknown = false;
    get limited() {
        return this.capacityUnknown;
    }
    reset() {
        this.states.clear();
        this.identity = '';
        this.lastAt = 0;
        this.capacityUnknown = false;
    }
    update(areas: readonly EntryArea[] | null, fix: EntryFix | null, now: number): EntryNotice[] {
        if (!entryFixUsable(fix, now)) return [];
        if (this.identity !== fix.identity) {
            this.reset();
            this.identity = fix.identity;
        }
        if (this.capacityUnknown) return [];
        if (fix.at <= this.lastAt) return [];
        if (this.lastAt && fix.at - this.lastAt > 15000) this.states.clear();
        this.lastAt = fix.at;
        if (!areas) return [];
        if (areas.length > 2000) {
            this.capacityUnknown = true;
            return [];
        }
        const notices: EntryNotice[] = [];
        for (const area of areas) {
            const relation = areaRelation(area, fix);
            if (relation === 'unknown') continue;
            const previous = this.states.get(area.key);
            if (relation === 'inside' && previous === 'outside')
                notices.push({
                    key: area.key,
                    label: area.label,
                    source: area.source,
                    at: fix.at,
                    fixSource: fix.source,
                });
            this.states.set(area.key, relation);
        }
        // Omitted areas are not cleared. A finite identity ledger refuses new
        // admissions until a lifecycle reset instead of silently evicting latches.
        if (this.states.size > 2000) {
            this.states.clear();
            this.capacityUnknown = true;
            return [];
        }
        return notices.slice(0, 5);
    }
}
