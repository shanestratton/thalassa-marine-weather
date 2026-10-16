import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    listBuddyWatches,
    saveBuddyWatch,
    type BuddyWatchList,
    type BuddyWatchRow,
} from '../../services/buddyWatchClient';
import { parseBuddyConfiguration, BUDDY_FRESH_MS, type BuddyConfiguration } from '../../utils/buddyWatch';
const subscribe = (fn: () => void) => subscribeAuthIdentityScope(() => fn());
export default function BuddyWatchSheet({
    onClose,
    candidate,
}: {
    onClose: () => void;
    candidate?: { mmsi: number; label: string };
}) {
    const scope = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope);
    const boatId = useSettingsStore((s) => s.activeVesselId),
        key = `${scope.key}:${scope.generation}:${boatId}`;
    const [loaded, setLoaded] = useState<{ key: string; value: BuddyWatchList } | null>(null),
        [busy, setBusy] = useState(false),
        [message, setMessage] = useState('');
    const [mmsi, setMmsi] = useState(String(candidate?.mmsi ?? '')),
        [label, setLabel] = useState(candidate?.label.slice(0, 60) ?? '');
    const [areaOn, setAreaOn] = useState(false),
        [lat, setLat] = useState(''),
        [lon, setLon] = useState(''),
        [radius, setRadius] = useState('1'),
        [areaLabel, setAreaLabel] = useState('');
    const value = loaded?.key === key ? loaded.value : null;
    const [formKey, setFormKey] = useState(key),
        [now, setNow] = useState(Date.now);
    const formCurrent = formKey === key,
        ready = value?.ready && now - value.checkedAt <= 60_000;
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);
    const current = useCallback(
        () => isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boatId,
        [scope, boatId],
    );
    const reload = async () => {
        if (!boatId) return;
        const result = await listBuddyWatches(boatId, scope);
        if (current()) setLoaded(result ? { key, value: result } : null);
    };
    useEffect(() => {
        let active = true;
        setLoaded(null);
        setFormKey(key);
        setMessage('');
        setBusy(false);
        setMmsi(String(candidate?.mmsi ?? ''));
        setLabel(candidate?.label.slice(0, 60) ?? '');
        setAreaOn(false);
        setLat('');
        setLon('');
        setAreaLabel('');
        setRadius('1');
        if (boatId)
            void listBuddyWatches(boatId, scope).then((result) => {
                if (active && current()) setLoaded(result ? { key, value: result } : null);
            });
        return () => {
            active = false;
        };
    }, [key, boatId, candidate?.mmsi, candidate?.label, current, scope]); // account/boat replacement retires every pending result and private field
    const mutate = async (row: BuddyWatchRow | null, config: BuddyConfiguration | null) => {
        if (!boatId || busy) return;
        setBusy(true);
        setMessage('');
        try {
            await saveBuddyWatch(boatId, row, config, scope);
            if (current()) {
                setMessage(config ? 'Saved. Notices require a separate explicit enable action.' : 'Removed.');
                await reload();
            }
        } catch (e) {
            if (current()) setMessage(e instanceof Error ? e.message : 'Unavailable.');
        } finally {
            if (current()) setBusy(false);
        }
    };
    const add = () => {
        const config = parseBuddyConfiguration({
            mmsi: /^[1-7]\d{8}$/.test(mmsi) ? Number(mmsi) : null,
            label: label.trim(),
            enabled: false,
            area: areaOn
                ? {
                      lat: lat.trim() ? Number(lat) : null,
                      lon: lon.trim() ? Number(lon) : null,
                      radiusNm: radius.trim() ? Number(radius) : null,
                      label: areaLabel.trim(),
                  }
                : null,
        });
        if (!config) {
            setMessage(
                'Use a nine-digit vessel MMSI and label. An optional area needs a name, coordinates and radius 0.2–50 NM.',
            );
            return;
        }
        void mutate(null, config);
    };
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title="Buddy boats"
            zIndex="z-10070"
            fitViewport
            footer={
                <button type="button" className="min-h-11 px-4 rounded-lg bg-slate-800 text-white" onClick={onClose}>
                    Close buddy boats
                </button>
            }
        >
            <div className="space-y-3 p-4 text-white text-sm">
                <p>
                    Up to ten boats per account. Informational AIS reports only; coverage can be missing. This does not
                    replace an agreed check-in or a safety watch.
                </p>
                <p role="status">
                    {value
                        ? ready
                            ? 'Notices available; each follow starts off.'
                            : 'Notices held pending reviewed AIS rights, scheduled service and delivery.'
                        : 'Connect as this vessel’s owner to load the list. No background AIS lookup runs here.'}
                </p>
                <button
                    type="button"
                    className="min-h-11 px-3 rounded-lg bg-slate-800 disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void reload()}
                >
                    Reload watch status
                </button>
                <a href="https://www.aishub.net" target="_blank" rel="noreferrer" className="underline">
                    Data: AISHub contributors
                </a>
                {value?.watches.map((row) => (
                    <article key={row.id} className="rounded-xl border border-white/10 p-3 space-y-1">
                        <strong>{row.configuration.label}</strong>
                        <p>
                            MMSI {row.configuration.mmsi} · {row.configuration.enabled ? 'Notices enabled' : 'Off'}
                        </p>
                        <p>
                            {!row.state?.observedAt || now - row.state.observedAt > BUDDY_FRESH_MS
                                ? 'Not seen in available AIS coverage; current position unknown'
                                : `Partial AIS · report ${new Date(row.state.observedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC`}
                        </p>
                        {row.configuration.area && (
                            <p>
                                Chosen area: {row.configuration.area.label}, {row.configuration.area.radiusNm} NM.
                                Enter/leave means reported across this circle, not verified port arrival.
                            </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                            <button
                                className="min-h-11 px-3 rounded-lg bg-slate-800 disabled:opacity-40"
                                disabled={busy || (!row.configuration.enabled && !ready)}
                                onClick={() =>
                                    void mutate(row, { ...row.configuration, enabled: !row.configuration.enabled })
                                }
                            >
                                {row.configuration.enabled ? 'Stop notices' : 'Enable notices'}
                            </button>
                            <button
                                className="min-h-11 px-3 rounded-lg bg-slate-800"
                                disabled={busy}
                                onClick={() => void mutate(row, null)}
                            >
                                Remove {row.configuration.label}
                            </button>
                        </div>
                    </article>
                ))}
                <fieldset
                    disabled={busy || !value || value.watches.length >= 10}
                    className="space-y-2 border-t border-white/10 pt-3"
                >
                    <legend>Add a follow · starts off</legend>
                    <label className="block">
                        Vessel MMSI
                        <input
                            className="block min-h-11 w-full rounded-lg bg-slate-800 p-2"
                            value={formCurrent ? mmsi : ''}
                            maxLength={9}
                            inputMode="numeric"
                            onChange={(e) => setMmsi(e.target.value)}
                        />
                    </label>
                    <label className="block">
                        Your label
                        <input
                            className="block min-h-11 w-full rounded-lg bg-slate-800 p-2"
                            value={formCurrent ? label : ''}
                            maxLength={60}
                            onChange={(e) => setLabel(e.target.value)}
                        />
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                        <input
                            type="checkbox"
                            checked={formCurrent && areaOn}
                            onChange={(e) => setAreaOn(e.target.checked)}
                        />
                        Watch entry/exit of a chosen circle
                    </label>
                    {formCurrent && areaOn && (
                        <>
                            <p>
                                Crossings need two minutes of distinct AIS reports and a 10% boundary buffer. Gaps can
                                miss a crossing.
                            </p>
                            <label className="block">
                                Area name
                                <input
                                    className="block min-h-11 w-full bg-slate-800 p-2"
                                    value={areaLabel}
                                    maxLength={60}
                                    onChange={(e) => setAreaLabel(e.target.value)}
                                />
                            </label>
                            <label className="block">
                                Latitude
                                <input
                                    className="block min-h-11 w-full bg-slate-800 p-2"
                                    value={lat}
                                    inputMode="decimal"
                                    onChange={(e) => setLat(e.target.value)}
                                />
                            </label>
                            <label className="block">
                                Longitude
                                <input
                                    className="block min-h-11 w-full bg-slate-800 p-2"
                                    value={lon}
                                    inputMode="decimal"
                                    onChange={(e) => setLon(e.target.value)}
                                />
                            </label>
                            <label className="block">
                                Radius (NM)
                                <input
                                    className="block min-h-11 w-full bg-slate-800 p-2"
                                    value={radius}
                                    inputMode="decimal"
                                    onChange={(e) => setRadius(e.target.value)}
                                />
                            </label>
                        </>
                    )}
                    <button className="min-h-11 px-4 rounded-lg bg-sky-700" onClick={add}>
                        Follow boat
                    </button>
                </fieldset>
                {message && <p role="status">{message}</p>}
            </div>
        </ModalSheet>
    );
}
