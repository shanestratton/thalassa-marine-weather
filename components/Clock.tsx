
import React, { useState, useEffect } from 'react';

interface ClockProps {
    timeZone?: string;
    utcOffset?: number;
    className?: string;
    format?: 'time' | 'date' | 'datetime' | 'full';
    showLocalLabel?: boolean;
}

export const Clock: React.FC<ClockProps> = ({ timeZone, utcOffset, className, format = 'time', showLocalLabel }) => {
    const [time, setTime] = useState(new Date());

    useEffect(() => {
        // Sync to the second
        const timer = setInterval(() => setTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const getText = () => {
        // Determine target date object
        let targetDate = time;
        let timeZoneOption: string | undefined = undefined;

        if (timeZone) {
            timeZoneOption = timeZone;
        } else if (utcOffset !== undefined) {
             const nowUTC = time.getTime();
             const nowOffset = time.getTimezoneOffset() * 60000; // Local offset in ms
             const utcTime = nowUTC + nowOffset; // Pure UTC
             targetDate = new Date(utcTime + (utcOffset * 3600 * 1000));
             timeZoneOption = 'UTC'; // We shifted the time manually, so treat as UTC for formatting
        }

        const options: Intl.DateTimeFormatOptions = { timeZone: timeZoneOption };

        if (format === 'date') {
            options.weekday = 'long';
            options.month = 'short';
            options.day = 'numeric';
            return targetDate.toLocaleDateString('en-US', options);
        }
        
        if (format === 'datetime') {
            return targetDate.toLocaleString('en-US', options);
        }

        if (format === 'full') {
            // "14:32 • Friday, August 24"
            const timeStr = targetDate.toLocaleTimeString('en-US', { 
                ...options, 
                hour: 'numeric', 
                minute: '2-digit', 
                hour12: false 
            });
            const dateStr = targetDate.toLocaleDateString('en-US', { 
                ...options, 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric' 
            });
            return `${timeStr} • ${dateStr}`;
        }

        // Default 'time'
        return targetDate.toLocaleTimeString('en-US', { 
            ...options, 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: false
        });
    };

    return (
        <span className={className}>
            {getText()}
            {showLocalLabel && <span className="text-sm opacity-60 ml-2">(Local)</span>}
        </span>
    );
};
