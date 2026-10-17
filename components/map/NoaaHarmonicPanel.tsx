import React from 'react';
import { NOAA_HARMONIC_STATION as station, noaaHarmonicDay } from '../../services/tides/noaaHarmonics';
export default function NoaaHarmonicPanel() {
    const [day, setDay] = React.useState(() => new Date().toISOString().slice(0, 10));
    const rows = React.useMemo(() => noaaHarmonicDay(station.id, day), [day]);
    return (
        <section className="border border-white/15 rounded p-3 space-y-2">
            <h3 className="text-white font-semibold">Built-in NOAA station reconstruction</h3>
            <p>
                {station.name} · NOAA {station.id} only · {station.datum} · datum epoch {station.datumEpoch}.
            </p>
            <p>
                Calculated on this device from 37 NOAA harmonic constituents, with astronomical and nodal corrections.
                No internet required. Informational approximation, not an official prediction table or a water-level
                observation.
            </p>
            <label className="block">
                UTC date{' '}
                <input
                    aria-label="NOAA reconstruction UTC date"
                    className="min-h-11 bg-slate-800 rounded px-2"
                    type="date"
                    min="2026-01-01"
                    max="2027-04-30"
                    value={day}
                    onChange={(e) => setDay(e.target.value)}
                />
            </label>
            {rows.length ? (
                <details>
                    <summary className="min-h-11 cursor-pointer">Hourly reconstructed heights · {day} UTC</summary>
                    <div className="max-h-52 overflow-y-auto">
                        {rows.map((r) => (
                            <p key={r.timeMs}>
                                {new Date(r.timeMs).toISOString().slice(11, 16)} UTC · {r.heightM.toFixed(2)} m MLLW
                            </p>
                        ))}
                    </div>
                </details>
            ) : (
                <p>No reconstruction for this date.</p>
            )}
            <p>
                Compared with {station.comparison.samples.toLocaleString()} NOAA hourly predictions in{' '}
                {station.comparison.periods}: largest difference under {station.comparison.maxErrorM} m. That comparison
                is not an accuracy guarantee for other times or actual water levels.
            </p>
            <p>
                Constants retrieved {station.constantsRetrieved}. This station’s constants cannot represent other ports
                or positions.
            </p>
            <a
                href={station.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline min-h-11 inline-flex items-center"
            >
                NOAA source constants
            </a>
            <p className="text-xs">Astronomy adapted from UTide · Copyright © 2014 Wesley Bowman · MIT licence.</p>
        </section>
    );
}
