import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { listShoreContacts, type ShoreContactsList } from '../../services/shoreContactsClient';
import {
    loadOverdueStatus,
    saveOverdueWatch,
    endOverdueWatch,
    type OverdueStatus,
} from '../../services/overdueWatchClient';
import {
    evaluateOverdue,
    parseOverduePlan,
    type OverduePlan,
    type OverdueConfiguration,
} from '../../utils/overdueWatch';
import { REVIEWED_RESCUE_ADVICE } from '../../services/marineRescueDirectory';
const subscribe = (fn: () => void) => subscribeAuthIdentityScope(() => fn());
export default function OverdueWatchSection({
    plan,
    binding,
}: {
    plan: OverduePlan | null;
    binding: { key: string; generation: number; boatId: string | null };
}) {
    const scope = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope),
        boat = useSettingsStore((s) => s.activeVesselId);
    // The open document belongs to the account/vessel that opened it. A new
    // selection must reopen/review the FloatPlan, never inherit its old draft.
    const opened = useRef(binding);
    return scope.userId &&
        boat &&
        opened.current?.key === scope.key &&
        opened.current.generation === scope.generation &&
        opened.current.boatId === boat ? (
        <OwnedWatch
            key={`${scope.key}:${scope.generation}:${boat}`}
            boat={boat}
            scope={scope}
            plan={parseOverduePlan(plan)}
        />
    ) : null;
}
function OwnedWatch({ boat, scope, plan }: { boat: string; scope: AuthIdentityScope; plan: OverduePlan | null }) {
    const [status, setStatus] = useState<OverdueStatus | null>(null),
        [contacts, setContacts] = useState<ShoreContactsList | null>(null),
        [busy, setBusy] = useState(false),
        [message, setMessage] = useState(''),
        [selected, setSelected] = useState<string[]>([]),
        [share, setShare] = useState(false),
        [region, setRegion] = useState<OverdueConfiguration['rescueRegion']>(null),
        [reviewed, setReviewed] = useState(false),
        [now, setNow] = useState(Date.now);
    const mounted = useRef(true);
    const current = () =>
        mounted.current && isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boat;
    async function reload() {
        const [s, c] = await Promise.all([loadOverdueStatus(boat, scope), listShoreContacts(boat, scope)]);
        if (current()) {
            setNow(Date.now());
            setStatus(s);
            setContacts(c);
        }
    }
    useEffect(() => {
        mounted.current = true;
        let active = true;
        void Promise.all([loadOverdueStatus(boat, scope), listShoreContacts(boat, scope)]).then(([s, c]) => {
            if (active && current()) {
                setNow(Date.now());
                setStatus(s);
                setContacts(c);
            }
        });
        const timer = setInterval(() => setNow(Date.now()), 15000);
        return () => {
            active = false;
            mounted.current = false;
            clearInterval(timer);
        }; /* remounted for exact account/boat */
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const planKey = JSON.stringify(plan);
    useEffect(() => setReviewed(false), [planKey]);
    if (!status || (!status.ready && !status.watch)) return null;
    const fresh = status.checkedAt <= now && now - status.checkedAt <= 60000,
        watch = status.watch,
        eligible =
            contacts && now - contacts.checkedAt <= 60000
                ? contacts.contacts.filter(
                      (c) =>
                          c.consent === 'confirmed' &&
                          c.configuration.enabled &&
                          c.configuration.allowOverdue === true &&
                          (c.configuration.channel === 'email' ? contacts.emailReady : contacts.telegramReady),
                  )
                : [],
        configured = watch ? evaluateOverdue(watch.configuration, watch.state, now) : null;
    async function perform(action: () => Promise<void>) {
        setBusy(true);
        setMessage('');
        try {
            await action();
            if (current()) await reload();
        } catch (e) {
            if (current()) setMessage(e instanceof Error ? e.message : 'Watch unavailable.');
        } finally {
            if (current()) setBusy(false);
        }
    }
    const cfg =
        plan && parseOverduePlan(plan)
            ? {
                  enabled: true,
                  plan,
                  contacts: selected
                      .map((id) => eligible.find((c) => c.id === id))
                      .filter((c) => !!c)
                      .map((c) => ({ id: c.id, revision: c.revision })),
                  sharePosition: share,
                  rescueRegion: region,
              }
            : null;
    return (
        <section aria-label="Overdue watch" className="space-y-3 border border-white/10 rounded-xl p-3 text-slate-200">
            <h3 className="font-bold text-white">Optional overdue watch</h3>
            <p>
                Default off. Save only the compact plan below. Your full roster, medical notes, equipment and raw route
                stay in the float plan.
            </p>
            <p>
                Owner first; personal contacts only after a push attempt begins and a ten-minute grace. Attempted does
                not mean delivered. This service never contacts rescue agencies. Keep a manual shore-contact
                arrangement.
            </p>
            {watch && (
                <div>
                    <p>
                        Saved plan: {watch.configuration.plan.vesselLabel} · {watch.configuration.plan.from} to{' '}
                        {watch.configuration.plan.to}
                    </p>
                    <p>Saved overdue time: {new Date(watch.configuration.plan.overdueAt).toISOString()}</p>
                    {watch.state.endedAt !== null && (
                        <p>
                            Watch ended: {watch.endReason} · {new Date(watch.state.endedAt).toISOString()}
                        </p>
                    )}
                    <p>
                        Status:{' '}
                        {fresh
                            ? watch.reviewRequired
                                ? 'consent or position source changed — review/rearm'
                                : configured?.reason
                            : 'status expired — reload'}
                    </p>
                    {watch.state.ownerAttemptedAt !== null && (
                        <p>
                            Owner notification attempted {new Date(watch.state.ownerAttemptedAt).toISOString()};
                            delivery unconfirmed.
                        </p>
                    )}
                    <button
                        type="button"
                        className="min-h-11 px-3 bg-white/10 rounded-lg disabled:opacity-40"
                        disabled={busy || !fresh || watch.state.endedAt !== null}
                        onClick={() => void perform(() => endOverdueWatch(boat, watch.revision, 'arrived', scope))}
                    >
                        Mark arrived
                    </button>{' '}
                    <button
                        type="button"
                        className="min-h-11 px-3 bg-white/10 rounded-lg disabled:opacity-40"
                        disabled={busy || !fresh || watch.state.endedAt !== null}
                        onClick={() => void perform(() => endOverdueWatch(boat, watch.revision, 'cancelled', scope))}
                    >
                        Cancel overdue watch
                    </button>
                </div>
            )}
            <button
                type="button"
                className="min-h-11 px-3 bg-white/10 rounded-lg"
                disabled={busy}
                onClick={() => void perform(async () => {})}
            >
                Reload overdue status
            </button>
            {fresh && status.ready && (
                <>
                    {plan ? (
                        <p>
                            Review: {plan.vesselLabel} · {plan.from} → {plan.to} · departure{' '}
                            {new Date(plan.departureAt).toISOString()} · ETA{' '}
                            {plan.etaAt === null ? 'not supplied' : new Date(plan.etaAt).toISOString()} · overdue{' '}
                            {new Date(plan.overdueAt).toISOString()} · {plan.persons} aboard.
                        </p>
                    ) : (
                        <p>Complete the vessel, ports, people and future times above before arming.</p>
                    )}
                    <p>
                        Select contacts with fresh explicit overdue consent in Alerts settings. Earlier anchor-only
                        consent is insufficient.
                    </p>
                    {eligible.map((c) => (
                        <label key={c.id} className="flex min-h-11 items-center gap-2">
                            <input
                                type="checkbox"
                                checked={selected.includes(c.id)}
                                onChange={(e) =>
                                    setSelected((s) =>
                                        e.target.checked ? [...s, c.id] : s.filter((id) => id !== c.id),
                                    )
                                }
                            />
                            {c.configuration.label} · {c.configuration.channel}
                        </label>
                    ))}
                    {eligible.length === 0 && <p>No confirmed enabled overdue contacts.</p>}
                    <label className="flex min-h-11 items-center gap-2">
                        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
                        Share the last explicitly registered vessel report (both recipient and owner must permit it;
                        unavailable is possible).
                    </label>
                    <label className="block">
                        Review rescue advice region
                        <span className="relative block">
                            <select
                                className="block w-full min-h-11 appearance-none scheme-dark bg-slate-900 text-slate-100 rounded p-2 pr-8"
                                value={region ?? ''}
                                onChange={(e) =>
                                    setRegion(
                                        e.target.value
                                            ? (e.target.value as OverdueConfiguration['rescueRegion'])
                                            : null,
                                    )
                                }
                            >
                                <option value="">Unverified / choose manually</option>
                                {Object.entries(REVIEWED_RESCUE_ADVICE).map(([key, row]) => (
                                    <option key={key} value={key}>
                                        {row.label}
                                    </option>
                                ))}
                            </select>
                            <span
                                aria-hidden="true"
                                className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                            >
                                ▾
                            </span>
                        </span>
                    </label>
                    <p>
                        Region is your choice, not a jurisdiction inferred from old position or route. Short emergency
                        numbers route by the caller’s location.
                    </p>
                    <label className="flex min-h-11 items-center gap-2">
                        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I
                        reviewed this compact plan, deadline, selected recipients and permissions.
                    </label>
                    <button
                        type="button"
                        className="min-h-11 px-3 bg-sky-900 rounded-lg disabled:opacity-40"
                        disabled={
                            busy ||
                            !reviewed ||
                            !cfg ||
                            cfg.contacts.length === 0 ||
                            cfg.contacts.length !== selected.length ||
                            !!(
                                share &&
                                selected.some((id) => !eligible.find((c) => c.id === id)?.configuration.sharePosition)
                            )
                        }
                        onClick={() =>
                            cfg && void perform(() => saveOverdueWatch(boat, watch?.revision ?? null, cfg, scope))
                        }
                    >
                        {watch ? 'Replace / extend with reviewed plan' : 'Save and arm reviewed plan'}
                    </button>
                    <p>
                        Replacing or extending retires the previous deadline and queued work. No automatic arrival is
                        inferred from GPS.
                    </p>
                </>
            )}
            {message && <p role="status">{message}</p>}
        </section>
    );
}
