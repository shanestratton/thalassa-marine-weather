/**
 * WeatherPositionChoiceDialog — "the boat, or your phone?"
 *
 * Shown once per hold: the boat has gone quiet, her last fix is being held for
 * the weather, and the phone is clearly somewhere else (ASK_DISTANCE_NM).
 * Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes
 * centered on the punters screen"), and Shane 2026-09-06: "make the question
 * about do you want pi or phone, in a modal box in the center of the screen."
 *
 * Dismissing it (backdrop, Escape) keeps the boat: holding her last fix is the
 * default the skipper asked for, so no swipe-away can silently switch the
 * weather to the phone.
 */
import React, { useCallback, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import type { WeatherPositionChoicePrompt } from '../../context/WeatherContext';
import { formatFixAge, type HeldChoice } from '../../services/weatherPosition';
import { haversineNM } from '../../utils/gpsFollow';

interface WeatherPositionChoiceDialogProps {
    prompt: WeatherPositionChoicePrompt | null;
    vesselName: string;
    onChoose: (choice: HeldChoice) => void;
}

export const WeatherPositionChoiceDialog: React.FC<WeatherPositionChoiceDialogProps> = ({
    prompt,
    vesselName,
    onChoose,
}) => {
    const boatRef = useRef<HTMLButtonElement>(null);
    const chooseBoat = useCallback(() => onChoose('boat'), [onChoose]);
    const choosePhone = useCallback(() => onChoose('phone'), [onChoose]);
    const dialogRef = useFocusTrap<HTMLDivElement>(prompt !== null, {
        initialFocusRef: boatRef,
        onEscape: chooseBoat,
    });

    if (!prompt) return null;

    const age = formatFixAge(Date.now() - prompt.held.timestamp);
    const apartNM = prompt.phone
        ? haversineNM(prompt.held.lat, prompt.held.lon, prompt.phone.lat, prompt.phone.lon)
        : null;
    const apart =
        apartNM === null
            ? ''
            : ` Your phone is ${apartNM < 10 ? apartNM.toFixed(1) : Math.round(apartNM)} NM from there.`;

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4"
            onClick={chooseBoat}
            role="dialog"
            aria-modal="true"
            aria-labelledby="weather-position-title"
            ref={dialogRef}
        >
            <div className="absolute inset-0 bg-black/60" />
            <div
                className="relative w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl p-6 animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <h3 id="weather-position-title" className="text-lg font-black text-white text-center mb-2">
                    Weather for the boat, or for you?
                </h3>
                <p className="text-sm text-gray-300 text-center mb-6">
                    {vesselName} last reported her position {age}.{apart} Until she reports again, the Glass can hold
                    her last fix or follow your phone.
                </p>
                <div className="flex gap-3">
                    <button
                        ref={boatRef}
                        type="button"
                        onClick={chooseBoat}
                        className="flex-1 py-3 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg transition-all active:scale-[0.97] bg-linear-to-r from-sky-600 to-sky-600 shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500"
                    >
                        Hold the boat
                    </button>
                    <button
                        type="button"
                        onClick={choosePhone}
                        className="flex-1 py-3 rounded-xl text-sm font-black uppercase tracking-widest border border-white/10 text-gray-300 transition-all active:scale-[0.97] hover:bg-white/5"
                    >
                        Follow my phone
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
