/**
 * WindRose — where the wind is, relative to the boat.
 *
 * Two needles on one card, because a sailor needs both and they answer
 * different questions:
 *
 *   TRUE (solid, cyan)     — where the wind actually is. Drawn from MWD's
 *                            compass bearing when the gateway sends it,
 *                            otherwise from the signed true wind angle. This
 *                            is the one that tells you what the weather is
 *                            doing.
 *   APPARENT (dashed, amber) — what the boat feels, which is what the sails
 *                            are trimmed to. Off the bow, always.
 *
 * The bow stays at the top and the needles move, rather than rotating the
 * card. On a phone clamped to a binnacle the boat outline must not spin — the
 * whole point is reading the wind against the hull at a glance.
 *
 * Sweeping, not snapping. Wind angle is noisy at anchor and a needle that
 * jumps every sample is unreadable; a short CSS transition on the rotation
 * averages it out for the eye without lying about the value, which is still
 * printed as a number. The transition is the ONLY animation here — no
 * requestAnimationFrame loop, because this panel is meant to sit open on a
 * phone for a whole passage.
 *
 * Rotation is unwrapped (see ./useUnwrappedAngle): feeding a raw bearing
 * straight to CSS makes the needle spin the long way round the card whenever
 * the wind crosses north, which reads as a gale arriving.
 */
import React from 'react';
import { useUnwrappedAngle } from './useUnwrappedAngle';

interface WindRoseProps {
    /** True wind direction, compass bearing °T. Null falls back to twaSigned. */
    twd: number | null;
    /** Signed true wind angle off the bow, negative to port. */
    twaSigned: number | null;
    /** Apparent wind angle off the bow, signed, negative to port. */
    awa: number | null;
    /** Boat heading °T — turns TWD into an angle off the bow. */
    heading: number | null;
    tws: number | null;
    aws: number | null;
    isLive: boolean;
}

const TRUE_COLOR = '#22d3ee';
const APPARENT_COLOR = '#fbbf24';

const Needle: React.FC<{ angle: number; color: string; dashed?: boolean; dim: boolean }> = ({
    angle,
    color,
    dashed,
    dim,
}) => (
    <g
        style={{
            transform: `rotate(${angle}deg)`,
            transformOrigin: '60px 60px',
            transition: 'transform 900ms cubic-bezier(0.22, 1, 0.36, 1)',
            opacity: dim ? 0.28 : 1,
        }}
    >
        {/* The wind BLOWS toward the boat, so the arrowhead sits at the rim
            pointing inward — this is a "wind from" rose, like every printed
            weather chart. Getting this backwards is a 180° error on the one
            number the sails are set by. */}
        <line
            x1="60"
            y1="18"
            x2="60"
            y2="52"
            stroke={color}
            strokeWidth={dashed ? 2 : 2.6}
            strokeLinecap="round"
            strokeDasharray={dashed ? '3 3' : undefined}
        />
        <path d="M60 56 L55.5 46 L64.5 46 Z" fill={color} />
    </g>
);

export const WindRose: React.FC<WindRoseProps> = ({ twd, twaSigned, awa, heading, tws, aws, isLive }) => {
    // Prefer MWD's bearing, converted to an angle off the bow. Fall back to
    // the signed angle when the gateway sends MWV but not MWD.
    const trueOffBow =
        twd !== null && heading !== null ? ((((twd - heading) % 360) + 540) % 360) - 180 : (twaSigned ?? null);

    const trueAngle = useUnwrappedAngle(trueOffBow);
    const apparentAngle = useUnwrappedAngle(awa);

    const dim = !isLive;
    const fmt = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? '--' : v.toFixed(d));
    /** 47 to port reads "47P" — a signed minus sign is ambiguous at a glance. */
    const side = (v: number | null) => (v === null ? '' : v < 0 ? 'P' : v > 0 ? 'S' : '');
    const mag = (v: number | null) => (v === null ? '--' : Math.abs(Math.round(v)).toString());

    return (
        <div className="flex w-full flex-col items-center">
            <svg viewBox="0 0 120 120" className="w-full" style={{ aspectRatio: '1' }}>
                <circle
                    cx="60"
                    cy="60"
                    r="55"
                    fill="rgba(15,23,42,0.4)"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="0.8"
                />

                {/* Fixed tick ring — degrees off the bow, not compass points.
                    The card does not rotate; the needles do. */}
                {Array.from({ length: 24 }, (_, i) => i * 15).map((deg) => {
                    const major = deg % 45 === 0;
                    const r1 = major ? 46 : 49;
                    const rad = ((deg - 90) * Math.PI) / 180;
                    return (
                        <line
                            key={deg}
                            x1={60 + r1 * Math.cos(rad)}
                            y1={60 + r1 * Math.sin(rad)}
                            x2={60 + 53 * Math.cos(rad)}
                            y2={60 + 53 * Math.sin(rad)}
                            stroke="#ffffff"
                            strokeOpacity={major ? 0.3 : 0.12}
                            strokeWidth={major ? 1 : 0.6}
                        />
                    );
                })}

                {/* Port red / starboard green, the only orientation cue a
                    sailor never has to think about. */}
                <path d="M60 8 A52 52 0 0 1 112 60" fill="none" stroke="#34d399" strokeOpacity="0.35" strokeWidth="2" />
                <path d="M8 60 A52 52 0 0 1 60 8" fill="none" stroke="#f87171" strokeOpacity="0.35" strokeWidth="2" />

                {/* Boat, bow up, fixed. */}
                <path
                    d="M60 40 C67 50 68 66 60 80 C52 66 53 50 60 40 Z"
                    fill="rgba(255,255,255,0.10)"
                    stroke="rgba(255,255,255,0.35)"
                    strokeWidth="1"
                />

                {awa !== null && <Needle angle={apparentAngle} color={APPARENT_COLOR} dashed dim={dim} />}
                {trueOffBow !== null && <Needle angle={trueAngle} color={TRUE_COLOR} dim={dim} />}
            </svg>

            <div className="mt-1 grid w-full grid-cols-2 gap-1">
                <div className="rounded-lg bg-white/4 px-1.5 py-1 text-center">
                    <div className="text-[8px] font-black uppercase tracking-widest" style={{ color: TRUE_COLOR }}>
                        True
                    </div>
                    <div className="font-mono text-[13px] font-black tabular-nums text-white">
                        {fmt(tws)}
                        <span className="text-[8px] font-bold text-gray-500">kt</span>
                    </div>
                    <div className="font-mono text-[9px] tabular-nums text-gray-400">
                        {mag(trueOffBow)}°{side(trueOffBow)}
                        {twd !== null ? ` · ${Math.round(twd)}°T` : ''}
                    </div>
                </div>
                <div className="rounded-lg bg-white/4 px-1.5 py-1 text-center">
                    <div className="text-[8px] font-black uppercase tracking-widest" style={{ color: APPARENT_COLOR }}>
                        Apparent
                    </div>
                    <div className="font-mono text-[13px] font-black tabular-nums text-white">
                        {fmt(aws)}
                        <span className="text-[8px] font-bold text-gray-500">kt</span>
                    </div>
                    <div className="font-mono text-[9px] tabular-nums text-gray-400">
                        {mag(awa)}°{side(awa)}
                    </div>
                </div>
            </div>
        </div>
    );
};

WindRose.displayName = 'WindRose';
