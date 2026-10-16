import React, { useId, useState, useSyncExternalStore } from 'react';
import { DirectSignalKService } from '../../services/signalk/DirectSignalKService';
import { readSignalKDeviceConfig, saveSignalKDeviceConfig, signalKDeviceOrigin } from '../../services/signalk/config';
import { nativeSignalKAvailable } from '../../services/signalk/native';
import { getPairing } from '../../services/PiPairingService';
import { Button } from '../ui/Button';
const words = {
    off: 'Reader stopped',
    approval: 'Device approval needed',
    pending: 'Waiting for server administrator',
    denied: 'Device request denied',
    unsupported: 'Device access unavailable',
    connecting: 'Connecting…',
    reading: 'Direct Signal K · read only',
    paused: 'Reader paused',
    error: 'Signal K unavailable',
} as const;
export default function SignalKReaderCard() {
    const initial = readSignalKDeviceConfig(),
        id = useId();
    const [origin, setOrigin] = useState(initial?.origin ?? ''),
        [insecure, setInsecure] = useState(initial?.allowInsecureLan ?? false),
        [error, setError] = useState<string | null>(null),
        [busy, setBusy] = useState(false);
    const view = useSyncExternalStore(DirectSignalKService.subscribe, DirectSignalKService.getSnapshot);
    const available = nativeSignalKAvailable(),
        paired = getPairing() !== null;
    const action = async (kind: 'approve' | 'connect') => {
        setError(null);
        setBusy(true);
        try {
            const normal = signalKDeviceOrigin(origin, insecure),
                old = readSignalKDeviceConfig();
            const config = {
                origin: normal,
                allowInsecureLan: insecure,
                clientId: old?.origin === normal ? old.clientId : crypto.randomUUID(),
                selected: true,
            };
            saveSignalKDeviceConfig(config);
            if (kind === 'approve') await DirectSignalKService.requestApproval(config);
            else await DirectSignalKService.start();
        } catch {
            setError('Check the server origin and private-network HTTP choice.');
        } finally {
            setBusy(false);
        }
    };
    const field = 'w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-base text-white';
    return (
        <section
            className="mb-3 space-y-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4"
            aria-label="Direct Signal K reader"
        >
            <h2 className="text-sm font-bold text-white">Signal K without a Pi</h2>
            <p className="text-xs leading-relaxed text-gray-300">
                Read instruments directly from your own Signal K server. The server administrator must approve this
                device with read-only access. A paired Pi keeps priority.
            </p>
            {!available && (
                <p className="text-sm text-amber-200">
                    Direct Signal K needs the iPhone or iPad app. This browser does not open an authenticated boat
                    connection.
                </p>
            )}
            {paired && <p className="text-sm text-amber-200">A Pi is paired. The direct reader stays paused.</p>}
            <label htmlFor={`${id}-origin`} className="block text-xs text-gray-300">
                Signal K server origin
            </label>
            <input
                id={`${id}-origin`}
                className={field}
                type="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="https://boat.example"
                disabled={busy}
            />
            <label className="flex min-h-11 items-center gap-3 text-xs text-gray-300">
                <input
                    type="checkbox"
                    checked={insecure}
                    onChange={(e) => setInsecure(e.target.checked)}
                    disabled={busy}
                />
                Allow unencrypted HTTP only on my private boat network
            </label>
            {insecure && (
                <p className="text-xs text-amber-200">
                    HTTP exposes readings and the device token to others on that network. HTTPS is preferred.
                </p>
            )}
            <p role="status" className="text-sm text-sky-200">
                {words[view.status]}
            </p>
            <p className="text-xs leading-relaxed text-gray-400">
                This is a read-only instrument source. It does not steer navigation, replace the boat position with the
                phone, or enable route/autopilot writes. It pauses in the background and in Satellite Mode.
            </p>
            {error && (
                <p role="alert" className="text-sm text-red-300">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="secondary"
                    disabled={!available || paired || busy}
                    onClick={() => void action('approve')}
                >
                    Request device access
                </Button>
                {view.status === 'pending' && (
                    <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void DirectSignalKService.checkApproval()}
                    >
                        Check approval
                    </Button>
                )}
                <Button
                    variant="secondary"
                    disabled={!available || paired || busy}
                    onClick={() => void action('connect')}
                >
                    Read Signal K
                </Button>
                <Button variant="secondary" onClick={() => DirectSignalKService.stop()}>
                    Stop reader
                </Button>
                <Button variant="ghost" onClick={() => void DirectSignalKService.forget()}>
                    Forget device access
                </Button>
            </div>
            {view.status === 'reading' && (
                <label className="flex min-h-11 items-center gap-3 text-xs leading-relaxed text-gray-300">
                    <input
                        type="checkbox"
                        checked={view.soundEnabled === true}
                        onChange={(e) => DirectSignalKService.setNotificationSound(e.target.checked)}
                    />
                    Play a three-second cue for new server alarms while this reader is active. Sound depends on system
                    volume and audio route.
                </label>
            )}
            {view.status === 'pending' && (
                <p className="text-xs text-gray-300">
                    Open Security → Access Requests on your server, approve this Thalassa device as read only, then tap
                    Check approval. Access is never requested automatically.
                </p>
            )}
            {view.notices.length > 0 && (
                <div className="space-y-2 border-t border-white/10 pt-3" aria-label="Signal K notifications">
                    <p className="text-xs text-gray-300">Server notifications · source-dated</p>
                    {view.notices.map((n) => (
                        <div key={`${n.source}|${n.path}`} className="rounded-lg bg-white/5 p-3 text-xs text-gray-200">
                            <strong>{n.state.toUpperCase()}</strong> · {n.message}
                            <div className="mt-1 text-gray-400">
                                {n.source} · {new Date(n.at).toISOString().slice(11, 19)} UTC ·{' '}
                                {Math.max(0, Math.floor((Date.now() - n.at) / 1000))} s old
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
