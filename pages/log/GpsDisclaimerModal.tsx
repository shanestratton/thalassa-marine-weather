/**
 * The phone notice — shown once, and only when this phone is the voyage's
 * source (build 123, package VL).
 *
 * Shane 2026-10-07 saw the old "GPS Accuracy Notice" while the boat's own
 * GPS was feeding the log: it was gated on nothing, and it listed a Bad Elf
 * as a "WiFi gateway" (a Bad Elf is a Bluetooth receiver that feeds the
 * phone's own location). It now says which receiver is logging, honestly,
 * and how to use the boat instead. Centred and clear of the tab bar (the
 * modal rule, 2026-08-31). Its two paragraphs are set at leading-normal so the
 * whole notice, the Always advice included, fits 320x568 in wide fonts (fit123).
 */
import React from 'react';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface GpsDisclaimerModalProps {
    isOpen: boolean;
    onDismiss: (dontShowAgain: boolean) => void;
    /** iOS: advise Always for a phone-only log (an advisory, never a refusal). */
    alwaysAdvice?: boolean;
}

export const GpsDisclaimerModal: React.FC<GpsDisclaimerModalProps> = ({ isOpen, onDismiss, alwaysAdvice = false }) => {
    const checkboxRef = React.useRef<HTMLInputElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
        initialFocusRef: checkboxRef,
    });

    if (!isOpen) return null;

    return (
        <OverlayPortal
            role="presentation"
            className="flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="gps-disclaimer-title"
                aria-describedby={`gps-disclaimer-description${alwaysAdvice ? ' gps-disclaimer-always' : ''}`}
                data-phone-notice
                className="bg-slate-900 border border-amber-500/20 rounded-2xl p-4 max-w-sm w-full max-h-full overflow-y-auto shadow-2xl animate-[slideUp_0.2s_ease-out]"
            >
                <div className="flex items-center gap-3 mb-2">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                        <span className="text-xl" aria-hidden="true">
                            📱
                        </span>
                    </div>
                    <h3 id="gps-disclaimer-title" className="text-lg font-bold text-white">
                        Logging from this phone
                    </h3>
                </div>
                <p id="gps-disclaimer-description" className="text-sm text-slate-300 leading-normal mb-2">
                    A phone&apos;s GPS is less accurate on the water than a boat&apos;s own receiver. If your boat has a
                    GPS on an NMEA network — through a Wi-Fi gateway or a Thalassa Pi — connect it and the log will use
                    your boat instead.
                </p>
                {alwaysAdvice && (
                    <p id="gps-disclaimer-always" className="text-sm text-slate-400 leading-normal mb-2">
                        To keep recording if iOS closes Thalassa, set Location to Always: Settings › Privacy &amp;
                        Security › Location Services › Thalassa › Always.
                    </p>
                )}
                <label className="flex min-h-[44px] items-center gap-2.5 mb-2 cursor-pointer">
                    <input
                        ref={checkboxRef}
                        type="checkbox"
                        id="gps-disclaimer-dismiss"
                        className="w-5 h-5 rounded-sm border-white/20 bg-slate-800 accent-amber-500"
                    />
                    <span className="text-sm text-slate-400">Don't show this again</span>
                </label>
                <button
                    type="button"
                    onClick={() => {
                        onDismiss(checkboxRef.current?.checked ?? false);
                    }}
                    className="w-full min-h-[44px] py-3 rounded-xl bg-linear-to-r from-amber-500 to-amber-600 text-white font-bold text-sm uppercase tracking-wider active:scale-[0.97] transition-all"
                >
                    Start tracking
                </button>
            </div>
        </OverlayPortal>
    );
};
