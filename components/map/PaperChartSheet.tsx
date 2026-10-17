import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { chartSourceCovers, type ChartSource, type ChartSourceId } from '../../services/ChartCatalogService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { noaaAgreementAccepted } from '../../services/enc/noaaAgreement';
import { DISPLAY_CATEGORIES, type ChartDisplayCategory } from './chartDisplayCategory';
import ChartContourControls, { type ChartContourControlsProps } from './ChartContourControls';
const Agreement = React.lazy(() => import('./NoaaAgreementSheet'));
const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40';
export interface PaperChartSheetProps {
    onClose: () => void;
    bounds: [number, number, number, number] | null;
    sources: ChartSource[];
    onToggle: (id: ChartSourceId) => void;
    onOpacity: (id: ChartSourceId, value: number) => void;
    onConsent: () => void;
    category: ChartDisplayCategory | null;
    onCategory: (category: ChartDisplayCategory) => void;
    satelliteMode: boolean;
    onCatalogue?: () => void;
    onFindChart?: () => void;
    onLocalCharts?: () => void;
    onUserOverlays?: () => void;
    onDrawingTools?: () => void;
    drawingToolsDisabled?: boolean;
    contours?: ChartContourControlsProps;
    notices?: { enabled: boolean; onChange: (enabled: boolean) => void };
}
export default function PaperChartSheet(props: PaperChartSheetProps) {
    const [pending, setPending] = React.useState<ChartSourceId | null>(null);
    const live = React.useRef(true);
    const scopeAtOpen = React.useRef(getAuthIdentityScope());
    React.useEffect(() => {
        live.current = true;
        const unsubscribe = subscribeAuthIdentityScope(props.onClose);
        return () => {
            live.current = false;
            unsubscribe();
        };
    }, [props.onClose]);
    const available = props.sources.filter(
        (s) => ['noaa-ncds', 'linz-charts'].includes(s.id) && chartSourceCovers(s, props.bounds),
    );
    async function toggle(source: ChartSource) {
        const scope = getAuthIdentityScope();
        if (!source.enabled && source.id.startsWith('noaa-') && !(await noaaAgreementAccepted())) {
            if (live.current && isAuthIdentityScopeCurrent(scope)) setPending(source.id);
            return;
        }
        if (live.current && isAuthIdentityScopeCurrent(scope)) props.onToggle(source.id);
    }
    return (
        <>
            <ModalSheet isOpen onClose={props.onClose} title="Charts & detail" maxWidth="max-w-lg" zIndex="z-10060">
                <div className="min-w-0 space-y-4 text-sm text-slate-200">
                    <fieldset className="space-y-2">
                        <legend className="font-bold">ENC display category</legend>
                        <div className="grid grid-cols-3 gap-2">
                            {DISPLAY_CATEGORIES.map((category) => (
                                <button
                                    key={category}
                                    type="button"
                                    aria-pressed={props.category === category}
                                    className={`${button} capitalize ${props.category === category ? 'bg-sky-900 text-sky-100' : ''}`}
                                    onClick={() => props.onCategory(category)}
                                >
                                    {category[0].toUpperCase() + category.slice(1)}
                                </button>
                            ))}
                        </div>
                        <p className="text-xs text-slate-400">
                            S-52 category presets mapped to this app’s detail slider. Depth bands, safety contour,
                            hazards and isolated-danger marks remain.{' '}
                            {props.category === null ? 'The slider has a custom setting.' : ''}
                        </p>
                    </fieldset>
                    {props.notices && (
                        <section className="space-y-2" aria-label="Browsing notices">
                            <label className="flex min-h-[44px] items-center gap-2">
                                <input
                                    type="checkbox"
                                    className="h-5 w-5 shrink-0"
                                    checked={props.notices.enabled}
                                    onChange={(event) => {
                                        if (isAuthIdentityScopeCurrent(scopeAtOpen.current))
                                            props.notices?.onChange(event.target.checked);
                                    }}
                                />
                                Notices on Obs
                            </label>
                            <p className="text-xs text-slate-400">
                                Visible area only from zoom 9. Available geolocated listings are incomplete; no icon
                                does not mean no warnings. Read the issuer’s current notice.
                            </p>
                        </section>
                    )}
                    {props.contours && <ChartContourControls {...props.contours} />}
                    <section className="space-y-3" aria-label="Paper chart">
                        <h3 className="font-bold">Paper chart</h3>
                        <p className="text-xs">
                            Sources for the camera’s current region only. Coverage and compilation scale vary within
                            each region. Selecting an overlay keeps the camera in place.
                        </p>
                        {props.satelliteMode && (
                            <p role="status" className="text-amber-200">
                                Paper images paused in Satellite Mode. Use downloaded free ENC cells for offline charts.
                            </p>
                        )}
                        {available.length === 0 && <p>No paper chart source covers this camera region.</p>}
                        {available.map((source) => (
                            <div key={source.id} className="space-y-2 rounded-xl border border-white/15 p-3">
                                <button
                                    type="button"
                                    className={`${button} w-full text-left`}
                                    aria-pressed={source.enabled}
                                    disabled={!source.tileUrl || (props.satelliteMode && !source.enabled)}
                                    onClick={() => void toggle(source)}
                                >
                                    {source.name} · {source.enabled ? 'Selected' : 'Off'}
                                </button>
                                {source.enabled && (
                                    <label className="block">
                                        {source.name} opacity {Math.round(source.opacity * 100)}%
                                        <input
                                            className="block h-11 w-full"
                                            type="range"
                                            min="0.1"
                                            max="1"
                                            step="0.05"
                                            value={source.opacity}
                                            aria-label={`${source.name} opacity`}
                                            onChange={(event) => props.onOpacity(source.id, Number(event.target.value))}
                                        />
                                    </label>
                                )}
                                {source.id.startsWith('noaa-') ? (
                                    <p className="text-xs">
                                        <a
                                            className="underline text-sky-300"
                                            href="https://charts.noaa.gov/ENCs/"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            NOAA Office of Coast Survey · source
                                        </a>
                                        . Derived display, not official ENC or a certified navigation system. NOAA
                                        updates the source weekly; this overlay is not an edition check for your
                                        installed cells.
                                    </p>
                                ) : (
                                    <p className="text-xs">
                                        <a
                                            className="underline text-sky-300"
                                            href="https://data.linz.govt.nz/"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            © Land Information New Zealand · CC BY4.0
                                        </a>
                                        . Raster chart images; local notices and source date still need checking.
                                    </p>
                                )}
                            </div>
                        ))}
                    </section>
                    {props.onDrawingTools && (
                        <button
                            type="button"
                            className={`${button} w-full text-sky-200`}
                            disabled={props.drawingToolsDisabled}
                            onClick={(event) => {
                                event.currentTarget.focus({ preventScroll: true });
                                if (isAuthIdentityScopeCurrent(scopeAtOpen.current)) props.onDrawingTools?.();
                            }}
                        >
                            Draw on chart · ruler / annotations
                        </button>
                    )}
                    {props.onUserOverlays && (
                        <button
                            type="button"
                            className={`${button} w-full text-sky-200`}
                            onClick={(event) => {
                                event.currentTarget.focus({ preventScroll: true });
                                if (isAuthIdentityScopeCurrent(scopeAtOpen.current)) props.onUserOverlays?.();
                            }}
                        >
                            Your overlays · import / manage
                        </button>
                    )}
                    {props.onLocalCharts && (
                        <button
                            type="button"
                            className={`${button} w-full text-sky-200`}
                            onClick={(event) => {
                                event.currentTarget.focus({ preventScroll: true });
                                if (isAuthIdentityScopeCurrent(scopeAtOpen.current)) props.onLocalCharts?.();
                            }}
                        >
                            Import a chart file · your saved charts
                        </button>
                    )}
                    {props.onFindChart && (
                        <button
                            type="button"
                            className={`${button} w-full text-sky-200`}
                            onClick={(event) => {
                                event.currentTarget.focus({ preventScroll: true });
                                props.onFindChart?.();
                            }}
                        >
                            Find on chart · lights, marks, places
                        </button>
                    )}
                    {props.onCatalogue && (
                        <button type="button" className={`${button} w-full text-sky-200`} onClick={props.onCatalogue}>
                            Free NOAA ENC catalogue · download / update
                        </button>
                    )}
                    <p className="text-xs text-slate-400">
                        An overlay selection does not prove a chart has loaded. If the source is unavailable or this
                        area has no chart, use the chart’s coverage notices. No paper-image offline pack is downloaded
                        here.
                    </p>
                </div>
            </ModalSheet>
            <React.Suspense fallback={null}>
                {pending && (
                    <Agreement
                        onClose={() => setPending(null)}
                        onAccepted={() => {
                            const source = props.sources.find((s) => s.id === pending);
                            if (source && !source.enabled) props.onToggle(source.id);
                            props.onConsent();
                            setPending(null);
                        }}
                    />
                )}
            </React.Suspense>
        </>
    );
}
