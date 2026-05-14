import React, { useEffect, useMemo, useRef } from 'react';
import Map, { Source, Layer, Marker, type MapRef } from 'react-map-gl/maplibre';
import type { FeatureCollection, Feature, LineString } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MOOD, type VoyageLogEntry, type VoyageLogTrackPoint } from '../voyageLogApi';

interface MapContainerProps {
    track: VoyageLogTrackPoint[];
    entries: VoyageLogEntry[];
    /** Entry the viewer tapped in the sidebar — the map flies to it. */
    focusEntry: VoyageLogEntry | null;
}

// CartoDB dark-matter — a sleek dark basemap that suits the nautical theme.
// (Its domains are allow-listed in vercel.json's CSP connect-src.)
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const hasCoords = (e: VoyageLogEntry): e is VoyageLogEntry & { latitude: number; longitude: number } =>
    e.latitude != null && e.longitude != null;

export default function MapContainer({ track, entries, focusEntry }: MapContainerProps) {
    const mapRef = useRef<MapRef>(null);

    const trackCoords = useMemo<[number, number][]>(
        () => track.map((p) => [p.lon, p.lat] as [number, number]),
        [track],
    );

    const pinnedEntries = useMemo(() => entries.filter(hasCoords), [entries]);

    // Everything we'd want in frame: the track plus any pinned entries.
    const allCoords = useMemo<[number, number][]>(
        () => [...trackCoords, ...pinnedEntries.map((e) => [e.longitude, e.latitude] as [number, number])],
        [trackCoords, pinnedEntries],
    );

    const trackGeojson = useMemo<FeatureCollection<LineString>>(
        () => ({
            type: 'FeatureCollection',
            features:
                trackCoords.length >= 2
                    ? [
                          {
                              type: 'Feature',
                              properties: {},
                              geometry: { type: 'LineString', coordinates: trackCoords },
                          } satisfies Feature<LineString>,
                      ]
                    : [],
        }),
        [trackCoords],
    );

    // Initial camera — fit the whole voyage if we have coords, else a world view.
    const initialViewState = useMemo(() => {
        if (allCoords.length === 0) {
            return { longitude: 0, latitude: 20, zoom: 1.4 };
        }
        if (allCoords.length === 1) {
            return { longitude: allCoords[0][0], latitude: allCoords[0][1], zoom: 8 };
        }
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        for (const [lon, lat] of allCoords) {
            minLon = Math.min(minLon, lon);
            minLat = Math.min(minLat, lat);
            maxLon = Math.max(maxLon, lon);
            maxLat = Math.max(maxLat, lat);
        }
        return {
            bounds: [
                [minLon, minLat],
                [maxLon, maxLat],
            ] as [[number, number], [number, number]],
            fitBoundsOptions: { padding: 64 },
        };
        // Only the first computed value matters — initialViewState is mount-only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fly to a sidebar-selected entry.
    useEffect(() => {
        if (focusEntry && hasCoords(focusEntry)) {
            mapRef.current?.flyTo({
                center: [focusEntry.longitude, focusEntry.latitude],
                zoom: 9,
                duration: 1200,
            });
        }
    }, [focusEntry]);

    const lastFix = trackCoords[trackCoords.length - 1];

    return (
        <div className="w-full h-full relative bg-slate-900">
            <Map
                ref={mapRef}
                initialViewState={initialViewState}
                mapStyle={MAP_STYLE}
                attributionControl={{ compact: true }}
            >
                {/* Voyage track */}
                <Source id="voyage-track" type="geojson" data={trackGeojson}>
                    <Layer
                        id="track-line-glow"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#38bdf8', 'line-width': 8, 'line-opacity': 0.15 }}
                    />
                    <Layer
                        id="track-line"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#3b82f6', 'line-width': 3, 'line-opacity': 0.9 }}
                    />
                </Source>

                {/* Latest known position */}
                {lastFix && (
                    <Marker longitude={lastFix[0]} latitude={lastFix[1]} anchor="center">
                        <span className="relative flex h-4 w-4">
                            <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-60 animate-ping" />
                            <span className="relative inline-flex h-4 w-4 rounded-full bg-sky-400 border-2 border-white shadow-lg" />
                        </span>
                    </Marker>
                )}

                {/* Diary entry pins */}
                {pinnedEntries.map((entry) => (
                    <Marker key={entry.id} longitude={entry.longitude} latitude={entry.latitude} anchor="bottom">
                        <div
                            className="text-2xl drop-shadow-lg cursor-default leading-none -translate-y-0.5"
                            title={entry.title || 'Diary entry'}
                            style={{ filter: `drop-shadow(0 0 4px ${MOOD[entry.mood]?.hex ?? '#38bdf8'})` }}
                        >
                            {MOOD[entry.mood]?.emoji ?? '📍'}
                        </div>
                    </Marker>
                ))}
            </Map>
        </div>
    );
}
