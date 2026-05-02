/**
 * Calypso Integrations — Settings tab.
 *
 * Lets the skipper grant Calypso (the voice assistant) access to:
 *   - Apple Music (catalog search + playback hand-off)
 *   - Gmail (read inbox / draft / send with explicit confirmation)
 *
 * Both are gated behind the Skipper-tier subscription via canAccess(),
 * AND require an explicit toggle here. Calypso only sees the
 * corresponding tools when both checks pass — no silent registrations.
 *
 * For Gmail specifically: toggling ON kicks off the OAuth flow (pops a
 * system browser to Google's consent screen); toggling OFF clears the
 * stored access + refresh tokens via clearGmailTokens().
 */

import React, { useCallback, useEffect, useState } from 'react';
import { canAccess } from '../../services/SubscriptionService';
import {
    clearGmailTokens,
    getAuthorizationUrl,
    getConnectedEmail,
    isGmailConfigured,
} from '../../services/voice/integrations/gmail';
import { Row, Section, Toggle, type SettingsTabProps } from './SettingsPrimitives';

export const CalypsoIntegrationsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const tier = settings.subscriptionTier;
    const canMusic = canAccess(tier, 'calypsoMusic');
    const canEmail = canAccess(tier, 'calypsoEmail');

    const musicEnabled = settings.calypsoMusicEnabled ?? false;
    const emailEnabled = settings.calypsoEmailEnabled ?? false;
    const connectedEmail = settings.calypsoEmailAccount;

    const [gmailConfigured, setGmailConfigured] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void isGmailConfigured().then((ok) => {
            if (!cancelled) setGmailConfigured(ok);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Sync the settings.calypsoEmailAccount field with what's actually
    // stored in the Capacitor Preferences (source of truth for the
    // OAuth-linked email). Keeps the UI honest if the user revokes
    // access from Google's side and we lose the tokens silently.
    useEffect(() => {
        let cancelled = false;
        void getConnectedEmail().then((email) => {
            if (cancelled) return;
            if (email !== connectedEmail) {
                onSave({ calypsoEmailAccount: email ?? undefined });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [connectedEmail, onSave]);

    const handleMusicToggle = useCallback(
        (next: boolean) => {
            onSave({ calypsoMusicEnabled: next });
        },
        [onSave],
    );

    const handleEmailToggle = useCallback(
        async (next: boolean) => {
            if (busy) return;
            setBusy(true);
            try {
                if (next) {
                    // Toggling ON → OAuth flow. The actual browser
                    // launch + redirect handler lands in a follow-up
                    // commit (needs the Google Cloud project set up).
                    // For now the toggle just records intent + we
                    // surface a "Connect Gmail" CTA to the skipper.
                    const url = await getAuthorizationUrl();
                    if (!url) {
                        onSave({ calypsoEmailEnabled: false });
                        // eslint-disable-next-line no-alert
                        alert(
                            'Gmail integration is not configured yet. Add VITE_GOOGLE_OAUTH_CLIENT_ID to .env.local — ' +
                                'see services/voice/integrations/gmail.ts header for the Google Cloud setup steps.',
                        );
                        return;
                    }
                    // OAuth flow not yet wired — just flip the toggle
                    // for now and show instructions. Next session lands
                    // the @capacitor/browser launcher + redirect handler.
                    onSave({ calypsoEmailEnabled: true });
                } else {
                    // Toggling OFF → clear stored tokens + email field
                    await clearGmailTokens();
                    onSave({ calypsoEmailEnabled: false, calypsoEmailAccount: undefined });
                }
            } finally {
                setBusy(false);
            }
        },
        [busy, onSave],
    );

    return (
        <div className="px-4 pb-8">
            <p className="text-sm text-gray-400 mb-6">
                Grant Calypso access to integrations on your phone. Each is opt-in — Calypso only sees a tool when you
                toggle it on here. Skipper-tier only.
            </p>

            <Section title="Apple Music">
                {!canMusic ? (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white">Apple Music access</div>
                            <div className="text-xs text-amber-400 mt-1">Skipper-tier subscription required.</div>
                        </div>
                    </Row>
                ) : (
                    <>
                        <Row>
                            <div className="flex-1">
                                <div className="text-sm text-white font-bold">Allow music control</div>
                                <div className="text-xs text-gray-400 mt-1">
                                    "Calypso, play me some Pink Floyd" — opens Apple Music with the requested track or
                                    playlist. Hand-off only: Calypso can't read back what's playing.
                                </div>
                            </div>
                            <Toggle checked={musicEnabled} onChange={handleMusicToggle} label="Apple Music access" />
                        </Row>
                    </>
                )}
            </Section>

            <Section title="Gmail">
                {!canEmail ? (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white">Email access</div>
                            <div className="text-xs text-amber-400 mt-1">Skipper-tier subscription required.</div>
                        </div>
                    </Row>
                ) : gmailConfigured === false ? (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white">Email access</div>
                            <div className="text-xs text-amber-400 mt-1">
                                Gmail OAuth not configured yet — needs a Google Cloud project + client ID.
                            </div>
                            <div className="text-xs text-gray-500 mt-2">
                                See <code className="text-sky-400">services/voice/integrations/gmail.ts</code> header
                                for the one-time setup steps.
                            </div>
                        </div>
                    </Row>
                ) : (
                    <>
                        <Row>
                            <div className="flex-1">
                                <div className="text-sm text-white font-bold">Allow email read + draft + send</div>
                                <div className="text-xs text-gray-400 mt-1">
                                    "Calypso, anything urgent in my inbox?" / "Draft a reply saying we'll arrive
                                    Friday." Send requires explicit verbal confirmation every time.
                                </div>
                                {connectedEmail && (
                                    <div className="text-xs text-emerald-400 mt-2">Connected as {connectedEmail}</div>
                                )}
                            </div>
                            <Toggle
                                checked={emailEnabled}
                                onChange={(v) => void handleEmailToggle(v)}
                                label="Gmail access"
                            />
                        </Row>
                        <Row>
                            <div className="flex-1">
                                <div className="text-xs text-gray-500">
                                    <strong className="text-gray-400">Scopes requested:</strong> read inbox, draft
                                    messages, send messages. Calypso cannot delete, archive, or modify labels — those
                                    are intentionally out of scope to keep voice-driven email safe.
                                </div>
                            </div>
                        </Row>
                    </>
                )}
            </Section>

            <Section title="Coming soon">
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-500">
                            Native Apple Music playback control (skip / pause / now-playing read-back) — pending the
                            MusicKit native plugin. Currently Calypso uses URL-scheme hand-off.
                        </div>
                    </div>
                </Row>
            </Section>
        </div>
    );
};
