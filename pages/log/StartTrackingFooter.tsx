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

export const StartTrackingFooter: React.FC<{
    trackingStartFailure: TrackingStartFailure | null;
    castOffHandoff: CastOffHandoff | null;
    beginCastOff: () => void;
    checkingStartGps: boolean;
}> = ({ trackingStartFailure, castOffHandoff, beginCastOff, checkingStartGps }) => (
    <div className="shrink-0 px-4 pt-2" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
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
                        Open Location Settings
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
