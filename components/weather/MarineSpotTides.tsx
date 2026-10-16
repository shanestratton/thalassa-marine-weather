import React from 'react';
import {
    fetchNearbyTideStations,
    fetchTideStationDetails,
    type TideStation,
    type TideStationDetails,
} from '../../services/tides/stationDetails';
import { TideStationCard } from '../map/TideStationCard';
/** Explicitly mounted by the spot's Tides button. Informational prediction UI only. */
export default function MarineSpotTides({ point }: { point: { lat: number; lon: number } }) {
    const [stations, setStations] = React.useState<TideStation[] | null>(null);
    const [detail, setDetail] = React.useState<TideStationDetails | null>(null);
    const [selected, setSelected] = React.useState<TideStation | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        const controller = new AbortController();
        setStations(null);
        setSelected(null);
        setDetail(null);
        setFailed(false);
        void fetchNearbyTideStations(point.lat, point.lon, { signal: controller.signal }).then((rows) => {
            if (!controller.signal.aborted) {
                setStations(rows);
                setFailed(rows === null);
            }
        });
        return () => controller.abort();
    }, [point.lat, point.lon]);
    React.useEffect(() => {
        const controller = new AbortController();
        if (selected)
            void fetchTideStationDetails(selected, { signal: controller.signal }).then((row) => {
                if (!controller.signal.aborted) {
                    setDetail(row);
                    setFailed(!row);
                }
            });
        return () => controller.abort();
    }, [selected]);
    return (
        <section>
            <h4 className="font-semibold">Nearby informational tides</h4>
            {failed ? (
                <p>Tide source unavailable.</p>
            ) : !stations ? (
                <p>Reading tide stations…</p>
            ) : stations.length === 0 ? (
                <p>No nearby tide station available here.</p>
            ) : (
                <ul>
                    {stations.slice(0, 8).map((station) => (
                        <li key={`${station.id}:${station.lat},${station.lon}`}>
                            <button
                                className="min-h-[44px] text-sky-200"
                                onClick={() => {
                                    setDetail(null);
                                    setSelected(station);
                                    setFailed(false);
                                }}
                            >
                                {station.name} · {station.distance.toFixed(1)} km
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {selected && (
                <TideStationCard
                    station={selected}
                    detail={detail}
                    loading={!detail && !failed}
                    error={failed}
                    onClose={() => {
                        setSelected(null);
                        setDetail(null);
                    }}
                />
            )}
        </section>
    );
}
