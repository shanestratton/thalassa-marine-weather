/**
 * SkewTChart — the Sounding sheet's skew-T log-P diagram (build 125, SND).
 *
 * Ported from the approved mock-up (make.py): isotherms, dry and moist
 * adiabats, the temperature and dewpoint lines with a dot per level, the
 * surface parcel dashed with its positive area shaded, the cloud base and any
 * dry lid marked, pressure labels on the left, temperatures along the bottom
 * and wind barbs down the right, thinned within 18 px. The legend is the
 * sheet's, under the diagram, as in the mock-up. Colours are the
 * sheet's tokens (soundingSheet.css), so day, dark and the red night palette
 * all come from one drawing.
 *
 * Barbs follow the WMO convention: feathers on the low-pressure side, so
 * south of the equator they sit on the other side of the staff (as on the
 * Bureau's and MetService's charts) and a westerly's feathers point south.
 *
 * The diagram is drawn at its slot's real pixel size, so text stays at the
 * app's 12 px floor and the chart grows or shrinks with the screen instead of
 * scrolling. The skew
 * is the mock-up's 0.55 at its own 278 × 394 plot, held as a temperature
 * shift (≈62 °C over the full height) so a short phone keeps the profile in
 * the same place rather than clipping the dry upper-air dewpoints.
 */
import React, { useId, useMemo } from 'react';
import type { SpeedUnit, TempUnit } from '../../types/units';
import {
    barbParts,
    dryLid,
    fromKmh,
    lclBolton,
    moistAscent,
    parcelPath,
    temperatureAt,
    type SoundingLevel,
} from '../../services/weather/sounding/soundingMath';
import { SPEED_LABEL } from '../../services/weather/sounding/soundingReadings';

/** Room for "1000" and "-40°" at 12 px beside and under the plot, and the barbs to its right. */
const MARGIN = { left: 38, right: 46, top: 10, bottom: 22 };
/** The labels' size (soundingSheet.css .snd-ax/.snd-ann) and the gap that keeps two apart. */
const LABEL_PX = 12;
const P_MAX = 1050;
const P_MIN = 200;
const T_MIN = -40;
const T_SPAN = 80;
/** 0.55 px per px at the mock-up's 278 × 394 plot, as degrees across the full height. */
const SKEW_C = (0.55 * 394 * T_SPAN) / 278;
const LOG_SPAN = Math.log(P_MAX) - Math.log(P_MIN);

export interface SkewTProps {
    profile: SoundingLevel[];
    width: number;
    height: number;
    speedUnit: SpeedUnit;
    tempUnit: TempUnit;
    /** "cloud base ≈ 650 m", drawn on the LCL line. */
    cloudBaseText: string;
    /** "trade lid (dry above)", drawn in the lid's band. */
    lidText: string;
    /** South of the equator: barb feathers on the other side of the staff (WMO). */
    southern?: boolean;
}

interface Frame {
    w: number;
    h: number;
    pw: number;
    ph: number;
}

const up = (f: Frame, p: number) => ((Math.log(P_MAX) - Math.log(p)) / LOG_SPAN) * f.ph;
const yOf = (f: Frame, p: number) => MARGIN.top + f.ph - up(f, p);
const xOf = (f: Frame, t: number, p: number) =>
    MARGIN.left + ((t - T_MIN + (SKEW_C * up(f, p)) / f.ph) * f.pw) / T_SPAN;

const pathOf = (points: [number, number][]) =>
    points.length ? `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}` : '';

