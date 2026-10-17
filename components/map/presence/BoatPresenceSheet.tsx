import React from 'react';
import { ModalSheet } from '../../ui/ModalSheet';
import { boatPresence } from '../../../services/presence/boatPresence';
import type { PresenceTier } from '../../../services/presence/BoatPresenceController';
const control =
    'min-h-[44px] min-w-[44px] rounded-lg border border-white/20 bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-50';
export default function BoatPresenceSheet({ onClose }: { onClose: () => void }) {
    const s = React.useSyncExternalStore(boatPresence.subscribe, boatPresence.snapshot);
    const [tier, setTier] = React.useState<PresenceTier>('off'),
        [error, setError] = React.useState(''),
        [busy, setBusy] = React.useState(false);
    const [label, setLabel] = React.useState(''),
        [token, setToken] = React.useState(''),
        [invitation, setInvitation] = React.useState('');
    const [preview, setPreview] = React.useState<{ vesselName: string; expiresAt: string } | null>(null),
        [expires, setExpires] = React.useState('');
    const live = React.useRef(true);
    const content = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        // The shared trap otherwise prefers the invitation textarea far down
        // this settings sheet. Start at Close, keeping privacy choices visible
        // without opening a keyboard or changing the shared modal contract.
        content.current
            ?.closest('[data-modal-sheet]')
            ?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
            ?.focus({ preventScroll: true });
    }, []);
    React.useEffect(() => {
        live.current = true;
        void boatPresence
            .load()
            .then(() => boatPresence.friends())
            .catch(() => {
                if (live.current) setError('Could not load boat presence. Sign in on a normal connection and reload.');
            });
        return () => {
            live.current = false;
        };
    }, []);
    React.useEffect(() => {
        setTier(s.config?.tier ?? 'off');
        if (!s.config) {
            setToken('');
            setInvitation('');
            setPreview(null);
            setLabel('');
            setExpires('');
        }
    }, [s.config]);
    async function run(task: () => Promise<unknown>) {
        setBusy(true);
        setError('');
        try {
            await task();
        } catch (e) {
            if (live.current) setError(e instanceof Error ? e.message : 'Presence request failed');
        } finally {
            if (live.current) setBusy(false);
        }
    }
    return (
        <ModalSheet isOpen onClose={onClose} title="Thalassa boats" maxWidth="max-w-md" fitViewport>
            <div ref={content} className="space-y-4 text-sm text-slate-100" style={{ overflowWrap: 'anywhere' }}>
                <p>
                    Off by default. Every audience sees 0.05° cells (about 3 NM north–south), delayed at least 5
                    minutes. Self-reported app positions, separate from AIS. No speed, heading, trail or collision use.
                </p>
                <p role="status" aria-label="Boat presence session">
                    {s.status}
                </p>
                {error && (
                    <p role="alert" className="text-amber-200">
                        {error}
                    </p>
                )}
                <p className="font-semibold">{s.config?.vesselName ?? 'No active owned vessel'}</p>
                <label className="block">
                    Who may see this vessel
                    <select
                        aria-label="Presence audience"
                        value={tier}
                        onChange={(e) => setTier(e.target.value as PresenceTier)}
                        className={`${control} mt-1 w-full`}
                        disabled={!s.config || busy}
                    >
                        <option value="off">Off</option>
                        <option value="crew">Accepted crew only</option>
                        <option value="friends">Accepted friends only</option>
                        <option value="nearby">Nearby Thalassa users</option>
                    </select>
                </label>
                <div className="flex flex-wrap gap-2">
                    <button
                        className={control}
                        disabled={!s.config || busy}
                        onClick={() => void run(() => boatPresence.configure(tier))}
                    >
                        Save audience
                    </button>
                    <button
                        className={control}
                        disabled={!s.config}
                        onClick={() => void run(() => boatPresence.configure('off'))}
                    >
                        Turn sharing off
                    </button>
                    <button className={control} disabled={busy} onClick={() => void run(() => boatPresence.load())}>
                        Reload controls
                    </button>
                </div>
                <button
                    className={`${control} w-full`}
                    aria-pressed={s.publishing}
                    disabled={
                        !s.config ||
                        (busy && !s.publishing) ||
                        (!s.publishing && (!s.foreground || s.config.tier === 'off' || !s.config.vesselId))
                    }
                    onClick={() => void run(() => boatPresence.setSession('publisher', !s.publishing))}
                >
                    {s.publishing ? 'Stop publishing now' : 'Publish for this foreground session'}
                </button>
                <p className="text-xs text-slate-300">
                    Saving an audience does not start publication. Start it explicitly in Obs with fresh phone GPS.
                    Leaving Obs, switching account or vessel, going offline, Satellite Mode or hiding the app ends the
                    session. Server publication expires within 45 seconds without a fresh heartbeat; viewers retain a
                    snapshot for at most 30 seconds. No automatic restart.
                </p>
                <p className="text-xs text-slate-300">
                    The Live → Thalassa boats layer only uses a private rounded GPS context to find boats within 25
                    nautical miles. Viewing does not share your position.
                </p>
                {s.config?.tier === 'friends' && (
                    <fieldset className="space-y-2 rounded-xl border border-white/15 p-3">
                        <legend>Create a friend invitation</legend>
                        <label className="block">
                            Private reminder label
                            <input
                                className={`${control} mt-1 w-full`}
                                maxLength={80}
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                            />
                        </label>
                        <button
                            className={control}
                            disabled={busy || !label.trim()}
                            onClick={() =>
                                void run(async () => {
                                    const x = await boatPresence.invite(label.trim());
                                    if (live.current) {
                                        setToken(x.token);
                                        setExpires(x.expiresAt);
                                    }
                                })
                            }
                        >
                            Create one-time invitation
                        </button>
                        {token && (
                            <>
                                <label className="block">
                                    Invitation token
                                    <textarea
                                        readOnly
                                        className={`${control} mt-1 w-full resize-none`}
                                        value={token}
                                        rows={3}
                                    />
                                </label>
                                <p className="text-xs">
                                    Expires {new Date(expires).toLocaleTimeString()}. Share this token yourself with the
                                    intended friend. It can be accepted once. Thalassa sends no message.
                                </p>
                                <button
                                    className={control}
                                    onClick={() =>
                                        void run(async () => {
                                            await navigator.clipboard.writeText(token);
                                        })
                                    }
                                >
                                    Copy invitation
                                </button>
                                <button className={control} onClick={() => setToken('')}>
                                    Hide token
                                </button>
                            </>
                        )}
                    </fieldset>
                )}
                <fieldset className="space-y-2 rounded-xl border border-white/15 p-3">
                    <legend>Accept a friend invitation</legend>
                    <label className="block">
                        One-time token
                        <textarea
                            className={`${control} mt-1 w-full resize-none`}
                            maxLength={64}
                            rows={3}
                            autoComplete="off"
                            value={s.config ? invitation : ''}
                            onChange={(e) => {
                                setInvitation(e.target.value.trim().toLowerCase());
                                setPreview(null);
                            }}
                        />
                    </label>
                    <button
                        className={control}
                        disabled={busy || invitation.length !== 64}
                        onClick={() =>
                            void run(async () => {
                                const x = await boatPresence.invitation(invitation);
                                if (live.current) setPreview(x);
                            })
                        }
                    >
                        Review invitation
                    </button>
                    {preview && s.config && (
                        <>
                            <p>
                                Allow yourself to see {preview.vesselName} when its owner explicitly publishes?
                                Positions stay rounded and delayed.
                            </p>
                            <button
                                className={control}
                                disabled={busy}
                                onClick={() =>
                                    void run(async () => {
                                        await boatPresence.invitation(invitation, true);
                                        if (live.current) {
                                            setInvitation('');
                                            setPreview(null);
                                        }
                                        await boatPresence.friends();
                                    })
                                }
                            >
                                Accept this invitation
                            </button>
                        </>
                    )}
                </fieldset>
                <div>
                    <h4 className="font-semibold">Accepted friends</h4>
                    {!s.friends.length && <p>No accepted grants.</p>}
                    {s.friends.map((f) => (
                        <div
                            key={f.id}
                            className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2"
                        >
                            <p className="min-w-0 flex-1">
                                {f.label} · {f.direction === 'sharing' ? 'May see this boat' : 'You may see this boat'}
                            </p>
                            <button
                                className={control}
                                disabled={busy}
                                onClick={() => void run(() => boatPresence.revoke(f.id))}
                            >
                                Revoke
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </ModalSheet>
    );
}
