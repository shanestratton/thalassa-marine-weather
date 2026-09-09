import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ShipLogEntry } from '../types';
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../services/authIdentityScope';
import { loadSavedTraces } from '../services/routeTracer';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import {
    completePlannedRouteFingerprint,
    possibleUnlinkedRouteMirrors,
    reconcileFollowRouteMirrors,
} from '../services/followRoutePickerIdentity';
import { useUIStore } from '../stores/uiStore';
import { withTimeout } from '../utils/deadline';

const summaryKey = (summary: VoyageSummary) =>
    JSON.stringify([
        summary.voyageId,
        summary.startedAt,
        summary.endedAt,
        summary.entryCount,
        summary.firstLat,
        summary.firstLon,
        summary.lastLat,
        summary.lastLon,
        summary.totalDistanceNM,
    ]);

/** Compatibility reads are small, per-planned-route and only for suspected
 * mirrors. Never download the ship's entire recorded history to paint a picker.
 */
export function useFollowRoutePickerIdentity(
    summaries: readonly VoyageSummary[],
    entryLinks: ReadonlyMap<string, string>,
    entries: readonly ShipLogEntry[],
    scope: AuthIdentityScope,
) {
    const offline = useUIStore((state) => state.isOffline);
    const [traceRevision, setTraceRevision] = useState(0);
    const [resolved, setResolved] = useState({
        scope,
        byVoyage: new Map<string, { key: string; fingerprint: string }>(),
    });
    const activeScope = useRef(scope);
    activeScope.current = scope;
    useEffect(() => {
        setResolved({ scope, byVoyage: new Map() });
        const changed = () => {
            if (isAuthIdentityScopeCurrent(scope)) setTraceRevision((value) => value + 1);
        };
        window.addEventListener('thalassa:saved-routes-changed', changed);
        return () => window.removeEventListener('thalassa:saved-routes-changed', changed);
    }, [scope]);
    // Saved traces are an external store: its revision event invalidates this snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const traces = useMemo(() => loadSavedTraces(scope), [scope, traceRevision]);
    const fingerprints = useMemo(() => {
        const byVoyage = new Map<string, ShipLogEntry[]>();
        for (const entry of entries) {
            if (!entry.voyageId || entry.source !== 'planned_route') continue;
            const rows = byVoyage.get(entry.voyageId) ?? [];
            rows.push(entry);
            byVoyage.set(entry.voyageId, rows);
        }
        const out = new Map<string, string>();
        for (const summary of summaries) {
            const resident = byVoyage.get(summary.voyageId);
            const cached = resolved.scope === scope ? resolved.byVoyage.get(summary.voyageId) : undefined;
            const fingerprint = resident && completePlannedRouteFingerprint(summary, resident);
            if (fingerprint) out.set(summary.voyageId, fingerprint);
            else if (cached?.key === summaryKey(summary)) out.set(summary.voyageId, cached.fingerprint);
        }
        return out;
    }, [entries, summaries, resolved, scope]);
    const reconciled = useMemo(
        () => reconcileFollowRouteMirrors(summaries, entryLinks, traces, fingerprints),
        [summaries, entryLinks, traces, fingerprints],
    );
    const baseline = useMemo(
        () => reconcileFollowRouteMirrors(summaries, entryLinks, traces, new Map()),
        [summaries, entryLinks, traces],
    );
    const candidates = possibleUnlinkedRouteMirrors(summaries, baseline.links, traces).slice(0, 12);
    const candidateKey = candidates.map(summaryKey).join('|');
    const candidatesRef = useRef(candidates);
    candidatesRef.current = candidates;
    const fingerprintsRef = useRef(fingerprints);
    fingerprintsRef.current = fingerprints;
    useEffect(() => {
        if (offline || !candidateKey || !isAuthIdentityScopeCurrent(scope)) return;
        let alive = true;
        const controllers = new Set<AbortController>();
        const pending = candidatesRef.current.filter((summary) => !fingerprintsRef.current.has(summary.voyageId));
        const current = () => alive && activeScope.current === scope && isAuthIdentityScopeCurrent(scope);
        const worker = async () => {
            const { getVoyageEntries } = await import('../services/shiplog/VoyageSummary');
            while (current() && pending.length > 0) {
                const summary = pending.shift()!;
                const controller = new AbortController();
                controllers.add(controller);
                const timer = setTimeout(() => controller.abort(), 6_000);
                let rows: ShipLogEntry[];
                try {
                    rows = await withTimeout(
                        getVoyageEntries(summary.voyageId, false, {
                            maxRows: Math.min(summary.entryCount + 1, 401),
                            requireComplete: true,
                            signal: controller.signal,
                        }),
                        [] as ShipLogEntry[],
                        6_000,
                    );
                } finally {
                    clearTimeout(timer);
                    controller.abort();
                    controllers.delete(controller);
                }
                if (!current()) return;
                const fingerprint = completePlannedRouteFingerprint(summary, rows);
                if (fingerprint)
                    setResolved((previous) => {
                        if (!current()) return previous;
                        const next = new Map(previous.scope === scope ? previous.byVoyage : []);
                        next.set(summary.voyageId, { key: summaryKey(summary), fingerprint });
                        return { scope, byVoyage: next };
                    });
            }
        };
        void Promise.all([worker(), worker(), worker()]).catch(() => {
            /* keep unresolved rows visible */
        });
        return () => {
            alive = false;
            controllers.forEach((controller) => controller.abort());
        };
    }, [candidateKey, offline, scope]);
    const reconcileSnapshot = useCallback(
        (snapshot: readonly VoyageSummary[]) => reconcileFollowRouteMirrors(snapshot, entryLinks, traces, fingerprints),
        [entryLinks, traces, fingerprints],
    );
    return { ...reconciled, reconcileSnapshot };
}
