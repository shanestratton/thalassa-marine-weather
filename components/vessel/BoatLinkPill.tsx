/**
 * BoatLinkPill — where this phone is and how fresh the boat's data is, as the
 * header pill on the NMEA Gateway page and the Instrument Panel.
 *
 * Two chips, one reading: AWAY · LIVE. Said as one pill it clipped at 320 pt
 * with wide fonts ('AWAY · NOT CONNECTED' is 20 capitals at the widest
 * tracking under a back button); as a pair it wraps cleanly onto a second row
 * instead. Screen readers hear one sentence: the separator is spoken, not
 * drawn. The words and tones come from services/boatLink, so every screen
 * that shows this says the same thing.
 */
import React from 'react';
import type { BoatLinkPillWords, Tone } from '../../services/boatLink/boatLinkModel';

/** The red chip by day: opaque red-50 with red-800 text, not red-700 on a tint that measured 4.55:1 (UX scorecard run 7). */
export const PILL_TONE: Record<Tone, string> = {
    green: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    sky: 'bg-sky-500/10 border-sky-500/30 text-sky-400',
    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
    red: 'bg-red-500/10 border-red-500/30 text-red-400 [.display-light_&]:bg-red-50! [.display-light_&]:text-red-800!',
    grey: 'bg-white/5 border-white/15 text-gray-400',
};

export const DOT_TONE: Record<Tone, string> = {
    green: 'bg-emerald-400',
    sky: 'bg-sky-400',
    amber: 'bg-amber-400',
    red: 'bg-red-400',
    grey: 'bg-gray-500',
};

const CHIP =
    'flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-extrabold uppercase tracking-widest';

export const BoatLinkPill: React.FC<{
    pill: BoatLinkPillWords;
    /** A live-status role of its own; off when the pill sits inside a labelled button. */
    asStatus?: boolean;
    /** Pulse the dot (a connection in progress, or a live panel). */
    pulse?: boolean;
    /** Drawn at the end of the data chip, e.g. a "details" chevron. */
    trailing?: React.ReactNode;
}> = ({ pill, asStatus = true, pulse = false, trailing }) => {
    const dotTone = pill.place ? pill.placeTone : pill.dataTone;
    const dot = (
        <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[dotTone]}${pulse ? ' animate-pulse' : ''}`}
        />
    );
    return (
        <span
            role={asStatus ? 'status' : undefined}
            data-testid="boat-link-pill"
            className="flex flex-wrap items-center gap-1.5"
        >
            {pill.place && (
                <span className={`${CHIP} ${PILL_TONE[pill.placeTone]}`} data-testid="boat-link-place">
                    {dot}
                    {pill.place}
                </span>
            )}
            {pill.place && <span className="sr-only"> · </span>}
            <span className={`${CHIP} ${PILL_TONE[pill.dataTone]}`} data-testid="boat-link-data">
                {!pill.place && dot}
                {pill.data}
                {trailing}
            </span>
        </span>
    );
};
