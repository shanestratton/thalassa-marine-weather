/**
 * TideAndVessel — Barrel re-export + TideWidget + SunMoonWidget.
 *
 * Heavy components are extracted into:
 *   - ./tide/TideCanvas.tsx  — Canvas-based tide chart renderer
 *   - ./tide/TideGraph.tsx   — Tide data computation + rendering
 *   - ./VesselWidget.tsx     — Vessel hydrostatics + VesselStatusWidget
 *
 * This file retains:
 *   - TideWidget       — Card wrapper around TideGraph
 *   - SunMoonWidget    — Celestial (moon + solar arc) card
 *   - All re-exports for backward compat
 */
import React from 'react';
import { Card } from './shared/Card';
import { TideCurveIcon, StarIcon } from '../Icons';
import { Tide, UnitPreferences, HourlyForecast, WeatherMetrics, TidePoint } from '../../types';
import { TideGUIDetails } from '../../services/weather/api/tides';

// Direct imports used by TideWidget + SunMoonWidget
import { TideGraph } from './tide/TideGraph';
import { MoonVisual, SolarArc, getMoonPhaseData } from './tide/CelestialComponents';

// Re-exports for backward compat (barrel pattern)
export { TideCanvas } from './tide/TideCanvas';
export { TideGraph, TideGraphOriginal } from './tide/TideGraph';
export { VesselWidget, VesselStatusWidget } from './VesselWidget';
export type { VesselStatus, VesselStatusStyles } from './VesselWidget';
export { MoonVisual, SolarArc, getMoonPhaseData };

// ── TideWidget ──
const TideWidgetComponent = ({
    tides,
    hourlyTides,
    tideHourly,
    units,
    timeZone,
    modelUsed,
    stationName,
    guiDetails,
    customTime,
    showAllDayEvents,
}: {
    tides: Tide[];
    hourlyTides: HourlyForecast[];
    tideHourly?: TidePoint[];
    units: UnitPreferences;
    timeZone?: string;
    modelUsed?: string;
    stationName?: string;
    guiDetails?: TideGUIDetails;
    customTime?: number;
    showAllDayEvents?: boolean;
}) => {
    return (
        <Card
            key={guiDetails ? JSON.stringify(guiDetails) : 'tide-widget-loading'}
            className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px] relative overflow-hidden gap-4"
            role="figure"
            aria-labelledby="tide-chart-title"
            aria-describedby="tide-chart-desc"
        >
            {/* Header */}
            <div className="flex justify-between items-start border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                    <TideCurveIcon className="w-5 h-5 text-sky-400" aria-hidden="true" />
                    <div className="flex flex-col">
                        <h3 id="tide-chart-title" className="text-sm font-bold text-white uppercase tracking-widest">
                            Tidal Forecast{' '}
                            {guiDetails?.stationName ? (
                                <span className="text-sky-400">• {guiDetails.stationName}</span>
                            ) : (
                                ''
                            )}
                        </h3>
                    </div>
                </div>
            </div>
            <span id="tide-chart-desc" className="sr-only">
                Interactive tidal forecast graph showing predicted tide heights over 24 hours. The moving indicator
                shows the current tide level.
            </span>

            {/* Graph Area */}
            <div className="flex-1 w-full min-h-[160px] relative z-10">
                <TideGraph
                    tides={tides}
                    unit={units.tideHeight || 'm'}
                    timeZone={timeZone}
                    hourlyTides={hourlyTides}
                    tideSeries={tideHourly}
                    modelUsed={modelUsed}
                    unitPref={units}
                    stationName={stationName}
                    guiDetails={guiDetails}
                    customTime={customTime}
                    showAllDayEvents={showAllDayEvents}
                />
            </div>
        </Card>
    );
};
export const TideWidget = React.memo(TideWidgetComponent);

// ── SunMoonWidget ──
const SunMoonWidgetComponent = ({
    current,
    units: _units,
    timeZone,
    lat,
}: {
    current: WeatherMetrics;
    units: UnitPreferences;
    timeZone?: string;
    lat?: number;
}) => {
    return (
        <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col gap-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-2">
                <StarIcon className="w-5 h-5 text-sky-300" />
                <h3 className="text-sm font-bold text-sky-300 uppercase tracking-widest">Celestial</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                {/* Moon Side */}
                <div className="flex items-center justify-center p-2 border-b md:border-b-0 md:border-r border-white/5">
                    <MoonVisual
                        cloudCover={current.cloudCover || 0}
                        apiPhase={current.moonPhase}
                        apiIllumination={current.moonIllumination}
                        apiPhaseValue={current.moonPhaseValue}
                        lat={lat}
                    />
                </div>

                {/* Sun Side */}
                <div className="flex items-center justify-center p-2 w-full">
                    {current.sunrise && current.sunset && (
                        <div className="w-full">
                            <div className="text-[11px] text-gray-400 font-bold uppercase tracking-wider mb-2 text-center">
                                Solar Cycle
                            </div>
                            <SolarArc
                                sunrise={current.sunrise}
                                sunset={current.sunset}
                                size="normal"
                                showTimes={true}
                                timeZone={timeZone}
                            />
                        </div>
                    )}
                </div>
            </div>
        </Card>
    );
};
export const SunMoonWidget = React.memo(SunMoonWidgetComponent);
