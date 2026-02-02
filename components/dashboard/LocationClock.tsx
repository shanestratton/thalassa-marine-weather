import React, { useState, useEffect } from 'react';

export const LocationClock = ({ timeZone, utcOffset }: { timeZone: string | undefined, utcOffset?: number }) => {
    const [now, setNow] = useState(new Date());

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // if (!timeZone) return null; // FIX: Always show clock, fallback to local if no TZ

    let tStr = '';
    let dStr = '';

    try {
        if (timeZone) {
            tStr = now.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
            dStr = now.toLocaleDateString('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        } else if (utcOffset !== undefined) {
            // Manual Shift: Time = UTC + Offset. Display as UTC.
            // API returns utcOffset in SECONDS. Convert to MS.
            const targetTime = new Date(now.getTime() + (utcOffset * 1000));
            // We use 'UTC' as the timezone to display the shifted time "as is"
            tStr = targetTime.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
            dStr = targetTime.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        } else {
            // Fallback to Device Time
            tStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            dStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        }
    } catch (e) {
        // Fallback to local time if timezone is invalid
        tStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        dStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }

    return (
        <span className="text-white font-mono text-[8px] md:text-[10px] font-bold opacity-80 text-center flex flex-wrap justify-center gap-0.5 leading-tight">
            <span className="whitespace-nowrap">{tStr}</span>
            <span className="opacity-50">•</span>
            <span className="whitespace-nowrap hidden sm:inline">{dStr}</span>
            <span className="whitespace-nowrap sm:hidden">{now.toLocaleDateString('en-US', { timeZone: timeZone || 'UTC', month: 'short', day: 'numeric' })}</span>
        </span>
    );
};
