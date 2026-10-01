import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AutoroutingTrialRoute } from '../../types/autorouting';
import type { TrialRouteReview } from '../../services/autoroutingReview';
import type { SavedTrace } from '../../services/routeTracer';
import { autoroutingProposalGeometryKey } from '../../services/autoroutingProposalEvidence';
import {
    evaluateAutoroutingProposalSave,
    saveReviewedAutoroutingProposal,
} from '../../services/autoroutingProposalSave';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { getRegistryFingerprint, subscribe } from '../../services/enc/EncCellMetadata';
import type { PushResult } from '../../services/savedRoutesSync';

interface Props {
    route: AutoroutingTrialRoute;
    review: TrialRouteReview | null;
    draftM: number;
    draftAssumed: boolean;
    /** Local durable save only; this is not an activation callback. */
    onSaved?: (trace: SavedTrace) => void;
    onOpenSavedRoutes?: () => void;
}
const control = 'min-h-11 rounded-lg border border-white/20 px-3 text-micro font-bold disabled:opacity-40';
const syncMessage = (result: PushResult) =>
    result === 'ok'
        ? 'Saved to your private account. Available in Saved Routes and Trip Legs. Nothing was activated.'
        : result === 'schema-pending'
          ? 'Saved on this device only. Private sync is pending a server update; all detailed route points and evidence are retained here.'
          : 'Saved on this device only. Private sync is pending; all detailed route points and evidence are retained here.';

/** Geometry/profile already key the enclosing form. Use the completed review
 * stamp and the route's notes here, not a second serialization of every leg.
 * Recompute on render (including same-object edits) and at submission. */
const acknowledgementKey = (route: AutoroutingTrialRoute, review: TrialRouteReview | null, allowed: boolean) =>
    allowed && review?.phase === 'complete' && review.basis
        ? JSON.stringify([review.basis.checkedAt, review.basis.registryFingerprint, route.warnings])
        : null;

/** Key the form to exact inputs so a name/acknowledgement cannot leak onto a
 * replacement proposal. The enclosing workspace owns map/layout/navigation. */
export function AutoroutingProposalSaveCard(props: Props) {
    const scope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope);
    return (
        <SaveForm
            key={`${scope.generation}:${props.route.id}:${autoroutingProposalGeometryKey(props.route.coordinates)}:${props.draftM}:${props.draftAssumed}:${JSON.stringify(props.route.vesselProfile ?? null)}`}
            {...props}
        />
    );
}

function SaveForm({ route, review, draftM, draftAssumed, onSaved, onOpenSavedRoutes }: Props) {
    useSyncExternalStore(subscribe, getRegistryFingerprint);
    const [scope] = useState(getAuthIdentityScope);
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const submitted = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const eligibility = evaluateAutoroutingProposalSave(route, review, draftM, draftAssumed);
    const allowed = eligibility.eligible && !!scope.userId && isAuthIdentityScopeCurrent(scope);
    const evidenceKey = acknowledgementKey(route, review, allowed);
    // The derived check clears visually and disables submit in the same render;
    // clearing stored consent also prevents it reviving if old inputs return.
    const acknowledged = evidenceKey !== null && acknowledgedKey === evidenceKey;
    useEffect(() => setAcknowledgedKey(null), [evidenceKey]);
    return (
        <section aria-label="Save planned proposal" className="space-y-2 text-micro">
            {!saved && !open && (
                <button type="button" className={`${control} w-full`} disabled={!allowed} onClick={() => setOpen(true)}>
                    Save as planned route
                </button>
            )}
            {!saved && !allowed && (
                <p className="text-amber-200">
                    {scope.userId ? eligibility.reason : 'Sign in before saving a private planned route.'}
                </p>
            )}
            {!saved && open && (
                <form
                    className="space-y-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (submitted.current) return;
                        setError('');
                        try {
                            const currentKey = acknowledgementKey(
                                route,
                                review,
                                evaluateAutoroutingProposalSave(route, review, draftM, draftAssumed).eligible,
                            );
                            if (currentKey === null || acknowledgedKey !== currentKey)
                                throw new Error(
                                    'Review the current warnings and acknowledge the planned-only limitations again.',
                                );
                            const result = saveReviewedAutoroutingProposal(
                                {
                                    name,
                                    route,
                                    review,
                                    currentDraftM: draftM,
                                    currentDraftAssumed: draftAssumed,
                                    acknowledgedPlannedOnly: true,
                                },
                                scope,
                            );
                            submitted.current = true;
                            setSaved(true);
                            setMessage('Saved on this device. Private sync pending. Nothing was activated.');
                            void result.cloud
                                .then((status) => {
                                    if (mounted.current && isAuthIdentityScopeCurrent(scope))
                                        setMessage(syncMessage(status));
                                })
                                .catch(() => {
                                    if (mounted.current && isAuthIdentityScopeCurrent(scope))
                                        setMessage(syncMessage('error'));
                                });
                            onSaved?.(result.trace);
                        } catch (cause) {
                            setError(cause instanceof Error ? cause.message : 'The proposal could not be saved.');
                        }
                    }}
                >
                    <label className="block space-y-1">
                        <span>Planned route name</span>
                        <input
                            className={`${control} block w-full bg-slate-950 font-normal`}
                            value={name}
                            maxLength={120}
                            required
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    <label className="flex min-h-11 items-start gap-2 leading-relaxed">
                        <input
                            className="mt-1"
                            type="checkbox"
                            checked={acknowledged}
                            disabled={!allowed}
                            onChange={(event) => setAcknowledgedKey(event.target.checked ? evidenceKey : null)}
                        />
                        <span>
                            I reviewed the warnings. This saves a planned route only, including incomplete or
                            missing-depth checks. It does not establish safety, tidal clearance or permission to
                            navigate.
                        </span>
                    </label>
                    <p className="text-slate-300">
                        All {route.coordinates.length} detailed route points and bounded review evidence are retained. A
                        new private Saved Routes entry becomes available to Trip Legs; no trip, voyage or navigation
                        starts.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button type="submit" className={control} disabled={!allowed || !name.trim() || !acknowledged}>
                            Save new planned route
                        </button>
                        <button type="button" className={control} onClick={() => setOpen(false)}>
                            Cancel
                        </button>
                    </div>
                </form>
            )}
            {error && (
                <p role="alert" className="text-red-300">
                    {error}
                </p>
            )}
            {saved && (
                <>
                    <p role="status" className="text-slate-200">
                        {message}
                    </p>
                    {onOpenSavedRoutes && (
                        <button type="button" className={control} onClick={onOpenSavedRoutes}>
                            Open Saved Routes
                        </button>
                    )}
                </>
            )}
        </section>
    );
}
