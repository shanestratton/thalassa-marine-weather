import { useSyncExternalStore } from 'react';
export interface AisCoverage {
    state: 'unknown' | 'held' | 'queued' | 'recent' | 'limited' | 'unavailable';
    polledAt: string | null;
    truncated: boolean;
}
let state: AisCoverage = { state: 'unknown', polledAt: null, truncated: false };
const listeners = new Set<() => void>();
export function publishAisCoverage(value: unknown) {
    const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    state = {
        state: ['held', 'queued', 'recent', 'limited', 'unavailable'].includes(String(v.state))
            ? (v.state as AisCoverage['state'])
            : 'unknown',
        polledAt:
            typeof v.polledAt === 'string' && v.polledAt.length <= 40 && Number.isFinite(Date.parse(v.polledAt))
                ? v.polledAt
                : null,
        truncated: v.truncated === true,
    };
    for (const listener of listeners) listener();
}
export const useAisCoverage = () =>
    useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        () => state,
    );
export function aisCoverageText(coverage: AisCoverage, now = Date.now(), compact = false): string {
    if (compact) {
        if (coverage.state === 'held') return 'AIS held · licence review';
        if (coverage.state === 'queued') return 'AIS area queued · partial';
        if (coverage.state === 'unavailable' || coverage.state === 'unknown') return 'AIS coverage unavailable';
        const time = Date.parse(coverage.polledAt ?? '');
        if (!Number.isFinite(time) || now - time > 900000 || time > now + 60000) return 'AIS coverage stale or unknown';
        return `AIS centre ${Math.max(0, Math.floor((now - time) / 60000))} min ago · partial`;
    }
    if (coverage.state === 'held') return 'Internet AIS held pending display licence review';
    if (coverage.state === 'queued') return 'Internet AIS area queued; fleet coverage is limited';
    if (coverage.state === 'unavailable' || coverage.state === 'unknown') return 'Internet AIS coverage unavailable';
    const age = Date.parse(coverage.polledAt ?? '');
    if (!Number.isFinite(age) || now - age > 15 * 60000 || age > now + 60000)
        return 'Internet AIS area coverage is stale or unknown';
    return `Map centre polled ${Math.max(0, Math.floor((now - age) / 60000))} min ago${coverage.state === 'limited' || coverage.truncated ? ' · limited results' : ''}; surrounding coverage may be sparse`;
}
