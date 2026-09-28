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
import { useSettingsStore } from '../stores/settingsStore';
import { type WeatherFixKind, type WeatherFollowTarget } from '../services/weatherPosition';
import { fixAgeText, followedFix, validFixTime, type GpsBoxFixes } from './gpsFixState';

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

/**
 * 'Forecast for your last position (fixed 44 s ago), refreshed 20 s ago.'
 * Each time names what it dates, and both use the card's one age wording
 * (fixAgeText), so the sentence never mixes '5 min' with '5m' (UX scorecard
 * run 10: two bare times about different things read as a contradiction).
 */
function retainedForecast(fixAge: string | null, updatedAt: number | null | undefined, now: number): string {
    const fixed = fixAge ? ` (fixed ${fixAge})` : '';
    const refreshed = validFixTime(updatedAt, now) ? `, refreshed ${fixAgeText(Math.max(0, now - updatedAt))}` : '';
    return `Forecast for your last position${fixed}${refreshed}.`;
}

/** Pure: the shape and tone from what the weather chain and the instrument store say. */
export function resolveGpsSourceState(input: {
    weatherKind: WeatherFixKind | null;
    storeStatus: 'connected' | 'connecting' | 'disconnected' | 'error' | 'remote';
    remoteVia: 'lan' | 'cloud' | null;
    target?: WeatherFollowTarget;
    status?: 'live' | 'last-known' | 'unavailable' | 'resolving';
    retainedWeather?: boolean;
    timestamp?: number;
    hasWeatherContext?: boolean;
    /** The place the Glass is showing when the skipper picked one (not GPS-follow). */
    chosenPlace?: string | null;
    /**
     * The fix state of each receiver in the System status box, from the one
     * timestamp its card's position line reads (gpsFixState). When given,
     * every fix claim in this row reads it too, so the row and the cards
     * below it cannot disagree (UX referee run 8, gps-one-truth).
     */
    fixes?: GpsBoxFixes | null;
    /** When the forecast on the Glass was made: the '(updated …)' of a retained forecast. */
    forecastUpdatedAt?: number | null;
    now?: number;
}): GpsSourceState {
    const { weatherKind, storeStatus, remoteVia, target, status, timestamp } = input;
    const now = input.now ?? Date.now();
    const fix = input.fixes ? followedFix(input.fixes, weatherKind, target) : null;
    // The followed receiver's age from the box's one fix state; the bare
    // glyph (no box) falls back to the weather's own copy of the fix. One age
    // wording either way: the one the cards use.
    const fixAge = (): string | null =>
        fix && fix.kind !== 'none'
            ? fixAgeText(fix.ageMs)
            : validFixTime(timestamp, now)
              ? fixAgeText(Math.max(0, now - timestamp))
              : null;
    const lastFix = (who: string): string => {
        const age = fixAge();
        return `Position: ${who} last fix${age ? ` · ${age}` : ''}`;
    };
    const finding = `Position: finding ${target === 'boat' ? 'the boat’s' : 'this phone’s'} GPS location`;
    if (status === 'resolving') {
        return { glyph: target ?? 'none', tone: 'none', label: finding, canChoose: false };
    }
    if (status === 'unavailable') {
        // The weather could not read the receiver, yet the card below has a
        // live fix from it: the follower has not caught up. Saying the
        // receiver "isn't giving a position" would contradict the card.
        if (fix?.kind === 'live') {
            return {
                glyph: target ?? 'none',
                tone: 'none',
                label: input.retainedWeather
                    ? `Position: ${retainedForecast(null, input.forecastUpdatedAt, now).replace(/^F/, 'f')}`
                    : finding,
                canChoose: false,
            };
        }
        // A sentence with a verb. The retained tail names what each time
        // dates: the fix ('fixed 44 s ago', the card's own age words, never a
        // bare 'fix just now' that read as a fresh fix) and the forecast's
        // refresh (UX scorecard run 10).
        return {
            glyph: target ?? 'none',
            tone: 'none',
            label: `Position: ${target === 'boat' ? 'the boat' : 'this phone'} isn’t giving a position.${
                input.retainedWeather ? ` ${retainedForecast(fixAge(), input.forecastUpdatedAt, now)}` : ''
            }`,
            canChoose: false,
        };
    }
    if (weatherKind === 'phone') {
        const notLive = fix ? fix.kind !== 'live' : status === 'last-known';
        return notLive
            ? { glyph: 'phone', tone: 'held', label: lastFix('this phone’s'), canChoose: false }
            : { glyph: 'phone', tone: 'phone', label: 'Position: this phone’s GPS', canChoose: false };
    }
    // The weather's boat fix has aged past the boat card's live gate (or its
    // own, with no card): her last fix, never "live".
    const boatNotLive = weatherKind !== null && (fix ? fix.kind !== 'live' : status === 'last-known');
    const boatLastFix: GpsSourceState = { glyph: 'boat', tone: 'held', label: lastFix('the boat’s'), canChoose: false };
    // Instrument connectivity cannot override which receiver weather follows.
    const fallbackToInstruments = input.hasWeatherContext === false;
    const busLive =
        fallbackToInstruments && (storeStatus === 'connected' || (storeStatus === 'remote' && remoteVia === 'lan'));
    if (busLive || weatherKind === 'bus' || weatherKind === 'pi') {
        if (boatNotLive) return boatLastFix;
        return { glyph: 'boat', tone: 'live', label: 'Position: the boat’s GPS, live', canChoose: false };
    }
    if (weatherKind === 'cloud' || (fallbackToInstruments && storeStatus === 'remote' && remoteVia === 'cloud')) {
        if (boatNotLive) return boatLastFix;
        return { glyph: 'boat', tone: 'cloud', label: 'Position: the boat’s GPS, through the cloud', canChoose: false };
    }
    if (weatherKind === 'held') {
        return {
            glyph: 'boat',
            tone: 'held',
            label: `${lastFix('the boat’s')} — tap to choose the boat or this phone`,
            canChoose: true,
        };
    }
    // A picked place is where the weather is for, and no receiver is being
    // read for it. 'none yet' beside a Glass showing Gladstone read as if the
    // forecast had no position at all (UX scorecard run 6).
    if (input.chosenPlace) {
        return {
            glyph: 'none',
            tone: 'none',
            label: `Position: ${input.chosenPlace} (chosen place) — GPS not in use`,
            canChoose: false,
        };
    }
    return { glyph: 'none', tone: 'none', label: 'Position: none yet', canChoose: false };
}

