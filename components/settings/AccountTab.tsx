/**
 * AccountTab — Account & Cloud settings panel: auth, API status, sync options.
 * Extracted from SettingsModal to reduce component size.
 */
import React, { useState, useEffect } from 'react';
import { Section, Row, RowChevron, SatelliteModeGlyph, SignInCard, type SettingsTabProps } from './SettingsPrimitives';
import { CheckIcon, CloudIcon, LockIcon } from '../Icons';
import { SignInScreen } from '../SignInScreen';
import { useAuth } from '../../context/AuthContext';
import { checkStormglassStatus } from '../../services/weather/keys';
import { isGeminiConfigured } from '../../services/geminiService';
import { isSupabaseConfigured } from '../../services/supabase';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { Button } from '../ui/Button';
import {
    ACCOUNT_DELETION_PRIVACY_EMAIL,
    ACCOUNT_DELETION_PRIVACY_MAILTO,
    ACCOUNT_DELETION_PUBLIC_BETA_ENABLED,
} from '../../services/accountDeletionPublicBetaBoundary';
import { EncPersonalCloudPanel } from '../vessel/EncPersonalCloudPanel';

// Keep the destructive flow coupled to the committed release profile. The
// direct env check lets Vite/Rollup remove the dynamic import entirely if the
// capability is ever re-held without weakening the service-side fence.
const DeleteAccountDialog =
    import.meta.env.VITE_ACCOUNT_DELETION_ENABLED === 'true'
        ? React.lazy(async () => {
              const module = await import('./DeleteAccountDialog');
              return { default: module.DeleteAccountDialog };
          })
        : null;

const isMapboxConfigured = () => {
    const envKey = process.env?.MAPBOX_ACCESS_TOKEN || (import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN);
    if (envKey && envKey.length > 5 && !envKey.includes('YOUR_')) return true;
    try {
        const local = localStorage.getItem('thalassa_mapbox_key');
        return !!local;
    } catch (e) {
        console.warn('Suppressed:', e);
        return false;
    }
};

const isOpenMeteoConfigured = () => isSupabaseConfigured();

// ── Status Row sub-component ──
// A STATE, never an instruction, and never more than is known. Nothing on this
// page probes a service: checkStormglassStatus() returns OK without a request
// (it will not spend paid quota to paint Settings), and the rest only read
// whether a key or URL is present. "Set up" beside a tick read as an
// instruction ("go and set it up"), so a service this app has what it needs
// for says "Ready" (UX scorecard run 8). "Configured" plus a footnote was
// developer's wording, and a bare "Paused" gave no reason (run 7).
// Offline, a service that is set up still cannot answer, so it says 'No
// signal' instead of 'Ready' (UX scorecard run 9: three 'Ready' rows offshore
// while the forecast would not load). That reads the app's own probe-verified
// WAN state (useOnlineStatus) — nothing new is probed from this page.
type ServiceState = 'setUp' | 'missing' | 'free' | 'checking' | 'error' | 'paused' | 'signedOut' | 'offline';

const SERVICE_STATE: Record<ServiceState, { dot: string; text: string; word: string }> = {
    setUp: { dot: '', text: 'text-gray-300 font-medium', word: 'Ready' },
    missing: { dot: 'border border-slate-500', text: 'text-gray-400 font-medium', word: 'Not set up' },
    // The marine forecast without its key runs on the free sources.
    free: { dot: 'bg-sky-500', text: 'text-sky-300 font-medium', word: 'Free mode' },
    checking: { dot: 'bg-yellow-500 animate-pulse', text: 'text-yellow-400 font-medium', word: 'Checking…' },
    error: { dot: 'bg-red-500', text: 'text-red-400 font-medium', word: 'Not working' },
    // The voice assistant is parked for the public beta
    // (FEATURE_VISIBILITY.calypsoConsole), whatever key is present.
    paused: { dot: 'border border-slate-500', text: 'text-gray-400 font-medium', word: 'Paused for the beta' },
    // Amber like the sign-in row: a state that stops the service working now.
    offline: {
        dot: 'bg-amber-400 [.display-light_&]:bg-amber-700',
        text: 'text-amber-300 font-semibold',
        word: 'No signal',
    },
    // The one row that asks something of the skipper stands out from the
    // ready ones: amber ring and amber words, not grey on grey (run 8).
    // Daylight: the ring darkens to amber-700 (3:1 on the white card); the
    // words already remap to amber-800 there (styles/daylight.css).
    signedOut: {
        dot: 'border-2 border-amber-400 [.display-light_&]:border-amber-700',
        text: 'text-amber-300 font-semibold',
        word: 'Needs sign-in',
    },
};

