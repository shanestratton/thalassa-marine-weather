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
 * For Gmail specifically: toggling ON kicks off a real OAuth 2.0 +
 * PKCE flow — we generate a code_verifier, derive an S256 challenge,
 * launch Google's consent screen via @capacitor/browser, then catch
 * the redirect via App.addListener('appUrlOpen') and exchange the
 * code for access + refresh tokens. Toggling OFF clears the stored
 * tokens via clearGmailTokens().
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { canAccess } from '../../services/SubscriptionService';
import {
    beginAuthorization,
    clearGmailTokens,
    completeAuthorization,
    extractAuthCodeFromCallbackUrl,
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
    /** Tracks whether we're currently mid-OAuth (browser is open, waiting
     *  for redirect). Lets us ignore stray appUrlOpen events that aren't
     *  ours, and lets us re-render the toggle as "Connecting…". */
    const awaitingCallback = useRef(false);

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

    /**
     * Register the appUrlOpen listener for the lifetime of this tab.
     * The redirect URL looks like:
     *   com.googleusercontent.apps.<id>:/oauth2redirect?code=4/...&scope=...
     * We pull the code, exchange it via completeAuthorization(), and
     * persist the resulting email. Browser is closed regardless.
     */
    useEffect(() => {
        let listenerHandle: { remove: () => Promise<void> } | undefined;
        let cancelled = false;
        const setup = async () => {
            const handle = await App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
                if (!awaitingCallback.current) return;
                const url = event.url ?? '';
                if (!url.startsWith('com.googleusercontent.apps.')) return;
                const code = extractAuthCodeFromCallbackUrl(url);
                awaitingCallback.current = false;
                // Close the in-app browser regardless — user has already
                // returned to our app via the deep link.
                void Browser.close().catch(() => undefined);
                if (!code) {
                    onSave({ calypsoEmailEnabled: false });
                    setBusy(false);
                    return;
                }
                void completeAuthorization(code).then((email) => {
                    if (cancelled) return;
                    if (email) {
                        onSave({
                            calypsoEmailEnabled: true,
                            calypsoEmailAccount: email,
                        });
                    } else {
                        onSave({ calypsoEmailEnabled: false });
                        // eslint-disable-next-line no-alert
                        alert(
                            'Gmail authorisation failed. Try again — if it keeps failing, check that the OAuth client ID matches your iOS bundle ID in the Google Cloud console.',
                        );
                    }
                    setBusy(false);
                });
            });
            if (cancelled) {
                await handle.remove();
            } else {
                listenerHandle = handle;
            }
        };
        void setup();
        return () => {
            cancelled = true;
            if (listenerHandle) void listenerHandle.remove();
        };
    }, [onSave]);

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
                    const url = await beginAuthorization();
                    if (!url) {
                        onSave({ calypsoEmailEnabled: false });
                        // eslint-disable-next-line no-alert
                        alert(
                            'Gmail integration is not configured. Add VITE_GOOGLE_OAUTH_CLIENT_ID to .env.local — ' +
                                'see services/voice/integrations/gmail.ts for the Google Cloud setup steps.',
                        );
                        setBusy(false);
                        return;
                    }
                    awaitingCallback.current = true;
                    // Open the OAuth consent URL in the in-app browser.
                    // We DON'T flip emailEnabled to true yet — that
                    // happens only after completeAuthorization() succeeds
                    // in the appUrlOpen handler. setBusy(false) likewise
                    // moves into that handler.
                    await Browser.open({ url, presentationStyle: 'popover' });
                } else {
                    // Toggling OFF → clear stored tokens + email field
                    await clearGmailTokens();
                    onSave({ calypsoEmailEnabled: false, calypsoEmailAccount: undefined });
                    setBusy(false);
                }
            } catch (err) {
                awaitingCallback.current = false;
                onSave({ calypsoEmailEnabled: false });
                setBusy(false);
                // eslint-disable-next-line no-alert
                alert(`Gmail authorisation failed: ${(err as Error).message}`);
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
                                {busy && (
                                    <div className="text-xs text-sky-400 mt-2">
                                        Connecting — finish signing in on Google's screen, then return to Thalassa.
                                    </div>
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