/** The panel row's sentence starts with a capital, like the rows below it
 *  ('Not tracking', 'Not deployed'); the accessible name keeps its prefix. */
function rowDetail(label: string): string {
    const detail = label.replace(/^Position:\s*/, '');
    return detail.charAt(0).toUpperCase() + detail.slice(1);
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
function useGpsSourceState(fixes?: GpsBoxFixes | null): {
    state: GpsSourceState;
    choice: { open: () => void } | null | undefined;
} {
    const weather = useWeatherOptional();
    const link = useNmeaConnectionStatus();
    const defaultLocation = useSettingsStore((s) => s.settings?.defaultLocation);
    // Off GPS-follow the context publishes no receiver at all; the place on
    // the Glass is then the skipper's pick.
    const shownName = weather?.weatherData?.locationName?.trim();
    const chosenPlace =
        weather && !weather.positionSource && defaultLocation && defaultLocation !== 'Current Location' && shownName
            ? shownName
            : null;
    const generatedAt = weather?.weatherData?.generatedAt;
    const state = resolveGpsSourceState({
        weatherKind: weather?.positionSource?.kind ?? null,
        storeStatus: link.status,
        remoteVia: link.remote?.via ?? null,
        target: weather?.positionSource?.target,
        status: weather?.positionSource?.status,
        retainedWeather: weather?.positionSource?.retainedWeather,
        timestamp: weather?.positionSource?.timestamp,
        hasWeatherContext: weather != null,
        chosenPlace,
        fixes,
        forecastUpdatedAt: generatedAt ? Date.parse(String(generatedAt)) : null,
    });
    return { state, choice: weather?.positionChoice };
}

/**
 * The row in the ℹ System Status panel (Shane 2026-09-08: "lets move the
 * phone or vessel gps icon into the i section, rather than sticking yet
 * another fab on the already jam packed screen"). Glyph plus the sentence —
 * this is the one place the words are welcome.
 */
export const GpsSourceRow: React.FC<{
    compact?: boolean;
    /** The box's per-receiver fix states (presentWeatherPositionBox), so this row reads the cards' one timestamp. */
    fixes?: GpsBoxFixes | null;
}> = ({ compact = false, fixes = null }) => {
    const { state } = useGpsSourceState(fixes);
    const detail = rowDetail(state.label);
    return (
        <div
            data-testid="gps-source-row"
            data-glyph={state.glyph}
            data-tone={state.tone}
            className={
                compact
                    ? 'flex items-center gap-2.5'
                    : 'flex items-center gap-3 rounded-xl border border-white/10 bg-white/3 p-3'
            }
        >
            <span
                className={`flex shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 ${compact ? 'h-8 w-8' : 'h-10 w-10'}`}
            >
                <GlyphArt glyph={state.glyph} tone={state.tone} />
            </span>
            {/* One heading style in the card: sentence-case semibold, the same
                as 'Phone location' below it, over a regular-weight sentence.
                It was a tracked-caps eyebrow over an all-bold paragraph, then a
                sentence-case bold heading, three looks in one card (UX
                scorecard run 9). */}
            <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold text-white">{compact ? 'Weather position' : 'Position'}</h3>
                <p className={`${compact ? 'text-xs' : 'text-sm'} mt-0.5 leading-snug text-slate-300`}>{detail}</p>
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
