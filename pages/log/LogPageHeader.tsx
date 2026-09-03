/**
 * LogPageHeader — the Ship's Log PageHeader and its overflow (kebab) menu,
 * extracted verbatim from pages/LogPage.tsx.
 */
import React from 'react';
import { DownloadIcon, MapIcon, ShareIcon } from '../../components/Icons';
import { PageHeader } from '../../components/ui/PageHeader';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
import type { LogPageAction } from '../../hooks/useLogPageState';
import type { ShipLogEntry } from '../../types';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import { MenuBtn } from './LogSubComponents';
import { ExportIcon, StatsIcon } from './LogPageIcons';

export const LogPageHeader: React.FC<{
    isTracking: boolean;
    gpsStatus: 'locked' | 'stale' | 'none';
    hasRecordedFix: boolean;
    gpsHeadline: string;
    onBack?: () => void;
    overflowTriggerRef: React.RefObject<HTMLButtonElement>;
    overflowMenuRef: React.RefObject<HTMLDivElement>;
    overflowMenuId: string;
    showMenu: boolean;
    setShowMenu: React.Dispatch<React.SetStateAction<boolean>>;
    closeOverflowMenu: () => void;
    dispatch: (action: LogPageAction) => void;
    loggedVoyages: VoyageSummary[];
    loggedEntries: ShipLogEntry[];
}> = ({
    isTracking,
    gpsStatus,
    hasRecordedFix,
    gpsHeadline,
    onBack,
    overflowTriggerRef,
    overflowMenuRef,
    overflowMenuId,
    showMenu,
    setShowMenu,
    closeOverflowMenu,
    dispatch,
    loggedVoyages,
    loggedEntries,
}) => (
    <PageHeader
        title="Ship's Log"
        subtitle={
            isTracking ? (
                <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${
                            gpsStatus === 'locked'
                                ? 'bg-emerald-400 animate-pulse'
                                : gpsStatus === 'stale'
                                  ? 'bg-amber-400 animate-pulse'
                                  : 'bg-red-500 animate-pulse'
                        }`}
                    />
                    <span
                        className={`text-xs font-bold uppercase tracking-widest ${
                            gpsStatus === 'locked'
                                ? 'text-emerald-400'
                                : gpsStatus === 'stale'
                                  ? 'text-amber-300'
                                  : 'text-red-400'
                        }`}
                    >
                        {gpsStatus === 'locked' && hasRecordedFix ? 'Recording' : gpsHeadline}
                    </span>
                </div>
            ) : (
                'GPS Voyage Recorder'
            )
        }
        onBack={onBack}
        action={
            <div className="relative">
                <button
                    ref={overflowTriggerRef}
                    aria-label="Open menu"
                    aria-haspopup="menu"
                    aria-expanded={showMenu}
                    aria-controls={showMenu ? overflowMenuId : undefined}
                    onClick={() => setShowMenu(!showMenu)}
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                        <circle cx="10" cy="4" r="1.5" />
                        <circle cx="10" cy="10" r="1.5" />
                        <circle cx="10" cy="16" r="1.5" />
                    </svg>
                </button>
                {/* Overflow Menu */}
                {showMenu && (
                    <>
                        <div
                            role="presentation"
                            aria-hidden="true"
                            className="fixed inset-0 z-40"
                            onClick={closeOverflowMenu}
                        />
                        <div
                            ref={overflowMenuRef}
                            id={overflowMenuId}
                            role="menu"
                            aria-label="Log actions"
                            className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden"
                        >
                            {/* Rapid Mode + Precision Mode toggles were removed
                                                from this menu 2026-05-17. Precision Mode is now
                                                always-on whenever tracking is active (the
                                                canonical "hi-fi 2 Hz + live decimation" pipeline),
                                                so the toggle was just visual noise. Rapid Mode is
                                                preserved in the service for potential future
                                                paywall gating but no longer surfaced in the UI —
                                                "having two tracking modes, one of which works"
                                                was the wrong story. The handler hooks
                                                (handleToggleRapidMode, handleTogglePrecisionMode)
                                                stay in the hook in case we re-expose them as a
                                                Skipper-tier gate. */}
                            {/* Diary kebab item REMOVED 2026-05-17 — Diary now
                                                has its own prominent full-card tile in the new
                                                Vessel-tab → Sharing section (paired with
                                                Scuttlebutt). The kebab was the right rescue
                                                home when Diary was otherwise orphaned, but for
                                                the "share your voyage" conversion story it
                                                deserves real presence, not menu-burial. */}
                            <MenuBtn
                                icon={<StatsIcon className="w-4 h-4" />}
                                label="Statistics"
                                onClick={() => {
                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'stats' });
                                    setShowMenu(false);
                                }}
                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                            />
                            <MenuBtn
                                icon={<MapIcon className="w-4 h-4" />}
                                label="Track Map"
                                onClick={() => {
                                    dispatch({ type: 'SHOW_TRACK_MAP', show: true });
                                    setShowMenu(false);
                                }}
                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                            />
                            <MenuBtn
                                icon={<ExportIcon className="w-4 h-4" />}
                                label="Export"
                                onClick={() => {
                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'export' });
                                    setShowMenu(false);
                                }}
                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                            />
                            {FEATURE_VISIBILITY.communityTrackSharing && (
                                <MenuBtn
                                    icon={<DownloadIcon className="w-4 h-4" />}
                                    label="Import"
                                    onClick={() => {
                                        dispatch({ type: 'SET_ACTION_SHEET', sheet: 'import' });
                                        setShowMenu(false);
                                    }}
                                />
                            )}
                            <MenuBtn
                                icon={<ShareIcon className="w-4 h-4" />}
                                label="Share"
                                onClick={() => {
                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' });
                                    setShowMenu(false);
                                }}
                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                            />
                        </div>
                    </>
                )}
            </div>
        }
    />
);
