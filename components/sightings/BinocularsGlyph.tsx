/**
 * The Sightings mark: a pair of binoculars, a stroke glyph in the current
 * colour. Its own tiny module because the two ways in (the Scuttlebutt card
 * and the Log page's Sighting pill) live in other chunks and need only this.
 */
import React from 'react';

export const BinocularsGlyph: React.FC<{ className?: string }> = ({ className = 'h-5 w-5' }) => (
    <svg
        aria-hidden="true"
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <circle cx="6.5" cy="15.5" r="3.5" />
        <circle cx="17.5" cy="15.5" r="3.5" />
        <path d="M10 15.5h4" />
        <path d="M4 13l2-7h3l1 6M20 13l-2-7h-3l-1 6" />
    </svg>
);
