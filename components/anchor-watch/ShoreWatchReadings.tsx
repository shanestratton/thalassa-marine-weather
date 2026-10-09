import React, { useMemo, type ReactNode } from 'react';
import type { PositionBroadcast } from '../../services/AnchorWatchSyncService';
import { liveAgeWords, readAnchorLiveConditions, type LiveDepthReference } from '../../services/anchorLiveConditions';
import type { DistanceUnit, LengthUnit, SpeedUnit } from '../../types/units';
import { convertSpeed } from '../../utils/units';
import { MuteIcon } from '../Icons';
import { anchorLengthParts, formatAnchorLength } from './anchorUtils';
import { shoreSwingModel, type ShoreTrailPoint } from './shoreSwingModel';
import { SwingCircleCanvas } from './SwingCircleCanvas';

interface ShoreWatchReadingsProps {
    data: PositionBroadcast;
    fresh: boolean;
    isAlarm: boolean;
    statusLabel: string;
    showMute: boolean;
    muted: boolean;
    onMute: () => void;
    /** The VIEWER's units, from this phone's Settings, never the boat's (126-03a). */
    lengthUnit: LengthUnit;
    speedUnit: SpeedUnit;
    /** Lengths past 1000 m read in this; NM unless the viewer chose km or miles. */
    distanceUnit?: DistanceUnit;
    /** Her trail as this phone heard it, half-minutes oldest first (ShoreSwingTrail). */
    trail: readonly ShoreTrailPoint[];
    /** The radar's bottom-left corner, kept for an action (126-07a's Move anchor). */
    radarAction?: ReactNode;
    /** For the live readings' ages; the page re-renders each second. */
    now?: number;
}

/** A time in the viewer's own clock, as the Last Update reading has it. */
const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const SPEED_LABEL: Record<SpeedUnit, string> = { kts: 'kn', mph: 'mph', kmh: 'km/h', mps: 'm/s' };
const DEPTH_LABEL: Record<LiveDepthReference, string> = {
    'below-keel': 'Depth below keel',
    'below-transducer': 'Depth below transducer',
    'below-surface': 'Depth below surface',
};

