/**
 * A UTC clock that actually ticks.
 *
 * RadioConsolePage computed `new Date().toISOString().slice(11, 19)` during
 * render with nothing to re-render it, so the time in the MAYDAY strip only
 * moved when something unrelated happened to change (audit 2026-09-02). On
 * an emergency console the UTC time is read aloud over the radio; it has to
 * be right to the second when it is read, not when the page last happened
 * to repaint.
 */
import { useEffect, useState } from 'react';

const stamp = (): string => new Date().toISOString().slice(11, 19);

export function useUtcClock(intervalMs = 1000): string {
    const [now, setNow] = useState(stamp);
    useEffect(() => {
        const id = setInterval(() => setNow(stamp()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
}
