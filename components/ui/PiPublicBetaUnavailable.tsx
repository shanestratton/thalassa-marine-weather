import React from 'react';
import { PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE } from '../../services/piPublicBetaBoundary';
import { LockIcon } from '../Icons';

/**
 * Honest replacement for every Pi setup/control surface, on builds that cannot
 * verify the Pi.
 *
 * Since 2026-08-06 this is no longer a beta-wide hold — the Pi is available to
 * any build carrying the native certificate-pinning transport. What this screen
 * now says is narrower and more useful: THIS build cannot check that the box
 * answering `calypso.local` is your Pi, so it will not talk to it. The web
 * build is the ordinary case (browsers do not expose the peer certificate to
 * script, so nothing there can verify the pin).
 */
export const PiPublicBetaUnavailable: React.FC<{ onOpenEncLibrary?: () => void }> = ({ onOpenEncLibrary }) => (
    <div className="max-w-2xl mx-auto p-5 sm:p-8" role="status" aria-live="polite">
        <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 p-6 text-center">
            <div
                aria-hidden="true"
                className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-400/15 text-amber-300"
            >
                <LockIcon className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-white">Pi integration unavailable in this build</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-amber-100/80">
                {PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE}
            </p>
            <p className="mx-auto mt-3 max-w-lg text-xs leading-relaxed text-white/50">
                Thalassa continues using its normal on-device and HTTPS cloud paths. No Pi discovery, setup, Pi-hosted
                chart/ENC sync, diary relay, or boat-network controls run in this build. Open Thalassa on your phone, on
                the boat network, to pair with the Pi.
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
