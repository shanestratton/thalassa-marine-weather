/**
 * My map: your sightings and your crew's, at their exact positions (only you
 * and your crew ever see these; the public feed is fuzzed by the server).
 *
 * Leaflet on the Log page's own tiles (logBaseTiles through the Pi's tile
 * cache, the seam guard, the compact credits), so it adds no map code. Offline
 * the tiles fail and the markers sit on a plain sea colour, with a line
 * saying so. The page unmounts this while any sheet is open: iOS WebKit
 * paints Leaflet's layers above fixed overlays.
 */
import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { piCache } from '../../services/PiCacheService';
import { installLeafletTileSeamGuard } from '../map/leafletTileSeamGuard';
import { installCompactAttribution } from '../map/leafletCompactAttribution';
import { logBaseTiles } from '../map/logMapTiles';
import { formatClock, dayLabel, sightingTitle, type SightingItem } from './sightingsFormat';
import { GroupChip } from './SightingGlyphs';

export const SightingsMap: React.FC<{
    items: SightingItem[];
    myUserId: string | null;
    onOpen: (item: SightingItem) => void;
    isOffline: boolean;
}> = ({ items, myUserId, onOpen, isOffline }) => {
    const box = useRef<HTMLDivElement>(null);
    const map = useRef<L.Map | null>(null);
    const layer = useRef<L.LayerGroup | null>(null);
    const [selected, setSelected] = useState<SightingItem | null>(null);
    const [tilesFailed, setTilesFailed] = useState(false);

    useEffect(() => {
        if (!box.current || map.current) return;
        const m = L.map(box.current, {
            zoomControl: false,
            attributionControl: true,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            fadeAnimation: false,
            zoomAnimation: false,
        });
        const tiles = logBaseTiles(import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined);
        const base = L.tileLayer(piCache.leafletTileTemplate(tiles.url, undefined, 'image/jpeg'), {
            maxZoom: tiles.maxZoom,
            attribution: tiles.attribution,
            ...(tiles.isMapbox ? { tileSize: 512, zoomOffset: -1 } : {}),
        });
        installLeafletTileSeamGuard(base);
        let errors = 0;
        base.on('tileerror', () => {
            errors += 1;
            if (errors >= 3) setTilesFailed(true);
        });
        base.on('tileload', () => setTilesFailed(false));
        base.addTo(m);
        installCompactAttribution(m);
        layer.current = L.layerGroup().addTo(m);
        m.setView([-20.27, 148.95], 9);
        map.current = m;
        return () => {
            m.remove();
            map.current = null;
            layer.current = null;
        };
    }, []);

    useEffect(() => {
        const m = map.current;
        const group = layer.current;
        if (!m || !group) return;
        group.clearLayers();
        const points: L.LatLngExpression[] = [];
        for (const item of items) {
            if (item.latitude === null || item.longitude === null) continue;
            const mine = item.observerId === myUserId;
            const marker = L.circleMarker([item.latitude, item.longitude], {
                radius: 9,
                weight: 2.5,
                color: '#e0f2fe',
                fillColor: mine ? '#0ea5e9' : '#0369a1',
                fillOpacity: mine ? 0.95 : 0.75,
            });
            marker.on('click', () => setSelected(item));
            marker.addTo(group);
            points.push([item.latitude, item.longitude]);
        }
        if (points.length === 1) m.setView(points[0], 11);
        else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 12 });
    }, [items, myUserId]);

    return (
        <div className="relative h-full min-h-[260px] overflow-hidden rounded-2xl sg-map" data-testid="sightings-map">
            <div
                ref={box}
                className="thalassa-log-leaflet-map absolute inset-0"
                aria-label="Map of your and your crew's sightings"
                role="img"
            />
            {(isOffline || tilesFailed) && (
                <p className="pointer-events-none absolute top-2 left-2 z-[500] rounded-full bg-slate-900/80 px-2.5 py-1 text-[11.5px] font-bold text-white/85">
                    Map tiles need a connection
                </p>
            )}
            {selected && (
                <button
                    type="button"
                    onClick={() => onOpen(selected)}
                    className="sg-card absolute right-2 bottom-2 left-2 z-[500] flex min-h-[56px] items-center gap-3 p-2.5 text-left"
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
