import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Section, Row, Toggle } from './SettingsPrimitives';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { fetchWeatherWatchStatus, saveWeatherWatch, type WeatherWatchStatus } from '../../services/weatherWatchClient';
import {
    defaultWeatherWatch,
    weatherWatchReady,
    type WeatherWatchFeature,
    type WeatherWatchPreferences,
} from '../../utils/weatherWatch';
import { resolveTimeZone } from '../../utils/timezone';
import { WEATHER_POSITION_HOLD_MS, type WeatherPositionSource } from '../../utils/weatherPosition';
const subscribe = (notify: () => void) => subscribeAuthIdentityScope(() => notify());
const FEATURES: readonly [WeatherWatchFeature, string][] = [
    ['morning', 'Morning briefing'],
    ['rain', 'Rain arriving'],
    ['storm', 'Route and spot thunder risk'],
    ['gust', 'Route and spot gusts'],
];
export default function WeatherWatchSection() {
    const scope = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope);
    const boatId = useSettingsStore((s) => s.activeVesselId),
        settings = useSettingsStore((s) => s.settings);
    const [loaded, setLoaded] = useState<{ key: string; status: WeatherWatchStatus } | null>(null);
    const [draft, setDraft] = useState<WeatherWatchPreferences>(defaultWeatherWatch);
    const [busy, setBusy] = useState(false),
        [message, setMessage] = useState('');
    const [, setNow] = useState(Date.now);
    const [reviewedSource, setReviewedSource] = useState<WeatherPositionSource | null>(null);
    const now = Date.now();
    const key = `${scope.key}:${scope.generation}:${boatId}`;
    const reload = async () => {
        if (!boatId) return;
        setBusy(true);
        try {
            const status = await fetchWeatherWatchStatus(boatId, scope);
            if (!isAuthIdentityScopeCurrent(scope) || useSettingsStore.getState().activeVesselId !== boatId) return;
            setLoaded(status ? { key, status } : null);
            setDraft(status?.profile?.preferences ?? defaultWeatherWatch());
        } finally {
            if (isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boatId)
                setBusy(false);
        }
    };
    useEffect(() => {
        let active = true;
        setLoaded(null);
        setDraft(defaultWeatherWatch());
        setMessage('');
        setReviewedSource(null);
        setBusy(false);
        if (boatId)
            void fetchWeatherWatchStatus(boatId, scope).then((status) => {
                if (active && status && isAuthIdentityScopeCurrent(scope)) {
                    setLoaded({ key, status });
                    setDraft(status.profile?.preferences ?? defaultWeatherWatch());
                }
            });
        return () => {
            active = false;
        };
    }, [key, boatId, scope]);
    useEffect(() => {
        let active = true;
        const timer = setInterval(() => {
            setNow(Date.now());
            if (boatId)
                void fetchWeatherWatchStatus(boatId, scope).then((next) => {
                    // A background capability refresh must never adopt another phone's
                    // configuration revision behind the unsaved editor draft.
                    if (active && isAuthIdentityScopeCurrent(scope))
                        setLoaded((previous) =>
                            next && previous?.key === key
                                ? {
                                      key,
                                      status: {
                                          ...previous.status,
                                          capabilities: next.capabilities,
                                          position:
                                              previous.status.position?.registration?.revision ===
                                              next.position?.registration?.revision
                                                  ? next.position
                                                  : {
                                                        registration: previous.status.position?.registration ?? null,
                                                        position: null,
                                                    },
                                      },
                                  }
                                : null,
                        );
                });
        }, 60_000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [key, boatId, scope]);
    const status = loaded?.key === key ? loaded.status : null;
    const deployed = (feature: WeatherWatchFeature) =>
        weatherWatchReady(feature, status?.capabilities[feature] ?? null, now);
    const positionReady = !!status?.position?.position && now - status.position.position.at <= WEATHER_POSITION_HOLD_MS;
    const ready = (feature: WeatherWatchFeature) =>
        deployed(feature) && (!['morning', 'rain'].includes(feature) || positionReady);
    if (!boatId || !status || !FEATURES.some(([feature]) => deployed(feature))) return null;
    const change = (patch: Partial<WeatherWatchPreferences>) => setDraft((d) => ({ ...d, ...patch }));
    const save = async () => {
        if (!isAuthIdentityScopeCurrent(scope) || useSettingsStore.getState().activeVesselId !== boatId) return;
        setBusy(true);
        setMessage('');
        try {
            await saveWeatherWatch(boatId, status.profile?.revision ?? null, draft, scope);
            if (isAuthIdentityScopeCurrent(scope)) {
                await reload();
                setMessage('Saved for this vessel.');
            }
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) setMessage(e instanceof Error ? e.message : 'Save not confirmed.');
        } finally {
            if (isAuthIdentityScopeCurrent(scope)) setBusy(false);
        }
    };
    const registerBoat = async () => {
        setBusy(true);
        setReviewedSource(null);
        try {
            const { reviewWeatherPositionSource } = await import('../../services/weatherPositionClient');
            const source = await reviewWeatherPositionSource(scope);
            if (!isAuthIdentityScopeCurrent(scope) || useSettingsStore.getState().activeVesselId !== boatId) return;
            setReviewedSource(source);
            setMessage(
                source
                    ? 'Review this source, then explicitly allow position sharing. Forecast opt-ins remain unchanged.'
                    : 'A fresh original-clock position from the enrolled Pi on the boat’s own Wi-Fi is required. Phone GPS is not substituted.',
            );
        } catch {
            if (isAuthIdentityScopeCurrent(scope)) setMessage('Paired Pi source unavailable.');
        } finally {
            if (isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boatId)
                setBusy(false);
        }
    };
    const sharePosition = async (enabled: boolean) => {
        const source = enabled ? reviewedSource : status.position?.registration;
        if (!source) return;
        setBusy(true);
        setMessage('');
        try {
            const { saveWeatherPositionSource } = await import('../../services/weatherPositionClient');
            await saveWeatherPositionSource(
                boatId,
                status.position?.registration?.revision ?? null,
                source,
                enabled,
                scope,
            );
            if (!isAuthIdentityScopeCurrent(scope) || useSettingsStore.getState().activeVesselId !== boatId) return;
            setReviewedSource(null);
            // Re-read state without adopting a competing forecast-profile CAS.
            const next = await fetchWeatherWatchStatus(boatId, scope);
            if (!isAuthIdentityScopeCurrent(scope) || useSettingsStore.getState().activeVesselId !== boatId) return;
            if (next)
                setLoaded({ key, status: { ...status, position: next.position, capabilities: next.capabilities } });
            if (enabled && 'position' in source)
                change({ zone: resolveTimeZone(source.position.lat, source.position.lon) });
            setMessage(
                enabled
                    ? 'Position sharing allowed for this exact vessel/source. Waiting for the Pi’s next qualified telemetry proof.'
                    : 'Position sharing stopped; overnight boat checks are unavailable.',
            );
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope))
                setMessage(e instanceof Error ? e.message : 'Position sharing not confirmed.');
        } finally {
            if (isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boatId)
                setBusy(false);
        }
    };
    const registerRoute = async () => {
        const [{ useFollowRouteStore }, { authorizedRouteSamples }] = await Promise.all([
            import('../../stores/followRouteStore'),
            import('../../services/weatherWatchSamples'),
        ]);
        const follow = useFollowRouteStore.getState();
        if (!follow.isFollowing) {
            setMessage('Follow a route first.');
            return;
        }
        const line = follow.routeCoords.map((p) => ({ lat: p.lat, lon: p.lon }));
        try {
            const samples = await authorizedRouteSamples(line, Date.now());
            if (
                !isAuthIdentityScopeCurrent(scope) ||
                useSettingsStore.getState().activeVesselId !== boatId ||
                useFollowRouteStore.getState().routeCoords !== follow.routeCoords
            )
                return;
            const others = draft.samples.filter((s) => s.kind !== 'route');
            if (others.length + samples.length > 16) {
                setMessage('Remove saved samples before adding this route snapshot.');
                return;
            }
            change({ samples: [...others, ...samples] });
            setMessage(
                'Route snapshot selected for 48 h. Gaps between these samples are not checked; register again after a route change.',
            );
        } catch {
            if (isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boatId)
                setMessage('Route samples unavailable.');
        }
    };
    return (
        <Section title="Briefings and forecast watch">
            <p className="px-4 py-3 text-xs text-gray-300">
                Off until you opt in for this vessel. Registering sends only the selected coordinates to your private
                watch; rain checks also send the boat sample to Rainbow. Allowing the paired Pi source separately shares
                its fresh positions while ordinary Pi internet is allowed, including when this phone is closed. No chart
                depths, marks, grades or licensed chart evidence are sent. These are forecast notices, below the boat’s
                own alarms.
            </p>
            {FEATURES.filter(([feature]) => ready(feature) || (deployed(feature) && draft[feature])).map(
                ([feature, label]) => (
                    <Row key={feature}>
                        <span>{label}</span>
                        <Toggle
                            label={label}
                            checked={draft[feature]}
                            disabled={busy}
                            onChange={(on) => {
                                if (!on || ready(feature)) change({ [feature]: on });
                            }}
                        />
                    </Row>
                ),
            )}
            {deployed('morning') && (
                <Row>
                    <label htmlFor="weather-briefing-hour">
                        Briefing hour ({status.position?.position?.zone ?? draft.zone})
                    </label>
                    <select
                        id="weather-briefing-hour"
                        className="min-h-11 appearance-none rounded bg-slate-800 px-3 text-white"
                        style={{ colorScheme: 'dark' }}
                        disabled={busy}
                        value={draft.hour}
                        onChange={(e) => change({ hour: Number(e.target.value) })}
                    >
                        {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>
                                {String(h).padStart(2, '0')}:00
                            </option>
                        ))}
                    </select>
                </Row>
            )}
            {ready('gust') && (
                <Row>
                    <label htmlFor="weather-watch-gust">Gust threshold (kt)</label>
                    <input
                        id="weather-watch-gust"
                        disabled={busy}
                        type="number"
                        min={1}
                        max={200}
                        value={draft.gustKts ?? ''}
                        onChange={(e) => change({ gustKts: e.target.value === '' ? null : Number(e.target.value) })}
                        className="min-h-11 w-20 rounded bg-slate-800 p-2 text-white"
                        style={{ colorScheme: 'dark' }}
                    />
                </Row>
            )}
            <div className="space-y-3 px-4 py-3 text-xs text-gray-300">
                <p>
                    Morning and rain need the explicitly registered Pi source and an original position clock less than
                    15 minutes old. Missing, changed or stale sources send nothing. The current boat timezone sets the
                    briefing hour. Route checks use up to eight sampled 0.25° cells, not continuous route coverage.
                </p>
                <button
                    type="button"
                    onClick={() => void registerBoat()}
                    disabled={busy}
                    className="min-h-11 rounded-lg bg-slate-800 px-3"
                >
                    Review paired Pi position source
                </button>{' '}
                {reviewedSource && (
                    <div className="rounded-lg border border-slate-700 p-3">
                        <p>
                            Paired Pi source {reviewedSource.sourceKey.slice(0, 12)} · measured{' '}
                            {new Date(reviewedSource.position.at).toISOString().slice(0, 19)} UTC.
                        </p>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void sharePosition(true)}
                            className="min-h-11 px-3 text-sky-300"
                        >
                            Allow this vessel’s position sharing
                        </button>
                    </div>
                )}
                {status.position?.registration?.enabled && (
                    <p>
                        {positionReady
                            ? `Qualified position ${new Date(status.position.position!.at).toISOString().slice(0, 19)} UTC`
                            : 'Position sharing configured; fresh matching Pi proof unavailable.'}{' '}
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void sharePosition(false)}
                            className="min-h-11 px-3 text-sky-300"
                        >
                            Stop position sharing
                        </button>
                    </p>
                )}
                <button
                    type="button"
                    onClick={() => void registerRoute()}
                    disabled={busy}
                    className="min-h-11 rounded-lg bg-slate-800 px-3"
                >
                    Register followed route snapshot
                </button>
                <label className="block">
                    Add a saved spot
                    <select
                        aria-label="Add a saved spot"
                        disabled={busy}
                        className="block min-h-11 max-w-full appearance-none rounded bg-slate-800 p-2 text-white"
                        style={{ colorScheme: 'dark' }}
                        value=""
                        onChange={(e) => {
                            const point = settings.savedLocationCoords?.[e.target.value];
                            if (!point) return;
                            if (draft.samples.length >= 16) {
                                setMessage('The 16-sample limit is reached. Remove a sample first.');
                                return;
                            }
                            const sample = {
                                key: `spot:${crypto.randomUUID()}`,
                                kind: 'spot' as const,
                                label: e.target.value.slice(0, 64),
                                ...point,
                                sourceAt: now,
                                expiresAt: now + 30 * 86_400_000,
                            };
                            change({ samples: [...draft.samples, sample] });
                        }}
                    >
                        <option value="">Choose a place…</option>
                        {(settings.savedLocations ?? [])
                            .filter((name) => settings.savedLocationCoords?.[name])
                            .slice(0, 50)
                            .map((name) => (
                                <option key={name}>{name}</option>
                            ))}
                    </select>
                </label>
                {draft.samples.map((sample) => (
                    <p key={sample.key}>
                        {sample.label} ·{' '}
                        {sample.expiresAt <= now
                            ? 'Expired'
                            : `expires ${new Date(sample.expiresAt).toISOString().slice(0, 16)} UTC`}{' '}
                        <button
                            type="button"
                            onClick={() => change({ samples: draft.samples.filter((s) => s.key !== sample.key) })}
                            disabled={busy}
                            className="min-h-11 px-3 text-sky-300"
                        >
                            Remove
                        </button>
                    </p>
                ))}
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void save()}
                    className="min-h-11 rounded-lg bg-sky-900 px-4"
                >
                    {busy ? 'Saving…' : 'Save forecast watch'}
                </button>{' '}
                <button type="button" disabled={busy} onClick={() => void reload()} className="min-h-11 px-3">
                    Reload for review
                </button>
                {message && <p role="status">{message}</p>}
            </div>
        </Section>
    );
}
