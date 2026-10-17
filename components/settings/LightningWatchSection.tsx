import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Section, Row, Toggle } from './SettingsPrimitives';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    fetchLightningWatchStatus,
    saveLightningWatch,
    type LightningWatchStatus,
} from '../../services/lightningWatchClient';
import { fetchWeatherWatchStatus } from '../../services/weatherWatchClient';
import type { WeatherPositionRegistration, WeatherPositionSource } from '../../utils/weatherPosition';
const subscribe = (notify: () => void) => subscribeAuthIdentityScope(() => notify());
/** Owner chooses the watch and position sharing separately. No automatic GPS or opt-in. */
export default function LightningWatchSection() {
    const scope = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope);
    const boat = useSettingsStore((s) => s.activeVesselId),
        key = `${scope.key}:${scope.generation}:${boat}`;
    const lifetime = useRef({ key, generation: 0 });
    if (lifetime.current.key !== key) lifetime.current = { key, generation: lifetime.current.generation + 1 };
    const generation = lifetime.current.generation;
    const [loaded, setLoaded] = useState<{
        key: string;
        status: LightningWatchStatus;
        registration: WeatherPositionRegistration | null;
    } | null>(null);
    const [reviewed, setReviewed] = useState<WeatherPositionSource | null>(null),
        [busy, setBusy] = useState(false),
        [message, setMessage] = useState('');
    const live = useRef(false),
        operation = useRef(0),
        current = () =>
            live.current &&
            lifetime.current.generation === generation &&
            isAuthIdentityScopeCurrent(scope) &&
            useSettingsStore.getState().activeVesselId === boat;
    const status = loaded?.key === key ? loaded.status : null,
        registration = loaded?.key === key ? loaded.registration : null;
    const reload = async () => {
        if (!boat || !current()) return;
        const token = ++operation.current;
        const [next, weather] = await Promise.all([
            fetchLightningWatchStatus(boat, scope),
            fetchWeatherWatchStatus(boat, scope),
        ]);
        if (token === operation.current && current())
            setLoaded(next ? { key, status: next, registration: weather?.position.registration ?? null } : null);
    };
    useEffect(() => {
        live.current = true;
        setLoaded(null);
        setReviewed(null);
        setMessage('');
        setBusy(false);
        void reload();
        const retire = () => {
            live.current = false;
            operation.current++;
        };
        return () => {
            retire();
        };
        // Identity generation and vessel form one synchronous retirement key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    if (!scope.userId || !boat || !status || (!status.ready && !status.profile?.enabled)) return null;
    const change = async (enabled: boolean) => {
        if (!current() || busy || (enabled && (!status.ready || !status.positionFresh))) return;
        setBusy(true);
        setMessage('');
        setReviewed(null);
        try {
            await saveLightningWatch(boat, status.profile?.revision ?? null, enabled, scope);
            if (current()) {
                await reload();
                if (current())
                    setMessage(enabled ? 'Lightning notices enabled for this vessel.' : 'Lightning notices stopped.');
            }
        } catch (error) {
            if (current()) setMessage(error instanceof Error ? error.message : 'Change not confirmed.');
        } finally {
            if (current()) setBusy(false);
        }
    };
    const review = async () => {
        if (!current() || busy) return;
        setBusy(true);
        setReviewed(null);
        setMessage('');
        try {
            const { reviewWeatherPositionSource } = await import('../../services/weatherPositionClient');
            const source = await reviewWeatherPositionSource(scope);
            if (current()) {
                setReviewed(source);
                setMessage(
                    source
                        ? 'Review this source, then allow position sharing separately.'
                        : 'Connect to the enrolled boat Pi with a fresh original GPS fix. Phone GPS is not substituted.',
                );
            }
        } catch {
            if (current()) setMessage('Paired boat position unavailable.');
        } finally {
            if (current()) setBusy(false);
        }
    };
    const share = async (enabled: boolean) => {
        const source = enabled ? reviewed : registration;
        if (!source || !current() || busy) return;
        setBusy(true);
        setMessage('');
        try {
            const { saveWeatherPositionSource } = await import('../../services/weatherPositionClient');
            if (!current()) return;
            await saveWeatherPositionSource(boat, registration?.revision ?? null, source, enabled, scope);
            if (current()) {
                setReviewed(null);
                await reload();
                if (current())
                    setMessage(
                        enabled
                            ? 'Position sharing allowed. Wait for the next fresh boat fix, then enable lightning notices.'
                            : 'Position sharing stopped. Boat-position weather watches send nothing without a fresh shared source.',
                    );
            }
        } catch (error) {
            if (current()) setMessage(error instanceof Error ? error.message : 'Sharing not confirmed.');
        } finally {
            if (current()) setBusy(false);
        }
    };
    return (
        <Section title="Lightning nearby">
            <p className="px-4 py-3 text-xs text-gray-300">
                Optional Vaisala Xweather notices within 20 NM of your boat. Coverage is not guaranteed. These are
                informational notices and respect Focus. Silence does not mean conditions are clear.
            </p>
            <Row>
                <span>Lightning within 20 NM</span>
                <Toggle
                    label="Lightning within 20 NM"
                    checked={status.profile?.enabled === true}
                    disabled={busy || (!status.profile?.enabled && (!status.ready || !status.positionFresh))}
                    onChange={(on) => void change(on)}
                />
            </Row>
            <div className="space-y-3 px-4 py-3 text-xs text-gray-300">
                <p>
                    Requires a connected boat source measured less than 2 minutes ago. Allowing sharing sends that
                    vessel’s fresh positions to your private weather watch while ordinary Pi internet is allowed,
                    including while this phone is closed.
                </p>
                <p>
                    {status.positionFresh
                        ? 'Fresh boat position available.'
                        : 'Fresh shared boat position unavailable; notices cannot start.'}
                </p>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void review()}
                    className="min-h-11 rounded-lg bg-slate-800 px-3"
                >
                    Review paired boat position
                </button>
                {reviewed && (
                    <div className="space-y-2 rounded-lg border border-slate-700 p-3">
                        <p>
                            Source {reviewed.sourceKey.slice(0, 12)} ·{' '}
                            {new Date(reviewed.position.at).toISOString().slice(0, 19)} UTC
                        </p>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void share(true)}
                            className="min-h-11 px-3 text-sky-300"
                        >
                            Allow this vessel’s position sharing
                        </button>
                    </div>
                )}
                {registration?.enabled && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void share(false)}
                        className="min-h-11 px-3 text-sky-300"
                    >
                        Stop position sharing
                    </button>
                )}
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reload()}
                    className="min-h-11 px-3 text-sky-300"
                >
                    Reload lightning watch
                </button>
                {message && <p role="status">{message}</p>}
            </div>
        </Section>
    );
}