/** One flat row in the Services list: plain sentence-case name, state on the right. */
const StatusRow = ({ label, state, details }: { label: string; state: ServiceState; details?: string }) => {
    const look = SERVICE_STATE[state];
    return (
        <li className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-3 border-b border-white/5 last:border-0">
            <div className="flex min-w-0 items-center gap-3">
                {state === 'setUp' ? (
                    <CheckIcon className="w-4 h-4 shrink-0 -mx-[3px] text-gray-300" />
                ) : (
                    <span aria-hidden="true" className={`w-2.5 h-2.5 shrink-0 rounded-full ${look.dot}`} />
                )}
                <span className="text-sm font-bold text-white">{label}</span>
            </div>
            <span className={`text-right text-sm ${look.text}`}>{details || look.word}</span>
        </li>
    );
};

interface AccountTabProps extends SettingsTabProps {
    /** The sign-in sheet opened over this page (the host reopens it after). */
    onSignInOpened?: () => void;
    /** The sheet closed (dismissed, or done). */
    onSignInClosed?: () => void;
    /** Opens Settings → Preferences, where the Satellite mode switch lives. */
    onOpenPreferences?: () => void;
}

/** Satellite mode's state in one line, pointing at its switch in Preferences. */
const SatellitePointer: React.FC<{ on: boolean }> = ({ on }) => (
    <div className="flex flex-1 min-w-0 items-center gap-3">
        <div
            className={`shrink-0 rounded-xl p-2.5 ${on ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-400'}`}
            aria-hidden="true"
        >
            <SatelliteModeGlyph className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-white">Satellite mode</p>
            <p className="text-xs text-gray-400">{on ? 'On, forecast only' : 'Off'} · switch in Preferences</p>
        </div>
    </div>
);

