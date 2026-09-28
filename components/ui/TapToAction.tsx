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
 *
 * Daylight (UX scorecard run 10): the night track is a 25% tint of the theme
 * colour, and on the pale daylight page that measured 1.22:1 (border 1.3:1),
 * so 'Start plotting' was the faintest object on the screen in sun while the
 * Log's slide kept its solid knob. By day the bar is a solid 700 fill with a
 * white label, like every other daylight primary. The night look is unchanged.
 * The classes carry `!` because the track colours are inline styles.
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

/** The daylight fill per theme: the 700 step, which carries a white label at
 *  5:1 or better and stands off the daylight page at 3:1 or better. */
const DAYLIGHT_FILL: Record<keyof typeof THEMES, string> = {
    emerald: '[.display-light_&]:bg-emerald-700! [.display-light_&]:border-emerald-800!',
    amber: '[.display-light_&]:bg-amber-700! [.display-light_&]:border-amber-800!',
    sky: '[.display-light_&]:bg-sky-700! [.display-light_&]:border-sky-800!',
};
const DAYLIGHT_SOLID =
    '[.display-light_&]:bg-none! [.display-light_&]:shadow-md [.display-light_&]:shadow-slate-900/15';
const DAYLIGHT_LABEL = '[.display-light_&]:text-white!';

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
                className={`w-full h-14 rounded-full flex items-center justify-center gap-3 ${DAYLIGHT_SOLID} ${DAYLIGHT_FILL[theme]}`}
                style={{ background: colors.loadingTrack, border: colors.loadingBorder }}
            >
                <div
                    className={`w-5 h-5 border-2 ${colors.spinnerBorder} [.display-light_&]:border-white! border-t-transparent [.display-light_&]:border-t-transparent! rounded-full animate-spin`}
                />
                <span className={`text-sm ${colors.loadingTextColor} ${DAYLIGHT_LABEL} font-bold`}>{loadingText}</span>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={onConfirm}
            disabled={disabled}
            data-toast-dock=""
            className={`press ${buttonTokens.ctaShape} ${DAYLIGHT_SOLID} ${DAYLIGHT_FILL[theme]}`}
            style={{ background: colors.track, border: colors.trackBorder }}
        >
            <span className={`inline-flex items-center justify-center gap-2 ${colors.labelColor} ${DAYLIGHT_LABEL}`}>
                <span aria-hidden="true" className="flex shrink-0 items-center">
                    {icon}
                </span>
                <span>{label}</span>
            </span>
        </button>
    );
};
