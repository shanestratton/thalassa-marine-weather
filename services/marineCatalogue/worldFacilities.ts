import type { CatalogueResult } from './service';
import { placeSourceUrl, type FacilityKind, type MarinePlace } from './schema';

export const WORLD_FACILITY_LIMIT = 2000;
export const FACILITY_LABELS: Record<FacilityKind, string> = {
    marina: 'Marina',
    fuel: 'Fuel dock',
    boat_ramp: 'Boat ramp',
    pump_out: 'Pump-out',
};
export interface WorldFacilitiesStatus {
    state: 'loading' | 'ready' | 'unavailable' | 'zoom';
    count: number;
    partial: boolean;
    cachedOnly: boolean;
    sourceAt?: string;
    generation?: string;
    coverage?: string;
}
export const WORLD_FACILITIES_NOTICE = 'Community data, may be incomplete.';
/** Same source position, in the rendered world copy nearest the actual click. */
export function facilityDisplayLongitude(longitude: number, nearLongitude: number): number {
    return longitude + 360 * Math.round((nearLongitude - longitude) / 360);
}
/** Put the popup on the roomier side of the actual marker, retaining its exact arrow position. */
export function facilityPopupLayout(point: { x: number; y: number }, bounds: { width: number; height: number }) {
    const right = point.x >= bounds.width / 2,
        bottom = point.y >= bounds.height / 2;
    return {
        anchor: bottom
            ? right
                ? ('bottom-right' as const)
                : ('bottom-left' as const)
            : right
              ? ('top-right' as const)
              : ('top-left' as const),
        maxWidth: Math.max(1, Math.min(280, (right ? point.x : bounds.width - point.x) - 16)),
        contentMaxHeight: Math.max(1, Math.min(280, bounds.height / 2 - 50)),
    };
}
export function facilityDistanceNM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const rad = Math.PI / 180,
        dy = (b.lat - a.lat) * rad,
        dx = (b.lon - a.lon) * rad;
    return (
        3440.065 *
        2 *
        Math.asin(
            Math.min(
                1,
                Math.sqrt(
                    Math.sin(dy / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dx / 2) ** 2,
                ),
            ),
        )
    );
}
/** Bounded display references; never a route destination, availability or access verdict. */
export function selectWorldFacilities(result: CatalogueResult, centre: { lat: number; lon: number }) {
    const manifest = result.manifests.find((m) => m.dataset === 'facilities-world');
    if (!manifest)
        return {
            records: [] as MarinePlace[],
            status: {
                state: 'unavailable',
                count: 0,
                partial: true,
                cachedOnly: result.cachedOnly,
            } satisfies WorldFacilitiesStatus,
        };
    const nearby = result.records
        .filter((p) => p.facilityKinds?.length && facilityDistanceNM(centre, p) <= 50)
        .sort((a, b) => facilityDistanceNM(centre, a) - facilityDistanceNM(centre, b) || a.id.localeCompare(b.id));
    const records = nearby.slice(0, WORLD_FACILITY_LIMIT);
    return {
        records,
        status: {
            state: 'ready',
            count: records.length,
            partial: result.partial || nearby.length > records.length,
            cachedOnly: result.cachedOnly,
            sourceAt: manifest.sourceAt,
            generation: manifest.generation,
            coverage: manifest.coverage,
        } satisfies WorldFacilitiesStatus,
    };
}
export function worldFacilitiesWarning(status: WorldFacilitiesStatus, now = Date.now()): boolean {
    const at = Date.parse(status.sourceAt ?? '');
    return (
        status.state !== 'ready' ||
        status.partial ||
        status.cachedOnly ||
        !Number.isFinite(at) ||
        at > now + 300000 ||
        now - at > 45 * 86400000
    );
}
export function worldFacilitiesSummary(status: WorldFacilitiesStatus, now = Date.now()): string {
    if (status.state === 'zoom') return 'Facilities: zoom in to level 7 or closer to load a bounded 50 NM area.';
    if (status.state === 'loading') return 'Facilities: loading this area.';
    if (status.state === 'unavailable')
        return 'Facilities unavailable in this area; the worldwide catalogue may not be published or saved here yet.';
    const at = Date.parse(status.sourceAt ?? ''),
        date = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : 'unknown';
    return `${status.count} facility references within 50 NM. Oldest source ${date}${Number.isFinite(at) && now - at > 45 * 86400000 ? ' (older than the monthly update interval)' : ''}. ${status.cachedOnly ? 'Saved data; downloads paused offline or in Satellite Mode. ' : ''}${status.partial ? 'Partial area: a load or display limit was reached. ' : ''}${status.count === 0 ? 'No mapped facilities in the loaded area; absence does not establish that none exist. ' : ''}${WORLD_FACILITIES_NOTICE}`;
}
/** DOM construction avoids HTML interpolation from community names, aliases or access tags. */
export function facilityPopupContent(
    place: MarinePlace,
    status: WorldFacilitiesStatus,
    onMarinaReview?: () => void,
): HTMLElement {
    const root = document.createElement('div');
    root.className = 'world-facility-popup';
    Object.assign(root.style, {
        color: '#16242c',
        fontFamily: 'system-ui,sans-serif',
        fontSize: '13px',
        lineHeight: '1.4',
        maxHeight: 'min(300px, calc(50dvh - 40px))',
        overflowY: 'auto',
    });
    const title = document.createElement('strong');
    title.textContent = place.name;
    root.append(title);
    if (onMarinaReview && place.facilityKinds?.includes('marina')) {
        const reviews = document.createElement('button');
        reviews.type = 'button';
        reviews.textContent = 'Skipper notes';
        Object.assign(reviews.style, {
            display: 'block',
            minHeight: '44px',
            minWidth: '44px',
            color: '#075985',
            textDecoration: 'underline',
        });
        reviews.onclick = onMarinaReview;
        root.append(reviews);
    }
    const line = (text: string) => {
        const p = document.createElement('p');
        p.textContent = text;
        p.style.marginTop = '6px';
        root.append(p);
    };
    line((place.facilityKinds ?? []).map((k) => FACILITY_LABELS[k]).join(' · '));
    line(WORLD_FACILITIES_NOTICE);
    line(
        place.approximate
            ? 'Representative area centre; the entrance and usable position are unknown.'
            : 'Mapped point; confirm the usable position locally.',
    );
    line(
        place.access
            ? `OSM access tag: ${place.access}. Confirm permission locally.`
            : 'Access and permission unknown; check locally.',
    );
    line('Opening hours, service availability and approach depth are unverified.');
    if (place.restrictions?.length) line(`OSM tags: ${place.restrictions.join('; ')}`);
    line(
        `Oldest source: ${status.sourceAt?.slice(0, 10) ?? 'unknown'}${status.cachedOnly ? ' · saved data' : ''}${status.partial ? ' · partial area' : ''}.`,
    );
    const link = (label: string, url: string) => {
        const a = document.createElement('a');
        a.textContent = label;
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        Object.assign(a.style, {
            display: 'flex',
            alignItems: 'center',
            minHeight: '44px',
            textDecoration: 'underline',
            color: '#075985',
        });
        root.append(a);
    };
    link('View original OpenStreetMap object', placeSourceUrl(place));
    link('© OpenStreetMap contributors · ODbL', 'https://www.openstreetmap.org/copyright');
    return root;
}
