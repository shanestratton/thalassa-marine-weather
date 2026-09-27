import React, { useId, useState, useSyncExternalStore } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SettingsModal');
import { UserSettings } from '../types';
import { BellIcon, SailBoatIcon, StarIcon, GearIcon, ServerIcon, MapPinIcon } from './Icons';
import { reverseGeocode } from '../services/weatherService';
import { useSettings } from '../context/SettingsContext';
import { GpsService } from '../services/GpsService';

import { AlertsTab } from './settings/AlertsTab';
import { VesselTab } from './settings/VesselTab';
import { GeneralTab } from './settings/GeneralTab';
import { AccountTab } from './settings/AccountTab';
import { LocationsTab } from './settings/LocationsTab';
import { VoyageLogTab } from './settings/VoyageLogTab';
import { RowChevron } from './settings/SettingsPrimitives';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { PageHeader } from './ui/PageHeader';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';
import { VoyageLogService } from '../services/VoyageLogService';
import { PUBLIC_BETA_ACCESS } from '../services/SubscriptionService';

interface SettingsViewProps {
    settings: UserSettings;
    onSave: (settings: Partial<UserSettings>) => void;
    onLocationSelect: (location: string) => void;
    onBack?: () => void;
}

// Settings tab-nav button. Rewritten 2026-05-17 to align with the
// Minimal v3 active-state language that the bottom nav adopted on
// the same day. The previous treatment was three signals stacked
// (gradient bg + 20 px sky-glow shadow + left-border highlight +
// scale-110 icon tile + animate-pulse arrow + translate-x label) —
// fine in isolation but it screamed against the toned-down bottom
// nav within the same app session. One active-state language now:
// solid sky-500 left-bar (the "you are here" anchor) + brighter
// label/icon (the inherent color cue) + subtle bg tint. No glow,
// no scale, no pulse.
const NavButton = React.memo(
    ({
        active,
        onClick,
        icon,
        label,
    }: {
        active: boolean;
        onClick: () => void;
        icon: React.ReactNode;
        label: string;
    }) => (
        <button
            aria-label={label}
            onClick={onClick}
            className={`relative flex items-center gap-3 w-full pl-4 pr-3 py-2.5 rounded-lg transition-colors duration-150 text-left ${
                active ? 'bg-white/4 text-white' : 'text-slate-400 hover:bg-white/3 hover:text-slate-200'
            }`}
        >
            {/* Single-pixel anchor bar. Solid sky-500 at full opacity
                so it reads cleanly without a halo. Mirrors the bottom-
                nav indicator-dot pattern: one solid mark, no glow. */}
            {active && (
                <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-sky-500" aria-hidden="true" />
            )}
            <span className={active ? 'text-sky-300' : 'text-slate-400'}>{icon}</span>
            {/* Capitals by CSS, so VoiceOver reads 'Preferences', not a spelled-out 'PREFERENCES'. */}
            <span className="font-semibold text-sm uppercase tracking-wide">{label}</span>
        </button>
    ),
);

// Toggle — imported from ./settings/SettingsPrimitives

// Section, Row — imported from ./settings/SettingsPrimitives

type SettingsTab = 'general' | 'account' | 'vessel' | 'alerts' | 'locations' | 'voyageLog';

/**
 * Section grouping for the Settings tab list.
 *
 * Scorecard fix 2026-05-17: the previous flat list of 10 tabs put
 * Pi Cache (which 95 % of users will never touch — they
 * exist for the on-boat hardware integration story) on the same
 * shelf as Account and Notifications (which every user touches).
 * That dilutes discoverability for the items that matter and makes
 * the Settings surface read as "everything-and-the-kitchen-sink".
 *
 * Grouped by everyday settings and account sharing:
 *   - essentials      — what every user actually configures
 *   - sharing         — outward-facing (cloud sync, public log)
 *   - (appearance folded into Preferences → General on 2026-09-09)
 * Boat hardware and integrations live in Vessel → Boat Network.
 */
type SettingsGroup = 'essentials' | 'sharing';

const SETTINGS_GROUPS: { id: SettingsGroup; label: string }[] = [
    { id: 'essentials', label: 'Essentials' },
    { id: 'sharing', label: 'Account & Sharing' },
];

