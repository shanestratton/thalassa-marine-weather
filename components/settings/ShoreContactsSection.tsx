import { useEffect, useState, useSyncExternalStore } from 'react';
import { Section } from './SettingsPrimitives';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    isAuthIdentityScopeCurrent,
} from '../../services/authIdentityScope';
import {
    listShoreContacts,
    configureShoreContact,
    inviteShoreContact,
    bindShoreAnchor,
    type ShoreContactsList,
} from '../../services/shoreContactsClient';
import { parseShoreConfiguration, type ShoreContactSummary } from '../../utils/shoreContacts';
const subscribe = (fn: () => void) => subscribeAuthIdentityScope(() => fn());
export default function ShoreContactsSection() {
    const scope = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope),
        boat = useSettingsStore((s) => s.activeVesselId),
        key = `${scope.key}:${scope.generation}:${boat}`;
    const [loaded, setLoaded] = useState<{ key: string; value: ShoreContactsList } | null>(null),
        [formKey, setFormKey] = useState(key),
        [busy, setBusy] = useState(false),
        [message, setMessage] = useState('');
    const [label, setLabel] = useState(''),
        [address, setAddress] = useState(''),
        [channel, setChannel] = useState<'email' | 'telegram'>('email'),
        [share, setShare] = useState(false),
        [overdue, setOverdue] = useState(false),
        [link, setLink] = useState(''),
        [session, setSession] = useState('');
    const [now, setNow] = useState(Date.now),
        current = () => isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === boat;
    const value = loaded?.key === key ? loaded.value : null,
        ready = !!value && now - value.checkedAt <= 60_000;
    useEffect(() => {
        let active = true;
        setLoaded(null);
        setFormKey(key);
        setLabel('');
        setAddress('');
        setShare(false);
        setOverdue(false);
        setChannel('email');
        setLink('');
        setSession('');
        setMessage('');
        setBusy(false);
        if (boat)
            void listShoreContacts(boat, scope).then((value) => {
                if (active && current() && value) setLoaded({ key, value });
            });
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => {
            active = false;
            clearInterval(timer);
        };
        // The key includes account generation and durable boat identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    async function perform(action: () => Promise<void>) {
        setBusy(true);
        setMessage('');
        setLink('');
        try {
            await action();
            if (current() && boat) {
                const next = await listShoreContacts(boat, scope);
                if (current()) setLoaded(next ? { key, value: next } : null);
            }
        } catch (e) {
            if (current()) setMessage(e instanceof Error ? e.message : 'Contact unavailable.');
        } finally {
            if (current()) setBusy(false);
        }
    }
    if (!value || !boat || (!value.emailReady && !value.telegramReady && value.contacts.length === 0)) return null;
    const available = (c: 'email' | 'telegram') => ready && (c === 'email' ? value.emailReady : value.telegramReady),
        cfg = parseShoreConfiguration({
            channel,
            label,
            address: channel === 'email' ? address : null,
            enabled: false,
            sharePosition: share,
            ...(overdue ? { allowOverdue: true } : {}),
        });
    const act = (row: ShoreContactSummary, enabled: boolean) =>
        perform(() => configureShoreContact(boat, row, { ...row.configuration, enabled }, scope));
    return (
        <Section title="Personal shore contacts">
            <p>Default off. Delivery can fail or be delayed. These contacts are not monitored rescue coverage.</p>
            {!ready && <p role="status">Readiness expired. Reload before changing contacts.</p>}
            <button
                className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                type="button"
                disabled={busy}
                onClick={() => void perform(async () => {})}
            >
                Reload contacts
            </button>
            {value.contacts.map((row) => (
                <div key={row.id} className="p-3 space-y-2 border border-white/10 rounded-xl">
                    <p>
                        {row.configuration.allowOverdue
                            ? 'Anchor and overdue purposes requested. '
                            : 'Anchor purpose only. '}
                        {row.configuration.label} · {row.configuration.channel} · {row.consent}
                    </p>
                    <p>
                        {row.configuration.sharePosition
                            ? 'Explicit registered-position sharing requested'
                            : 'Position sharing off'}
                    </p>
                    <button
                        className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                        type="button"
                        disabled={
                            busy ||
                            !ready ||
                            (!row.configuration.enabled &&
                                (!available(row.configuration.channel) || row.consent !== 'confirmed'))
                        }
                        onClick={() => void act(row, !row.configuration.enabled)}
                    >
                        {row.configuration.enabled ? 'Stop this contact' : 'Enable confirmed contact'}
                    </button>
                    {value.overdueReady && (
                        <button
                            type="button"
                            className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                            disabled={busy || !available(row.configuration.channel)}
                            onClick={() =>
                                void perform(() =>
                                    configureShoreContact(
                                        boat,
                                        row,
                                        {
                                            ...row.configuration,
                                            enabled: false,
                                            allowOverdue: !row.configuration.allowOverdue,
                                            ...(row.configuration.allowOverdue && row.configuration.channel === 'email'
                                                ? { sharePosition: false }
                                                : {}),
                                        },
                                        scope,
                                    ),
                                )
                            }
                        >
                            {row.configuration.allowOverdue
                                ? 'Remove overdue permission (pauses this contact)'
                                : 'Request new overdue consent (pauses this contact)'}
                        </button>
                    )}
                    <button
                        className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                        type="button"
                        disabled={busy || !available(row.configuration.channel)}
                        onClick={() =>
                            void perform(async () => {
                                const url = await inviteShoreContact(boat, row, scope);
                                if (current()) {
                                    setLink(url ?? '');
                                    setMessage(
                                        url
                                            ? 'Share this private invitation only with the intended person. They must open the private bot, review permissions and explicitly confirm.'
                                            : 'Email invitation accepted by provider. The recipient must explicitly confirm, then you must enable delivery.',
                                    );
                                }
                            })
                        }
                    >
                        Invite again / renew consent
                    </button>
                    <button
                        className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                        type="button"
                        disabled={busy || !ready}
                        onClick={() => void perform(() => configureShoreContact(boat, row, null, scope))}
                    >
                        Remove contact
                    </button>
                </div>
            ))}
            <label className="block">
                Contact label
                <input
                    className="w-full min-h-11 bg-slate-900 p-2 rounded"
                    value={formKey === key ? label : ''}
                    maxLength={60}
                    onChange={(e) => setLabel(e.target.value)}
                />
            </label>
            <label className="block">
                Channel
                <select
                    className="w-full min-h-11 bg-slate-900 p-2 rounded"
                    value={channel}
                    onChange={(e) => {
                        setChannel(e.target.value as 'email' | 'telegram');
                        setShare(false);
                    }}
                >
                    <option value="email">Email</option>
                    <option value="telegram">Telegram private chat</option>
                </select>
            </label>
            {channel === 'email' && (
                <label className="block">
                    Recipient email
                    <input
                        className="w-full min-h-11 bg-slate-900 p-2 rounded"
                        type="email"
                        value={formKey === key ? address : ''}
                        maxLength={254}
                        onChange={(e) => setAddress(e.target.value)}
                    />
                </label>
            )}
            {value.overdueReady && (
                <label className="block">
                    <input
                        type="checkbox"
                        checked={formKey === key && overdue}
                        onChange={(e) => {
                            setOverdue(e.target.checked);
                            setShare(false);
                        }}
                    />
                    Request float-plan overdue notices too (fresh recipient consent; owner must separately arm each
                    plan)
                </label>
            )}
            <label className="block">
                <input
                    type="checkbox"
                    disabled={channel !== 'telegram' && !overdue}
                    checked={formKey === key && share}
                    onChange={(e) => setShare(e.target.checked)}
                />
                Allow explicitly registered position sharing (/where on Telegram; last report in overdue notices)
            </label>
            <p>
                Changing recipient or position permission requires fresh consent. A new position registration also
                requires fresh consent.
            </p>
            <button
                className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                type="button"
                disabled={busy || !available(channel) || !cfg || value.contacts.length >= 10}
                onClick={() => void perform(() => configureShoreContact(boat, null, cfg, scope))}
            >
                Save contact off
            </button>
            <p>
                For a phone-kept anchor watch, deliberately bind its current session to this vessel. Pi watches use
                their registered vessel binding.
            </p>
            <label className="block">
                Current anchor-session code
                <input
                    className="w-full min-h-11 bg-slate-900 p-2 rounded"
                    value={formKey === key ? session : ''}
                    maxLength={12}
                    autoCapitalize="characters"
                    onChange={(e) => setSession(e.target.value.toUpperCase())}
                />
            </label>
            <button
                className="min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40"
                type="button"
                disabled={busy || !ready || !/^[A-HJ-NP-Z2-9]{12}$/.test(session)}
                onClick={() =>
                    void perform(async () => {
                        await bindShoreAnchor(boat, session, null, scope);
                        if (current()) setMessage('Current anchor session bound to this vessel.');
                    })
                }
            >
                Bind this new session
            </button>
            {link && (
                <label className="block">
                    Private Telegram invitation (expires in 24 hours)
                    <textarea
                        className="w-full min-h-24 bg-slate-900 p-2 rounded"
                        readOnly
                        value={link}
                        onFocus={(e) => e.currentTarget.select()}
                    />
                </label>
            )}
            {message && <p role="status">{message}</p>}
        </Section>
    );
}
