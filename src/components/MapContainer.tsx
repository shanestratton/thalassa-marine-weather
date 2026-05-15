import React, { useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer, Marker, NavigationControl } from 'react-map-gl/mapbox';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MAPBOX_TOKEN, MOOD, type VoyageLogEntry, type VoyageLogTrackPoint } from '../voyageLogApi';
import { nightPolygon } from '../geo';

interface MapContainerProps {
    track: VoyageLogTrackPoint[];
    entries: VoyageLogEntry[];
    /** A map marker was tapped. */
    onEntryClick: (entry: VoyageLogEntry) => void;
}

const STYLES = {
    dark: 'mapbox://styles/mapbox/dark-v11',
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type StyleMode = keyof typeof STYLES;

const hasCoords = (e: VoyageLogEntry): e is VoyageLogEntry & { latitude: number; longitude: number } =>
    e.latitude != null && e.longitude != null;

export default function MapContainer({ track, entries, onEntryClick }: MapContainerProps) {
    const [styleMode, setStyleMode] = useState<StyleMode>('satellite');

    // Tick once a minute so the day/night terminator drifts in real time.
    const [now, setNow] = useState<Date>(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(id);
    }, []);
    const nightFeature = useMemo(() => nightPolygon(now), [now]);
    const nightGeojson = useMemo(
        () =>
            nightFeature
                ? { type: 'FeatureCollection' as const, features: [nightFeature] }
                : { type: 'FeatureCollection' as const, features: [] },
        [nightFeature],
    );

    const trackCoords = useMemo<[number, number][]>(
        () => track.map((p) => [p.lon, p.lat] as [number, number]),
        [track],
    );
    const pinnedEntries = useMemo(() => entries.filter(hasCoords), [entries]);
    const allCoords = useMemo<[number, number][]>(
        () => [...trackCoords, ...pinnedEntries.map((e) => [e.longitude, e.latitude] as [number, number])],
        [trackCoords, pinnedEntries],
    );

    // Track line.
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

    // One dot per track point — the literal hourly-positioning breadcrumb.
    const trackPointsGeojson = useMemo<FeatureCollection<Point>>(
        () => ({
            type: 'FeatureCollection',
            features: trackCoords.map(
                (c) =>
                    ({
                        type: 'Feature',
                        properties: {},
                        geometry: { type: 'Point', coordinates: c },
                    }) satisfies Feature<Point>,
            ),
        }),
        [trackCoords],
    );

    // Initial camera — fit the whole voyage, else a globe view.
    const initialViewState = useMemo(() => {
        if (allCoords.length === 0) return { longitude: 0, latitude: 20, zoom: 1.3 };
        if (allCoords.length === 1) return { longitude: allCoords[0][0], latitude: allCoords[0][1], zoom: 8 };
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
            fitBoundsOptions: { padding: 90 },
        };
        // initialViewState is mount-only — the first computed value is what matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Selecting an entry deliberately does NOT move the camera — the whole
    // track is already framed, and viewers want to keep the overview.

    const lastFix = trackCoords[trackCoords.length - 1];

    if (!MAPBOX_TOKEN) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-slate-900 text-slate-500 text-sm">
                Map unavailable — Mapbox token not configured for this build.
            </div>
        );
    }

    return (
        <div className="w-full h-full relative bg-slate-900">
            <Map
                mapboxAccessToken={MAPBOX_TOKEN}
                initialViewState={initialViewState}
                mapStyle={STYLES[styleMode]}
                projection="globe"
            >
                <NavigationControl position="top-left" showCompass={false} />

                {/* Day/night terminator — translucent shadow over the night side */}
                <Source id="night-side" type="geojson" data={nightGeojson}>
                    <Layer id="night-fill" type="fill" paint={{ 'fill-color': '#000814', 'fill-opacity': 0.32 }} />
                </Source>

                {/* Voyage track — glow underlay + crisp line */}
                <Source id="voyage-track" type="geojson" data={trackGeojson}>
                    <Layer
                        id="track-glow"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#38bdf8', 'line-width': 11, 'line-blur': 7, 'line-opacity': 0.3 }}
                    />
                    <Layer
                        id="track-line"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#7dd3fc', 'line-width': 2.5, 'line-opacity': 0.95 }}
                    />
                </Source>

                {/* Hourly position dots */}
                <Source id="voyage-track-points" type="geojson" data={trackPointsGeojson}>
                    <Layer
                        id="track-points"
                        type="circle"
                        paint={{
                            'circle-radius': 3,
                            'circle-color': '#bae6fd',
                            'circle-stroke-color': '#0c4a6e',
                            'circle-stroke-width': 1,
                            'circle-opacity': 0.9,
                        }}
                    />
                </Source>

                {/* Latest known position — pulsing */}
                {lastFix && (
                    <Marker longitude={lastFix[0]} latitude={lastFix[1]} anchor="center">
                        <span className="relative flex h-4 w-4">
                            <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-60 animate-ping" />
                            <span className="relative inline-flex h-4 w-4 rounded-full bg-sky-400 border-2 border-white shadow-lg" />
                        </span>
                    </Marker>
                )}

                {/* Diary entry pins — camera badge if it carries photos */}
                {pinnedEntries.map((entry) => {
                    const hasPhotos = entry.photos.length > 0;
                    const moodHex = MOOD[entry.mood]?.hex ?? '#38bdf8';
                    return (
                        <Marker key={entry.id} longitude={entry.longitude} latitude={entry.latitude} anchor="bottom">
                            <button
                                type="button"
                                onClick={() => onEntryClick(entry)}
                                aria-label={`Voyage log entry: ${entry.title || 'Untitled'}`}
                                className="cursor-pointer leading-none -translate-y-0.5 transition-transform hover:scale-110 active:scale-95"
                            >
                                {hasPhotos ? (
                                    <span
                                        className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-900/90 border-2 text-sm shadow-lg"
                                        style={{ borderColor: moodHex }}
                                    >
                                        📷
                                    </span>
                                ) : (
                                    <span className="text-2xl" style={{ filter: `drop-shadow(0 0 4px ${moodHex})` }}>
                                        {MOOD[entry.mood]?.emoji ?? '📍'}
                                    </span>
                                )}
                            </button>
                        </Marker>
                    );
                })}
            </Map>

            {/* Basemap toggle */}
            <div className="absolute top-3 right-3 flex rounded-lg overflow-hidden border border-white/15 bg-slate-900/80 backdrop-blur-md shadow-lg text-[11px] font-bold uppercase tracking-wider">
                {(['dark', 'satellite'] as StyleMode[]).map((m) => (
                    <button
                        key={m}
                        onClick={() => setStyleMode(m)}
                        aria-label={`${m === 'dark' ? 'Chart' : 'Satellite'} basemap`}
                        className={`px-3 py-1.5 transition-colors ${
                            styleMode === m ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-white/10'
                        }`}
                    >
                        {m === 'dark' ? 'Chart' : 'Satellite'}
                    </button>
                ))}
            </div>
        </div>
    );
}
