/**
 * GPS Accuracy Disclaimer Modal — extracted from LogPage.
 *
 * Warning modal about phone GPS accuracy on water.
 * Shows on first tracking start, with a "don't show again" checkbox.
 */
import React from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface GpsDisclaimerModalProps {
    isOpen: boolean;
    onDismiss: (dontShowAgain: boolean) => void;
}

export const GpsDisclaimerModal: React.FC<GpsDisclaimerModalProps> = ({ isOpen, onDismiss }) => {
    const checkboxRef = React.useRef<HTMLInputElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
        initialFocusRef: checkboxRef,
    });

    if (!isOpen) return null;

    return (
        <div
            role="presentation"
            className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-sm px-6"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="gps-disclaimer-title"
                aria-describedby="gps-disclaimer-description gps-disclaimer-guidance"
                className="bg-slate-900 border border-amber-500/20 rounded-2xl p-6 max-w-sm w-full shadow-2xl animate-[slideUp_0.2s_ease-out]"
            >
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                        <span className="text-xl" aria-hidden="true">
                            ⚠️
                        </span>
                    </div>
                    <h3 id="gps-disclaimer-title" className="text-lg font-bold text-white">
                        GPS Accuracy Notice
                    </h3>
                </div>
                <p id="gps-disclaimer-description" className="text-sm text-slate-300 leading-relaxed mb-4">
                    Phone GPS accuracy degrades significantly on water without WiFi or cell-tower assist — especially in
                    overcast or rainy conditions.
                </p>
                <p id="gps-disclaimer-guidance" className="text-sm text-slate-300 leading-relaxed mb-5">
                    For best track accuracy offshore, connect to your vessel's{' '}
                    <span className="text-amber-400 font-semibold">NMEA GPS</span> via a WiFi gateway (e.g. YDWG-02,
                    Vesper, or Bad Elf).
                </p>
                <label className="flex items-center gap-2.5 mb-5 cursor-pointer">
                    <input
                        ref={checkboxRef}
                        type="checkbox"
                        id="gps-disclaimer-dismiss"
                        className="w-4 h-4 rounded border-white/20 bg-slate-800 accent-amber-500"
                    />
                    <span className="text-xs text-slate-400">Don't show this again</span>
                </label>
                <button
                    aria-label="Dismiss GPS disclaimer"
                    onClick={() => {
                        onDismiss(checkboxRef.current?.checked ?? false);
                    }}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-white font-bold text-sm uppercase tracking-wider active:scale-[0.97] transition-all"
                >
                    Got it — Start Tracking
                </button>
            </div>
        </div>
    );
};
