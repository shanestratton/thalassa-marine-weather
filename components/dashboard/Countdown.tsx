import React, { useState, useEffect } from 'react';

export const Countdown = ({ targetTime }: { targetTime: number | null }) => {
    const [timeLeft, setTimeLeft] = useState("Updating...");

    useEffect(() => {
        if (!targetTime) return;
        const interval = setInterval(() => {
            const now = Date.now();
            const diff = targetTime - now;

            if (diff <= 0) {
                // Show "Updating..." but with a safety net:
                // If we've been stuck at "Updating..." for >60s, something went wrong.
                // The WeatherContext should reschedule nextUpdate on failure,
                // but this is a UI-level safety net.
                const overdueSecs = Math.abs(diff) / 1000;
                if (overdueSecs > 60) {
                    // Stale — show how overdue we are so user knows it's stuck
                    const mins = Math.floor(overdueSecs / 60);
                    setTimeLeft(`Overdue ${mins}m`);
                } else {
                    setTimeLeft("Updating...");
                }
            } else {
                const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const secs = Math.floor((diff % (1000 * 60)) / 1000);
                setTimeLeft(`${mins}:${secs.toString().padStart(2, '0')} `);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, [targetTime]);

    if (!targetTime) return null;
    return <span className="font-mono tabular-nums tracking-tighter">{timeLeft}</span>;
};
