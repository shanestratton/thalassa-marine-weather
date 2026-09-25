import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ShipLogEntry } from '../types';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';
import { getLastPosition, type StoredPosition } from '../services/shiplog/TrackingStateStore';
import { getOfflineEntries } from '../services/shiplog/OfflineQueue';
import { getCachedSummaries } from '../services/shiplog/VoyageSummaryCache';
import { voyageDepartureTime } from '../utils/voyageTiming';

export const RECORDING_METRICS_POLL_MS = 30_000;
// Earlier Log summaries may put recording arm time in departedAt as a legacy
// fallback. That date is intentionally the same boundary as voyageTiming.
const DEPARTURE_EVIDENCE_SINCE = Date.parse('2026-09-23T00:00:00Z');
const subscribeIdentity = (notify: () => void) => subscribeAuthIdentityScope(() => notify());

export interface PassageRecordingMetrics {
    distanceNm: number | null;
    recordedAt: number | null;
    departedAt: number | null;
    nowMs: number;
}

const emptyMetrics = (): PassageRecordingMetrics => ({
    distanceNm: null,
    recordedAt: null,
    departedAt: null,
    nowMs: Date.now(),
});

/** The accumulator belongs to this voyage, never a legacy or previous voyage's fix. */
export function recordedDistance(position: StoredPosition | null, voyageId: string, nowMs: number) {
    const recordedAt = Date.parse(position?.timestamp ?? '');
    return position?.voyageId === voyageId &&
        Number.isFinite(position.cumulativeDistanceNM) &&
        position.cumulativeDistanceNM >= 0 &&
        Number.isFinite(recordedAt) &&
        recordedAt <= nowMs
        ? { distanceNm: position.cumulativeDistanceNM, recordedAt }
        : { distanceNm: null, recordedAt: null };
}

/**
 * Use the Log's movement-confirmed departure, never the recording arm time.
 * Its legacy fallback predates departure detection; with no explicit cached
 * departedAt, that historical arm-time fallback is not evidence for this HUD.
 */
export function recordedDeparture(entries: readonly ShipLogEntry[], voyageId: string, nowMs: number): number | null {
    const own = entries.filter((entry) => entry.voyageId === voyageId && (!entry.source || entry.source === 'device'));
    const candidate = Date.parse(voyageDepartureTime(own) ?? '');
    return Number.isFinite(candidate) && candidate >= DEPARTURE_EVIDENCE_SINCE && candidate <= nowMs ? candidate : null;
}

/**
 * Local-only and bounded to one recording: one accumulator read per 30 s.
 * The recorder keeps its current voyage in the local queue until Stop. Read
 * that voyage for departure evidence only until movement is confirmed; never
 * fetch career history or poll cloud track points. A saved summary can retain
 * a confirmed departure when continuing a previously completed voyage.
 */
export function usePassageRecordingMetrics(voyageId: string): PassageRecordingMetrics {
    const scope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const [snapshot, setSnapshot] = useState(() => ({ scope, voyageId, value: emptyMetrics() }));
    useEffect(() => {
        let disposed = false;
        let inFlight = false;
        let departedAt: number | null = null;
        let summaryRead = false;
        const current = () => !disposed && isAuthIdentityScopeCurrent(scope);
        const refresh = async () => {
            if (!current() || inFlight) return;
            inFlight = true;
            try {
                if (!summaryRead) {
                    const summaries = await getCachedSummaries(scope);
                    if (!current()) return;
                    summaryRead = true;
                    const summary = summaries?.find((entry) => entry.voyageId === voyageId);
                    const cachedDeparture = Date.parse(summary?.departedAt ?? '');
                    if (
                        !summary?.isPlannedRoute &&
                        !summary?.isImported &&
                        Number.isFinite(cachedDeparture) &&
                        cachedDeparture >= DEPARTURE_EVIDENCE_SINCE &&
                        cachedDeparture <= Date.now()
                    )
                        departedAt = cachedDeparture;
                }
                const [position, entries] = await Promise.all([
                    getLastPosition(scope),
                    departedAt === null ? getOfflineEntries({ voyageId, expectedScope: scope }) : Promise.resolve(null),
                ]);
                if (!current()) return;
                const nowMs = Date.now();
                if (entries) departedAt = recordedDeparture(entries, voyageId, nowMs);
                setSnapshot({
                    scope,
                    voyageId,
                    value: { ...recordedDistance(position, voyageId, nowMs), departedAt, nowMs },
                });
            } catch {
                // Keep the saved measurement with its own age if local storage
                // temporarily fails. A failed read must not become zero miles.
                if (current())
                    setSnapshot((previous) => ({
                        ...previous,
                        value: { ...previous.value, nowMs: Date.now() },
                    }));
            } finally {
                inFlight = false;
            }
        };
        void refresh();
        const timer = setInterval(() => {
            // The age/elapsed clock keeps running even if a native storage
            // read hangs. The in-flight guard still bounds concurrent I/O.
            if (current())
                setSnapshot((previous) => ({
                    ...previous,
                    value: { ...previous.value, nowMs: Date.now() },
                }));
            void refresh();
        }, RECORDING_METRICS_POLL_MS);
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [scope, voyageId]);
    return snapshot.scope === scope && snapshot.voyageId === voyageId ? snapshot.value : emptyMetrics();
}
