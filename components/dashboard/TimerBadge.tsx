import React from 'react';
import { useWeather } from '../../context/WeatherContext';
import { Countdown } from './Countdown';

export const TimerBadge = () => {
    const { nextUpdate } = useWeather();

    return (
        <div className={`px-1.5 py-1.5 rounded-lg border text-[8px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-300 border-blue-500/30 bg-black/40 flex items-center gap-1 min-w-[60px] justify-center`}>
            {nextUpdate ? <Countdown targetTime={nextUpdate} /> : "LIVE"}
        </div>
    );
};
