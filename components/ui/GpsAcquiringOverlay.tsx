/**
 * GpsAcquiringOverlay — the UNMISSABLE "we don't have a fix yet" state.
 *
 * Shane 2026-07-03 (departure morning): the tiny "Acquiring GPS fix…"
 * header badge is invisible in sunlight — the skipper starts tracking,
 * pockets the phone, and the first minutes of track never record. This
 * is the full-screen version: big, centred, amber, and it dismisses
 * ITSELF the instant the first trustworthy fix is recorded. A manual
 * "keep it in the background" escape drops back to the header badge for
 * flaky-GPS days (it never blocks recording — capture starts on lock
 * regardless).
 */
import React, { useId, useRef, useEffect, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from './OverlayPortal';
import { useGpsHealth, gpsHealthMessage, openDeviceSettings } from '../../hooks/useGpsHealth';

interface GpsAcquiringOverlayProps {
    open: boolean;
    onDismiss: () => void;
}

export const GpsAcquiringOverlay: React.FC<GpsAcquiringOverlayProps> = ({ open, onDismiss }) => {
    const titleId = useId();
    const descriptionId = useId();
    const dismissRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(open, {
        initialFocusRef: dismissRef,
        onEscape: onDismiss,
    });

    // WHY we are waiting, when the OS already knows. A denial and a cold start
    // used to look identical here — the same amber spinner, for hours.
    const health = useGpsHealth();
    const blocked = health && !health.usable ? gpsHealthMessage(health.reason) : null;

    // A counter cannot lie. "Hold tight, up to 30 seconds" is reassuring at
    // 0:20 and an insult at 14:00, and the elapsed time is what tells the
    // skipper which one they are living in.
    const [elapsedSec, setElapsedSec] = useState(0);
    useEffect(() => {
        if (!open) {
            setElapsedSec(0);
            return;
        }
        const startedAt = Date.now();
        setElapsedSec(0);
        const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => clearInterval(id);
    }, [open]);

    if (!open) return null;

    const mmss = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`;
    // Past a minute a clear-sky cold start has had its chance; stop implying
    // that waiting is the answer.
    const overdue = elapsedSec >= 60;

    return (
        <OverlayPortal layer="critical" className="flex items-center justify-center p-6">
            <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm" aria-hidden="true" />
            <div
                ref={dialogRef}
                className="relative w-full max-w-sm text-center animate-in fade-in zoom-in-95 duration-300"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
            >
                {/* Pulsing satellite ring */}
                <div className="mx-auto relative w-36 h-36 mb-6">
                    <div
                        className={`absolute inset-0 rounded-full ${blocked ? 'bg-red-400/10' : 'bg-amber-400/10 animate-ping'}`}
                    />
                    <div
                        className={`absolute inset-3 rounded-full ${blocked ? 'bg-red-400/15' : 'bg-amber-400/15 animate-pulse'}`}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <svg
                            className={`w-16 h-16 ${blocked ? 'text-red-300' : 'text-amber-300'}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.6}
                        >
                            {/* satellite dish / signal */}
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 21a9 9 0 009-9M12 17a5 5 0 005-5M12 13a1 1 0 100-2 1 1 0 000 2zM3 3l7.5 7.5"
                            />
                        </svg>
                    </div>
                </div>

                <h2
                    id={titleId}
                    className={`text-3xl font-black tracking-tight mb-3 ${blocked ? 'text-red-300' : 'text-amber-300'}`}
                >
                    {blocked ? blocked.title : 'Acquiring GPS fix…'}
                </h2>
                <div id={descriptionId}>
                    {blocked ? (
                        <p className="text-base text-slate-200 leading-relaxed mb-8">{blocked.detail}</p>
                    ) : (
                        <>
                            <p className="text-base text-slate-200 leading-relaxed mb-2">
                                {overdue ? (
                                    <>
                                        Still searching after{' '}
                                        <span className="font-bold text-white tabular-nums">{mmss}</span>. A clear view
                                        of the sky is what it needs most.
                                    </>
                                ) : (
                                    <>
                                        Hold tight — a cold start can take up to{' '}
                                        <span className="font-bold text-white">30 seconds</span> with clear sky.
                                    </>
                                )}
                            </p>
                            <p className="text-sm text-slate-400 leading-relaxed mb-2">
                                Recording starts automatically the moment we lock on. This screen will clear itself.
                            </p>
                            <p className="text-xs text-slate-500 tabular-nums mb-8" aria-live="polite">
                                Searching {mmss}
                            </p>
                        </>
                    )}
                </div>

                <div className="flex flex-col gap-2 items-center">
                    {blocked && health?.actionable && (
                        <button
                            onClick={openDeviceSettings}
                            className="px-6 py-3 rounded-2xl bg-sky-500/90 text-white text-sm font-bold uppercase tracking-widest active:scale-[0.97] transition-transform"
                        >
                            Open Settings
                        </button>
                    )}
                    <button
                        ref={dismissRef}
                        onClick={onDismiss}
                        className="px-6 py-3 rounded-2xl bg-white/10 border border-white/15 text-slate-200 text-sm font-bold uppercase tracking-widest active:scale-[0.97] transition-transform"
                    >
                        {blocked ? 'Continue anyway' : 'Keep waiting in background'}
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
