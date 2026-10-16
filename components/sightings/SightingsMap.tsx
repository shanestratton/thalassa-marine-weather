/** Exact private sightings stay local; only the existing public basemap requests leave the device. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogMap, LOG_MAP_WORLD_VIEW, logMapBounds, logMapToken, type LonLat } from '../map/logMap';
import { useLogMapOnScreen } from '../map/useLogMapOnScreen';
import { formatClock, dayLabel, sightingTitle, type SightingItem } from './sightingsFormat';
import { GroupChip } from './SightingGlyphs';

/** Smallest circular longitude span, so an unordered Fiji group does not frame the whole world. */
export function sightingsMapPoints(items: readonly SightingItem[]): Array<{ item: SightingItem; position: LonLat }> {
    const points = items.filter(
        (item) =>
            typeof item.latitude === 'number' &&
            Number.isFinite(item.latitude) &&
            Math.abs(item.latitude) <= 90 &&
            typeof item.longitude === 'number' &&
            Number.isFinite(item.longitude) &&
            Math.abs(item.longitude) <= 180,
    );
    const positiveLongitude = (lon: number) => (lon < 0 ? lon + 360 : lon);
    const longitudes = points.map((item) => positiveLongitude(item.longitude!)).sort((a, b) => a - b);
    let start = longitudes[0] ?? 0,
        largestGap = -1;
    for (let i = 0; i < longitudes.length; i++) {
        const next = longitudes[(i + 1) % longitudes.length] + (i + 1 === longitudes.length ? 360 : 0);
        if (next - longitudes[i] > largestGap) {
            largestGap = next - longitudes[i];
            start = longitudes[(i + 1) % longitudes.length];
        }
    }
    const unwrapped = points.map((item) => {
        const longitude = positiveLongitude(item.longitude!);
        return longitude < start ? longitude + 360 : longitude;
    });
    const shift = unwrapped.length && (Math.min(...unwrapped) + Math.max(...unwrapped)) / 2 > 180 ? 360 : 0;
    return points.map((item, i) => ({
        item,
        position: [item.longitude! + Math.round((unwrapped[i] - shift - item.longitude!) / 360) * 360, item.latitude!],
    }));
}

