import React from 'react';
import { usePassageRecordingMetrics } from '../../hooks/usePassageRecordingMetrics';
import { formatVoyageDuration } from '../../utils/voyageTiming';
import { DASH, fmtNm } from './passageHudFormat';

export const PassageRecordingMetrics: React.FC<{ voyageId: string; paused: boolean }> = ({ voyageId, paused }) => {
    const metrics = usePassageRecordingMetrics(voyageId);
    const ageMs = metrics.recordedAt === null ? null : Math.max(0, metrics.nowMs - metrics.recordedAt);
    const stale = ageMs !== null && ageMs > 60_000;
    const ageLabel =
        ageMs === null ? 'No saved fix' : stale ? `Saved ${Math.floor(ageMs / 60_000)}m ago` : 'Saved track';
    const distanceLabel =
        metrics.distanceNm === null
            ? 'Recorded sailed distance unavailable'
            : `${fmtNm(metrics.distanceNm)} nautical miles sailed, saved ${new Date(metrics.recordedAt!).toLocaleString()}`;
    return (
        <>
            <div
                className="border-b border-white/10 px-1 py-1 text-center"
                data-testid="hud-recorded-distance"
                data-freshness={metrics.distanceNm === null ? 'none' : stale ? 'stale' : 'live'}
                aria-label={distanceLabel}
                title={distanceLabel}
            >
                <p className="text-[10px] font-black uppercase leading-none text-gray-400">Sailed</p>
                <p
                    className={`font-mono text-[32px] font-black leading-tight tabular-nums ${metrics.distanceNm === null ? 'text-white/40' : stale ? 'text-white/60' : 'text-white'}`}
                >
                    {metrics.distanceNm === null ? DASH : fmtNm(metrics.distanceNm)}
                    {metrics.distanceNm !== null && (
                        <span className="ml-1 text-[13px] font-bold text-gray-400">NM</span>
                    )}
                </p>
                <p
                    className={`text-[10px] font-black uppercase leading-tight ${stale ? 'text-amber-300' : 'text-gray-400'}`}
                >
                    {ageLabel}
                </p>
            </div>
            <div className="border-b border-white/10 px-1 py-1 text-center" data-testid="hud-recording-elapsed">
                <p className="text-[10px] font-black uppercase leading-tight text-gray-400">Since departure</p>
                <p className="font-mono text-[20px] font-black leading-tight tabular-nums text-white">
                    {metrics.departedAt === null ? DASH : formatVoyageDuration(metrics.nowMs - metrics.departedAt)}
                </p>
                {metrics.departedAt === null && (
                    <p className="text-[10px] font-bold text-amber-300">Awaiting departure</p>
                )}
                <p
                    className={`text-[10px] font-black uppercase leading-tight ${paused ? 'text-amber-300' : 'text-emerald-300'}`}
                    data-testid="hud-recording-status"
                >
                    {paused ? 'Recording paused' : 'Recording'}
                </p>
            </div>
        </>
    );
};
