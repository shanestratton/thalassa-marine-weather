import React from 'react';
import { useWeather } from '../../context/WeatherContext';

export const TimerBadge = () => {
    const { nextUpdate, weatherData, refreshData } = useWeather();
    const [label, setLabel] = React.useState<string>('LIVE');
    const [isRefreshing, setIsRefreshing] = React.useState(false);

    // Robust Timer Logic
    React.useEffect(() => {
        const update = () => {
            const now = Date.now();

            // 1. If we have a valid next update in the future, COUNT DOWN
            if (nextUpdate && nextUpdate > now) {
                const diff = nextUpdate - now;
                const mins = Math.ceil(diff / (1000 * 60));
                // Show minute-precision countdown (10s interval instead of 1s)
                setLabel(mins <= 1 ? '<1m' : `${mins}m`);
                return;
            }

            // 2. Fallback: If no future update, show AGE of data (e.g. "5m ago")
            if (weatherData?.generatedAt) {
                const generated = new Date(weatherData.generatedAt).getTime();
                const age = now - generated;
                const ageMins = Math.floor(age / 60000);

                if (ageMins < 1) setLabel('Now');
                else if (ageMins < 60) setLabel(`${ageMins}m`);
                else setLabel(`${Math.floor(ageMins / 60)}h`);
                return;
            }

            setLabel('LIVE');
        };

        update();
        const interval = setInterval(update, 10_000);
        return () => clearInterval(interval);
    }, [nextUpdate, weatherData]);

    const handleTap = () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        setLabel('...');
        refreshData();
        // refreshData is fire-and-forget (not async), reset spinner after a brief period
        setTimeout(() => setIsRefreshing(false), 3000);
    };

    const isCountdown = nextUpdate && nextUpdate > Date.now();

    return (
        <button
            onClick={handleTap}
            disabled={isRefreshing}
            className={`px-2 py-1.5 rounded-lg border text-[11px] font-bold uppercase tracking-wider bg-black/40 flex items-center gap-1 min-w-[52px] justify-center active:scale-95 transition-transform ${
                isRefreshing
                    ? 'bg-sky-500/20 text-sky-300 border-sky-500/30 animate-pulse'
                    : isCountdown
                      ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
                      : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            }`}
        >
            {isRefreshing ? (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            ) : (
                <svg
                    className="w-3 h-3 opacity-60"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                    />
                </svg>
            )}
            {label}
        </button>
    );
};
