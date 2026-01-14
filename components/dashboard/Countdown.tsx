import React, { useState, useEffect } from 'react';

export const Countdown = ({ targetTime }: { targetTime: number | null }) => {
    const [timeLeft, setTimeLeft] = useState("Updating...");

    useEffect(() => {
        if (!targetTime) return;
        const interval = setInterval(() => {
            const now = Date.now();
            const diff = targetTime - now;

            if (diff <= 0) {
                setTimeLeft("Updating...");
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
