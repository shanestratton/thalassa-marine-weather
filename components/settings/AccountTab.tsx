/**
 * AccountTab — Account & Cloud settings panel: auth, API status, sync options.
 * Extracted from SettingsModal to reduce component size.
 */
import React, { useState, useEffect } from 'react';
import { SATELLITE_MODE_ENFORCED } from '../../services/networkPolicy';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { CloudIcon, LockIcon } from '../Icons';
import { SignInScreen } from '../SignInScreen';
import { useAuth } from '../../context/AuthContext';
import { checkStormglassStatus } from '../../services/weather/keys';
import { isGeminiConfigured } from '../../services/geminiService';
import { isSupabaseConfigured } from '../../services/supabase';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
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
// whether a key or URL is present. So a set-up service reads a neutral
// "Configured" with a grey dot — the green "Ready"/"Working" pair read as two
// live checks, and "Cloud sync: Ready" glowed green while signed out (UX
// scorecard run 6). Green is kept for a real check; none runs here yet.
type ServiceState = 'configured' | 'missing' | 'free' | 'checking' | 'error' | 'paused' | 'signedOut';

const SERVICE_STATE: Record<ServiceState, { dot: string; text: string; word: string }> = {
    configured: { dot: 'bg-slate-400', text: 'text-gray-300', word: 'Configured' },
    missing: { dot: 'border border-slate-500', text: 'text-gray-400', word: 'Not set up' },
    // The marine forecast without its key runs on the free sources.
    free: { dot: 'bg-sky-500', text: 'text-sky-300', word: 'Free mode' },
    checking: { dot: 'bg-yellow-500 animate-pulse', text: 'text-yellow-400', word: 'Checking…' },
    error: { dot: 'bg-red-500', text: 'text-red-400', word: 'Not working' },
    paused: { dot: 'border border-slate-500', text: 'text-gray-400', word: 'Paused' },
    signedOut: { dot: 'border border-slate-500', text: 'text-gray-400', word: 'Sign in to sync' },
};

/** One flat row in the Services list: plain sentence-case name, state on the right. */
const StatusRow = ({ label, state, details }: { label: string; state: ServiceState; details?: string }) => {
    const look = SERVICE_STATE[state];
    return (
        <li className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-3 border-b border-white/5 last:border-0">
            <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true" className={`w-2.5 h-2.5 shrink-0 rounded-full ${look.dot}`} />
                <span className="text-sm font-bold text-white">{label}</span>
            </div>
            <span className={`text-right text-sm font-medium ${look.text}`}>{details || look.word}</span>
        </li>
    );
};

