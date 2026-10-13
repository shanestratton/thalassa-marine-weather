/**
 * SwipeableSavedPlaceRow — a saved place in The Glass's Locations box whose
 * Delete hides behind a right-to-left swipe, like the rest of the app's lists.
 *
 * Shane 2026-10-13: "these locations in the location box will not remove when
 * i press the remove button. however, i would prefer them to be a swipe
 * delete, like almost all of the rest of the app." The saved-route rows'
 * pattern (routes/SwipeableSavedRouteRow.tsx): the same reveal, the same
 * words, and the same two taps, Delete then Confirm, because a saved place has
 * no undo here either.
 *
 * Unlike a route row it holds two buttons side by side (go there, Set home),
 * so the row slides as a box, and its own taps are guarded here: the click a
 * swipe's release can make never goes to the place or sets home, and a tap on
 * a row left open only closes it.
 */
import React, { useRef } from 'react';
import { useSwipeable } from '../hooks/useSwipeable';
import { triggerHaptic } from '../utils/system';

/**
 * Sideways travel past this was a swipe, not a tap. Twice useSwipeable's 6 px
 * direction lock: a thumb that rolls a few px on a tap (underway, say) slides
 * the row and snaps back, and that tap still goes to the place, as it does on
 * the saved-route rows. Anything that latches open (24 px) is past it.
 */
const SWIPE_SLOP_PX = 12;
/** A click this soon after a swipe, with no new touch between, is the swipe's own. */
const RELEASE_CLICK_MS = 1000;

interface SwipeableSavedPlaceRowProps {
    name: string;
    /** True once the first tap has armed this row's delete. */
    armed: boolean;
    onDelete: () => void;
    /** The row's own classes (the wash on the place the Glass is showing). */
    className?: string;
    children: React.ReactNode;
}

export const SwipeableSavedPlaceRow: React.FC<SwipeableSavedPlaceRowProps> = ({
    name,
    armed,
    onDelete,
    className = '',
    children,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable({
        onSwipeComplete: () => void triggerHaptic('light'),
    });
    const revealed = swipeOffset > 0;
    const touchStartX = useRef<number | null>(null);
    // When the last swipe on this row let go. A new touch clears it, so a
    // deliberate tap is never mistaken for a swipe's release.
    const swipedAt = useRef(0);

    return (
        <div role="none" className="relative overflow-hidden">
            <button
                type="button"
                role={revealed ? 'menuitem' : undefined}
                aria-label={armed ? `Confirm delete ${name}` : `Delete ${name}`}
                aria-hidden={!revealed}
                tabIndex={revealed ? 0 : -1}
                onClick={() => {
                    if (!armed) triggerHaptic('medium');
                    onDelete();
                }}
                className={`absolute inset-y-0 right-0 flex w-20 items-center justify-center text-center text-[11px] font-black uppercase tracking-wide text-white transition-opacity ${
                    armed ? 'bg-red-500' : 'bg-red-600'
                } ${revealed ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
                {armed ? 'Confirm' : 'Delete'}
            </button>

            {/* The flyout's own opaque fill, so Delete never shows through mid-swipe. */}
            <div
                ref={ref}
                role="none"
                onTouchStart={(e) => {
                    touchStartX.current = e.touches[0]?.clientX ?? null;
                    swipedAt.current = 0;
                }}
                onTouchEnd={(e) => {
                    const x = e.changedTouches[0]?.clientX;
                    const start = touchStartX.current;
                    if (start !== null && x !== undefined && Math.abs(x - start) > SWIPE_SLOP_PX) {
                        swipedAt.current = Date.now();
                    }
                    touchStartX.current = null;
                }}
                onClickCapture={(e) => {
                    if (swipedAt.current && Date.now() - swipedAt.current < RELEASE_CLICK_MS) {
                        swipedAt.current = 0;
                    } else if (revealed) {
                        resetSwipe();
                    } else {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                }}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                className={`thalassa-popover-solid relative bg-slate-800 transition-transform ${isSwiping ? '' : 'duration-200'}`}
            >
                <div role="none" className={`flex items-center pr-2 ${className}`}>
                    {children}
                </div>
            </div>
        </div>
    );
};
