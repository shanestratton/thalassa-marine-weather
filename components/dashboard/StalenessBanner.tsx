/**
 * StalenessBanner — A thin floating strip that tells the user when the
 * weather data on screen is older than it looks. Surfaces the `_stale`
 * and `_staleAgeMinutes` fields that the weather orchestrator already
 * sets when every upstream fails and we fall back to offline cache, plus
 * the `error` signal from WeatherContext.
 *
 * Severity tiers (in decreasing order of urgency):
 *   - error     — fetch pipeline failed outright (red)
 *   - offline   — _stale === true, serving from offline cache  (red)
 *   - very-old  — age ≥ 120 min coastal / 240 min offshore (amber)
 *   - old       — age ≥ 60  min coastal / 120 min offshore (yellow)
 *   - none      — fresh enough, render nothing
 *
 * Offshore thresholds are doubled since offshore data only refreshes
 * hourly — we don't want to scream WARNING on every normal fetch.
 */
import React from 'react';

interface StalenessBannerProps {
    generatedAt?: string;
    /** Orchestrator marks this true when it served from offline cache. */
    stale?: boolean;
    /** Age in minutes, set alongside `stale`. */
    staleAgeMinutes?: number;
    /** From WeatherContext — pipeline-level failure. */
    error?: string | null;
    /** Offshore refreshes hourly — loosen thresholds. */
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    /** Device-level offline flag from navigator.onLine. The orchestrator's
     *  `stale` only fires when a fetch attempt fails — if the user is just
     *  sitting on fresh data and their connection drops, nothing signals
     *  them. Wiring this prop in surfaces the offline state immediately. */
    isOffline?: boolean;
    onRefresh?: () => void;
    /** Disables the button while a refresh is in flight. */
    isSyncing?: boolean;
}

type Severity = 'error' | 'offline' | 'no-network' | 'very-old' | 'old' | null;

function pickSeverity(
    ageMin: number,
    stale: boolean | undefined,
    error: string | null | undefined,
    isOffline: boolean | undefined,
    isOffshore: boolean,
): Severity {
    if (error) return 'error';
    if (stale) return 'offline';
    // Device is offline but weather data is still recent enough — show
    // the subtle amber 'no-network' banner so the user knows why a refresh
    // won't happen, without screaming at them.
    if (isOffline) return 'no-network';
    const oldT = isOffshore ? 120 : 60;
    const veryOldT = isOffshore ? 240 : 120;
    if (ageMin >= veryOldT) return 'very-old';
    if (ageMin >= oldT) return 'old';
    return null;
}

const THEME: Record<
    Exclude<Severity, null>,
    { bg: string; border: string; text: string; dot: string; icon: string }
> = {
    error: {
        bg: 'bg-red-500/15',
        border: 'border-red-500/40',
        text: 'text-red-200',
        dot: 'bg-red-400',
        icon: 'text-red-300',
    },
    offline: {
        bg: 'bg-red-500/15',
        border: 'border-red-500/40',
        text: 'text-red-200',
        dot: 'bg-red-400',
        icon: 'text-red-300',
    },
    'no-network': {
        // Subtle amber — serving cached data happily, just no connection
        // to refresh. Less alarming than the red 'offline' variant which
        // fires when the orchestrator actively failed to fetch.
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        text: 'text-amber-200',
        dot: 'bg-amber-400',
        icon: 'text-amber-300',
    },
    'very-old': {
        bg: 'bg-amber-500/15',
        border: 'border-amber-500/40',
        text: 'text-amber-200',
        dot: 'bg-amber-400',
        icon: 'text-amber-300',
    },
    old: {
        bg: 'bg-yellow-500/15',
        border: 'border-yellow-500/40',
        text: 'text-yellow-200',
        dot: 'bg-yellow-400',
        icon: 'text-yellow-300',
    },
};