const MENU_ITEMS: {
    id: SettingsTab;
    label: string;
    description: string;
    /** Words the search matches but the row does not print, so a short
     *  subtitle costs no findability ("feedback", "freeze", "crew"). */
    keywords?: string;
    icon: (cls: string) => React.ReactNode;
    iconBg: string;
    iconHoverBg: string;
    group: SettingsGroup;
}[] = [
    // ── ESSENTIALS ──────────────────────────────────────────────
    {
        id: 'general',
        label: 'Preferences',
        // Leads with the home port the page opens on (UX scorecard run 7).
        description: 'Home port, units, clock & display',
        // Satellite mode and Smart Polars live here now (UX scorecard run 8).
        keywords:
            'default port location time bells zone appearance ais sharing satellite iridium metered network smart polars offshore model legal feedback reset',
        icon: (c) => <GearIcon className={c} />,
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
        group: 'essentials',
    },
    {
        id: 'vessel',
        label: 'Vessel Profile',
        // Names the comfort limits and crew the page also holds (UX scorecard run 7).
        description: 'Boat, safety, comfort limits & crew',
        keywords: 'specs rig hull keel dimensions performance mmsi epirb liferaft routing currents tanks capacity',
        // The sailboat the Vessel tab and hub card wear; the hatched box read
        // as a hazard or 'closed' sign (UX scorecard run 8).
        icon: (c) => <SailBoatIcon className={c} />,
        iconBg: 'bg-amber-500/15 text-amber-400 shadow-amber-500/10',
        iconHoverBg: 'group-hover:bg-amber-500/25',
        group: 'essentials',
    },
    {
        id: 'locations',
        label: 'Locations',
        description: 'Saved ports & anchorages',
        keywords: 'favourites places',
        icon: (c) => <MapPinIcon className={c} />,
        iconBg: 'bg-emerald-500/15 text-emerald-400 shadow-emerald-500/10',
        iconHoverBg: 'group-hover:bg-emerald-500/25',
        group: 'essentials',
    },
    {
        id: 'alerts',
        label: 'Notifications',
        // The page holds weather thresholds only; the anchor alarm lives on
        // Anchor Watch (UX scorecard run 6). One line at 375 pt, so the row
        // keeps its height now that it also carries the live alert count; the
        // rest of the list is in the search keywords (run 7).
        description: 'Wind, sea & weather alerts',
        keywords: 'gusts swell visibility uv temperature heat cold freeze rain precipitation thresholds',
        icon: (c) => <BellIcon className={c} />,
        iconBg: 'bg-red-500/15 text-red-400 shadow-red-500/10',
        iconHoverBg: 'group-hover:bg-red-500/25',
        group: 'essentials',
    },

    // ── ACCOUNT & SHARING ───────────────────────────────────────
    {
        id: 'account',
        label: 'Account & Cloud',
        // Satellite mode's switch moved to Preferences (UX scorecard run 8).
        description: 'Sign-in, sync & service status',
        keywords: 'sync sign out delete services calypso',
        icon: (c) => <ServerIcon className={c} />,
        iconBg: 'bg-purple-500/15 text-purple-400 shadow-purple-500/10',
        iconHoverBg: 'group-hover:bg-purple-500/25',
        group: 'sharing',
    },
    {
        id: 'voyageLog',
        label: 'Voyage Log',
        // Says who it is for, so it doesn't read as the LOG tab's ship's log
        // (UX scorecard run 7).
        description: 'Public page for followers ashore',
        keywords: 'share sharing link follow passage api public',
        icon: (c) => (
            <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0a8.949 8.949 0 004.951-1.488M12 21a8.949 8.949 0 01-4.951-1.488M3.6 9h16.8M3.6 15h16.8M12 3a13.5 13.5 0 000 18 13.5 13.5 0 000-18z"
                />
            </svg>
        ),
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
        group: 'sharing',
    },

    // ── APPEARANCE ── folded into Preferences on 2026-09-09 (Shane: "move the
    // entire aesthetics page to a section inside the preference page").
];

