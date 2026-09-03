/**
 * Calypso Integrations — Settings tab.
 *
 * Lets the skipper grant Calypso (the voice assistant) access to:
 *   - Apple Music — a public-beta unavailable notice while the
 *     compile-time visibility boundary is closed. The dedicated Music
 *     page and controls are reachable only after that gate is reviewed.
 *   - Gmail — read inbox / draft / send with explicit confirmation.
 *     Real OAuth 2.0 + PKCE flow, opt-in toggle.
 *   - Proactive alerts — an explicit public-beta hold until monitoring
 *     moves to a verified native lifecycle.
 *
 * Voice picker also lives here (which voice Calypso speaks in).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { canAccess } from '../../services/SubscriptionService';
import {
    beginAuthorization,
    clearGmailTokens,
    completeAuthorization,
    extractAuthCallbackFromUrl,
    GMAIL_PUBLIC_BETA_ENABLED,
    getConnectedEmail,
    isGmailConfigured,
} from '../../services/voice/integrations/gmail';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { AlertMonitorService } from '../../services/AlertMonitorService';
import { CALYPSO_VOICE_PRESETS, DEFAULT_VOICE_PRESET_ID } from '../../services/voice/voicePresets';
import { speak } from '../../services/voice/ttsClient';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
import { Row, Section, Toggle, type SettingsTabProps } from './SettingsPrimitives';

export const CalypsoIntegrationsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const tier = settings.subscriptionTier;
    const canMusic = canAccess(tier, 'calypsoMusic');
    const canEmail = canAccess(tier, 'calypsoEmail');
    const canAlerts = canAccess(tier, 'calypsoAlerts');

    const emailEnabled = settings.calypsoEmailEnabled ?? false;
    const alertsEnabled = settings.calypsoAlertsEnabled ?? false;
    const connectedEmail = settings.calypsoEmailAccount;

    const [gmailConfigured, setGmailConfigured] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [gmailOperation, setGmailOperation] = useState<'connect' | 'disconnect' | null>(null);
    const [gmailError, setGmailError] = useState<string | null>(null);
    const emailOperationInFlight = useRef<string | null>(null);
    /** Tracks whether we're currently mid-OAuth (browser is open, waiting
     *  for redirect). Lets us ignore stray appUrlOpen events that aren't
     *  ours, and lets us re-render the toggle as "Connecting…". */
    const awaitingCallback = useRef<AuthIdentityScope | null>(null);
    const releaseEmailOperation = useCallback((scope: AuthIdentityScope) => {
        if (emailOperationInFlight.current === scope.key) emailOperationInFlight.current = null;
    }, []);

    useEffect(() => {
        let cancelled = false;
        void isGmailConfigured().then((ok) => {
            if (!cancelled) setGmailConfigured(ok);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Sync the settings fields with this exact account's local OAuth
    // envelope. This also turns off stale pre-v2 settings after unowned
    // legacy credentials are quarantined. Remote Google revocation is only
    // discovered when a token refresh is attempted.
    useEffect(() => {
        let cancelled = false;
        const operationScope = getAuthIdentityScope();
        void getConnectedEmail().then((email) => {
            if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
            if (email !== connectedEmail || (!email && emailEnabled)) {
                onSave({
                    calypsoEmailAccount: email ?? undefined,
                    ...(!email && emailEnabled ? { calypsoEmailEnabled: false } : {}),
                });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [connectedEmail, emailEnabled, onSave]);

    // Never carry account A's in-progress browser flow or busy state into
    // account B's settings UI. The service independently rejects the stale
    // callback; this keeps the caller from mutating B's settings afterward.
    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                const wasAwaitingGmail = awaitingCallback.current !== null;
                awaitingCallback.current = null;
                emailOperationInFlight.current = null;
                setBusy(false);
                setGmailOperation(null);
                setGmailError(null);
                if (wasAwaitingGmail) void Browser.close().catch(() => undefined);
            }),
        [],
    );

    // If the skipper closes Google's browser without completing OAuth,
    // release the operation lock so the toggle can be tried again. The deep
    // link handler clears awaitingCallback before it closes the browser, so a
    // successful callback cannot be mistaken for a cancellation here.
    useEffect(() => {
        let cancelled = false;
        let listenerHandle: { remove: () => Promise<void> } | undefined;
        void Browser.addListener('browserFinished', () => {
            const operationScope = awaitingCallback.current;
            if (!operationScope) return;
            awaitingCallback.current = null;
            releaseEmailOperation(operationScope);
            if (!cancelled && isAuthIdentityScopeCurrent(operationScope)) {
                setBusy(false);
                setGmailOperation(null);
            }
        })
            .then(async (handle) => {
                if (cancelled) await handle.remove();
                else listenerHandle = handle;
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            if (listenerHandle) void listenerHandle.remove();
        };
    }, [releaseEmailOperation]);

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
                const operationScope = awaitingCallback.current;
                if (!operationScope) return;
                if (!isAuthIdentityScopeCurrent(operationScope)) {
                    awaitingCallback.current = null;
                    releaseEmailOperation(operationScope);
                    void Browser.close().catch(() => undefined);
                    return;
                }
                const url = event.url ?? '';
                if (!url.startsWith('com.googleusercontent.apps.')) return;
                const callback = extractAuthCallbackFromUrl(url);
                awaitingCallback.current = null;
                // Close the in-app browser regardless — user has already
                // returned to our app via the deep link.
                void Browser.close().catch(() => undefined);
                if (!callback) {
                    onSave({ calypsoEmailEnabled: false });
                    releaseEmailOperation(operationScope);
                    setBusy(false);
                    setGmailOperation(null);
                    setGmailError('Gmail returned an invalid authorisation response. Please try connecting again.');
                    return;
                }
                void (async () => {
                    try {
                        const email = await completeAuthorization(callback.code, callback.state);
                        if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
                        if (email) {
                            setGmailError(null);
                            onSave({
                                calypsoEmailEnabled: true,
                                calypsoEmailAccount: email,
                            });
                        } else {
                            onSave({ calypsoEmailEnabled: false });
                            setGmailError(
                                'Gmail authorisation failed. Try again. If it keeps failing, check that the OAuth client ID matches your iOS bundle ID in the Google Cloud console.',
                            );
                        }
                    } catch (error) {
                        if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
                        onSave({ calypsoEmailEnabled: false });
                        setGmailError(
                            `Gmail authorisation failed: ${
                                error instanceof Error ? error.message : 'unexpected OAuth error'
                            }`,
                        );
                    } finally {
                        releaseEmailOperation(operationScope);
                        if (!cancelled && isAuthIdentityScopeCurrent(operationScope)) {
                            setBusy(false);
                            setGmailOperation(null);
                        }
                    }
                })();
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
    }, [onSave, releaseEmailOperation]);

    const handleAlertsToggle = useCallback(
        (next: boolean) => {
            onSave({ calypsoAlertsEnabled: next });
            // Service start/stop is handled centrally in App.tsx via a
            // useEffect on the same setting, so toggling off there
            // tears down the listener even if this tab unmounts. We
            // don't call AlertMonitorService.stop() here directly.
        },
        [onSave],
    );

    const handleTestAlert = useCallback(() => {
        // Sanity-check the wiring without actually waiting for a
        // threshold violation. Does the same thing a real alert does:
        // chime → page-takeover → Calypso speaks → history-log turn.
        AlertMonitorService.fireTestAlert();
    }, []);

    // ── Voice picker ───────────────────────────────────────────────
    const currentVoiceId = settings.calypsoVoiceId ?? DEFAULT_VOICE_PRESET_ID;
    /** Currently sample-playing preset key, so we can disable other
     *  buttons while one is playing (don't let the skipper stack
     *  overlapping samples). */
    const [samplePlaying, setSamplePlaying] = useState<string | null>(null);

    const handleVoiceSelect = useCallback(
        (presetId: string) => {
            onSave({ calypsoVoiceId: presetId });
        },
        [onSave],
    );

    const handlePlaySample = useCallback(
        (presetId: string) => {
            const preset = CALYPSO_VOICE_PRESETS.find((p) => p.id === presetId);
            if (!preset || samplePlaying) return;
            setSamplePlaying(presetId);
            // Pass the voice_id explicitly so the sample uses THIS
            // preset, not whatever the skipper currently has saved.
            // Lets them audition before committing.
            const handle = speak(preset.samplePhrase, { voiceId: preset.voiceId });
            void handle.done.finally(() => setSamplePlaying(null));
        },
        [samplePlaying],
    );

    const handleEmailToggle = useCallback(
        async (next: boolean) => {
            if (emailOperationInFlight.current !== null) return;
            const operationScope = getAuthIdentityScope();
            emailOperationInFlight.current = operationScope.key;
            setBusy(true);
            setGmailOperation(next ? 'connect' : 'disconnect');
            setGmailError(null);
            try {
                if (next) {
                    const url = await beginAuthorization();
                    if (!isAuthIdentityScopeCurrent(operationScope)) {
                        releaseEmailOperation(operationScope);
                        return;
                    }
                    if (!url) {
                        onSave({ calypsoEmailEnabled: false });
                        // The env var / setup-steps detail is for whoever builds
                        // the app, not for the skipper reading this screen.
                        console.warn(
                            '[gmail] not configured: add VITE_GOOGLE_OAUTH_CLIENT_ID to .env.local — see services/voice/integrations/gmail.ts for the Google Cloud setup steps.',
                        );
                        setGmailError('Gmail integration is not configured in this build yet.');
                        releaseEmailOperation(operationScope);
                        setBusy(false);
                        setGmailOperation(null);
                        return;
                    }
                    awaitingCallback.current = operationScope;
                    // Open the OAuth consent URL in the in-app browser.
                    // We DON'T flip emailEnabled to true yet — that
                    // happens only after completeAuthorization() succeeds
                    // in the appUrlOpen handler. setBusy(false) likewise
                    // moves into that handler.
                    await Browser.open({ url, presentationStyle: 'popover' });
                    if (!isAuthIdentityScopeCurrent(operationScope)) {
                        awaitingCallback.current = null;
                        releaseEmailOperation(operationScope);
                        void Browser.close().catch(() => undefined);
                    }
                } else {
                    // Toggling OFF → clear stored tokens + email field
                    awaitingCallback.current = null;
                    const cleared = await clearGmailTokens();
                    if (!isAuthIdentityScopeCurrent(operationScope)) {
                        releaseEmailOperation(operationScope);
                        return;
                    }
                    if (!cleared) {
                        throw new Error('could not clear the account-scoped Gmail credentials');
                    }
                    onSave({ calypsoEmailEnabled: false, calypsoEmailAccount: undefined });
                    releaseEmailOperation(operationScope);
                    setBusy(false);
                    setGmailOperation(null);
                }
            } catch (err) {
                releaseEmailOperation(operationScope);
                if (!isAuthIdentityScopeCurrent(operationScope)) return;
                awaitingCallback.current = null;
                if (next) onSave({ calypsoEmailEnabled: false });
                setBusy(false);
                setGmailOperation(null);
                setGmailError(
                    `${next ? 'Gmail authorisation' : 'Gmail disconnection'} failed: ${
                        err instanceof Error ? err.message : 'unexpected integration error'
                    }`,
                );
            }
        },
        [onSave, releaseEmailOperation],
    );

    const handleOpenMusicPage = useCallback(() => {
        window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'music' } }));
    }, []);

    /** Apple's supported route opens Thalassa's own Settings page. iOS does
     * not expose a public URL for the system Music crossfade control. */
    const handleOpenMusicSystemSettings = useCallback(() => {
        try {
            window.location.href = 'app-settings:';
        } catch {
            /* Browser preview only: the user can still follow the manual path. */
        }
    }, []);

    return (
        <div className="px-4 pb-8">
            <p className="text-sm text-gray-400 mb-6">
                Available third-party integrations are opt-in. Calypso only sees a tool after you connect it, and
                public-beta holds are shown explicitly. Skipper-tier only.
            </p>

            <Section title="Voice">
                <Row>
                    <div className="flex-1">
                        <div className="text-sm text-white font-bold">Pick Calypso's voice</div>
                        <div className="text-xs text-gray-400 mt-1">
                            Tap the speaker icon to audition a voice; tap the radio to make it Calypso's. The change
                            applies on her next utterance — no restart needed.
                        </div>
                    </div>
                </Row>
                {CALYPSO_VOICE_PRESETS.map((preset) => {
                    const selected = currentVoiceId === preset.id;
                    const playing = samplePlaying === preset.id;
                    return (
                        <Row key={preset.id}>
                            <button
                                onClick={() => handleVoiceSelect(preset.id)}
                                className="flex-1 flex items-center gap-3 text-left group"
                                aria-label={`Use ${preset.label} voice`}
                            >
                                {/* Radio indicator */}
                                <div
                                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                                        selected
                                            ? 'border-sky-400 bg-sky-400/20'
                                            : 'border-gray-600 group-hover:border-gray-400'
                                    }`}
                                >
                                    {selected && <div className="w-2 h-2 rounded-full bg-sky-400" />}
                                </div>
                                <div className="flex-1">
                                    <div className={`text-sm ${selected ? 'text-white font-bold' : 'text-gray-200'}`}>
                                        {preset.label}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-0.5">{preset.description}</div>
                                </div>
                            </button>
                            <button
                                onClick={() => handlePlaySample(preset.id)}
                                disabled={!!samplePlaying}
                                className={`min-h-[44px] text-xs px-2 py-1 rounded border transition-colors ${
                                    playing
                                        ? 'border-sky-400 text-sky-400 bg-sky-400/10'
                                        : samplePlaying
                                          ? 'border-gray-700 text-gray-400'
                                          : 'border-gray-600 text-gray-300 hover:text-sky-400 hover:border-sky-400/50'
                                }`}
                                aria-label={`Play sample of ${preset.label}`}
                            >
                                {playing ? '▶ Playing…' : '▶ Sample'}
                            </button>
                        </Row>
                    );
                })}
            </Section>

            <Section title="Proactive vessel alerts">
                {!FEATURE_VISIBILITY.calypsoAlerts ? (
                    <Row>
                        <div className="flex-1" role="status">
                            <div className="text-sm font-bold text-white">
                                Proactive alerts unavailable in public beta
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-amber-300">
                                Calypso is not running as a background or terminated-app vessel monitor in this beta.
                                Previously saved alert opt-ins are switched off, and no battery, depth, GPS, engine, or
                                lost-NMEA alert will run from this feature.
                            </div>
                            <div className="mt-2 text-xs leading-relaxed text-gray-400">
                                Keep dedicated instrument alarms and watchkeeping procedures active. Calypso's on-demand
                                voice console remains available while Thalassa is open.
                            </div>
                        </div>
                    </Row>
                ) : !canAlerts ? (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white">Proactive alerts</div>
                            <div className="text-xs text-amber-400 mt-1">Skipper-tier subscription required.</div>
                        </div>
                    </Row>
                ) : (
                    <>
                        <Row>
                            <div className="flex-1">
                                <div className="text-sm text-white font-bold">Let Calypso interrupt with alerts</div>
                                <div className="text-xs text-gray-400 mt-1">
                                    While Thalassa is open and active, Calypso can watch incoming NMEA data and speak up
                                    about battery, charging, depth, GPS, engine, or backbone conditions. This is an
                                    ordinary in-app audio path, not a Critical Alert or independent vessel alarm.
                                </div>
                                <div className="text-xs text-gray-500 mt-2">
                                    Monitoring can stop when the app is backgrounded, suspended, force-quit, or
                                    terminated. Keep dedicated alarms and normal watchkeeping active.
                                </div>
                            </div>
                            <Toggle
                                checked={alertsEnabled}
                                onChange={handleAlertsToggle}
                                label="Calypso speak-up alerts"
                            />
                        </Row>
                        {alertsEnabled && (
                            <Row>
                                <div className="flex-1">
                                    <div className="text-xs text-gray-400">
                                        Hear what an alert sounds like — runs the full chain: chime, page takeover,
                                        Calypso speaks, history log.
                                    </div>
                                </div>
                                <button
                                    onClick={handleTestAlert}
                                    className="min-h-[44px] text-sm font-bold text-sky-400 hover:text-sky-300 px-3 py-1 rounded-sm border border-sky-400/40 hover:border-sky-300/60 transition-colors"
                                >
                                    Test alert
                                </button>
                            </Row>
                        )}
                    </>
                )}
            </Section>

            <Section title="Apple Music">
                {!FEATURE_VISIBILITY.appleMusic ? (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white font-bold">Apple Music unavailable in public beta</div>
                            <div className="text-xs text-amber-300 mt-1 leading-relaxed">
                                Music controls remain held until the production MusicKit capability and signed-device
                                playback are verified. Calypso voice continues normally, and no Apple Music connection
                                or permission is requested by this beta.
                            </div>
                        </div>
                    </Row>
                ) : !canMusic ? (
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
                                <div className="text-sm text-white font-bold">Music lives on its own page</div>
                                <div className="text-xs text-gray-400 mt-1">
                                    Calypso can search and play anything in the Apple Music catalog (~100 million
                                    tracks). Auth, your playlists, and transport controls live on the dedicated Music
                                    page — tap the pink music icon next to Calypso, or use the button below.
                                </div>
                                <div className="text-xs text-gray-500 mt-2">
                                    Voice commands work the moment you're authorised: "Calypso, play me some Pink
                                    Floyd", "skip this track", "what's playing?" Music keeps playing while she talks.
                                </div>
                            </div>
                            <button
                                onClick={handleOpenMusicPage}
                                className="min-h-[44px] text-sm font-bold text-pink-400 hover:text-pink-300 px-3 py-1.5 rounded-sm border border-pink-400/40 hover:border-pink-300/60 transition-colors"
                            >
                                Open Music
                            </button>
                        </Row>
                        <Row>
                            <div className="flex-1">
                                <div className="text-sm text-white font-bold">Smooth song transitions (crossfade)</div>
                                <div className="text-xs text-gray-400 mt-1">
                                    Apple's MusicKit doesn't let third-party apps toggle crossfade on or off — the
                                    setting is system-wide and lives in iOS Settings. Once enabled, every track
                                    transition in Thalassa (and every other music app on your phone) glides into the
                                    next without the gap. iOS does not offer apps a supported direct link to this
                                    switch, so open Settings manually and turn{' '}
                                    <strong className="text-gray-300">Crossfade</strong> on and pick a duration.
                                </div>
                                <div className="text-xs text-gray-500 mt-2">
                                    Path: <span className="text-gray-400">iOS Settings → Apps → Music → Audio</span>.
                                    The button below opens Thalassa's own settings for its app permissions; iOS 17 or
                                    newer is required for the Music path above.
                                </div>
                            </div>
                            <button
                                onClick={handleOpenMusicSystemSettings}
                                className="min-h-[44px] text-sm font-bold text-pink-400 hover:text-pink-300 px-3 py-1.5 rounded-sm border border-pink-400/40 hover:border-pink-300/60 transition-colors"
                            >
                                Open Thalassa Settings
                            </button>
                        </Row>
                    </>
                )}
            </Section>

            <Section title="Gmail">
                {gmailError && (
                    <div
                        role="alert"
                        aria-live="assertive"
                        className="flex items-start gap-3 border-b border-red-500/15 bg-red-500/8 p-4"
                    >
                        <p className="flex-1 text-xs leading-relaxed text-red-200">{gmailError}</p>
                        <button
                            type="button"
                            onClick={() => setGmailError(null)}
                            aria-label="Dismiss Gmail error"
                            className="min-h-11 min-w-11 rounded-lg text-lg text-red-200/70 hover:bg-white/5 hover:text-red-100"
                        >
                            ×
                        </button>
                    </div>
                )}
                {!GMAIL_PUBLIC_BETA_ENABLED ? (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm font-bold text-white">Email access paused for public beta</div>
                            <div className="mt-1 text-xs leading-relaxed text-gray-400">
                                Gmail will return after its credentials move into Keychain storage and provider-grant
                                revocation is verified. No Gmail token or inbox content is used by this beta build.
                            </div>
                        </div>
                    </Row>
                ) : !canEmail ? (
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
                            <div className="text-xs text-amber-400 mt-1">Not available in this build yet.</div>
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
                                        {gmailOperation === 'disconnect'
                                            ? 'Disconnecting Gmail…'
                                            : "Connecting — finish signing in on Google's screen, then return to Thalassa."}
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
        </div>
    );
};
