import React, { useEffect, useRef, useState } from 'react';
import type { CatalogueDetail, CatalogueSummary, CatalogueVariantRef } from '../../services/dayPlanner/catalogue';
import type { CataloguePlanSelection } from '../../services/dayPlanner/cataloguePlanningTypes';
import { discoverCatalogueChoices, loadCatalogueChoice } from '../../services/dayPlanner/cataloguePlanning';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';

const identity = (value: { id: string; version: number }) => `${value.id}:${value.version}`;
const same = (a: { id: string; version: number } | undefined, b: { id: string; version: number }) =>
    !!a && identity(a) === identity(b);

export function CatalogueTripPicker({
    position,
    enabled,
    mode,
    value,
    onChange,
    onReadyChange,
}: {
    position: { lat: number; lon: number };
    enabled: boolean;
    mode: 'return' | 'overnight';
    value: CataloguePlanSelection | null;
    onChange: (selection: CataloguePlanSelection | null) => void;
    onReadyChange: (ready: boolean) => void;
}) {
    const [scope] = useState(getAuthIdentityScope);
    const [identityChanged, setIdentityChanged] = useState(false);
    const [expanded, setExpanded] = useState(!!value);
    const [retry, setRetry] = useState(0);
    const [discovery, setDiscovery] = useState<{
        key: string;
        status: 'loading' | 'ready' | 'empty' | 'unavailable';
        summaries: CatalogueSummary[];
        message: string;
    } | null>(null);
    const [detail, setDetail] = useState<{ key: string; value: CatalogueDetail } | null>(null);
    const [detailError, setDetailError] = useState('');
    const discoveryRun = useRef<AbortController | null>(null);
    const detailRun = useRef<AbortController | null>(null);
    const selectionRef = useRef(value);
    selectionRef.current = value;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const positionKey = `${position.lat},${position.lon}`;
    const allowed = enabled && !!scope.userId && !identityChanged && isAuthIdentityScopeCurrent(scope);
    const selectedKey = value ? identity(value) : '';
    const currentDiscovery = discovery?.key === positionKey ? discovery : null;
    const selectedSummary = currentDiscovery?.summaries.find((summary) => identity(summary) === selectedKey);
    const currentDetail =
        allowed && selectedSummary && detail?.key === `${positionKey}/${selectedKey}` ? detail.value : null;
    const variants = currentDetail?.kind === 'trip' ? currentDetail.variants : [];
    const directionValid = (direction: 'outbound' | 'return') =>
        variants.some((variant) => variant.direction === direction && same(value?.[direction], variant));
    const ready =
        !value ||
        (!!currentDetail &&
            currentDetail.kind !== 'route_variant' &&
            (currentDetail.kind === 'destination' ||
                (!currentDetail.variantsTruncated &&
                    directionValid('outbound') &&
                    (mode !== 'return' || directionValid('return')))));

    useEffect(() => onReadyChange(ready), [ready, onReadyChange]);
    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                discoveryRun.current?.abort();
                detailRun.current?.abort();
                setIdentityChanged(true);
            }),
        [],
    );

    useEffect(() => {
        if (!expanded || !allowed) return;
        const controller = new AbortController();
        discoveryRun.current = controller;
        setDiscovery({
            key: positionKey,
            status: 'loading',
            summaries: [],
            message: 'Loading nearby shared references…',
        });
        setDetail(null);
        setDetailError('');
        void discoverCatalogueChoices({ lat: position.lat, lon: position.lon }, controller.signal)
            .then((result) => {
                if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope))
                    setDiscovery({ key: positionKey, ...result });
            })
            .catch(() => {
                if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope))
                    setDiscovery({
                        key: positionKey,
                        status: 'unavailable',
                        summaries: [],
                        message: 'The shared catalogue is unavailable. Its coverage could not be checked.',
                    });
            });
        return () => controller.abort();
    }, [expanded, allowed, positionKey, position.lat, position.lon, retry, scope]);

    useEffect(() => {
        setDetail(null);
        setDetailError('');
        if (!allowed || !selectedKey || !selectedSummary || currentDiscovery?.status !== 'ready') return;
        const controller = new AbortController();
        detailRun.current = controller;
        void loadCatalogueChoice({ id: selectedSummary.id, version: selectedSummary.version }, controller.signal)
            .then((next) => {
                if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return;
                if (identity(next) !== selectedKey || next.kind === 'route_variant')
                    throw new Error('This catalogue choice is no longer available.');
                setDetail({ key: `${positionKey}/${selectedKey}`, value: next });
                if (next.kind === 'trip' && !next.variantsTruncated) {
                    const current = selectionRef.current;
                    if (!current || identity(current) !== selectedKey) return;
                    const chosen = { ...current };
                    for (const direction of ['outbound', 'return'] as const) {
                        const candidates = next.variants.filter((variant) => variant.direction === direction);
                        // A withdrawn or superseded choice remains visibly invalid.
                        // Never replace a selected exact version with a new sole option.
                        if (!chosen[direction] && candidates.length === 1)
                            chosen[direction] = { id: candidates[0].id, version: candidates[0].version };
                    }
                    onChangeRef.current(chosen);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope))
                    setDetailError('This selected reference is unavailable. Retry or explicitly choose another stop.');
            });
        return () => controller.abort();
    }, [allowed, selectedKey, selectedSummary, currentDiscovery?.status, positionKey, scope]);

    const selectDirection = (direction: 'outbound' | 'return', key: string) => {
        if (!value) return;
        const chosen = variants.find((variant) => variant.direction === direction && identity(variant) === key);
        const next = { ...value };
        if (chosen) next[direction] = { id: chosen.id, version: chosen.version };
        else delete next[direction];
        onChange(next);
    };
    const directionPicker = (direction: 'outbound' | 'return') => {
        const choices: CatalogueVariantRef[] = variants.filter((variant) => variant.direction === direction);
        return (
            <label key={direction}>
                {direction === 'outbound' ? 'Outbound route reference' : 'Return route reference'}
                <select
                    value={value?.[direction] ? identity(value[direction]!) : ''}
                    onChange={(event) => selectDirection(direction, event.target.value)}
                >
                    <option value="">
                        {choices.length ? 'Choose a route reference' : 'No reviewed route available'}
                    </option>
                    {value?.[direction] && !choices.some((variant) => same(value[direction], variant)) && (
                        <option value={identity(value[direction]!)}>Selected route reference unavailable</option>
                    )}
                    {choices.map((variant) => (
                        <option key={identity(variant)} value={identity(variant)}>
                            {variant.name}
                        </option>
                    ))}
                </select>
            </label>
        );
    };

    return (
        <section className="day-plan-catalogue" aria-label="Shared cruising catalogue">
            {!expanded ? (
                <button
                    type="button"
                    className="day-plan-secondary"
                    disabled={!allowed}
                    onClick={() => setExpanded(true)}
                >
                    Browse shared catalogue
                </button>
            ) : (
                <>
                    <label>
                        Shared destination or trip
                        <select
                            value={selectedKey}
                            disabled={!allowed || currentDiscovery?.status === 'loading'}
                            onChange={(event) => {
                                const summary = currentDiscovery?.summaries.find(
                                    (item) => identity(item) === event.target.value,
                                );
                                onChange(summary ? { id: summary.id, version: summary.version } : null);
                            }}
                        >
                            <option value="">Use regional or mapped stops</option>
                            {value && !selectedSummary && (
                                <option value={selectedKey}>Selected reference unavailable here</option>
                            )}
                            {currentDiscovery?.summaries.map((summary) => (
                                <option key={identity(summary)} value={identity(summary)}>
                                    {summary.name} · {summary.kind === 'trip' ? 'trip' : 'destination'}
                                </option>
                            ))}
                        </select>
                    </label>
                    {allowed && currentDiscovery && (
                        <p className="day-plan-fine" role="status">
                            {currentDiscovery.message}
                        </p>
                    )}
                    {allowed && currentDiscovery?.status === 'empty' && (
                        <p className="day-plan-notice">
                            No reviewed shared destination or trip is available nearby. Regional or mapped stops remain
                            available.
                        </p>
                    )}
                    {allowed &&
                        value &&
                        !selectedSummary &&
                        currentDiscovery &&
                        currentDiscovery.status !== 'loading' && (
                            <p className="day-plan-notice">
                                Your selected reference cannot be used for this departure. Choose another stop or clear
                                the selection.
                            </p>
                        )}
                    {allowed && selectedSummary && !currentDetail && !detailError && (
                        <p role="status">Loading the selected reference…</p>
                    )}
                    {detailError && (
                        <p className="day-plan-notice" role="status">
                            {detailError}
                        </p>
                    )}
                    {(currentDiscovery?.status === 'unavailable' || detailError) && (
                        <button
                            type="button"
                            className="day-plan-secondary"
                            disabled={!allowed}
                            onClick={() => setRetry((n) => n + 1)}
                        >
                            Retry shared catalogue
                        </button>
                    )}
                    {currentDetail && (
                        <>
                            <p>{currentDetail.summary}</p>
                            <p className="day-plan-fine">
                                Reviewed catalogue source; approach, access and current conditions still require checks.
                            </p>
                            {currentDetail.kind === 'destination' && (
                                <p className="day-plan-notice">
                                    No reviewed local route available · calculate and check a new route.
                                </p>
                            )}
                            {currentDetail.kind === 'trip' &&
                                (currentDetail.variantsTruncated ? (
                                    <p className="day-plan-notice">
                                        The route choices are incomplete. This trip cannot be selected.
                                    </p>
                                ) : (
                                    <>
                                        {directionPicker('outbound')}
                                        {mode === 'return' && directionPicker('return')}
                                        {!ready && (
                                            <p className="day-plan-notice">
                                                Choose a separately reviewed route for each required direction. A return
                                                route is not assumed from the outbound route. You can choose a
                                                destination separately to calculate a new route.
                                            </p>
                                        )}
                                    </>
                                ))}
                            {!!currentDetail.limitations.length && (
                                <ul>
                                    {currentDetail.limitations.map((note, index) => (
                                        <li key={index}>{note}</li>
                                    ))}
                                </ul>
                            )}
                            <details className="day-plan-details">
                                <summary>Catalogue source review</summary>
                                <p>
                                    Reviewed {currentDetail.review.reviewedAt.slice(0, 10)} · review due{' '}
                                    {currentDetail.review.reviewDueAt.slice(0, 10)}.
                                </p>
                                <p>{currentDetail.review.scope}</p>
                                {currentDetail.evidence.map((evidence, index) => (
                                    <p key={index}>
                                        <a href={evidence.sourceUrl} target="_blank" rel="noreferrer">
                                            {evidence.sourceLabel}
                                        </a>{' '}
                                        · {evidence.scope}
                                    </p>
                                ))}
                            </details>
                        </>
                    )}
                </>
            )}
            {!allowed && (
                <p className="day-plan-fine">
                    Confirm your departure position and sign in to browse the shared catalogue.
                </p>
            )}
        </section>
    );
}
