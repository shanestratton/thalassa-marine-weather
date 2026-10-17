import React, { useEffect, useRef, useState } from 'react';
import { NmeaStore, type NmeaStoreState } from '../../services/NmeaStore';
import {
    PILOT_STATES,
    SYSTEMS_FIELDS,
    systemsValueAvailable,
    type SystemsKind,
    type SystemsReading,
} from '../../services/systemsTelemetry';
import { usableReading } from '../../services/instruments/measurements';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { getPairing } from '../../services/PiPairingService';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
const GROUPS: readonly [string, readonly SystemsKind[]][] = [
    ['Battery', ['b']],
    ['Tanks', ['f', 'd', 'w', 'g']],
    ['Solar', ['s']],
    ['AC & charger', ['a', 'c']],
    ['Engine', []],
    ['Autopilot', ['p']],
];
const age = (at: number, now: number) => `${Math.max(0, Math.floor((now - at) / 1000))}s`;
function SenderCard({
    title,
    kinds,
    readings,
    now,
}: {
    title: string;
    kinds: readonly SystemsKind[];
    readings: SystemsReading[];
    now: number;
}) {
    const options = readings.filter((reading) => kinds.includes(reading.kind));
    const [selected, setSelected] = useState('');
    const key = (reading: SystemsReading) => JSON.stringify([reading.kind, reading.instance, reading.source]);
    const reading = options.find((reading) => key(reading) === selected) ?? options[0];
    return (
        <section aria-label={title} className="min-w-0 rounded-xl border border-white/15 bg-slate-900 p-1.5">
            <div className="flex min-w-0 items-center gap-1">
                <h2 className="shrink-0 text-xs font-bold">
                    {title === 'Battery'
                        ? 'Batt.'
                        : title === 'AC & charger'
                          ? 'Power'
                          : title === 'Autopilot'
                            ? 'Pilot'
                            : title}
                </h2>
                {reading && (
                    <div className="relative min-w-0 flex-1">
                        <select
                            aria-label={`${title} reported sender`}
                            value={key(reading)}
                            onChange={(event) => setSelected(event.target.value)}
                            className="min-h-[44px] w-full min-w-0 appearance-none rounded border border-white/20 bg-slate-950 pl-1 pr-4 text-xs text-white"
                            style={{ colorScheme: 'dark' }}
                        >
                            {options.map((option) => (
                                <option key={key(option)} value={key(option)}>
                                    {option.instance} &middot; {SYSTEMS_FIELDS[option.kind].label} ({option.source})
                                </option>
                            ))}
                        </select>
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-xs"
                        >
                            &#9662;
                        </span>
                    </div>
                )}
            </div>
            {reading ? (
                <>
                    <dl className="mt-1 grid grid-cols-1 gap-1">
                        {SYSTEMS_FIELDS[reading.kind].fields.map(([label, unit], i) => {
                            const value = reading.values[i],
                                available = systemsValueAvailable(value, now);
                            return (
                                <div key={label} className="text-xs">
                                    <dt className="sr-only">{label}</dt>
                                    <dd className="font-mono tabular-nums">
                                        {available
                                            ? reading.kind === 'p'
                                                ? PILOT_STATES[value.value]
                                                : `${value.value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
                                            : 'Unavailable'}{' '}
                                        <span
                                            aria-label={available ? `Sample age ${age(value.at, now)} ago` : undefined}
                                            className={
                                                available && now - value.at <= 15000
                                                    ? 'text-emerald-300'
                                                    : 'text-amber-300'
                                            }
                                        >
                                            {available ? age(value.at, now) : value ? 'Stale' : ''}
                                        </span>
                                    </dd>
                                </div>
                            );
                        })}
                    </dl>
                </>
            ) : (
                <p className="mt-2 text-xs text-white/60">No current reported sender</p>
            )}
        </section>
    );
}
function EngineCard({ state, now }: { state: NmeaStoreState; now: number }) {
    const evidence = state.instrumentEvidence,
        rpm = evidence?.readings.rpm;
    const live = usableReading(rpm, 'rpm', now, 0, 20000);
    const engine =
        live && rpm.engineCount === 1 && rpm.engineId === evidence?.engine?.engineId ? evidence?.engine : undefined;
    return (
        <section aria-label="Engine" className="min-w-0 rounded-xl border border-white/15 bg-slate-900 p-1.5">
            <h2 className="text-sm font-bold">Engine</h2>
            <p className="break-all text-xs text-white/60">
                {live ? (rpm.engineId ?? 'Reported RPM') : 'No current reported engine'}
            </p>
            <dl className="mt-1 space-y-1 text-xs">
                <div>
                    <dt className="sr-only">RPM</dt>
                    <dd>{live ? `${Math.round(rpm.value)} RPM ${age(rpm.at, now)}` : 'Unavailable'}</dd>
                </div>
                {(
                    [
                        ['Coolant', engine?.coolant, '\u00b0C'],
                        ['Oil pressure', engine?.oilPressure, 'kPa'],
                        ['Engine meter', engine?.runTime, 'h'],
                    ] as const
                ).map(([label, value, unit]) => {
                    const available = !!value && value.at > 0 && value.at <= now + 1000 && now - value.at <= 13000;
                    return (
                        <div key={label}>
                            <dt className="sr-only">{label}</dt>
                            <dd className="font-mono">
                                {available
                                    ? `${(unit === 'h' ? value.value / 3600 : value.value).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit} ${age(value.at, now)}`
                                    : 'Unavailable'}
                            </dd>
                        </div>
                    );
                })}
            </dl>
        </section>
    );
}
export default function SystemsPage({ onClose }: { onClose: () => void }) {
    const [state, setState] = useState(() => ({ ...NmeaStore.getState() }));
    const [now, setNow] = useState(Date.now);
    const close = useRef(onClose);
    close.current = onClose;
    const initial = useRef({
        auth: getAuthIdentityScope(),
        pair: JSON.stringify(getPairing()),
        vessel: useSettingsStore.getState().activeVesselId,
    });
    const button = useRef<HTMLButtonElement>(null);
    const dialog = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: button, onEscape: onClose });
    useEffect(() => {
        let current = true;
        const retire = () => {
            if (!current) return;
            current = false;
            setState((previous) => ({ ...previous, systemsReadings: [], instrumentEvidence: undefined }));
            close.current();
        };
        const changed = () =>
            !isAuthIdentityScopeCurrent(initial.current.auth) ||
            JSON.stringify(getPairing()) !== initial.current.pair ||
            useSettingsStore.getState().activeVesselId !== initial.current.vessel;
        const unsubscribe = NmeaStore.subscribe(() => {
            if (changed()) retire();
            else if (current) setState({ ...NmeaStore.getState() });
        });
        const auth = subscribeAuthIdentityScope(retire);
        const fleet = useSettingsStore.subscribe(() => {
            if (changed()) retire();
        });
        if (changed()) retire();
        const timer = setInterval(() => {
            if (changed()) retire();
            else if (current) setNow(Date.now());
        }, 1000);
        return () => {
            current = false;
            unsubscribe();
            auth();
            fleet();
            clearInterval(timer);
        };
    }, []);
    return (
        <OverlayPortal
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Boat systems"
            className="flex flex-col bg-slate-950 p-3 text-white"
            style={{
                paddingTop: 'max(12px, env(safe-area-inset-top))',
                paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
            }}
        >
            <header className="mb-2 flex shrink-0 items-start justify-between gap-2">
                <div>
                    <h1 className="text-lg font-bold">Systems</h1>
                    <p className="text-xs text-white/60">Values &middot; sample age</p>
                </div>
                <button
                    ref={button}
                    onClick={onClose}
                    className="min-h-11 rounded-lg border border-white/20 px-3 text-sm"
                >
                    Close
                </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="grid grid-cols-2 items-start gap-2">
                    {GROUPS.map(([title, kinds]) =>
                        title === 'Engine' ? (
                            <EngineCard key={title} state={state} now={now} />
                        ) : (
                            <SenderCard
                                key={title}
                                title={title}
                                kinds={kinds}
                                readings={state.systemsReadings ?? []}
                                now={now}
                            />
                        ),
                    )}
                </div>
            </div>
            <p className="mt-2 shrink-0 text-xs text-white/60">
                Missing stays unknown. Battery +A is discharge. AC readings do not establish a shore connection.
                Monitoring only.
            </p>
        </OverlayPortal>
    );
}