/** The background: isotherms, dry adiabats, moist adiabats. Depends on the size only. */
function grid(f: Frame) {
    const isotherms: { t: number; d: string }[] = [];
    for (let t = -110; t <= 40; t += 10)
        isotherms.push({
            t,
            d: pathOf([
                [xOf(f, t, P_MAX), yOf(f, P_MAX)],
                [xOf(f, t, P_MIN), yOf(f, P_MIN)],
            ]),
        });
    const dry: string[] = [];
    for (let theta = -30; theta <= 110; theta += 10) {
        const pts: [number, number][] = [];
        for (let p = P_MAX; p >= P_MIN; p -= 10)
            pts.push([xOf(f, (theta + 273.15) * (p / 1000) ** 0.2857 - 273.15, p), yOf(f, p)]);
        dry.push(pathOf(pts));
    }
    const moist: string[] = [];
    for (const tw of [0, 8, 16, 24, 30]) {
        const pts: [number, number][] = [[xOf(f, tw, 1000), yOf(f, 1000)]];
        let t = tw;
        for (let p = 1000; p > P_MIN; p -= 5) {
            t = moistAscent(t, p, p - 5);
            pts.push([xOf(f, t, p - 5), yOf(f, p - 5)]);
        }
        moist.push(pathOf(pts));
    }
    return { isotherms, dry, moist };
}

/**
 * One barb: the staff points to where the wind comes from; 50 kt pennants,
 * 10 kt and 5 kt feathers, on the staff's low-pressure side (clockwise of it
 * north of the equator, anticlockwise south of it).
 */
function Barb({
    x,
    y,
    kmh,
    from,
    unit,
    p,
    southern,
}: {
    x: number;
    y: number;
    kmh: number;
    from: number;
    unit: SpeedUnit;
    p: number;
    southern: boolean;
}) {
    const parts = barbParts(kmh, 'kmh');
    // The barb itself is drawn in knots whatever the skipper reads: its title says so.
    const drawn = unit === 'kts' ? '' : `, drawn as ${parts.knots} kt`;
    const label = `${Math.round(p)} hPa: ${Math.round(fromKmh(kmh, unit))} ${SPEED_LABEL[unit]} from ${Math.round(from)}°${drawn}`;
    if (parts.calm)
        return (
            <g data-barb={`${Math.round(p)} hPa`}>
                <title>{label}</title>
                <circle className="snd-barb" cx={x} cy={y} r={3} fill="none" />
            </g>
        );
    const a = (from * Math.PI) / 180;
    const ux = Math.sin(a);
    const uy = -Math.cos(a);
    const ex = x + ux * 20;
    const ey = y + uy * 20;
    const side = southern ? -1 : 1;
    const px = -uy * side;
    const py = ux * side;
    const marks: React.ReactNode[] = [];
    let pos = 0;
    for (let i = 0; i < parts.pennants; i++, pos += 6) {
        const bx = ex - ux * pos;
        const by = ey - uy * pos;
        marks.push(
            <path
                key={`p${i}`}
                className="snd-pennant"
                d={`M${bx.toFixed(1)},${by.toFixed(1)}L${(bx + px * 8).toFixed(1)},${(by + py * 8).toFixed(1)}L${(bx - ux * 4).toFixed(1)},${(by - uy * 4).toFixed(1)}Z`}
            />,
        );
    }
    for (let i = 0; i < parts.full; i++, pos += 3.5) {
        const bx = ex - ux * pos;
        const by = ey - uy * pos;
        marks.push(
            <line
                key={`f${i}`}
                className="snd-barb"
                x1={bx}
                y1={by}
                x2={bx + px * 8 + ux * 2}
                y2={by + py * 8 + uy * 2}
            />,
        );
    }
    if (parts.half) {
        pos = Math.max(pos, 3.5);
        const bx = ex - ux * pos;
        const by = ey - uy * pos;
        marks.push(
            <line key="h" className="snd-barb" x1={bx} y1={by} x2={bx + px * 4.5 + ux} y2={by + py * 4.5 + uy} />,
        );
    }
    return (
        <g data-barb={`${Math.round(p)} hPa`} data-feathers={southern ? 'south' : 'north'}>
            <title>{label}</title>
            <line className="snd-barb" x1={x} y1={y} x2={ex} y2={ey} />
            {marks}
        </g>
    );
}

