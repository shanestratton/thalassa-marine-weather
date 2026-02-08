import React from 'react';
import { useWeather } from '../../context/WeatherContext';
import { Countdown } from './Countdown';

export const TimerBadge = () => {
    const { nextUpdate, weatherData } = useWeather();
    const [label, setLabel] = React.useState<string>("LIVE");

    // Robust Timer Logic
    React.useEffect(() => {
        const update = () => {
            const now = Date.now();

            // 1. If we have a valid next update in the future, COUNT DOWN
            if (nextUpdate && nextUpdate > now) {
                const diff = nextUpdate - now;
                const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const secs = Math.floor((diff % (1000 * 60)) / 1000);
                setLabel(`${mins}:${secs.toString().padStart(2, '0')}`);
                return;
            }

            // 2. Fallback: If no future update, show AGE of data (e.g. "5m ago")
            if (weatherData?.generatedAt) {
                const generated = new Date(weatherData.generatedAt).getTime();
                const age = now - generated;
                const ageMins = Math.floor(age / 60000);

                if (ageMins < 1) setLabel("Just now");
                else if (ageMins < 60) setLabel(`${ageMins}m ago`);
                else setLabel(`${Math.floor(ageMins / 60)}h ago`);
                return;
            }

            setLabel("LIVE");
        };

        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [nextUpdate, weatherData]);

    const isStale = label.includes("ago") && !label.includes("Just");

    return (
        <div className={`px-1.5 py-1.5 rounded-lg border text-sm font-bold uppercase tracking-wider ${isStale ? 'bg-orange-500/20 text-orange-300 border-orange-500/30' : 'bg-blue-500/20 text-blue-300 border-blue-500/30'} bg-black/40 flex items-center gap-1 min-w-[60px] justify-center`}>
            {label}
        </div>
    );
};
