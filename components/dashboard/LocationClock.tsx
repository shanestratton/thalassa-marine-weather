import React, { useState, useEffect } from 'react';

export const LocationClock = ({ timeZone }: { timeZone: string | undefined }) => {
    const [now, setNow] = useState(new Date());

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // if (!timeZone) return null; // FIX: Always show clock, fallback to local if no TZ

    const tStr = now.toLocaleTimeString('en-US', timeZone ? { timeZone, hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
    const dStr = now.toLocaleDateString('en-US', timeZone ? { timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    return (
        <span className="text-white font-mono text-[10px] md:text-xs font-bold opacity-90 text-center flex flex-wrap justify-center gap-1 leading-tight">
            <span className="opacity-70 whitespace-nowrap">Location Time:</span>
            <span className="whitespace-nowrap">{tStr},</span>
            <span className="whitespace-nowrap">{dStr}</span>
        </span>
    );
};
