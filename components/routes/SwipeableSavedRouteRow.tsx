/**
 * SwipeableSavedRouteRow — a saved-route row whose Delete hides behind a
 * right-to-left swipe, like every other list in the app.
 *
 * Shane 2026-09-02: "can we have the delete buttons, hidden like all of the
 * other styled items, so when i swipe from right to left, it then exposes the
 * delete button." The permanently-visible DELETE column made the picker read
 * as a management screen rather than a chooser, and put a destructive control
 * a thumb-width from the row you actually wanted to open.
 *
 * The two-tap confirm SURVIVES the change, deliberately. Every other
 * swipeable card in the app deletes on the revealed tap because those deletes
 * are undoable; a saved route's is not (handleRoutePickerRemove has no undo
 * path, and a stitched passage can represent three sessions of plotting). So
 * the swipe hides the button and the confirm still guards the act: swipe →
 * Delete → Confirm.
 */
import React from 'react';
import { useSwipeable } from '../../hooks/useSwipeable';
import { triggerHaptic } from '../../utils/system';

interface SwipeableSavedRouteRowProps {
    /** Row chrome — the caller owns the border/background grammar. */
    className: string;
    /** True once the first tap has armed this row's delete. */
    deleteArmed: boolean;
    /** True while this row's delete is in flight. */
    deleteBusy: boolean;
    /** True while ANY row's delete is in flight — locks the whole list. */
    anyDeleteBusy: boolean;
    /** Absent for rows that cannot be removed (shared, or not ours). */
    onDelete?: () => void;
    deleteLabel: string;
    onOpen: () => void;
    children: React.ReactNode;
}

export const SwipeableSavedRouteRow: React.FC<SwipeableSavedRouteRowProps> = ({
    className,
    deleteArmed,
    deleteBusy,
    anyDeleteBusy,
    onDelete,
    deleteLabel,
    onOpen,
    children,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable({
        onSwipeComplete: () => void triggerHaptic('light'),
    });
    const revealed = swipeOffset > 0;

    return (
        <div className="relative overflow-hidden rounded-xl">
            {onDelete && (
                <button
                    type="button"
                    disabled={anyDeleteBusy}
                    aria-label={deleteLabel}
                    aria-hidden={!revealed}
                    tabIndex={revealed ? 0 : -1}
                    onClick={() => {
                        // An armed row stays revealed so Confirm can be read
                        // and tapped; a completed delete unmounts the row.
                        if (!deleteArmed) triggerHaptic('medium');
                        onDelete();
                    }}
                    className={`absolute inset-y-0 right-0 flex w-20 items-center justify-center text-center text-[11px] font-black uppercase tracking-wide text-white transition-opacity disabled:cursor-wait ${
                        deleteArmed ? 'bg-red-500' : 'bg-red-600'
                    } ${revealed ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                >
                    {deleteBusy ? 'Deleting…' : deleteArmed ? 'Confirm' : 'Delete'}
                </button>
            )}

            <button
                type="button"
                ref={ref}
                disabled={anyDeleteBusy}
                onClick={() => {
                    // A swipe that ends over the row must not open it — the
                    // gesture was aimed at the button behind.
                    if (swipeOffset > 0) {
                        resetSwipe();
                        return;
                    }
                    onOpen();
                }}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                className={`${className} relative flex w-full items-center gap-3 p-3 text-left transition-transform disabled:cursor-wait disabled:opacity-60 ${
                    isSwiping ? '' : 'duration-200'
                } ${swipeOffset === 0 ? 'active:scale-[0.98]' : ''}`}
            >
                {children}
            </button>
        </div>
    );
};
