import React from 'react';
import type { GpsDiagnosticsPresentation } from './gpsDiagnosticsPresentation';

/** The same source-separated GPS details in the info page and layout fixture. */
export const GpsDiagnosticsCards: React.FC<{ sources: GpsDiagnosticsPresentation[] }> = ({ sources }) => (
    <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-3" data-testid="gps-quality-panel">
        <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">GPS quality</p>
        {sources.map((source) => (
            <section key={source.label} aria-label={source.label} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <h3 className="text-xs font-semibold text-white">{source.label}</h3>
                    <p className="text-[10px] text-slate-400">{source.position}</p>
                </div>
                <dl className="grid grid-cols-3 gap-2">
                    {(
                        [
                            ['Satellites', source.satellites],
                            ['Fix quality', source.quality],
                            ['Accuracy', source.accuracy],
                        ] as const
                    ).map(([label, metric]) => (
                        <div key={label} className="min-w-0 rounded-lg bg-black/15 px-2 py-2">
                            <dt className="text-[10px] text-slate-400">{label}</dt>
                            <dd
                                className={`mt-1 break-words text-xs font-semibold ${metric.state === 'current' ? 'text-white' : metric.state === 'stale' ? 'text-amber-300' : 'text-slate-400'}`}
                            >
                                {metric.text}
                            </dd>
                        </div>
                    ))}
                </dl>
                {source.hdop.state !== 'unknown' && (
                    <p className="text-[10px] text-slate-400">HDOP (geometry): {source.hdop.text}</p>
                )}
            </section>
        ))}
    </div>
);