export const AccountTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const { user, logout } = useAuth();
    const [authOpen, setAuthOpen] = useState(false);
    const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
    const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
    const [accountActionError, setAccountActionError] = useState<string | null>(null);
    const [sgStatus, setSgStatus] = useState<{ status: string; message: string } | null>(null);

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
                onClose={() => setAuthOpen(false)}
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

            {/* Account Connection Hero */}
            <div className="bg-linear-to-br from-slate-800 to-slate-900 border border-white/10 rounded-2xl p-6 mb-8 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-32 bg-sky-500/10 rounded-full blur-3xl pointer-events-none -translate-y-1/2 translate-x-1/2"></div>
                <div className="flex flex-col items-center gap-4 relative z-10 text-center">
                    <div
                        className={`w-16 h-16 rounded-2xl flex items-center justify-center shadow-xl ${user ? 'bg-linear-to-br from-emerald-500 to-emerald-600 shadow-emerald-500/30' : 'bg-linear-to-br from-slate-600 to-slate-700'}`}
                    >
                        <CloudIcon className={`w-8 h-8 ${user ? 'text-white' : 'text-gray-400'}`} />
                    </div>
                    <div>
                        {/* h2, like every section heading below it — as an h3 it
                            sat under the Network Mode / Services h2s in the outline. */}
                        <h2 className="text-lg font-bold text-white">
                            {user ? 'Connected to the cloud' : 'Cloud connection'}
                        </h2>
                        <p className="text-sm text-gray-400 max-w-md mt-1">
                            {user
                                ? 'Your data is synced securely to the cloud.'
                                : 'Sign in to sync your settings and voyage data across your devices.'}
                        </p>
                    </div>
                    {!user ? (
                        <Button variant="primary" onClick={() => setAuthOpen(true)} className="px-8">
                            Sign in
                        </Button>
                    ) : (
                        <div className="flex flex-col gap-3 items-center w-full">
                            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-xl">
                                <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50 animate-pulse"></div>
                                <span className="text-sm text-emerald-300 font-mono font-bold">
                                    {user.email || user.phone}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
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
                        <div className="flex items-center gap-2">
                            <div
                                className="w-2 h-2 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50"
                                aria-hidden="true"
                            ></div>
                            <span className="text-xs text-emerald-400 font-bold">Active</span>
                        </div>
                    </Row>
                    <Row>
                        <div className="flex-1">
                            <label className="text-sm text-white font-medium block">Supabase</label>
                            <p className="text-xs text-gray-400">
                                {isSupabaseConfigured() ? 'Backend configured and ready' : 'Backend not configured'}
                            </p>
                        </div>
                        <div
                            className={`px-3 py-1 rounded-full text-xs font-bold ${isSupabaseConfigured() ? 'bg-white/5 border border-white/10 text-gray-300' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}
                        >
                            {isSupabaseConfigured() ? 'Configured' : 'Missing'}
                        </div>
                    </Row>
                </Section>
            )}

            {/* Satellite Mode */}
            {/* The switch sits straight in the section card, like every other
                settings row — it used to be a bordered card inside the section
                card. The amber wash still marks the mode as on. */}
            <Section title="Network Mode">
                <div
                    className={`p-4 transition-colors duration-500 ${settings.satelliteMode ? 'bg-linear-to-br from-amber-500/15 to-orange-500/10' : ''}`}
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div
                                className={`p-2.5 rounded-xl transition-all duration-500 ${settings.satelliteMode ? 'bg-amber-500/20 text-amber-400 shadow-lg shadow-amber-500/20 scale-110' : 'bg-white/5 text-gray-400'}`}
                            >
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M8.288 15.038a5.25 5.25 0 017.424-7.424m-5.303 5.303a2.25 2.25 0 013.182-3.182M12 21a9 9 0 100-18 9 9 0 000 18z"
                                    />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5l16.5 9" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-white font-bold text-sm">Satellite Mode</p>
                                <p
                                    className={`text-xs mt-0.5 transition-colors ${settings.satelliteMode ? 'text-amber-300/70' : 'text-gray-400'}`}
                                >
                                    {settings.satelliteMode
                                        ? 'Forecast only • grids, radar, AIS & uploads paused'
                                        : 'For Iridium GO! & metered connections'}
                                </p>
                            </div>
                        </div>
                        <Toggle
                            label="Satellite Mode"
                            checked={!!settings.satelliteMode}
                            onChange={(v) => onSave({ satelliteMode: v })}
                        />
                    </div>
                    {settings.satelliteMode && (
                        <div className="mt-3 pt-3 border-t border-amber-500/20 space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-300">
                            {/* The forecast still runs every source it normally
                                does — five small JSON calls every three hours.
                                "StormGlass only" was never true; the cadence is
                                the saving, and the cadence is what is promised. */}
                            <div className="flex items-center gap-2 text-xs">
                                <div
                                    className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400"
                                    aria-hidden="true"
                                ></div>
                                <span className="text-amber-200/70">Weather updates every 3 hours</span>
                            </div>
                            {/* Rendered FROM the policy module, so what this list
                                says and what the fetchers enforce are one thing.
                                Until 2026-09-05 the toggle promised "~200 KB/day •
                                Weather only" while GRIBs, radar, AIS and video
                                uploads ran exactly as on WiFi. */}
                            {SATELLITE_MODE_ENFORCED.map((entry) => (
                                <div key={entry.kind} className="flex items-center gap-2 text-xs">
                                    <div
                                        className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400"
                                        aria-hidden="true"
                                    ></div>
                                    <span className="text-amber-200/70">{entry.label}</span>
                                </div>
                            ))}
                            <div className="flex items-center gap-2 text-xs">
                                <div
                                    className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400"
                                    aria-hidden="true"
                                ></div>
                                <span className="text-amber-200/70">
                                    Log entries stored on-device until back on land
                                </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <div
                                    className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400"
                                    aria-hidden="true"
                                ></div>
                                <span className="text-amber-200/70">
                                    Diary relay uploads pause until normal network mode resumes
                                </span>
                            </div>
                        </div>
                    )}
                </div>
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
                        state={
                            !sgStatus || sgStatus.status === 'LOADING'
                                ? 'checking'
                                : sgStatus.status === 'MISSING_KEY'
                                  ? 'free'
                                  : sgStatus.status === 'ERROR'
                                    ? 'error'
                                    : 'configured'
                        }
                        details={sgStatus?.status === 'ERROR' ? sgStatus.message : undefined}
                    />
                    {/* The assistant is Calypso, whose console is parked
                        (FEATURE_VISIBILITY.calypsoConsole): a configured key does
                        not make him available. */}
                    <StatusRow
                        label="Assistant"
                        state={
                            !FEATURE_VISIBILITY.calypsoConsole
                                ? 'paused'
                                : isGeminiConfigured()
                                  ? 'configured'
                                  : 'missing'
                        }
                    />
                    <StatusRow label="Charts" state={isMapboxConfigured() ? 'configured' : 'missing'} />
                    {/* Sync needs a session, not just a configured backend. */}
                    <StatusRow
                        label="Cloud sync"
                        state={!isSupabaseConfigured() ? 'missing' : user ? 'configured' : 'signedOut'}
                    />
                    <StatusRow label="Weather models" state={isOpenMeteoConfigured() ? 'configured' : 'missing'} />
                </ul>
                <p className="px-4 pb-4 pt-1 text-xs leading-relaxed text-gray-400">
                    Configured means the service is set up in this app. It isn&apos;t tested from this screen.
                </p>
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
