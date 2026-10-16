import React, { useRef, useSyncExternalStore } from 'react';
import { readRouteReplan, subscribeRouteReplan } from '../../services/routing/routeReplanSession';
import { replanSuggestionReasons } from '../../services/routing/routeReplanPolicy';
import { useWindStore } from '../../stores/WindStore';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { sanitiseUnderwayPrefs, xteLimitNm } from '../../services/underway/underwayRule';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';

const subscribeOwner = (notify: () => void) => subscribeAuthIdentityScope(() => notify());

export default function RouteReplanControl(props: { xteNm: number | null; etaMs: number | null }) {
    const state = useSyncExternalStore(subscribeRouteReplan, readRouteReplan, readRouteReplan);
    const owner = useSyncExternalStore(subscribeOwner, getAuthIdentityScope, getAuthIdentityScope);
    const wind = useWindStore(),
        followKey = useFollowRouteStore((s) => `${s.voyageId}:${s.startedAt}`);
    const boat = useSettingsStore((s) => s.activeVesselId);
    const key = `${owner.key}:${owner.generation}:${boat}:${followKey}:${wind.model}`;
    const prefs = useSettingsStore((s) => s.settings.underwayAlarms);
    // Only actual generation identity can announce a new run. A forecast's
    // first valid hour or its fetch time must never be relabelled as a run.
    const run = wind.grid?.sourceGeneration ?? null;
    const baseline = useRef({ key, run, eta: props.etaMs });
    if (baseline.current.key !== key) baseline.current = { key, run, eta: props.etaMs };
    if (baseline.current.run === null && run !== null) baseline.current.run = run;
    if (baseline.current.eta === null && props.etaMs !== null) baseline.current.eta = props.etaMs;
    const reasons = replanSuggestionReasons({
        previousRun: baseline.current.run,
        currentRun: run,
        baselineEtaMs: baseline.current.eta,
        currentEtaMs: props.etaMs,
        xteNm: props.xteNm,
        xteLimitNm: xteLimitNm(null, null, sanitiseUnderwayPrefs(prefs).offRoute).limitNm,
    });
    const busy = state.phase === 'preparing' || state.phase === 'computing' || state.phase === 'accepting';
    return (
        <section className="shrink-0 border-t border-white/10 px-2 py-1" aria-label="Review a re-plan">
            {reasons.length > 0 && (
                <p className="text-xs text-amber-200">{reasons.join(' · ')}. Review only; the route stays.</p>
            )}
            <button
                type="button"
                className="min-h-11 w-full rounded-lg border border-sky-400/30 px-2 text-sm font-bold text-sky-200 disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                    void import('../../services/routing/routeReplan').then((api) =>
                        api.requestRouteReplan(props.etaMs),
                    );
                }}
            >
                {busy ? 'Preparing comparison…' : 'Re-plan from current position'}
            </button>
            {state.phase === 'error' && !state.base && (
                <p role="status" className="text-xs text-amber-200">
                    {state.message}
                </p>
            )}
            {state.phase === 'preparing' && (
                <button
                    type="button"
                    className="min-h-11 w-full text-sm text-gray-300"
                    onClick={() => {
                        void import('../../services/routing/routeReplan').then((api) => api.dismissRouteReplan());
                    }}
                >
                    Cancel comparison · keep original
                </button>
            )}
        </section>
    );
}
export function RouteReplanReview(props: { onFinished: () => void }) {
    const state = useSyncExternalStore(subscribeRouteReplan, readRouteReplan, readRouteReplan),
        base = state.base,
        candidate = state.candidate;
    if (!base) return null;
    const accepting = state.phase === 'accepting';
    return (
        <section aria-label="Original and proposed route" className="space-y-2 border-t border-white/10 p-3 text-sm">
            <h3 className="font-bold text-sky-200">Re-plan · review before replacing</h3>
            <table className="w-full table-fixed text-left text-xs">
                <thead>
                    <tr>
                        <th className="w-1/3">Route</th>
                        <th>Distance</th>
                        <th>Time left</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <th>Original · grey dashed</th>
                        <td>{base.remainingNm.toFixed(1)} NM</td>
                        <td>
                            {base.oldRemainingHours === null
                                ? 'Unknown'
                                : `${base.oldRemainingHours.toFixed(1)} h estimate`}
                        </td>
                    </tr>
                    <tr>
                        <th>Proposed</th>
                        <td>{candidate ? `${candidate.result.totalDistanceNM.toFixed(1)} NM` : 'Checking…'}</td>
                        <td>{candidate ? `${candidate.result.totalDurationHours.toFixed(1)} h` : 'Unknown'}</td>
                    </tr>
                </tbody>
            </table>
            <p className="break-words text-xs text-gray-400">{base.sourceLabel}</p>
            <p role="status" className="text-xs text-amber-200">
                {state.message}
            </p>
            <p className="text-xs text-gray-400">
                The original stays until acceptance. Current link set by {base.link.deviceName ?? 'an unnamed device'}.
                Accept checks that exact server revision again.
            </p>
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className="min-h-11 rounded-lg border border-white/20 px-3 font-bold"
                    disabled={accepting}
                    onClick={() => {
                        void import('../../services/routing/routeReplan').then((api) => {
                            api.dismissRouteReplan();
                            props.onFinished();
                        });
                    }}
                >
                    Keep original route
                </button>
                <button
                    type="button"
                    className="min-h-11 rounded-lg border border-sky-400/40 px-3 font-bold text-sky-200 disabled:opacity-50"
                    disabled={state.phase !== 'ready'}
                    onClick={() => {
                        void import('../../services/routing/routeReplan')
                            .then((api) => api.acceptRouteReplan())
                            .then((ok) => {
                                if (ok) props.onFinished();
                            });
                    }}
                >
                    {accepting ? 'Confirming revision…' : 'Accept reviewed route'}
                </button>
            </div>
        </section>
    );
}
