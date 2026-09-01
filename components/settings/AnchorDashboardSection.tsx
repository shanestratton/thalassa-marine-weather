/**
 * Anchor dashboard — where the skipper points the anchor push at their Pi.
 *
 * The endpoint and token are typed here and stored in Capacitor Preferences,
 * NOT in the settings store. That store's Supabase sync is a deny-list, so a
 * new field is uploaded to the account by default and re-hydrated onto every
 * other device. A bearer token for a machine on someone's private tailnet has
 * no business making that trip, and neither does the address of the machine.
 *
 * Nothing is baked into the build either — this repository is public.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Section } from './SettingsPrimitives';
import { FormField } from '../ui/FormField';
import {
    AnchorPiPush,
    clearAnchorPiConfig,
    postAnchorState,
    readAnchorPiConfig,
    writeAnchorPiConfig,
    type AnchorPiPayload,
} from '../../services/anchorPiPush';
import { triggerHaptic } from '../../utils/system';

/** Masked so a shoulder-surfer or a screenshot does not leak it. */
const maskToken = (token: string): string =>
    token.length <= 8 ? '••••••••' : `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-2)}`;

export const AnchorDashboardSection: React.FC = () => {
    const [endpoint, setEndpoint] = useState('');
    const [token, setToken] = useState('');
    const [savedToken, setSavedToken] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [testing, setTesting] = useState(false);

    useEffect(() => {
        void (async () => {
            const config = await readAnchorPiConfig();
            if (!config) return;
            setEndpoint(config.endpoint);
            setSavedToken(config.token);
        })();
    }, []);

    const save = useCallback(async () => {
        const url = endpoint.trim();
        const key = token.trim() || savedToken || '';
        if (!url || !key) {
            setStatus('Both the address and the token are needed.');
            return;
        }
        if (!url.startsWith('https://')) {
            // The push refuses plaintext too; say so here rather than letting
            // it fail silently later. This carries a live boat position.
            setStatus('The address must start with https://');
            return;
        }
        await writeAnchorPiConfig(url, key);
        setSavedToken(key);
        setToken('');
        triggerHaptic('light');
        setStatus('Saved. The next anchor change will be sent.');
    }, [endpoint, token, savedToken]);

    const forget = useCallback(async () => {
        await clearAnchorPiConfig();
        setEndpoint('');
        setToken('');
        setSavedToken(null);
        setStatus('Removed from this device.');
    }, []);

    /**
     * Send a real request so the answer means something. A 'cleared' is the
     * safe probe: it is the state that blanks the panel, so a dashboard with
     * no anchor on it is left exactly as it was.
     */
    const test = useCallback(async () => {
        const config = await readAnchorPiConfig();
        if (!config) {
            setStatus('Save the address and token first.');
            return;
        }
        setTesting(true);
        setStatus(null);
        const probe: AnchorPiPayload = {
            state: 'cleared',
            lat: 0,
            lon: 0,
            radius_m: 0,
            source: 'thalassa-test',
            watching: false,
            detail: 'Connection test',
        };
        const outcome = await postAnchorState(probe, config);
        setTesting(false);
        triggerHaptic('light');
        setStatus(
            outcome === 'sent'
                ? 'Dashboard answered. You are connected.'
                : outcome === 'unauthorised'
                  ? 'The dashboard rejected the token.'
                  : outcome === 'rejected'
                    ? 'The dashboard rejected the message — the Pi may be running an older version.'
                    : 'No answer. Check you are on the tailnet and the Pi is awake.',
        );
        // Anything already waiting can go now that we know the way is open.
        if (outcome === 'sent') void AnchorPiPush.drain();
    }, []);

    return (
        <Section title="Anchor Dashboard">
            <div className="space-y-3 p-4">
                <p className="text-[11px] leading-snug text-gray-400">
                    Send anchor state to the boat&rsquo;s cabin screen — where the hook went down, the alarm circle, and
                    whether it is holding. Sent only when something changes, never on a timer. You must be on the
                    tailnet.
                </p>

                <FormField
                    label="Dashboard address"
                    value={endpoint}
                    onChange={setEndpoint}
                    placeholder="https://your-pi.tailnet.ts.net/api/anchor"
                    mono
                />

                <FormField
                    label={savedToken ? `Token (saved: ${maskToken(savedToken)})` : 'Token'}
                    value={token}
                    onChange={setToken}
                    placeholder={savedToken ? 'Leave blank to keep the saved token' : 'Paste the token'}
                    mono
                />
                <p className="text-[11px] leading-snug text-gray-500">
                    Stored on this device only. It is never synced to your account or included in a backup.
                </p>

                <div className="flex flex-wrap gap-2 pt-1">
                    <button
                        onClick={() => void save()}
                        className="rounded-xl bg-sky-500/15 px-3 py-2 text-[12px] font-bold text-sky-300 active:scale-[0.98]"
                    >
                        Save
                    </button>
                    <button
                        onClick={() => void test()}
                        disabled={testing}
                        aria-busy={testing}
                        className="rounded-xl bg-white/6 px-3 py-2 text-[12px] font-bold text-gray-200 active:scale-[0.98] disabled:opacity-60"
                    >
                        {testing ? 'Testing…' : 'Test connection'}
                    </button>
                    {savedToken && (
                        <button
                            onClick={() => void forget()}
                            className="rounded-xl bg-white/4 px-3 py-2 text-[12px] font-bold text-gray-400 active:scale-[0.98]"
                        >
                            Forget
                        </button>
                    )}
                </div>

                {status && <p className="pt-1 text-[12px] font-semibold text-amber-200/90">{status}</p>}
            </div>
        </Section>
    );
};

export default AnchorDashboardSection;
