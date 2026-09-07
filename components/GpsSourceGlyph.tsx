/**
 * GpsSourceGlyph — a boat or a phone, with a GPS dot: which receiver the app
 * is reading right now.
 *
 * Shane 2026-09-08: "i do not like the messages that are popping up about
 * what gps we are using … could we instead just have a picture of a phone or
 * a picture of a little boat, with some way of identifying that it is gps??
 * then remove all of the references to which gps we are using." So: no words
 * on the page. The shape says boat or phone; the dot's colour says live,
 * through the cloud, or her held last fix. The sentence survives only as the
 * accessible name, and while the weather is holding the boat's last fix the
 * glyph is a button that re-opens the boat-or-phone question.
 */
import React from 'react';
import { useWeatherOptional } from '../context/WeatherContext';
import { useNmeaConnectionStatus } from './nmea/useNmeaStore';
import type { WeatherFixKind } from '../services/weatherPosition';

export type GpsGlyph = 'boat' | 'phone' | 'none';
export type GpsTone = 'live' | 'cloud' | 'held' | 'phone' | 'none';

export interface GpsSourceState {
    glyph: GpsGlyph;
    tone: GpsTone;
    /** The accessible name — the only place the words live. */
    label: string;
    /** A held last fix can be changed: the glyph becomes a button. */
    canChoose: boolean;
}

/** Pure: the shape and tone from what the weather chain and the instrument store say. */
export function resolveGpsSourceState(input: {
    weatherKind: WeatherFixKind | null;
    storeStatus: 'connected' | 'connecting' | 'disconnected' | 'error' | 'remote';
    remoteVia: 'lan' | 'cloud' | null;
}): GpsSourceState {
    const { weatherKind, storeStatus, remoteVia } = input;
    const busLive = storeStatus === 'connected' || (storeStatus === 'remote' && remoteVia === 'lan');
    if (busLive || weatherKind === 'bus' || weatherKind === 'pi') {
        return { glyph: 'boat', tone: 'live', label: 'Position: the boat’s GPS, live', canChoose: false };
    }
    if (weatherKind === 'cloud' || (storeStatus === 'remote' && remoteVia === 'cloud')) {
        return { glyph: 'boat', tone: 'cloud', label: 'Position: the boat’s GPS, through the cloud', canChoose: false };
    }
    if (weatherKind === 'held') {
        return {
            glyph: 'boat',
            tone: 'held',
            label: 'Position: the boat’s last fix — tap to choose the boat or this phone',
            canChoose: true,
        };
    }
    if (weatherKind === 'phone') {
        return { glyph: 'phone', tone: 'phone', label: 'Position: this phone’s GPS', canChoose: false };
    }
    return { glyph: 'none', tone: 'none', label: 'Position: none yet', canChoose: false };
}

const TONE_CLASS: Record<GpsTone, string> = {
    live: 'text-emerald-400',
    cloud: 'text-sky-400',
    held: 'text-amber-400',
    phone: 'text-slate-400',
    none: 'text-slate-600',
};

const GlyphArt: React.FC<{ glyph: GpsGlyph; tone: GpsTone }> = ({ glyph, tone }) => (
    <svg
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        {glyph === 'boat' && (
            <g className="text-white">
                <path d="M11 4v11" />
                <path d="M11 5l6 9h-6z" fill="currentColor" fillOpacity={0.35} />
                <path d="M3 17h17l-2.5 3.5H5.5z" />
            </g>
        )}
        {glyph === 'phone' && (
            <g className="text-white">
                <rect x="7" y="3" width="10" height="18" rx="2" />
                <path d="M11 18h2" />
            </g>
        )}
        {glyph === 'none' && (
            <g className="text-slate-500">
                <circle cx="11" cy="13" r="6" />
                <path d="M11 7V5M11 21v-2M5 13H3M19 13h-2" />
            </g>
        )}
        {/* The GPS fix dot: a filled centre and a ring. */}
        <g className={TONE_CLASS[tone]}>
            <circle cx="19" cy="5" r="2.4" fill="currentColor" stroke="none" />
            <circle cx="19" cy="5" r="4.2" strokeOpacity={0.55} />
        </g>
    </svg>
);

/** Shared by the chip and the status-panel row: what the app is reading right now. */
function useGpsSourceState(): { state: GpsSourceState; choice: { open: () => void } | null | undefined } {
    const weather = useWeatherOptional();
    const link = useNmeaConnectionStatus();
    const state = resolveGpsSourceState({
        weatherKind: weather?.positionSource?.kind ?? null,
        storeStatus: link.status,
        remoteVia: link.remote?.via ?? null,
    });
    return { state, choice: weather?.positionChoice };
}

/**
 * The row in the ℹ System Status panel (Shane 2026-09-08: "lets move the
 * phone or vessel gps icon into the i section, rather than sticking yet
 * another fab on the already jam packed screen"). Glyph plus the sentence —
 * this is the one place the words are welcome.
 */
export const GpsSourceRow: React.FC = () => {
    const { state } = useGpsSourceState();
    const detail = state.label.replace(/^Position:\s*/, '');
    return (
        <div
            data-testid="gps-source-row"
            data-glyph={state.glyph}
            data-tone={state.tone}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/3 p-3"
        >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5">
                <GlyphArt glyph={state.glyph} tone={state.tone} />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Position</p>
                <p className="text-sm font-semibold text-white">{detail}</p>
            </div>
        </div>
    );
};

export const GpsSourceGlyph: React.FC<{ className?: string }> = ({ className = '' }) => {
    const { state, choice } = useGpsSourceState();
    const chip = `flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 backdrop-blur-md ${className}`;
    if (state.canChoose && choice) {
        return (
            <button
                type="button"
                onClick={() => choice.open()}
                aria-label={state.label}
                title={state.label}
                data-testid="gps-source-glyph"
                data-glyph={state.glyph}
                data-tone={state.tone}
                className={`${chip} transition-transform active:scale-95`}
            >
                <GlyphArt glyph={state.glyph} tone={state.tone} />
            </button>
        );
    }
    return (
        <span
            role="img"
            aria-label={state.label}
            title={state.label}
            data-testid="gps-source-glyph"
            data-glyph={state.glyph}
            data-tone={state.tone}
            className={chip}
        >
            <GlyphArt glyph={state.glyph} tone={state.tone} />
        </span>
    );
};