/**
 * A Settings page that opened the sign-in sheet over itself (Account & Cloud,
 * Voyage Log). Signing in re-keys the app under the new identity
 * (WeatherProvider), which remounts Settings on its menu; this note, kept for
 * the session, reopens the page the skipper signed in from instead of leaving
 * them to find it again (UX scorecard run 7). The identity generation tells a
 * completed sign-in from a dismissed sheet.
 */
let resumeTabAfterSignIn: { tab: SettingsTab; generation: number; at: number } | null = null;
/** A sign-in that finishes later than this is not a return from this page. */
const RESUME_AFTER_SIGN_IN_MS = 10 * 60_000;
const resumeIsFresh = () =>
    resumeTabAfterSignIn !== null &&
    resumeTabAfterSignIn.generation !== getAuthIdentityScope().generation &&
    Date.now() - resumeTabAfterSignIn.at < RESUME_AFTER_SIGN_IN_MS;
const armSignInReturn = (tab: SettingsTab) => {
    resumeTabAfterSignIn = { tab, generation: getAuthIdentityScope().generation, at: Date.now() };
};
const disarmSignInReturn = () => {
    // Closed with no new account: nothing to return to.
    if (resumeTabAfterSignIn?.generation === getAuthIdentityScope().generation) resumeTabAfterSignIn = null;
};

/** Small section header used on both desktop sidebar and mobile menu. An h2
 *  under the page's h1, not a <p>: ESSENTIALS and ACCOUNT & SHARING are the
 *  menu's two sections (UX scorecard run 5). It wears the cyan-dot heading of
 *  the sub-pages' Section, so the menu and its pages speak one heading style
 *  (UX scorecard run 6). */
const SettingsSectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h2 className="ui-section-heading text-label font-bold uppercase tracking-[0.15em] text-sky-300 flex items-center gap-2 px-2 pt-3 pb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shadow-lg shadow-sky-500/50" aria-hidden="true" />
        {children}
    </h2>
);

