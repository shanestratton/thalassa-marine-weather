/**
 * The one stand-in question (build 123, package VL; Shane 2026-08-30: a phone
 * standing in for the boat's GPS needs "a modal opt-in AND per-point
 * tagging").
 *
 * Asked at the Log page's Start when a boat is set up but her GPS is silent,
 * never from ashore — and, once, for a live voyage started anywhere else (the
 * Cast Off handoff, a Start while her lane was still connecting) that has
 * never heard her and has the phone held for want of any fix of hers. "Wait
 * for the boat" makes it a boat-only voyage: the phone never stands in, and
 * the track begins when one of her lanes answers. "Log from this phone" makes
 * the phone the source, every point tagged as the phone's. Centred and clear
 * of the tab bar (the modal rule, 2026-08-31), and it must fit a 320 × 568
 * phone with large text.
 */
import React from 'react';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface StandInQuestionModalProps {
    isOpen: boolean;
    /** The boat's name, when the skipper gave her one. */
    boatName?: string | null;
    onAnswer: (answer: 'phone' | 'wait') => void;
    onCancel: () => void;
}

export const StandInQuestionModal: React.FC<StandInQuestionModalProps> = ({ isOpen, boatName, onAnswer, onCancel }) => {
    const waitRef = React.useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, { initialFocusRef: waitRef, onEscape: onCancel });
    if (!isOpen) return null;
    const name = boatName?.trim();
    const title = name ? `${name}’s GPS isn’t answering` : 'Your boat’s GPS isn’t answering';

    return (
        <OverlayPortal
            role="presentation"
            onClick={(event) => {
                if (event.target === event.currentTarget) onCancel();
            }}
            data-stand-in-question
            className="flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="stand-in-question-title"
                data-stand-in-card
                className="relative w-full max-w-sm max-h-full overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 p-4 text-white shadow-2xl"
            >
                <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Cancel"
                    className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-400 hover:bg-white/10 hover:text-white"
                >
                    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
                <h2 id="stand-in-question-title" className="ui-dialog-title min-h-11 pr-12 pt-1.5 wrap-break-word">
                    {title}
                </h2>
                <div className="mt-3 flex flex-col gap-2">
                    <button
                        ref={waitRef}
                        type="button"
                        onClick={() => onAnswer('wait')}
                        className="min-h-11 w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-bold text-white active:scale-[0.98]"
                    >
                        Wait for the boat
                    </button>
                    <button
                        type="button"
                        onClick={() => onAnswer('phone')}
                        className="min-h-11 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-bold text-white active:scale-[0.98]"
                    >
                        Log from this phone
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