function formatAge(min: number): string {
    if (min < 60) return `${Math.round(min)}m`;
    const h = Math.floor(min / 60);
    const rest = Math.round(min - h * 60);
    return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

export const StalenessBanner: React.FC<StalenessBannerProps> = React.memo(
    ({ generatedAt, stale, staleAgeMinutes, error, locationType, isOffline, onRefresh, isSyncing }) => {
        // Prefer generatedAt because _staleAgeMinutes is a snapshot at save time
        // and will lie after the cached payload gets rehydrated on a later launch.
        const ageMin = React.useMemo(() => {
            if (generatedAt) {
                const ts = new Date(generatedAt).getTime();
                if (!Number.isNaN(ts)) return Math.max(0, (Date.now() - ts) / 60_000);
            }
            if (typeof staleAgeMinutes === 'number' && staleAgeMinutes >= 0) return staleAgeMinutes;
            return 0;
        }, [generatedAt, staleAgeMinutes]);

        const isOffshore = locationType === 'offshore';
        const severity = pickSeverity(ageMin, stale, error, isOffline, isOffshore);

        if (!severity) return null;

        const theme = THEME[severity];

        let label: string;
        let detail: string;
        if (severity === 'error') {
            label = 'Weather data unavailable';
            detail = error || 'All sources failed';
        } else if (severity === 'offline') {
            label = 'Offline cache';
            detail = `Data ${formatAge(ageMin)} old — last fetch failed`;
        } else if (severity === 'no-network') {
            label = 'No connection';
            detail = `Showing cached data (${formatAge(ageMin)} old)`;
        } else if (severity === 'very-old') {
            label = 'Data is stale';
            detail = `${formatAge(ageMin)} since last update`;
        } else {
            label = 'Data getting old';
            detail = `${formatAge(ageMin)} since last update`;
        }

        // Loud-mode styling for the high-severity banners (error / offline).
        // User feedback: the thin 11px strip was too quiet when the refresh
        // pipeline has actually failed — the skipper needs a louder signal
        // than for "data's 70 minutes old". Lift these two severities to:
        //   - 12px bold text (up from 11px)
        //   - 4px left accent bar (ties visual weight to severity colour)
        //   - Subtle pulsing glow under the whole banner (new keyframe)
        // Everything else stays on the subtle original styling.
        const isLoud = severity === 'error' || severity === 'offline';
        const textSize = isLoud ? 'text-xs' : 'text-[11px]';
        const verticalPad = isLoud ? 'py-2.5' : 'py-2';
        const leftAccent = isLoud ? 'border-l-4' : '';
        const loudGlow = isLoud ? 'staleness-loud-glow' : '';

        return (
            <div
                role="status"
                aria-live="polite"
                className={`relative flex items-center gap-2 px-3 ${verticalPad} mb-2 rounded-xl border ${leftAccent} ${theme.bg} ${theme.border} ${loudGlow} backdrop-blur-sm`}
            >
                {/* Pulsing dot — catches the eye without being obnoxious */}
                <span className="relative flex w-2 h-2 shrink-0">
                    <span className={`animate-ping absolute inset-0 rounded-full ${theme.dot} opacity-60`} />
                    <span className={`relative w-2 h-2 rounded-full ${theme.dot}`} />
                </span>

                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                    <span className={`${textSize} font-bold uppercase tracking-wider ${theme.text}`}>{label}</span>
                    <span className={`${textSize} ${theme.text} opacity-80 truncate`}>{detail}</span>
                </div>

                {/* Hide the retry button when there's literally no network —
                    tapping it would just fail again. It comes back the moment
                    the connection returns. */}
                {onRefresh && severity !== 'no-network' && (
                    <button
                        onClick={onRefresh}
                        disabled={isSyncing}
                        aria-label="Retry fetching weather data"
                        className={`${textSize} font-bold uppercase tracking-wider px-2 py-1 rounded-lg border ${theme.border} ${theme.text} hover:bg-white/5 active:scale-[0.95] transition-all disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                        {isSyncing ? 'Syncing' : 'Retry'}
                    </button>
                )}
            </div>
        );
    },
);

StalenessBanner.displayName = 'StalenessBanner';
