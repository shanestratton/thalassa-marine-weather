/**
 * TapToAction — the tap twin of SlideToAction for routine, non-destructive
 * actions (adding a stores item, a task, a document…).
 *
 * Shane 2026-09-26 ("1 = word"): the slide guard stays on Drop Anchor and
 * Start Tracking, where an accidental activation matters; a routine add is a
 * single 44 pt+ tap. Same height, track and theme colours as the slide bar,
 * so the bottom of every Ship's Office page still reads as one family.
 *
 * No thumb disc (UX scorecard run 6): a tap bar that wore the slide's round
 * thumb looked exactly like 'Slide to drop anchor' and diluted what the
 * slide means. The icon sits inline beside the label instead, in the label's
 * colour — pass it uncoloured (stroke="currentColor", no text-* class).
 *
 * The shape is theme.ts `button.ctaShape`, the one bottom call to action, and
 * the label is sentence case like every other button (UX scorecard run 7:
 * ADD TASK sat beside 'Prepare voice call'). The slide bars now use the
 * same sentence-case 16 px bold label (UX scorecard run 9): their tracked
 * capitals made the slide the one shouting call to action on the page.
 *
 * `data-toast-dock` tells the toast stack to sit just above this bar instead
 * of over the page's first card (components/Toast.tsx).
 */
import React from 'react';
import { button as buttonTokens } from '../../theme';
import { ACTION_BAR_THEMES as THEMES } from './actionBarThemes';

interface TapToActionProps {
    /** Button text, sentence case, e.g. 'Add item' */
    label: string;
    /** Icon shown inline before the label; inherits the label colour */
    icon: React.ReactNode;
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
    icon,
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
                data-toast-dock=""
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
            data-toast-dock=""
            className={`press ${buttonTokens.ctaShape}`}
            style={{ background: colors.track, border: colors.trackBorder }}
        >
            <span className={`inline-flex items-center justify-center gap-2 ${colors.labelColor}`}>
                <span aria-hidden="true" className="flex shrink-0 items-center">
                    {icon}
                </span>
                <span>{label}</span>
            </span>
        </button>
    );
};
