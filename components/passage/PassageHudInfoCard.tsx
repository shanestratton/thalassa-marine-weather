import React from 'react';
import { usePassageHudInfo, usePassageSquallInfoVisible } from '../../stores/passageHudInfoStore';
import { SquallLegend } from '../map/SquallLegend';

/** Explanations belong in the existing blue ℹ panel, not below the chart slider. */
export const PassageHudInfoCard: React.FC = () => {
    const info = usePassageHudInfo();
    const squallVisible = usePassageSquallInfoVisible();
    if (!info && !squallVisible) return null;

    const hours = (value: number) => (value < 10 ? value.toFixed(1) : String(Math.round(value)));
    return (
        <section
            aria-label="Chart forecast information"
            data-testid="passage-hud-info"
            className="space-y-3 rounded-xl border border-sky-400/20 bg-sky-950/20 p-3 text-sm text-slate-200"
        >
            <h3 className="font-bold text-sky-200">{info ? 'Passage forecast' : 'Squall layer'}</h3>
            {info && (
                <>
                    <p className="font-mono text-xs font-bold text-amber-200">
                        {info.moment} · {info.modelLabel}
                    </p>
                    {info.joining && (
                        <p className="font-semibold text-amber-300" data-testid="route-scrub-join">
                            Joining route · unchecked estimate
                        </p>
                    )}
                    {info.joining && (
                        <p className="text-xs leading-relaxed">
                            The dashed connector starts at your GPS position. It has not been checked for land, depth or
                            hazards, and is not a route to steer. Route-sampled weather is withheld until the join.
                        </p>
                    )}
                    {info.note && (
                        <p className="font-semibold text-amber-200" data-testid="route-scrub-note">
                            {info.note}
                        </p>
                    )}
                    {info.ownTime.length > 0 && (
                        <p className="text-amber-200" data-testid="route-scrub-unsynced">
                            Chart {info.ownTime.join(', ')}: still at {info.ownTime.length > 1 ? 'their' : 'its'} own
                            time
                        </p>
                    )}
                    <div className="space-y-1 text-xs text-slate-300">
                        {info.windCoverageHours !== null && (
                            <p>Wind imagery reaches +{hours(info.windCoverageHours)} h.</p>
                        )}
                        {info.rainCoverageHours !== null && (
                            <p>Rain imagery reaches +{hours(info.rainCoverageHours)} h.</p>
                        )}
                        <p>The hollow amber boat is a forecast estimate, not your live GPS position.</p>
                    </div>
                    <div className="space-y-1 border-t border-white/10 pt-2 text-xs text-slate-300">
                        <p data-testid="route-scrub-credit">Forecast data: {info.credited.join(', ')}</p>
                        <p>
                            Weather data via{' '}
                            <a
                                className="text-sky-300 underline"
                                href="https://open-meteo.com/"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Open-Meteo
                            </a>
                            {' · '}
                            <a
                                className="text-sky-300 underline"
                                href="https://creativecommons.org/licenses/by/4.0/"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                CC BY 4.0
                            </a>
                            . Route samples and the displayed model-spread band are processed by Thalassa.
                        </p>
                    </div>
                </>
            )}
            {squallVisible && (
                <div className="space-y-2 border-t border-white/10 pt-2">
                    <p className="text-xs text-slate-300">
                        Heavy-rain proxy · its own snapshot time, not the forecast boat’s future time.
                    </p>
                    <SquallLegend visible />
                </div>
            )}
        </section>
    );
};