export const SkewTChart: React.FC<SkewTProps> = ({
    profile,
    width,
    height,
    speedUnit,
    tempUnit,
    cloudBaseText,
    lidText,
    southern = false,
}) => {
    const clipId = `snd-plot-${useId().replace(/:/g, '')}`;
    const f: Frame = useMemo(
        () => ({
            w: width,
            h: height,
            pw: Math.max(60, width - MARGIN.left - MARGIN.right),
            ph: Math.max(60, height - MARGIN.top - MARGIN.bottom),
        }),
        [width, height],
    );
    const background = useMemo(() => grid(f), [f]);

    const drawing = useMemo(() => {
        const s = profile[0];
        const lcl = lclBolton(s.t, s.td, s.p);
        const lid = dryLid(profile);
        const parcel = parcelPath({ p: s.p, t: s.t, td: s.td }, 250, 5);
        // The positive area, one polygon per run where the parcel is warmer than the air.
        const cape: string[] = [];
        let run: { p: number; t: number; env: number }[] = [];
        const flush = () => {
            if (run.length > 2)
                cape.push(
                    `${pathOf([
                        ...run.map((q): [number, number] => [xOf(f, q.t, q.p), yOf(f, q.p)]),
                        ...[...run].reverse().map((q): [number, number] => [xOf(f, q.env, q.p), yOf(f, q.p)]),
                    ])}Z`,
                );
            run = [];
        };
        for (const q of parcel) {
            const env = temperatureAt(profile, q.p);
            if (env != null && q.t > env) run.push({ ...q, env });
            else flush();
        }
        flush();
        return { lcl, lid, parcel, cape };
    }, [profile, f]);

    const right = MARGIN.left + f.pw;
    const bottom = MARGIN.top + f.ph;
    const lclY = yOf(f, drawing.lcl.pHpa);
    const showLcl = drawing.lcl.pHpa >= P_MIN && drawing.lcl.pHpa <= P_MAX;

    // Pressure labels, dropping any that would sit on top of the one below.
    const pressureLabels: number[] = [];
    let lastLabelY = Infinity;
    for (const p of [1000, 850, 700, 500, 400, 300, 250]) {
        const y = yOf(f, p);
        if (lastLabelY - y < LABEL_PX + 1) continue;
        pressureLabels.push(p);
        lastLabelY = y;
    }
    // Temperatures along the bottom, every 10 °C, or every 20 °C when they would crowd.
    const step = (10 * f.pw) / T_SPAN < 34 ? 20 : 10;
    const tempLabels = [-30, -20, -10, 0, 10, 20, 30].filter((t) => t % step === 0);
    const tempText = (t: number) => `${tempUnit === 'F' ? Math.round(t * 1.8 + 32) : t}°`;

    // Barbs at each level with a wind, thinned within 18 px.
    const barbs: React.ReactNode[] = [];
    let lastBarbY: number | null = null;
    for (const q of profile) {
        if (q.windKmh == null || q.windFrom == null) continue;
        const y = yOf(f, q.p);
        if (lastBarbY != null && Math.abs(y - lastBarbY) < 18) continue;
        barbs.push(
            <Barb
                key={q.p}
                x={right + 22}
                y={y}
                kmh={q.windKmh}
                from={q.windFrom}
                unit={speedUnit}
                p={q.p}
                southern={southern}
            />,
        );
        lastBarbY = y;
    }

    // The cloud-base label under its line, or over it when the line is at the foot of the plot;
    // the lid's label inside its band, or over the band when the two would touch.
    const below = LABEL_PX + 1;
    const cloudLabelY = !showLcl ? null : lclY + below < bottom - 1 ? lclY + below : lclY - 3;
    const lid = drawing.lid;
    let lidLabelY: number | null = null;
    if (lid) {
        const inside = yOf(f, lid.topHpa) + below;
        const above = yOf(f, lid.topHpa) - 3;
        const clear = (y: number) => cloudLabelY == null || Math.abs(y - cloudLabelY) >= LABEL_PX + 2;
        if (inside < bottom - 1 && clear(inside)) lidLabelY = inside;
        else if (above - LABEL_PX > MARGIN.top && clear(above)) lidLabelY = above;
    }

    const temps = profile.map((q): [number, number] => [xOf(f, q.t, q.p), yOf(f, q.p)]);
    const dews = profile.map((q): [number, number] => [xOf(f, q.td, q.p), yOf(f, q.p)]);
    const top = profile[profile.length - 1];

    return (
        <svg
            className="snd-chart-svg"
            role="img"
            aria-label={`Skew-T diagram: temperature, dewpoint and rising air from the surface to ${Math.round(top.p)} hPa`}
            viewBox={`0 0 ${f.w} ${f.h}`}
            width={f.w}
            height={f.h}
        >
            <defs>
                <clipPath id={clipId}>
                    <rect x={MARGIN.left} y={MARGIN.top} width={f.pw} height={f.ph} />
                </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`}>
                {background.isotherms.map(({ t, d }) => (
                    <path key={t} className={t === 0 ? 'snd-iso snd-iso0' : 'snd-iso'} d={d} />
                ))}
                {background.dry.map((d, i) => (
                    <path key={`d${i}`} className="snd-dry" d={d} />
                ))}
                {background.moist.map((d, i) => (
                    <path key={`m${i}`} className="snd-moist" d={d} />
                ))}
                {lid && (
                    <rect
                        className="snd-lidband"
                        x={MARGIN.left}
                        y={yOf(f, lid.topHpa)}
                        width={f.pw}
                        height={yOf(f, lid.baseHpa) - yOf(f, lid.topHpa)}
                    />
                )}
                {drawing.cape.map((d, i) => (
                    <path key={`c${i}`} className="snd-cape" d={d} />
                ))}
                <path
                    data-line="parcel"
                    className="snd-parcel"
                    d={pathOf(drawing.parcel.map((q): [number, number] => [xOf(f, q.t, q.p), yOf(f, q.p)]))}
                />
                <path data-line="dewpoint" className="snd-dew" d={pathOf(dews)} />
                <path data-line="temperature" className="snd-temp" d={pathOf(temps)} />
                {profile.map((q, i) => (
                    <g key={q.p}>
                        <circle className="snd-tdot" cx={temps[i][0]} cy={temps[i][1]} r={2.2} />
                        <circle className="snd-ddot" cx={dews[i][0]} cy={dews[i][1]} r={2.2} />
                    </g>
                ))}
                {showLcl && <line className="snd-lcl" x1={MARGIN.left} x2={right} y1={lclY} y2={lclY} />}
            </g>
            {cloudLabelY != null && (
                <text className="snd-ann" x={MARGIN.left + 5} y={cloudLabelY}>
                    {cloudBaseText}
                </text>
            )}
            {lid && lidLabelY != null && (
                <text className="snd-ann snd-lidtxt" x={MARGIN.left + 5} y={lidLabelY}>
                    {lidText}
                </text>
            )}
            {pressureLabels.map((p) => (
                <g key={p}>
                    <text className="snd-ax" x={MARGIN.left - 4} y={yOf(f, p) + 4} textAnchor="end">
                        {p}
                    </text>
                    <line className="snd-tick" x1={MARGIN.left} x2={MARGIN.left + 4} y1={yOf(f, p)} y2={yOf(f, p)} />
                </g>
            ))}
            {tempLabels.map((t) => (
                <text key={t} className="snd-ax" x={xOf(f, t, P_MAX)} y={bottom + 15} textAnchor="middle">
                    {tempText(t)}
                </text>
            ))}
            <rect className="snd-frame" x={MARGIN.left} y={MARGIN.top} width={f.pw} height={f.ph} />
            {barbs}
        </svg>
    );
};
