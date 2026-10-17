import React from 'react';
import type { HourlyForecast, MarineModelSnapshot } from '../../types/weather';
import type { VesselProfile } from '../../types';
import { comfortPreferenceLabel, type ComfortPreference } from '../../utils/comfortPreference';
import { admittedComfortMarine, comfortForMarine } from '../../utils/marineComfort';
import { MarineDataCredit } from './MarineDataCredit';
import { partitionTimeline } from '../../utils/partitionTimeline';
export function SeaPartitionsBlock({
    marine,
    vessel,
    preference,
    current = false,
    hours = [],
}: {
    marine?: MarineModelSnapshot;
    vessel?: Pick<VesselProfile, 'type' | 'length'> | null;
    preference?: ComfortPreference | null;
    current?: boolean;
    hours?: readonly HourlyForecast[];
}) {
    const admitted = admittedComfortMarine(marine, current),
        comfort = comfortForMarine(marine, vessel, preference, current);
    const rows = [
        ['Total sea', admitted?.parts.total],
        ['Wind sea', admitted?.parts.windSea],
        ['Swell', admitted?.parts.swell],
        ['Second swell', admitted?.parts.secondarySwell],
    ] as const;
    const max = Math.max(0.1, ...rows.map(([, part]) => part?.hM ?? 0));
    const timeline = partitionTimeline(hours, marine);
    return (
        <section
            className="space-y-2 rounded-xl border border-sky-500/20 bg-sky-950/20 p-3 text-slate-200"
            aria-label="Sea partitions and personal comfort"
        >
            <p className="text-sm font-bold text-white">
                {comfort?.word ?? 'Comfort unknown'} · {comfortPreferenceLabel(preference, comfort?.input)}
            </p>
            <p className="text-xs text-slate-300">
                {comfort?.reason ?? marine?.reason ?? 'No admitted local wave model.'}
                {comfort?.generic ? ' · generic 38 ft boat' : ''} Comfort, not safety.
            </p>
            <svg
                viewBox="0 0 320 136"
                role="img"
                aria-label="Wave partitions in metres; arrows point to the direction each comes from. Heights are not additive."
                className="w-full max-h-48"
            >
                {rows.map(([label, part], i) => (
                    <g key={label} transform={`translate(0 ${i * 34})`}>
                        <text x="0" y="13" fill="currentColor" fontSize="11">
                            {label}
                        </text>
                        <rect
                            x="84"
                            y="3"
                            width={part ? Math.max(1, (part.hM / max) * 95) : 0}
                            height="12"
                            rx="3"
                            fill={i === 0 ? '#7dd3fc' : '#67e8f9'}
                        />
                        <text x="188" y="13" fill="currentColor" fontSize="11">
                            {part
                                ? `${part.hM.toFixed(1)}m · ${part.periodS === null ? '?s' : `${part.periodS.toFixed(0)}s`}`
                                : 'Unknown'}
                        </text>
                        {part?.fromDeg != null && (
                            <g transform={`translate(291 10) rotate(${part.fromDeg})`}>
                                <path d="M0 -7L-4 1H-1V7H1V1H4Z" fill="#7dd3fc" />
                            </g>
                        )}
                        <text x="84" y="28" fill="#94a3b8" fontSize="10">
                            {part?.fromDeg == null ? 'Direction unknown' : `FROM ${Math.round(part.fromDeg)}° true`}
                        </text>
                    </g>
                ))}
            </svg>
            <ul className="space-y-1 text-sm" aria-label="Selected wave partition readings">
                {rows.map(([label, part]) => (
                    <li key={label}>
                        {label}:{' '}
                        {part
                            ? `${part.hM.toFixed(1)}m · ${part.periodS == null ? 'period unknown' : `${part.periodS}s`} · ${part.fromDeg == null ? 'direction unknown' : `FROM ${Math.round(part.fromDeg)}° true`}`
                            : 'Unknown'}
                    </li>
                ))}
            </ul>
            {timeline ? (
                <>
                    <svg
                        viewBox="0 0 320 100"
                        className="w-full"
                        role="img"
                        aria-label="Forecast partition timeline in metres; gaps remain unknown and heights are not additive"
                    >
                        {timeline.paths.map(({ key, path }, i) => (
                            <path
                                key={key}
                                d={path}
                                fill="none"
                                stroke={['#7dd3fc', '#fbbf24', '#67e8f9', '#c4b5fd'][i]}
                                strokeWidth="2"
                            />
                        ))}
                    </svg>
                    <p className="text-xs text-slate-300">
                        Total sea (blue), wind sea (amber), swell (cyan), second swell (violet). Scale 0–
                        {timeline.maximum.toFixed(1)}m · {new Date(timeline.start).toLocaleString()} to{' '}
                        {new Date(timeline.end).toLocaleString()}.
                    </p>
                </>
            ) : (
                <p className="text-xs text-slate-400">No same-cohort partition timeline available.</p>
            )}
            <p className="text-xs text-slate-400">
                Model significant heights, not maximum waves. Parts are not additive.
                {admitted?.waveValidAtMs != null
                    ? ` Selected sample valid ${new Date(admitted.waveValidAtMs).toLocaleString()}.`
                    : ''}
            </p>
            <MarineDataCredit />
        </section>
    );
}
