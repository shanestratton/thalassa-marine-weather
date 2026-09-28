import React from 'react';
import { AisLegend } from './AisLegend';
import { CruisingReferenceKey } from './CruisingReferenceKey';
import { SquallLegend } from './SquallLegend';
import { BlitzortungAttribution } from './BlitzortungAttribution';
import { RouteLegend } from './RouteLegend';
import { ChartKeyPanel } from './ChartKeyPanel';
import type { MooringColourFilter } from '../../services/anchorages/cruisingReference';

/** Non-weather entries share the weather panel's one collapsible key. */
export interface ObsLayerKeyProps {
    enc?: { imageryOn: boolean; tideDepthMode: boolean; draftConfigured: boolean; tideTimeLabel: string };
    ais: boolean;
    lightning: boolean;
    squall: boolean;
    storms: boolean;
    tides: boolean;
    moorings: boolean;
    anchorages: boolean;
    marks: boolean;
    protectedAreas: boolean;
    route: boolean;
    track: boolean;
    passage: boolean;
    forecastRoute: boolean;
    verificationStatus: 'idle' | 'pending' | 'verified' | 'unverified';
    referenceStatus: string;
    mooringFilter: MooringColourFilter;
    onMooringFilter: (value: MooringColourFilter) => void;
    tideStatus: { stationCount: number; loading: boolean; error: boolean; zoomRequired: boolean };
}

export function obsLayerKeyCount(props: ObsLayerKeyProps): number {
    return [
        Boolean(props.enc),
        props.ais,
        props.lightning,
        props.squall,
        props.storms,
        props.tides,
        props.moorings,
        props.anchorages,
        props.marks,
        props.protectedAreas,
        props.route,
        props.track,
        props.passage || props.forecastRoute,
    ].filter(Boolean).length;
}

function KeySection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section aria-label={`${title} key`} className="space-y-2 text-xs leading-relaxed text-slate-300">
            <h3 className="font-bold text-sky-200">{title}</h3>
            {children}
        </section>
    );
}

export function ObsLayerKey(props: ObsLayerKeyProps) {
    const tide = props.tideStatus;
    return (
        <div className="space-y-4" data-testid="obs-layer-key">
            {props.enc && <ChartKeyPanel visible inline {...props.enc} onClose={() => undefined} />}
            {props.ais && (
                <KeySection title="AIS">
                    <AisLegend visible embedded />
                </KeySection>
            )}
            {props.lightning && (
                <KeySection title="Lightning">
                    <BlitzortungAttribution visible />
                </KeySection>
            )}
            {props.squall && (
                <KeySection title="Squalls">
                    <SquallLegend visible />
                    <p>
                        Heavy precipitation can indicate squall activity; this layer does not measure gusts. Its
                        snapshot is independent of the forecast scrubber.
                    </p>
                </KeySection>
            )}
            {props.storms && (
                <KeySection title="Storms">
                    <p>
                        Tap a storm for its last reported position, intensity and track. Forecast segments appear only
                        where supplied by the provider; missing forecasts are not extrapolated.
                    </p>
                    <p className="text-amber-200">
                        An empty chart does not establish that no storms exist. Check the report time and official
                        warnings.
                    </p>
                </KeySection>
            )}
            {props.tides && (
                <KeySection title="Tide stations">
                    <p>
                        ≋ Teal wave square · a tide reference station. Tap for predictions, datum and any available wind
                        information—not a guarantee of a physical buoy.
                    </p>
                    <p
                        role={tide.error ? 'alert' : 'status'}
                        className={tide.error ? 'text-amber-200' : 'text-sky-200'}
                    >
                        {tide.zoomRequired
                            ? 'Zoom in to level 6 to show tide stations.'
                            : tide.loading
                              ? 'Loading nearby tide stations…'
                              : tide.error
                                ? 'Station search unavailable. Any retained stations are cached; retrying while open.'
                                : `${tide.stationCount} nearby stations loaded${tide.stationCount === 0 ? ' · coverage is not worldwide' : ''}.`}
                    </p>
                </KeySection>
            )}
            {(props.moorings || props.anchorages) && (
                <CruisingReferenceKey
                    embedded
                    moorings={props.moorings}
                    status={props.referenceStatus}
                    filter={props.mooringFilter}
                    onFilter={props.onMooringFilter}
                />
            )}
            {(props.route || props.track || props.passage) && (
                <KeySection title="Routes & tracks">
                    {(props.route || props.passage) && (
                        <p>
                            <span aria-hidden="true" style={{ color: '#a855f7' }}>
                                ━{' '}
                            </span>
                            Purple · planned route, not proof of a safe passage.
                        </p>
                    )}
                    {(props.track || props.passage) && (
                        <p>
                            <span aria-hidden="true" style={{ color: '#fbbf24' }}>
                                ━{' '}
                            </span>
                            Amber · recorded track already sailed.
                        </p>
                    )}
                    {props.passage && (
                        <p>
                            A hollow amber boat is a forecast estimate. A dashed join is unchecked, not a route to
                            steer.
                        </p>
                    )}
                </KeySection>
            )}
            {props.forecastRoute && <RouteLegend visible inline verificationStatus={props.verificationStatus} />}
            {props.marks && (
                <KeySection title="Sea marks">
                    <p>
                        Charted mark symbols follow their recorded type and colour. Tap to identify a mark; chart
                        sources may show their own symbols. Missing mapped marks do not mean clear water.
                    </p>
                </KeySection>
            )}
            {props.protectedAreas && (
                <KeySection title="Protected areas">
                    <p>
                        <span className="text-red-300">Red</span> · inferred high protection;{' '}
                        <span className="text-amber-300">amber</span> · conditional;{' '}
                        <span className="text-blue-300">blue</span> · multiple use.
                    </p>
                    <p>
                        Indicative CAPAD classes, not permissions. Tap for source/date and verify current fishing and
                        anchoring rules with the managing authority.
                    </p>
                </KeySection>
            )}
        </div>
    );
}
