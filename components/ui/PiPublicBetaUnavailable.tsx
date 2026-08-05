import React from 'react';
import { PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE } from '../../services/piPublicBetaBoundary';

/** Honest production replacement for every Pi setup/control surface. */
export const PiPublicBetaUnavailable: React.FC<{ onOpenEncLibrary?: () => void }> = ({ onOpenEncLibrary }) => (
    <div className="max-w-2xl mx-auto p-5 sm:p-8" role="status" aria-live="polite">
        <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 p-6 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-400/15 text-xl">
                {'\u{1F512}'}
            </div>
            <h2 className="text-lg font-bold text-white">Pi integration unavailable in public beta</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-amber-100/80">
                {PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE}
            </p>
            <p className="mx-auto mt-3 max-w-lg text-xs leading-relaxed text-white/50">
                Thalassa continues using its normal on-device and HTTPS cloud paths. No Pi discovery, setup, Pi-hosted
                chart/ENC sync, diary relay, or boat-network controls run in this build.
            </p>
            {onOpenEncLibrary && (
                <button
                    type="button"
                    onClick={onOpenEncLibrary}
                    className="mt-5 min-h-11 rounded-xl border border-sky-400/30 bg-sky-500/15 px-5 text-sm font-black text-sky-100 transition-colors hover:bg-sky-500/25"
                >
                    Open reference ENC Library
                </button>
            )}
        </div>
    </div>
);
