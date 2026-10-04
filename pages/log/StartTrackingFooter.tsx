/**
 * StartTrackingFooter — the pinned "Slide to Start Tracking" CTA and the
 * GPS-start failure card above it, extracted verbatim from pages/LogPage.tsx.
 */
import React from 'react';
import { PlayIcon } from '../../components/Icons';
import { SlideToAction } from '../../components/ui/SlideToAction';
import { openDeviceSettings } from '../../hooks/useGpsHealth';
import type { CastOffHandoff } from '../../services/castOffHandoff';
import type { TrackingStartFailure } from './logPageTypes';
import { LOG_FOOTER_CLEARANCE } from './footerClearance';

export const StartTrackingFooter: React.FC<{
    trackingStartFailure: TrackingStartFailure | null;
    castOffHandoff: CastOffHandoff | null;
    beginCastOff: () => void;
    checkingStartGps: boolean;
}> = ({ trackingStartFailure, castOffHandoff, beginCastOff, checkingStartGps }) => (
    // The 2rem top fade is the Plan CTA's (.route-planner-cta::before): the
    // list above now dissolves into the slide instead of being cut by a hard
    // edge 8 pt above it (UX scorecard run 6). Page ground: slate-950, and
    // slate-200 in daylight (the .display-light remap of bg-slate-950).
    <div
        className="relative z-10 shrink-0 px-4 pt-2 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-8 before:bg-linear-to-b before:from-transparent before:to-slate-950 before:content-[''] [.display-light_&]:before:to-[rgb(226_232_240)]"
        style={{ paddingBottom: LOG_FOOTER_CLEARANCE }}
    >
        {trackingStartFailure && (
            <div
                role="alert"
                aria-live="assertive"
                className="mb-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5"
            >
                <div className="text-sm font-black text-red-200">{trackingStartFailure.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-red-100/80">{trackingStartFailure.detail}</p>
                {trackingStartFailure.actionable && (
                    <button
                        type="button"
                        onClick={openDeviceSettings}
                        className="mt-2 min-h-[44px] rounded-xl border border-red-300/25 bg-red-400/15 px-3 py-2 text-xs font-black text-red-100"
                    >
                        Open location settings
                    </button>
                )}
            </div>
        )}
        {!castOffHandoff ? (
            <SlideToAction
                label="Slide to Start Tracking"
                thumbIcon={<PlayIcon className="w-5 h-5 text-white" />}
                onConfirm={beginCastOff}
                loading={checkingStartGps}
                loadingText="Checking GPS…"
                theme="emerald"
            />
        ) : null}
    </div>
);