export const SightingsMap: React.FC<{
    items: SightingItem[];
    myUserId: string | null;
    onOpen: (item: SightingItem) => void;
    isOffline: boolean;
}> = ({ items, myUserId, onOpen, isOffline }) => {
    const box = useRef<HTMLDivElement>(null);
    const map = useRef<mapboxgl.Map | null>(null);
    const markers = useRef<mapboxgl.Marker[]>([]);
    const points = useMemo(() => sightingsMapPoints(items), [items]);
    const currentPoints = useRef(points);
    currentPoints.current = points;
    const onScreen = useLogMapOnScreen(box);
    const [selection, setSelection] = useState<{ id: string; owner: string | null } | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [plainSea, setPlainSea] = useState(false);
    const [tilesFailed, setTilesFailed] = useState(false);
    const selected = selection?.owner === myUserId ? items.find((item) => item.id === selection.id) : undefined;

    useEffect(() => {
        if (!box.current || !onScreen) return;
        const token = logMapToken();
        const sourceFree = isOffline || !token;
        let active = true;
        setUnavailable(false);
        setTilesFailed(false);
        setPlainSea(sourceFree);
        const coordinates = currentPoints.current.map((point) => point.position);
        const bounds = logMapBounds(coordinates);
        const m = createLogMap({
            container: box.current,
            token,
            gestures: 'free',
            doubleClickZoom: false,
            keyboard: false,
            credits: 'bottom',
            offline: sourceFree,
            view:
                coordinates.length === 1
                    ? { center: coordinates[0], zoom: 11 }
                    : bounds
                      ? { bounds, padding: 28, maxZoom: 12 }
                      : LOG_MAP_WORLD_VIEW,
            onStyle: (loaded) => {
                if (active) setPlainSea(loaded.getContainer().dataset.logMapStyle === 'fallback');
            },
        });
        if (!m) {
            setUnavailable(true);
            return;
        }
        map.current = m;
        let errors = 0;
        m.on('error', (event) => {
            if (active && (event as { sourceId?: string }).sourceId && ++errors >= 3) setTilesFailed(true);
        });
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => m.resize());
        observer?.observe(box.current);
        return () => {
            active = false;
            observer?.disconnect();
            for (const marker of markers.current) marker.remove();
            markers.current = [];
            m.remove();
            if (map.current === m) map.current = null;
        };
    }, [onScreen, isOffline]);

    useEffect(() => {
        const m = map.current;
        if (!m) return;
        for (const marker of markers.current) marker.remove();
        markers.current = points.map(({ item, position }) => {
            const mine = item.observerId === myUserId;
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-label', `Show ${sightingTitle(item)}`);
            button.dataset.sightingId = item.id;
            button.dataset.sightingOwner = mine ? 'mine' : 'crew';
            Object.assign(button.style, {
                width: '44px',
                height: '44px',
                display: 'grid',
                placeItems: 'center',
                background: 'transparent',
                border: '0',
                padding: '0',
                cursor: 'pointer',
            });
            const dot = document.createElement('span');
            Object.assign(dot.style, {
                width: '21px',
                height: '21px',
                borderRadius: '50%',
                border: '2.5px solid #e0f2fe',
                background: mine ? '#0ea5e9' : '#0369a1',
                opacity: mine ? '0.95' : '0.75',
            });
            button.append(dot);
            button.addEventListener('click', () => setSelection({ id: item.id, owner: myUserId }));
            const marker = new mapboxgl.Marker({ element: button }).setLngLat(position).addTo(m);
            // Mapbox marks every custom marker as an image; retain this real button's keyboard/AT role.
            button.setAttribute('role', 'button');
            return marker;
        });
        const coordinates = points.map((point) => point.position);
        const bounds = logMapBounds(coordinates);
        if (coordinates.length === 1) m.jumpTo({ center: coordinates[0], zoom: 11 });
        else if (bounds) m.fitBounds(bounds, { padding: 28, maxZoom: 12, animate: false, retainPadding: false });
        else m.jumpTo(LOG_MAP_WORLD_VIEW);
    }, [points, myUserId, onScreen, isOffline]);

    return (
        <div className="relative h-full min-h-[260px] overflow-hidden rounded-2xl sg-map" data-testid="sightings-map">
            <div
                ref={box}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                aria-label="Map of your and your crew's sightings"
                role="region"
            />
            {(isOffline || plainSea || tilesFailed || unavailable) && (
                <p
                    className="pointer-events-none absolute top-2 left-2 z-10 rounded-full bg-slate-900/80 px-2.5 py-1 text-[11.5px] font-bold text-white/85"
                    role="status"
                >
                    {unavailable
                        ? 'Map unavailable · sightings remain in the list'
                        : isOffline
                          ? 'Offline map · sightings on plain sea'
                          : plainSea
                            ? 'Map tiles unavailable · sightings on plain sea'
                            : 'Some map tiles are unavailable'}
                </p>
            )}
            {selected && (
                <button
                    type="button"
                    onClick={() => onOpen(selected)}
                    className="sg-card absolute top-12 right-2 left-2 z-1 flex min-h-[56px] items-center gap-3 p-2.5 text-left"
                >
                    <GroupChip group={selected.group} size="sm" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-extrabold text-white">
                            {sightingTitle(selected)}
                        </span>
                        <span className="block text-[12px] sg-muted">
                            {dayLabel(selected.eventDate)} {formatClock(selected.eventDate)}
                        </span>
                    </span>
                    <span aria-hidden="true" className="sg-muted">
                        ›
                    </span>
                </button>
            )}
        </div>
    );
};
export default SightingsMap;
