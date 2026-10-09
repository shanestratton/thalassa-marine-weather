import React from 'react';
import { AnchorIcon } from '../Icons';

/**
 * The radar's amber "Move anchor" chip: on the boat's own radar for the watch
 * this phone keeps, and on Shore Watch's radar for the watch this phone handed
 * to the Pi (126-07a). One chip, so the two look and read alike. 44 px tall.
 */
export function MoveAnchorChip({ onClick, className = '' }: { onClick: () => void; className?: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex min-h-11 items-center gap-1.5 rounded-full border border-amber-400/30 bg-slate-900/80 px-3 text-sm font-bold text-amber-300 transition-all active:scale-[0.97] ${className}`}
        >
            <AnchorIcon className="h-4 w-4 shrink-0" />
            Move anchor
        </button>
    );
}