export const SettingsView: React.FC<SettingsViewProps> = React.memo(
    ({ settings, onSave, onLocationSelect, onBack }) => {
        const { resetSettings } = useSettings();
        const [activeTab, setActiveTab] = useState<SettingsTab | null>(() => {
            // Back from signing in over a Settings page: reopen that page.
            if (resumeIsFresh()) {
                return resumeTabAfterSignIn!.tab;
            }
            // Deep-link from outside: callers (e.g. the "Set up your
            // vessel" CTA in VesselHub, the "Personalise →" link in
            // RoutePlanner's Active Vessel indicator) write the
            // target tab to localStorage right before setPage('settings').
            // Pick it up here on mount, then clear the key so a
            // subsequent normal entry shows the default tab. Same
            // shape as the existing `thalassa_settings_return_to`
            // hint used by the back-button logic.
            if (typeof window !== 'undefined') {
                const deepLinkKey = authScopedStorageKey('thalassa_settings_initial_tab');
                const deepLink = localStorage.getItem(deepLinkKey);
                if (deepLink) {
                    localStorage.removeItem(deepLinkKey);
                    // Removed tabs (including the old boatNetwork hint) must
                    // not leave an empty settings pane after an app update.
                    const item = MENU_ITEMS.find((candidate) => candidate.id === deepLink);
                    if (item) return item.id;
                }
            }
            // Desktop (md breakpoint): default to 'general' so content area isn't empty
            // Mobile: default to null to show the vertical menu screen
            if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
                return 'general';
            }
            return null;
        });
        // Consumed once this mount has read it (the initialiser above stays pure).
        React.useEffect(() => {
            if (resumeTabAfterSignIn && resumeTabAfterSignIn.generation !== getAuthIdentityScope().generation) {
                resumeTabAfterSignIn = null;
            }
        }, []);
        const [showFactoryReset, setShowFactoryReset] = useState(false);
        const isObserver = settings?.vessel?.type === 'observer';
        const hasPaidPlan = !PUBLIC_BETA_ACCESS.enabled && settings.subscriptionTier !== 'free';

        // Settings tab search — added 2026-05-17 (scorecard fix #11).
        // 10 tabs is a lot even after the section grouping; "where do I
        // change the anchor alarm radius" still needs hunting. Search
        // filters MENU_ITEMS by label + description so the user can type
        // "anchor" and see the matching tabs surface.
        // Empty query passes through (shows the full section list).
        const [tabQuery, setTabQuery] = useState('');
        const filteredMenuItems = React.useMemo(() => {
            const q = tabQuery.trim().toLowerCase();
            if (!q) return MENU_ITEMS;
            return MENU_ITEMS.filter((m) =>
                [m.label, m.description, m.keywords ?? ''].some((text) => text.toLowerCase().includes(q)),
            );
        }, [tabQuery]);
        const searchIsActive = tabQuery.trim().length > 0;

        // Live state on the menu rows, from what Settings already holds; Voyage
        // Log aside (below), nothing is fetched to paint it (UX scorecard run
        // 7: the rows only described their pages, so every alert being off, or
        // the skipper being signed out, was invisible from here).
        const identity = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope, getAuthIdentityScope);
        const signedIn = Boolean(identity.userId);
        // Voyage Log is the one row whose state Settings does not already hold,
        // and the one that most needs it (it needs sign-in). Signed out, that is
        // known without asking. Signed in, its config is read once each time the
        // menu shows, for this account only; until it first answers, or when a
        // read finds no config or fails, the row shows no state rather than a
        // guess or an older answer (UX scorecard run 8). In Satellite mode the
        // read is skipped (a menu row is not worth a round of cloud calls on a
        // metered link) and the row keeps this session's last answer, if any.
        const satelliteMode = settings?.satelliteMode === true;
        const [voyageLogLive, setVoyageLogLive] = useState<{ generation: number; live: boolean } | null>(null);
        React.useEffect(() => {
            if (!identity.userId || activeTab !== null || satelliteMode) return;
            let cancelled = false;
            void VoyageLogService.getConfig()
                .then((config) => {
                    if (cancelled || !isAuthIdentityScopeCurrent(identity)) return;
                    setVoyageLogLive(
                        config ? { generation: identity.generation, live: config.enabled === true } : null,
                    );
                })
                .catch(() => {
                    if (!cancelled) setVoyageLogLive(null);
                });
            return () => {
                cancelled = true;
            };
        }, [identity, activeTab, satelliteMode]);
        const menuStatus = (id: SettingsTab): string | null => {
            switch (id) {
                case 'general': {
                    // What the home port IS, not a bare place: 'Current Location'
                    // read as a place or a link (UX scorecard run 8). The town the
                    // Glass opens on, without its state: 'Home: Gladstone'. A GPS
                    // fix saved as 'WP -27.2104, 153.0893' keeps both halves;
                    // cutting at the comma left a bare latitude.
                    const home = settings?.defaultLocation?.trim();
                    if (!home) return null;
                    if (home === 'Current Location') return 'Home: follows you';
                    if (/^(WP\s|[-+]?\d)/.test(home)) return `Home: ${home}`;
                    return `Home: ${home.split(',')[0].trim() || home}`;
                }
                case 'vessel': {
                    const name = settings?.vessel?.name?.trim();
                    return name && !isObserver ? name : null;
                }
                case 'alerts': {
                    const alerts = settings?.notifications;
                    if (!alerts) return null;
                    const on = Object.values(alerts).filter((alert) => alert?.enabled).length;
                    return on === 0 ? 'All alerts off' : on === 1 ? '1 alert on' : `${on} alerts on`;
                }
                case 'account':
                    return signedIn ? 'Signed in' : 'Not signed in';
                case 'locations': {
                    const saved = settings?.savedLocations?.length ?? 0;
                    return saved === 0 ? 'None saved' : `${saved} saved`;
                }
                case 'voyageLog':
                    if (!signedIn) return 'Needs sign-in';
                    if (!voyageLogLive || voyageLogLive.generation !== identity.generation) return null;
                    return voyageLogLive.live ? 'Live' : 'Off';
                default:
                    return null;
            }
        };
        const menuIdBase = useId();

        const handleSelectTab = React.useCallback((id: SettingsTab) => {
            setActiveTab(id);
        }, []);

        /** One mobile menu row: icon tile, name with its live state set right
         *  (the iOS Settings pattern, so the row stays ~64 pt), and what the
         *  page holds. The name carries the state ('Open Notifications
         *  settings, All alerts off'): as a description after the name,
         *  VoiceOver never reached it (UX scorecard run 8). The description is
         *  read after. */
        const renderMenuRow = (item: (typeof MENU_ITEMS)[number]) => {
            const status = menuStatus(item.id);
            const descId = `${menuIdBase}-${item.id}-desc`;
            return (
                <button
                    aria-label={`Open ${item.label} settings${status ? `, ${status}` : ''}`}
                    aria-describedby={descId}
                    key={item.id}
                    onClick={() => handleSelectTab(item.id)}
                    className="group w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl bg-white/3 border border-white/5 hover:bg-white/[0.07] hover:border-white/10 transition-all duration-300 active:scale-[0.98] text-left"
                >
                    <div
                        className={`p-2.5 rounded-xl ${item.iconBg} ${item.iconHoverBg} group-hover:scale-110 transition-all duration-300 shadow-lg`}
                    >
                        {item.icon('w-5 h-5')}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                            <p className="shrink-0 text-white font-bold text-sm tracking-wide">{item.label}</p>
                            {/* A long port or boat name ellipsises; the label never does. */}
                            {status && <p className="min-w-0 truncate text-xs font-semibold text-sky-300">{status}</p>}
                        </div>
                        <p id={descId} className="text-gray-300 text-xs mt-0.5">
                            {item.id === 'vessel' && isObserver
                                ? 'Crew member — tap to configure vessel'
                                : item.description}
                        </p>
                    </div>
                    <RowChevron className="w-4 h-4 text-gray-400 group-hover:text-sky-400 transition-colors" />
                </button>
            );
        };

        const handleDetectLocation = () => {
            GpsService.requestCurrentForegroundPosition({ staleLimitMs: 30_000 }).then(async (pos) => {
                if (pos) {
                    const { latitude, longitude } = pos;
                    let resolvedName = `WP ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
                    try {
                        const name = await reverseGeocode(latitude, longitude);
                        if (name) resolvedName = name;
                    } catch (e) {
                        log.warn(' fallback to WP coords:', e);
                    }
                    onSave({ defaultLocation: resolvedName });
                }
            });
        };

        return (
            // The port ends AT the tab bar (its real height, safe area included).
            // pb-24 stopped it ~30 pt short in the captures, so the sub-page
            // scroller cut rows mid-glyph over a band of empty page (UX scorecard run 7).
            <div className="w-full max-w-6xl mx-auto h-full flex flex-col md:flex-row pb-[var(--thalassa-tabbar-height)] relative">
                {/* Ambient Background Glows */}
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
                    <div className="absolute top-10 left-10 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]"></div>
                    <div className="absolute bottom-10 right-10 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]"></div>
                </div>

                {/* --- DESKTOP SIDEBAR (unchanged) --- */}
                <div className="hidden md:flex w-72 border-r border-white/5 p-6 flex-col gap-3 shrink-0 relative z-10 bg-linear-to-b from-transparent via-white/2 to-transparent">
                    {/* The page title, in PageHeader's type: the h1 on a wide
                        screen, where the phone header below is hidden. The gear
                        and the mono sky caption made Settings the one page with
                        its own header look (UX scorecard run 5). */}
                    <div className="mb-6 px-2">
                        <h1 className="ui-page-title text-xl font-extrabold leading-tight text-white uppercase tracking-wider">
                            Settings
                        </h1>
                        <p className="ui-caption text-xs text-gray-300 uppercase tracking-widest">Vessel</p>
                    </div>

                    {/* Tab search — solves "I know what I want to change
                        but not which section it lives in" for the 10-tab
                        Settings surface. Sits between the header and the
                        section list; when active, sections collapse and
                        every matching tab renders flat. */}
                    <div className="relative mb-3 px-2">
                        <svg
                            className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M21 21l-4.34-4.34m0 0A8 8 0 103.32 12.32a8 8 0 0013.34 4.34z"
                            />
                        </svg>
                        <input
                            type="search"
                            value={tabQuery}
                            onChange={(e) => setTabQuery(e.target.value)}
                            placeholder="Search settings…"
                            className="w-full h-9 pl-9 pr-8 rounded-lg bg-white/4 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-hidden focus:border-sky-500/40 focus:bg-white/6 transition-colors"
                            aria-label="Search settings"
                        />
                        {tabQuery && (
                            <button
                                type="button"
                                onClick={() => setTabQuery('')}
                                aria-label="Clear search"
                                className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300"
                            >
                                <svg
                                    className="w-3 h-3"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Desktop sidebar — driven by MENU_ITEMS + SETTINGS_GROUPS.
                        Before 2026-05-17 this was a hardcoded list of 7
                        NavButtons that omitted three of the registered
                        tabs (Voyage Log, etc), so
                        desktop users couldn't reach them. Now the same
                        source-of-truth feeds both desktop and mobile,
                        with section headers.

                        When `searchIsActive`, sections collapse and
                        filtered items render flat — the section labels
                        would be visual noise when the user has already
                        narrowed by text. */}
                    <div className="space-y-0.5">
                        {searchIsActive ? (
                            filteredMenuItems.length === 0 ? (
                                <p className="text-xs text-slate-400 px-2 py-3 leading-relaxed">
                                    No settings match <strong className="text-white/80">"{tabQuery}"</strong>.
                                </p>
                            ) : (
                                filteredMenuItems.map((item) => (
                                    <NavButton
                                        key={item.id}
                                        active={activeTab === item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        icon={item.icon('w-5 h-5')}
                                        label={item.id === 'vessel' && isObserver ? 'Vessel (crew)' : item.label}
                                    />
                                ))
                            )
                        ) : (
                            SETTINGS_GROUPS.map((group) => {
                                const items = MENU_ITEMS.filter((m) => m.group === group.id);
                                if (items.length === 0) return null;
                                const itemsJsx = items.map((item) => (
                                    <NavButton
                                        key={item.id}
                                        active={activeTab === item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        icon={item.icon('w-5 h-5')}
                                        label={item.id === 'vessel' && isObserver ? 'Vessel (crew)' : item.label}
                                    />
                                ));
                                return (
                                    <div key={group.id}>
                                        <SettingsSectionLabel>{group.label}</SettingsSectionLabel>
                                        <div className="space-y-0.5">{itemsJsx}</div>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="mt-auto pt-6 border-t border-white/5">
                        <div
                            className={`rounded-xl p-4 border ${
                                PUBLIC_BETA_ACCESS.enabled
                                    ? 'bg-linear-to-br from-cyan-500/15 to-sky-500/10 border-cyan-300/25'
                                    : hasPaidPlan
                                      ? 'bg-linear-to-br from-sky-500/20 to-purple-500/20 border-sky-500/30'
                                      : 'bg-white/3 border-white/10'
                            }`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <StarIcon
                                    className={`w-4 h-4 ${
                                        PUBLIC_BETA_ACCESS.enabled
                                            ? 'text-cyan-300'
                                            : hasPaidPlan
                                              ? 'text-sky-300'
                                              : 'text-slate-500'
                                    }`}
                                    filled
                                />
                                <span
                                    className={`text-xs font-bold uppercase tracking-wider ${
                                        PUBLIC_BETA_ACCESS.enabled
                                            ? 'text-cyan-100'
                                            : hasPaidPlan
                                              ? 'text-sky-200'
                                              : 'text-slate-300'
                                    }`}
                                >
                                    {PUBLIC_BETA_ACCESS.enabled
                                        ? PUBLIC_BETA_ACCESS.label
                                        : hasPaidPlan
                                          ? 'Thalassa Pro'
                                          : 'Deckhand Plan'}
                                </span>
                            </div>
                            <p
                                className={`text-[12px] ${
                                    PUBLIC_BETA_ACCESS.enabled
                                        ? 'text-cyan-100/70'
                                        : hasPaidPlan
                                          ? 'text-sky-200/70'
                                          : 'text-slate-400'
                                }`}
                            >
                                {PUBLIC_BETA_ACCESS.enabled
                                    ? PUBLIC_BETA_ACCESS.message
                                    : hasPaidPlan
                                      ? 'Your verified subscription is active.'
                                      : 'No paid subscription is active on this account.'}
                            </p>
                        </div>
                    </div>
                </div>

                {/* --- MOBILE: Vertical Menu Screen (shown when no tab selected) --- */}
                {activeTab === null && (
                    // The menu scrolls itself. It used to overflow into the app's
                    // page scroller, which runs under the tab bar, so 'Voyage Log'
                    // sat sliced at the bar's edge. Its own box ends where the root's
                    // padding stops, at the bar, and .thalassa-scroll-fade fades the
                    // last 14px there instead of cutting a row in half.
                    <div className="md:hidden flex-1 min-h-0 flex flex-col">
                        {/* The shared page header (title, grey caption, back), the
                            same chrome as every other page. Back goes where it
                            always went. The caption names where Settings lives, as
                            each sub-page's caption names Settings; 'Control Centre'
                            said nothing (UX scorecard run 7). Pinned above the list
                            with the hairline every sub-page's title bar has; it
                            used to scroll away with no divider (UX scorecard run 8). */}
                        <div className="relative z-20 shrink-0 bg-slate-950/90 border-b border-white/5">
                            <PageHeader title="Settings" subtitle="Vessel" onBack={onBack} />
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain thalassa-scroll-fade">
                            {/* Mobile menu — same grouping as the desktop
                            sidebar (single source of truth in MENU_ITEMS
                            + SETTINGS_GROUPS).
                            When search is active, sections collapse and
                            matching tabs render flat (same pattern as the
                            desktop sidebar).
                            pb-20 clears the floating now-playing bar (56px,
                            parked 4px above the tab bar), as the tab scroller
                            below does. */}
                            <div className="px-4 pt-4 pb-20 space-y-3">
                                {/* Search input — same component shape as desktop,
                                slightly taller (h-11 for thumb-friendly tap). */}
                                <div className="relative">
                                    <svg
                                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                        aria-hidden="true"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M21 21l-4.34-4.34m0 0A8 8 0 103.32 12.32a8 8 0 0013.34 4.34z"
                                        />
                                    </svg>
                                    <input
                                        type="search"
                                        value={tabQuery}
                                        onChange={(e) => setTabQuery(e.target.value)}
                                        placeholder="Search settings…"
                                        className="w-full h-11 pl-9 pr-9 rounded-xl bg-white/4 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-hidden focus:border-sky-500/40 focus:bg-white/6 transition-colors"
                                        aria-label="Search settings"
                                    />
                                    {tabQuery && (
                                        <button
                                            type="button"
                                            onClick={() => setTabQuery('')}
                                            aria-label="Clear search"
                                            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 min-w-[44px] min-h-[44px] rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300"
                                        >
                                            <svg
                                                className="w-3.5 h-3.5"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M6 18L18 6M6 6l12 12"
                                                />
                                            </svg>
                                        </button>
                                    )}
                                </div>

                                {searchIsActive && filteredMenuItems.length === 0 && (
                                    <p className="text-sm text-slate-400 px-2 py-4 leading-relaxed">
                                        No settings match <strong className="text-white/80">"{tabQuery}"</strong>.
                                    </p>
                                )}
                                {searchIsActive && filteredMenuItems.map(renderMenuRow)}
                                {/* Rows are ~64 pt (a 40 pt icon tile in 12 pt padding), not
                                80: at 80 the sixth row, Voyage Log, sat wholly below the
                                fold at 393 pt, so Account & Sharing read as a one-row
                                section (UX scorecard run 6). */}
                                {!searchIsActive &&
                                    SETTINGS_GROUPS.map((group) => {
                                        const items = MENU_ITEMS.filter((m) => m.group === group.id);
                                        if (items.length === 0) return null;
                                        return (
                                            <div key={group.id} className="space-y-2">
                                                <SettingsSectionLabel>{group.label}</SettingsSectionLabel>
                                                {items.map(renderMenuRow)}
                                            </div>
                                        );
                                    })}
                            </div>
                        </div>
                    </div>
                )}

                <div
                    className={`flex-1 flex flex-col h-full bg-transparent overflow-hidden ${activeTab === null ? 'hidden md:flex' : ''}`}
                >
                    {/* Mobile: the shared page header for a nested page — back,
                        section title, and 'Settings' as its caption. The trail
                        used to be a row of its own above the title, which only
                        repeated the title and cost ~24 pt of a header stack
                        already ~182 pt tall; the caption carries the same
                        'where am I' in the title row, and the chevron still
                        returns to the settings menu (UX scorecard run 6). */}
                    {activeTab !== null && (
                        <div className="md:hidden relative z-20 shrink-0 bg-slate-950/90 border-b border-white/5">
                            <PageHeader
                                title={MENU_ITEMS.find((m) => m.id === activeTab)?.label || 'Settings'}
                                subtitle="Settings"
                                onBack={() => setActiveTab(null)}
                                backLabel="Back to Settings"
                            />
                        </div>
                    )}
                    {/* pb-20, not pb-48: 192px left ~250pt of empty page under the
                        last section. 80px still clears the floating now-playing bar
                        (56px, parked 4px above the tab bar) so the last row can
                        scroll out from under it.

                        No .thalassa-scroll-fade here, unlike the menu: this scroller
                        holds position:fixed overlays of its own (Vessel's fleet sync
                        bar and saved line, Preferences' 'Share what you hear' consent
                        sheet), and a mask would fade and clip them to this box. The
                        fade is a painted sibling instead (below), and the port ends at
                        the tab bar's top edge.

                        Vessel Profile adds its own reserve while its fleet sync bar is
                        showing (only VesselTab knows when it is).

                        Keyed on the tab so every sub-page opens at its top: one
                        shared scroller used to carry the last page's offset, so
                        Account opened past its sign-in card (UX scorecard run 6). */}
                    <div className="relative flex-1 min-h-0 flex flex-col">
                        <div
                            key={activeTab ?? 'menu'}
                            className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 md:p-10 pb-20"
                        >
                            {activeTab === 'locations' && (
                                <LocationsTab settings={settings} onSave={onSave} onLocationSelect={onLocationSelect} />
                            )}

                            {activeTab === 'account' && (
                                <AccountTab
                                    settings={settings}
                                    onSave={onSave}
                                    onSignInOpened={() => armSignInReturn('account')}
                                    onSignInClosed={disarmSignInReturn}
                                    onOpenPreferences={() => handleSelectTab('general')}
                                />
                            )}

                            {activeTab === 'general' && (
                                <GeneralTab
                                    settings={settings}
                                    onSave={onSave}
                                    onLocationSelect={onLocationSelect}
                                    onDetectLocation={handleDetectLocation}
                                    onShowFactoryReset={() => setShowFactoryReset(true)}
                                />
                            )}

                            {activeTab === 'vessel' && <VesselTab settings={settings} onSave={onSave} />}

                            {activeTab === 'alerts' && <AlertsTab settings={settings} onSave={onSave} />}

                            {activeTab === 'voyageLog' && (
                                <VoyageLogTab
                                    settings={settings}
                                    onSave={onSave}
                                    onSignInOpened={() => armSignInReturn('voyageLog')}
                                    onSignInClosed={disarmSignInReturn}
                                />
                            )}
                        </div>
                        {/* A row leaving the port fades into the page instead of being
                            cut mid-glyph with no cue that the list goes on (UX
                            scorecard run 7). Painted over the port's last 24px, not
                            a mask, so the fixed overlays above keep their edges; the
                            80px bottom padding lets the last row scroll clear of it. */}
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-b from-transparent to-slate-950 [.display-light_&]:to-slate-200"
                        />
                    </div>
                </div>

                {/* Factory Reset confirmation dialog. It names what goes: the
                    reset writes the default settings over the vessel profile,
                    saved ports and alert thresholds too, not only preferences
                    (UX scorecard run 8). */}
                <ConfirmDialog
                    isOpen={showFactoryReset}
                    title="Factory reset"
                    message="Resets your vessel profile (MMSI, EPIRB, crew), saved ports, alert thresholds and preferences on this phone. Signed in, anything saved to your account syncs back; signed out, this can’t be undone."
                    confirmLabel="Reset everything"
                    cancelLabel="Cancel"
                    destructive
                    onConfirm={() => {
                        setShowFactoryReset(false);
                        resetSettings();
                    }}
                    onCancel={() => setShowFactoryReset(false)}
                />
            </div>
        );
    },
);
