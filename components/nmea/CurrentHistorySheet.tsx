import React, { useEffect, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { loadPiTrackHistory } from '../../services/piTrackHistory';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { currentHistory, type CurrentHistorySample } from '../../services/instruments/currentHistory';
export default function CurrentHistorySheet({ onClose }: { onClose: () => void }) {
    const [result, setResult] = useState<{
        samples: CurrentHistorySample[];
        unqualified: number;
        truncated: boolean;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController(),
            scope = getAuthIdentityScope();
        let active = true;
        const unsub = subscribeAuthIdentityScope(() => {
            active = false;
            controller.abort();
            setResult(null);
            onClose();
        });
        const to = Date.now();
        void loadPiTrackHistory({
            from: to - 2 * 3600000,
            to,
            maxPoints: 500,
            maxPages: 1,
            signal: controller.signal,
            isCurrent: () => active && isAuthIdentityScopeCurrent(scope),
        })
            .then((history) => {
                if (active && isAuthIdentityScopeCurrent(scope))
                    setResult({ ...currentHistory(history.points), truncated: history.truncated });
            })
            .catch((error) => {
                if (active && !controller.signal.aborted)
                    setError(error instanceof Error ? error.message : 'Pi history is unavailable.');
            });
        return () => {
            active = false;
            controller.abort();
            unsub();
        };
    }, [onClose]);
    return (
        <ModalSheet isOpen onClose={onClose} title="Recent instrument current" zIndex="z-1200">
            <div className="space-y-4 p-4 text-white">
                <p className="text-sm text-gray-400">
                    Up to 500 points from the last two hours, read privately from the paired Pi. Legacy points without
                    sensor clocks cannot give a qualified current estimate.
                </p>
                {!result && !error && <p role="status">Reading Pi history…</p>}
                {error && (
                    <p role="alert" className="text-amber-200">
                        {error}
                    </p>
                )}
                {result && (
                    <>
                        <p className="text-sm">
                            {result.samples.length} qualified vectors · {result.unqualified} points unavailable
                            {result.truncated ? ' · Partial window: the point limit was reached.' : ''}
                        </p>
                        {result.samples.length === 0 ? (
                            <p>No qualifying current measurements in this saved window.</p>
                        ) : (
                            <ol className="space-y-2">
                                {result.samples
                                    .slice(-20)
                                    .reverse()
                                    .map((s, i) => (
                                        <li
                                            key={`${s.at}:${i}`}
                                            className="flex flex-wrap justify-between gap-2 rounded-lg border border-white/10 p-3 text-sm"
                                        >
                                            <time dateTime={new Date(s.at).toISOString()}>
                                                {new Date(s.at).toISOString().slice(11, 19)} UTC
                                            </time>
                                            <span>
                                                {s.current.driftKts.toFixed(1)} kn ·{' '}
                                                {s.current.setTrueDeg === null
                                                    ? 'set —'
                                                    : `${Math.round(s.current.setTrueDeg) % 360}°T`}
                                            </span>
                                            <span className="w-full text-xs text-gray-400">
                                                {s.current.leewayDeg === null
                                                    ? 'Leeway uncorrected'
                                                    : `Explicit leeway ${s.current.leewayDeg.toFixed(1)}°`}{' '}
                                                · inputs {Math.max(0, Math.floor((s.at - s.current.observedAt) / 1000))}{' '}
                                                s old when recorded
                                            </span>
                                        </li>
                                    ))}
                            </ol>
                        )}
                        <p className="text-xs text-gray-400">
                            Latest 20 qualifying entries in this returned batch. Historical estimates describe their
                            recorded time and are not live current.
                        </p>
                    </>
                )}
            </div>
        </ModalSheet>
    );
}
