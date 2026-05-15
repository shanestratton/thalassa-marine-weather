import React, { useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, Popup } from 'react-map-gl/mapbox';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MAPBOX_TOKEN, MOOD, type NearbyVessel, type VoyageLogEntry, type VoyageLogTrackPoint } from '../voyageLogApi';
import { nightPolygon } from '../geo';
import { CompassRose } from './CompassRose';

interface MapContainerProps {
    track: VoyageLogTrackPoint[];
    entries: VoyageLogEntry[];
    /** Nearby AIS contacts to plot. */
    nearbyVessels: NearbyVessel[];
    /** A map marker was tapped. */
    onEntryClick: (entry: VoyageLogEntry) => void;
}

/** Hex fill for an AIS contact's triangle, by ship-type substring. */
function vesselColor(shipType: string | null | undefined): string {
    const t = (shipType ?? '').toLowerCase();
    if (t.includes('tanker')) return '#f87171'; // red
    if (t.includes('cargo')) return '#fbbf24'; // amber
    if (t.includes('passenger')) return '#38bdf8'; // sky
    if (t.includes('fishing')) return '#34d399'; // emerald
    if (t.includes('sailing') || t.includes('pleasure') || t.includes('yacht')) return '#a78bfa'; // violet
    if (t.includes('tug') || t.includes('pilot') || t.includes('sar') || t.includes('law')) return '#fb923c'; // orange
    return '#94a3b8'; // slate
}

const STYLES = {
    dark: 'mapbox://styles/mapbox/dark-v11',
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type StyleMode = keyof typeof STYLES;

const hasCoords = (e: VoyageLogEntry): e is VoyageLogEntry & { latitude: number; longitude: number } =>
    e.latitude != null && e.longitude != null;

export default function MapContainer({ track, entries, nearbyVessels, onEntryClick }: MapContainerProps) {
    const [styleMode, setStyleMode] = useState<StyleMode>('satellite');
    const [selectedVessel, setSelectedVessel] = useState<NearbyVessel | null>(null);

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

                {/* AIS — nearby ships. Triangle points along COG (or heading). */}
                {nearbyVessels.map((v) => {
                    const bearing = v.cog ?? v.heading ?? 0;
                    const fill = vesselColor(v.ship_type);
                    return (
                        <Marker key={v.mmsi} longitude={v.lon} latitude={v.lat} anchor="center" rotation={bearing}>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedVessel(v);
                                }}
                                aria-label={`AIS contact ${v.name || v.mmsi}`}
                                className="cursor-pointer transition-transform hover:scale-125"
                            >
                                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                                    <polygon
                                        points="8,1 13,14 8,11 3,14"
                                        fill={fill}
                                        stroke="rgba(15,23,42,0.85)"
                                        strokeWidth="1"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </button>
                        </Marker>
                    );
                })}

                {/* AIS detail popup */}
                {selectedVessel && (
                    <Popup
                        longitude={selectedVessel.lon}
                        latitude={selectedVessel.lat}
                        anchor="bottom"
                        offset={14}
                        closeButton={false}
                        closeOnClick
                        onClose={() => setSelectedVessel(null)}
                        className="voyage-log-ais-popup"
                    >
                        <div className="min-w-[180px] bg-slate-900 border border-white/10 rounded-xl px-3 py-2.5 text-slate-100 shadow-2xl">
                            <div className="flex items-center gap-2 mb-1.5">
                                <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: vesselColor(selectedVessel.ship_type) }}
                                />
                                <p className="text-sm font-bold truncate">
                                    {selectedVessel.name || `MMSI ${selectedVessel.mmsi}`}
                                </p>
                            </div>
                            {selectedVessel.ship_type && (
                                <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1.5">
                                    {selectedVessel.ship_type}
                                </p>
                            )}
                            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] font-mono">
                                {selectedVessel.sog != null && (
                                    <>
                                        <span className="text-slate-500">SOG</span>
                                        <span className="text-emerald-400 text-right">
                                            {selectedVessel.sog.toFixed(1)} kt
                                        </span>
                                    </>
                                )}
                                {selectedVessel.cog != null && (
                                    <>
                                        <span className="text-slate-500">COG</span>
                                        <span className="text-amber-400 text-right">
                                            {Math.round(selectedVessel.cog)}°
                                        </span>
                                    </>
                                )}
                                {selectedVessel.destination && (
                                    <>
                                        <span className="text-slate-500">To</span>
                                        <span className="text-slate-200 text-right truncate">
                                            {selectedVessel.destination}
                                        </span>
                                    </>
                                )}
                                {selectedVessel.call_sign && (
                                    <>
                                        <span className="text-slate-500">Call</span>
                                        <span className="text-slate-200 text-right">{selectedVessel.call_sign}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </Popup>
                )}
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

            {/* Compass rose — chart-style decoration, bottom-left */}
            <div className="absolute bottom-4 left-4 z-10">
                <CompassRose />
            </div>
        </div>
    );
}
