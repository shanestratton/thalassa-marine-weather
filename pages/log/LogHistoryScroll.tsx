import React from 'react';

/** Free scrolling keeps the archive header reachable above the voyage cards.
 * Card snapping skips that header and pulls it back behind the stats panel. */
export function LogHistoryScroll({ children }: { children: React.ReactNode }) {
    return (
        <div
            role="region"
            aria-label="Voyage history"
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-4 pb-4"
        >
            {children}
        </div>
    );
}
