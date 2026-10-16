import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { CmemsAttribution, type CmemsLayerId } from './CmemsAttribution';
import { BlitzortungAttribution } from './BlitzortungAttribution';
import { SatelliteIrCredit } from './SatelliteIrCredit';
import type { SatIrState } from './useSatelliteLayer';
import { satIrCoverageNote, satIrAgeLabel } from './satelliteImagery';
import { AisCoverageNotice } from './AisCoverageNotice';
import { aisCoverageText, useAisCoverage } from '../../services/ais/aisCoverage';
import { subscribeLightningStatus, type StatusSnapshot } from '../../services/weather/api/blitzortungLightning';
import { openExternalUrl } from '../../services/externalLinks';
import { CREDITS_STRIP_POSITION_CLASS } from './creditsStrip';

export interface ObsCreditsRollupProps {
    rain: 'radar' | 'forecast' | null;
    wind: string | null;
    cmems: readonly CmemsLayerId[];
    lightning: boolean;
    satellite: SatIrState;
    ais: boolean;
    onToggleSatellite: () => void;
}
/** Presentation only: subscribes to existing feed status, never starts a layer or makes a data request. */
export default function ObsCreditsRollup({
    rain,
    wind,
    cmems,
    lightning,
    satellite,
    ais,
    onToggleSatellite,
}: ObsCreditsRollupProps) {
    const [open, setOpen] = React.useState(false),
        [now, setNow] = React.useState(Date.now),
        [lightningStatus, setLightningStatus] = React.useState<StatusSnapshot | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    const coverage = useAisCoverage();
    React.useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(t);
    }, []);
    React.useEffect(() => {
        if (!lightning) {
            setLightningStatus(null);
            return;
        }
        return subscribeLightningStatus(setLightningStatus);
    }, [lightning]);
    const satelliteOn = satellite.status !== 'off',
        satelliteWarning =
            satelliteOn &&
            (satellite.status !== 'ready' ||
                satellite.coverage.outside ||
                !!satIrCoverageNote(satellite.coverage) ||
                satellite.frameTimeMs === null ||
                satellite.frameTimeMs > now + 60000 ||
                now - satellite.frameTimeMs > 3 * 3600000),
        aisTime = Date.parse(coverage.polledAt ?? ''),
        aisWarning =
            ais &&
            (coverage.state !== 'recent' ||
                coverage.truncated ||
                !Number.isFinite(aisTime) ||
                now - aisTime > 900000 ||
                aisTime > now + 60000),
        lightningWarning = lightning && lightningStatus?.status !== 'open',
        warning = satelliteWarning || aisWarning || lightningWarning;
    const active = !!rain || !!wind || cmems.length > 0 || lightning || satelliteOn || ais;
    React.useEffect(() => {
        if (!active) setOpen(false);
    }, [active]);
    if (!active) return null;
    const rainUrl = rain === 'radar' ? 'https://www.rainviewer.com/' : 'https://rainbow.ai/';
    const linkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void openExternalUrl(rainUrl);
    };
    const warnings = [
        satelliteWarning
            ? `Satellite ${satellite.status}; ${satellite.frameTimeMs === null ? 'frame time unknown' : satellite.frameTimeMs > now + 60000 ? 'frame time is in the future' : satIrAgeLabel(satellite.frameTimeMs, now)}. ${satIrCoverageNote(satellite.coverage) ?? ''}`
            : null,
        aisWarning ? aisCoverageText(coverage, now) : null,
        lightningWarning
            ? `Lightning feed ${lightningStatus?.status ?? 'connecting'}; absence is not clear sky.`
            : null,
    ]
        .filter(Boolean)
        .join(' ');
    return (
        <>
            <div
                data-map-credit
                data-testid="obs-credits-rollup"
                className={`${CREDITS_STRIP_POSITION_CLASS} z-520 flex h-[44px] max-w-[calc(100%-152px)] items-center overflow-hidden rounded-lg ring-1 ring-white/15 bg-slate-950/90 px-[4px] text-[12px] text-slate-100 shadow-lg`}
                // Follow the base picker's h-12 (3rem) and its 44px minimum.
                // Leave 6px beneath it and keep both side emergency/control columns clear.
                style={{ top: 'calc(env(safe-area-inset-top) + max(44px, 3rem) + 14px)' }}
            >
                <button
                    type="button"
                    aria-expanded={open}
                    aria-haspopup="dialog"
                    aria-label={warning ? 'Credits; layer status needs review' : 'Credits'}
                    className="h-[44px] shrink-0 whitespace-nowrap px-[6px] font-semibold"
                    onClick={() => setOpen(true)}
                >
                    Credits
                    {warning && (
                        <span aria-hidden className="ml-1 text-amber-300">
                            !
                        </span>
                    )}
                </button>
                {rain && (
                    <a
                        href={rainUrl}
                        onClick={linkClick}
                        aria-label={
                            rain === 'radar' ? 'Rain radar data by RainViewer' : 'Rain forecast imagery by Rainbow.ai'
                        }
                        className="inline-flex h-[44px] min-w-0 items-center whitespace-nowrap border-l border-white/15 px-[6px] underline underline-offset-2"
                    >
                        {rain === 'radar' ? 'RainViewer' : 'Rainbow.ai'}
                    </a>
                )}
            </div>
            {open && (
                <ModalSheet isOpen title="Map credits & source status" onClose={close} zIndex="z-[10090]" fitViewport>
                    <div
                        data-map-credit
                        className="space-y-4 p-4 text-sm leading-relaxed text-slate-200 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:text-xs"
                        onClick={(event) => {
                            if (event.defaultPrevented) return;
                            const a = event.target instanceof Element ? event.target.closest('a[href]') : null;
                            if (a instanceof HTMLAnchorElement && ['https:', 'http:'].includes(a.protocol)) {
                                event.preventDefault();
                                void openExternalUrl(a.href);
                            }
                        }}
                    >
                        <p>
                            Credits for the layers currently shown. Mapbox and map-source credits remain in the map's
                            own attribution control.
                        </p>
                        {warning && (
                            <p className="text-amber-200" role="status">
                                {warnings}
                            </p>
                        )}
                        {rain && (
                            <section aria-label="Rain source">
                                <h4 className="font-bold text-sky-200">Rain imagery</h4>
                                <p>
                                    {rain === 'radar'
                                        ? 'Weather radar data by RainViewer. Radar mosaics can be delayed or incomplete.'
                                        : 'Rain forecast imagery by Rainbow.ai; a model estimate, not observed radar.'}
                                </p>
                                <a className="inline-flex min-h-11 items-center underline" href={rainUrl}>
                                    {rain === 'radar' ? 'RainViewer' : 'Rainbow.ai'}
                                </a>
                            </section>
                        )}
                        {wind && (
                            <section aria-label="Wind source">
                                <h4 className="font-bold text-sky-200">Wind</h4>
                                <p>{wind}</p>
                            </section>
                        )}
                        {cmems.length > 0 && <CmemsAttribution layers={cmems} inline />}
                        {lightning && (
                            <section aria-label="Lightning source">
                                <BlitzortungAttribution visible />
                            </section>
                        )}
                        {satelliteOn && (
                            <section aria-label="Satellite source">
                                <SatelliteIrCredit state={satellite} inline top="" onTogglePlay={onToggleSatellite} />
                                <p className="mt-2 text-xs text-slate-400">
                                    Colours added by Thalassa; a derived display, not an unaltered NOAA product.
                                </p>
                            </section>
                        )}
                        {ais && (
                            <section aria-label="Internet AIS source">
                                <h4 className="font-bold text-sky-200">Internet AIS</h4>
                                <AisCoverageNotice />
                            </section>
                        )}
                        <p className="text-xs text-slate-400">
                            An empty layer or unavailable feed does not establish clear conditions. Source credits do
                            not establish chart coverage or navigational accuracy.
                        </p>
                    </div>
                </ModalSheet>
            )}
        </>
    );
}
