/**
 * Pure formatters for the Nav Station hero band.
 *
 * deriveVoyageState stays in components/VesselHub.tsx — its 'Drag Alarm'
 * branch is asserted there by tests/VesselHubUnderwayWeatherStrip.
 */

/** Format a relative time like "2 min ago" / "just now" / "1 hr ago". */
export function formatTimeSince(ts: number | null): string {
    if (!ts) return 'no fix';
    const delta = Date.now() - ts;
    if (delta < 30_000) return 'just now';
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
    if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} hr ago`;
    return `${Math.round(delta / 86_400_000)} d ago`;
}

/** Format a coordinate as "27.4673°S 153.1234°E" (degrees + cardinal). */
export function formatCoord(lat: number, lon: number): string {
    const latStr = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    return `${latStr}  ${lonStr}`;
}

/** Format a duration in milliseconds to a compact "5h 23m" / "23m" / "1d 4h". */
export function formatDuration(ms: number): string {
    if (ms <= 0) return 'now';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    const remMin = min % 60;
    if (hrs < 24) return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

/** Map a pressure trend to an indicator (arrow + colour). */
export function pressureTrendIndicator(trend: 'rising' | 'falling' | 'steady' | null): {
    arrow: string;
    color: string;
    label: string;
} | null {
    if (!trend || trend === 'steady') return null;
    if (trend === 'rising') return { arrow: '↑', color: '#10b981', label: 'rising' };
    return { arrow: '↓', color: '#f59e0b', label: 'falling' };
}
