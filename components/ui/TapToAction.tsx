/**
 * TapToAction — the tap twin of SlideToAction for routine, non-destructive
 * actions (adding a stores item, a task, a document…).
 *
 * Shane 2026-09-26 ("1 = word"): the slide guard stays on Drop Anchor and
 * Start Tracking, where an accidental activation matters; a routine add is a
 * single 44 pt+ tap. Same height, track, thumb disc and theme colours as the
 * slide bar, so the bottom of every Ship's Office page still reads as one
 * family — only the gesture changes.
 */
import React from 'react';
import { ACTION_BAR_THEMES as THEMES } from './actionBarThemes';

interface TapToActionProps {
    /** Button text, e.g. 'Add Item' */
    label: string;
    /** Icon shown in the round disc at the left, as on the slide thumb */
    thumbIcon: React.ReactNode;
    /** Called on tap */
    onConfirm: () => void;
    /** Show a spinner and loadingText instead of the button */
    loading?: boolean;
    loadingText?: string;
    disabled?: boolean;
    theme?: keyof typeof THEMES;
}

export const TapToAction: React.FC<TapToActionProps> = ({
    label,
    thumbIcon,
    onConfirm,
    loading = false,
    loadingText = 'Working…',
    disabled = false,
    theme = 'emerald',
}) => {
    const colors = THEMES[theme];

    if (loading) {
        return (
            <div
                role="status"
                className="w-full h-14 rounded-full flex items-center justify-center gap-3"
                style={{ background: colors.loadingTrack, border: colors.loadingBorder }}
            >
                <div
                    className={`w-5 h-5 border-2 ${colors.spinnerBorder} border-t-transparent rounded-full animate-spin`}
                />
                <span className={`text-sm ${colors.loadingTextColor} font-bold`}>{loadingText}</span>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={onConfirm}
            disabled={disabled}
            className="press relative w-full h-14 rounded-full flex items-center select-none transition-transform active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: colors.track, border: colors.trackBorder }}
        >
            <span
                aria-hidden="true"
                className="absolute left-1 top-1 bottom-1 aspect-square rounded-full flex items-center justify-center"
                style={{ background: colors.thumbBg, boxShadow: colors.thumbShadow }}
            >
                {thumbIcon}
            </span>
            <span className={`w-full text-center text-sm font-bold tracking-wider uppercase ${colors.labelColor}`}>
                {label}
            </span>
        </button>
    );
};