export const AccountTab: React.FC<AccountTabProps> = ({
    settings,
    onSignInOpened,
    onSignInClosed,
    onOpenPreferences,
}) => {
    const { user, logout } = useAuth();
    const [authOpen, setAuthOpen] = useState(false);
    const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
    const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
    const [accountActionError, setAccountActionError] = useState<string | null>(null);
    const [sgStatus, setSgStatus] = useState<{ status: string; message: string } | null>(null);
    const online = useOnlineStatus();
    /** A service that is set up (or on the free sources) cannot answer without signal. */
    const reachable = (state: ServiceState): ServiceState =>
        !online && (state === 'setUp' || state === 'free') ? 'offline' : state;

    useEffect(() => {
        setSgStatus({ status: 'LOADING', message: 'Checking...' });
        checkStormglassStatus().then((res: { status: string; message: string }) =>
            setSgStatus({ status: res.status, message: res.message }),
        );
    }, []);

    const handleLogout = async () => {
        setAccountActionError(null);
        try {
            await logout();
        } catch (logoutError) {
            setAccountActionError(
                logoutError instanceof Error ? logoutError.message : 'Sign out failed. Please try again.',
            );
        }
    };

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <SignInScreen
                isOpen={authOpen}
                onClose={() => {
                    setAuthOpen(false);
                    onSignInClosed?.();
                }}
                prompt="Sign in to sync your vessel, voyages, and crew across devices."
            />
            {ACCOUNT_DELETION_PUBLIC_BETA_ENABLED && DeleteAccountDialog && (
                <React.Suspense fallback={null}>
                    <DeleteAccountDialog
                        isOpen={deleteAccountOpen}
                        accountLabel={user?.email || user?.phone}
                        onClose={() => setDeleteAccountOpen(false)}
                        onDeleted={(result) => {
                            setDeleteAccountOpen(false);
                            setDeletionNotice(
                                [
                                    result.localCleanupComplete
                                        ? 'Your account and synced data were permanently deleted.'
                                        : 'Your cloud account was deleted. Some unreachable device cache could not be removed; reinstall Thalassa to clear it completely.',
                                    result.appleRevocationRequired
                                        ? 'To remove the remaining Apple authorisation, open iOS Settings → your name → Sign in with Apple → Thalassa → Delete.'
                                        : '',
                                    result.serverFinalizationPending
                                        ? 'Your sign-in was deleted, but the minimal server deletion receipt still needs an operational checkpoint; contact privacy@thalassawx.com if this notice persists.'
                                        : '',
                                ]
                                    .filter(Boolean)
                                    .join(' '),
                            );
                        }}
                    />
                </React.Suspense>
            )}

            {deletionNotice && (
                <div
                    role="status"
                    className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200"
                >
                    {deletionNotice}
                </div>
            )}

            {accountActionError && (
                <div
                    role="alert"
                    className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
                >
                    {accountActionError}
                </div>
            )}

            {/* Account card. Signed out, it is the one sign-in card (left-aligned
                title and reason, full-width Sign in under them) that Voyage Log
                uses too; the centred hero was a third sign-in layout (UX
                scorecard run 8). Its heading is an h2, like every section
                heading below it. */}
            <div className="mb-8 rounded-2xl border border-white/10 bg-white/3 p-4 shadow-lg shadow-black/10">
                {!user ? (
                    <SignInCard
                        headingLevel="h2"
                        icon={<CloudIcon className="w-5 h-5" />}
                        title="Sign in to sync across your devices"
                        reason="Your settings, vessel records and voyage data sync privately to your account."
                        onSignIn={() => {
                            setAuthOpen(true);
                            onSignInOpened?.();
                        }}
                    />
                ) : (
                    <div className="space-y-4">
                        <div className="flex items-start gap-3">
                            <div
                                className="shrink-0 rounded-xl bg-emerald-500/20 p-2.5 text-emerald-300"
                                aria-hidden="true"
                            >
                                <CloudIcon className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2 className="text-sm font-bold text-white">Connected to the cloud</h2>
                                <p className="mt-1 text-xs text-gray-400">Your data syncs privately to your account.</p>
                            </div>
                        </div>
                        <div className="flex min-h-11 items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2">
                            <div
                                className="w-2 h-2 shrink-0 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50"
                                aria-hidden="true"
                            ></div>
                            <span className="min-w-0 truncate text-sm font-bold text-emerald-300">
                                {user.email || user.phone}
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* Sync Status */}
            {user && (
                <Section title="Sync Status">
                    <Row>
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-emerald-500/20 text-emerald-300 rounded-lg">
                                <CloudIcon className="w-5 h-5" />
                            </div>
                            <div>
                                <p className="text-white font-bold text-sm">Cloud sync</p>
                                <p className="text-xs text-emerald-400 font-bold">Signed in</p>
                            </div>
                        </div>
                        {/* Offline it cannot be syncing, so it does not say
                            Active (the Services row below says No signal too). */}
                        <div className="flex items-center gap-2">
                            <div
                                className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50' : 'bg-amber-400 [.display-light_&]:bg-amber-700'}`}
                                aria-hidden="true"
                            ></div>
                            <span className={`text-xs font-bold ${online ? 'text-emerald-400' : 'text-amber-300'}`}>
                                {online ? 'Active' : 'No signal'}
                            </span>
                        </div>
                    </Row>
                    <Row>
                        <div className="flex-1">
                            <p className="text-sm text-white font-medium">Cloud service</p>
                            <p className="text-xs text-gray-400">
                                {isSupabaseConfigured()
                                    ? 'Set up in this app — where your synced data lives'
                                    : 'Not set up in this app'}
                            </p>
                        </div>
                        <div
                            className={`px-3 py-1 rounded-full text-xs font-bold ${isSupabaseConfigured() ? 'bg-white/5 border border-white/10 text-gray-300' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}
                        >
                            {isSupabaseConfigured() ? 'Ready' : 'Not set up'}
                        </div>
                    </Row>
                </Section>
            )}

            {/* Satellite mode lives in Preferences, the home for switches (Shane
                2026-09-09; UX scorecard run 8). Same setting (satelliteMode),
                same effect; this one line keeps its state visible here and
                goes to the switch. */}
            <Section title="Network Mode">
                {onOpenPreferences ? (
                    <Row
                        onClick={onOpenPreferences}
                        label={`Satellite mode, ${settings.satelliteMode ? 'on' : 'off'}. Change it in Preferences`}
                        className="min-h-[44px]"
                    >
                        <SatellitePointer on={!!settings.satelliteMode} />
                        <RowChevron />
                    </Row>
                ) : (
                    <Row>
                        <SatellitePointer on={!!settings.satelliteMode} />
                    </Row>
                )}
            </Section>

            {/* Cloud data behaviour — sync is automatic while signed in. */}
            {user && (
                <Section title="Cloud Data">
                    <Row>
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 rounded-lg bg-sky-500/20 p-2 text-sky-300">
                                <CloudIcon className="h-5 w-5" />
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm font-bold text-white">Automatic private sync</p>
                                <p className="text-xs leading-relaxed text-gray-400">
                                    While signed in, settings, vessel records, voyage data, and diary entries sync
                                    privately across your devices. Community tracks and diary posts are public only when
                                    you explicitly choose to share or publish them.
                                </p>
                            </div>
                        </div>
                    </Row>
                    {/*
                     * Chart backup lives here now.
                     *
                     * It is pure Supabase — no Pi anywhere in it or in
                     * personalCellSync — but its only mount was inside
                     * EncCellManager, which renders only when Pi integration
                     * is on. So a build without the pinning plugin, and the
                     * web build at thalassawx.app, could DOWNLOAD your
                     * personal cells and never publish or back one up. Paid
                     * Nouméa and Port Vila cells had no route off the phone
                     * they were imported on.
                     *
                     * It was also buried inside a collapsed card on a page
                     * about hardware discovery, which is not where anyone
                     * looks for a backup. This section already promises that
                     * settings, vessel records and voyage data sync privately
                     * across devices; charts belong in that sentence.
                     */}
                    <Row>
                        <EncPersonalCloudPanel />
                    </Row>
                </Section>
            )}

            <Section title="Services">
                <ul role="list" aria-label="Service status">
                    <StatusRow
                        label="Marine forecast"
                        state={reachable(
                            !sgStatus || sgStatus.status === 'LOADING'
                                ? 'checking'
                                : sgStatus.status === 'MISSING_KEY'
                                  ? 'free'
                                  : sgStatus.status === 'ERROR'
                                    ? 'error'
                                    : 'setUp',
                        )}
                        details={sgStatus?.status === 'ERROR' ? sgStatus.message : undefined}
                    />
                    {/* What it is, not the persona: 'Calypso' is a name the
                        skipper meets nowhere else while his console is parked
                        (FEATURE_VISIBILITY.calypsoConsole), so a configured key
                        does not make him available (UX scorecard run 9). */}
                    <StatusRow
                        label="Voice assistant"
                        state={
                            !FEATURE_VISIBILITY.calypsoConsole ? 'paused' : isGeminiConfigured() ? 'setUp' : 'missing'
                        }
                    />
                    <StatusRow label="Charts" state={reachable(isMapboxConfigured() ? 'setUp' : 'missing')} />
                    {/* Sync needs a session, not just a configured backend. */}
                    <StatusRow
                        label="Cloud sync"
                        state={reachable(!isSupabaseConfigured() ? 'missing' : user ? 'setUp' : 'signedOut')}
                    />
                    <StatusRow
                        label="Forecast models"
                        state={reachable(isOpenMeteoConfigured() ? 'setUp' : 'missing')}
                    />
                </ul>
            </Section>

            {/* Account Actions */}
            {user && (
                <Section title="Account">
                    <Row>
                        <Button variant="danger" onClick={() => void handleLogout()} className="w-full">
                            <LockIcon className="w-4 h-4" />
                            Sign out
                        </Button>
                    </Row>
                    <Row>
                        {ACCOUNT_DELETION_PUBLIC_BETA_ENABLED ? (
                            <div className="w-full space-y-2">
                                <Button
                                    variant="danger"
                                    aria-label="Permanently delete account"
                                    onClick={() => setDeleteAccountOpen(true)}
                                    className="w-full"
                                >
                                    Delete account and data
                                </Button>
                                <p className="text-center text-xs leading-relaxed text-gray-400">
                                    Permanently removes your account, synced data, uploads, and shared content.
                                </p>
                            </div>
                        ) : (
                            <div
                                role="status"
                                className="w-full rounded-xl border border-amber-400/25 bg-amber-400/8 p-4"
                            >
                                <p className="text-sm font-bold text-amber-200">
                                    Account deletion temporarily unavailable
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-amber-100/75">
                                    The destructive in-app flow is paused while its deletion safety controls are
                                    completed and verified. To request deletion during this beta, email{' '}
                                    <a
                                        href={ACCOUNT_DELETION_PRIVACY_MAILTO}
                                        className="font-semibold text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200"
                                    >
                                        {ACCOUNT_DELETION_PRIVACY_EMAIL}
                                    </a>
                                    .
                                </p>
                            </div>
                        )}
                    </Row>
                </Section>
            )}
        </div>
    );
};