/** Presentation only: displaying a shore fix must never own the live watch. */
export function ShoreWatchReadings({
    data,
    fresh,
    isAlarm,
    statusLabel,
    showMute,
    muted,
    onMute,
    lengthUnit,
    speedUnit,
    distanceUnit = 'nm',
    trail,
    radarAction,
    now = Date.now(),
}: ShoreWatchReadingsProps) {
    // The Pi confirms successive breaches before raising its alarm. During
    // that interval, an outside-radius fix is not evidence of "Holding".
    // This is presentation only; do not bypass the watchkeeper's confirmation.
    const outsideRadius = fresh && !isAlarm && data.swingRadius > 0 && data.distance > data.swingRadius;
    const tone = isAlarm ? 'text-red-400' : fresh && !outsideRadius ? 'text-emerald-400' : 'text-amber-300';
    const accent = isAlarm ? '239,68,68' : fresh && !outsideRadius ? '16,185,129' : '245,158,11';
    const length = (metres: number, decimals = 0) =>
        formatAnchorLength(metres, lengthUnit, { decimals, long: distanceUnit });
    // The broadcast and the trail change only when a position arrives, so the
    // radar is not redrawn from scratch on the page's one-second tick.
    const model = useMemo(() => shoreSwingModel(data, trail, isAlarm), [data, trail, isAlarm]);
    const distance = anchorLengthParts(data.distance, lengthUnit, { long: distanceUnit });
    // Only the newest stretch heard without a gap is drawn (shoreSwingModel),
    // so the note says when it starts, not "since this phone started listening".
    const trailSince = model.trailSince !== null ? clock(model.trailSince) : null;

    const metrics: { label: string; value: string; age?: string | null }[] = [
        { label: 'Swing Radius', value: length(data.swingRadius) },
        {
            label: 'Rode',
            value: data.config?.rodeLength !== undefined ? length(data.config.rodeLength) : '--',
        },
        {
            label: 'Depth',
            value: data.config?.waterDepth !== undefined ? length(data.config.waterDepth, 1) : '--',
        },
        {
            label: fresh ? 'Last Update' : 'Last-Known Update',
            value: clock(data.timestamp),
        },
    ];
    // The boat's own sounder and wind (126-05), only while the Pi sends them:
    // no row, not '--', for a phone-kept watch or an older Pi.
    const live = readAnchorLiveConditions(data.live, now);
    if (live.depth) {
        metrics.push({
            label: (live.depth.reference && DEPTH_LABEL[live.depth.reference]) || 'Sounder depth',
            value: length(live.depth.value, 1),
            age: liveAgeWords(live.depth.ageMs),
        });
    }
    if (live.tws || live.twd) {
        const speed = live.tws && `${convertSpeed(live.tws.value, speedUnit)} ${SPEED_LABEL[speedUnit] ?? 'kn'}`;
        const direction = live.twd && `${String(Math.round(live.twd.value) % 360).padStart(3, '0')}°T`;
        metrics.push({
            label: 'Wind',
            value: [speed, direction].filter(Boolean).join(' · '),
            age: liveAgeWords(Math.max(live.tws?.ageMs ?? 0, live.twd?.ageMs ?? 0)),
        });
    }

    const radarLabel =
        `Shore Watch radar${fresh ? '' : ', last-known'}${isAlarm ? ', drag alarm' : ''}. ` +
        `The boat ${fresh ? 'is' : 'was'} ${length(data.distance)} from the anchor; swing radius ${length(data.swingRadius)}.` +
        (trailSince ? ` Her trail since ${trailSince} is drawn.` : '');

    return (
        <section
            aria-label="Vessel anchor readings"
            className={`mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-2 [@media(max-height:500px)]:max-w-3xl [@media(max-height:500px)]:flex-row [@media(max-height:500px)]:items-center [@media(max-height:500px)]:gap-4`}
        >
            {/* The real radar (the boat's own), filling what the readings leave:
                at least 8rem, at most 16rem high. The distance has its own column
                beside the canvas, never over it: on a small radar it sat on the
                circle's north-west arc, over the boat when she lay there. In
                landscape, a square canvas with the column, beside the readings. */}
            <div className="relative flex min-h-32 w-full max-h-64 flex-1 overflow-hidden rounded-2xl bg-slate-900/40 [@media(max-height:500px)]:h-[clamp(8rem,40dvh,16rem)] [@media(max-height:500px)]:max-h-none [@media(max-height:500px)]:w-auto [@media(max-height:500px)]:flex-none">
                {/* The distance stays big, labelled above like the readings below.
                    The radar's own label says it all for a screen reader. */}
                <div
                    data-testid="shore-radar-distance"
                    aria-hidden="true"
                    className="pointer-events-none max-w-[40%] shrink-0 py-2 pl-2.5 pr-1 [@media(max-height:500px)]:max-w-[7rem]"
                >
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                        {fresh ? 'from anchor' : 'last-known from anchor'}
                    </div>
                    <div
                        className={`mt-0.5 flex flex-wrap items-baseline font-mono text-[clamp(1.75rem,5dvh,2.75rem)] font-black leading-none tracking-tight tabular-nums ${isAlarm ? 'text-red-400' : 'text-slate-100'}`}
                    >
                        {distance.value}
                        <span className="ml-1 text-lg">{distance.unit}</span>
                    </div>
                </div>
                <div className="relative min-w-0 flex-1 [@media(max-height:500px)]:aspect-square [@media(max-height:500px)]:h-full [@media(max-height:500px)]:flex-none">
                    <SwingCircleCanvas
                        model={model}
                        ariaLabel={radarLabel}
                        fitRose
                        className={`absolute inset-0 h-full w-full ${fresh ? '' : 'opacity-60'}`}
                    />
                </div>
                {/* The frame is drawn over the whole box, the distance's column and the canvas. */}
                <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-0 rounded-2xl ${isAlarm && fresh ? 'border-2 border-red-400/60 motion-safe:animate-pulse' : 'border'}`}
                    style={isAlarm && fresh ? undefined : { borderColor: `rgba(${accent},0.3)` }}
                />
                {radarAction && (
                    <div data-testid="shore-radar-action" className="absolute bottom-1.5 left-1.5">
                        {radarAction}
                    </div>
                )}
            </div>
            <div
                className={`flex w-full min-w-0 shrink-0 flex-col items-center gap-2 [@media(max-height:500px)]:flex-1`}
            >
                {/* The trail's note rides beside the status, a short line no taller
                    than the pill, so it costs the radar no height. */}
                <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1">
                    <div
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        className={`inline-flex max-w-full items-center gap-2 rounded-full border px-4 py-1.5 text-center text-sm font-black uppercase tracking-wider ${tone}`}
                        style={{ borderColor: `rgba(${accent},0.25)`, background: `rgba(${accent},0.08)` }}
                    >
                        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-current" />
                        {outsideRadius ? 'Outside radius · checking' : statusLabel}
                    </div>
                    {trailSince && (
                        <p className="text-[0.6875rem] font-medium leading-tight text-slate-400">
                            {`Trail since ${trailSince}`}
                        </p>
                    )}
                </div>
                {showMute && (
                    <button
                        type="button"
                        aria-label="Mute alarm on this device only"
                        disabled={muted}
                        onClick={onMute}
                        className="min-h-11 w-full rounded-2xl border border-red-400/30 bg-red-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-70"
                    >
                        <span className="inline-flex items-center justify-center gap-2">
                            <MuteIcon className="h-4 w-4" />
                            {muted ? 'Muted on this device only' : 'Mute this device only'}
                        </span>
                        <span className="mt-1 block text-xs font-medium text-red-100">
                            The vessel’s watch continues.
                        </span>
                    </button>
                )}
                <dl aria-label="Shore Watch metrics" className="grid w-full grid-cols-2 gap-2">
                    {metrics.map(({ label, value, age }) => (
                        <div
                            key={label}
                            className="min-w-0 rounded-2xl border border-white/8 bg-slate-800/40 px-2 py-1.5 text-center"
                        >
                            <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
                            <dd className="mt-0.5 text-xl font-bold leading-tight text-slate-100 tabular-nums">
                                {value}
                                {age && (
                                    <>
                                        {' '}
                                        <span className="block text-xs font-medium text-amber-300">({age})</span>
                                    </>
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
        </section>
    );
}
