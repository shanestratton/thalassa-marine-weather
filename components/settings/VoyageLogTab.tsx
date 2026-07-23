/**
 * Voyage Log — Settings tab.
 *
 * Manages the punter's public Voyage Log: the master on/off switch, their
 * public page URL, and the publishable API key + raw endpoint for anyone
 * who wants to build their own front-end against the voyage-log API.
 *
 * Diary entries are published one-by-one via the modal that appears after
 * saving an entry — this tab is the account-level control surface.
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Browser } from '@capacitor/browser';
import {
    VoyageLogService,
    voyageLogApiUrl,
    voyageLogPublicUrl,
    type VoyageLogConfig,
} from '../../services/VoyageLogService';
import { supabase } from '../../services/supabase';
import { toast } from '../Toast';
import { triggerHaptic } from '../../utils/system';
import { Row, Section, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { ShipLogService } from '../../services/ShipLogService';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import { fetchRoutesAndTracks, type RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { safeExternalHttpUrl } from '../../utils/safeUrl';

// Crew-on-someone-else's-boat surface: each entry represents a boat the
// current user is crew on (NOT the owner), plus their personal voyage-log
// config on that boat if one exists.
interface CrewBoatLog {
    boatId: string;
    boatName: string;
    firstName: string | null;
    config: { handle: string; enabled: boolean } | null;
}

const slugify = (s: string) =>
    s
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

const publicUrlForHandle = (handle: string) => `https://${handle}.thalassawx.app`;

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

export const VoyageLogTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);
    /**
     * Data is rendered only when it was reset/loaded for this exact generation.
     * The render immediately following A → B therefore shows a blank skeleton,
     * before effects have a chance to run, rather than flashing A's API key.
     */
    const [dataGeneration, setDataGeneration] = useState(identityScope.generation);
    const [config, setConfig] = useState<VoyageLogConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [keyRevealed, setKeyRevealed] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const [crewBoats, setCrewBoats] = useState<CrewBoatLog[]>([]);
    const [crewBusyBoatId, setCrewBusyBoatId] = useState<string | null>(null);
    const [setupError, setSetupError] = useState<string | null>(null);
    // Public-tracks management: every uploaded voyage + which are hidden
    // from the public page (voyage_log_hidden_voyages exclusion list).
    const [publicTracks, setPublicTracks] = useState<VoyageSummary[]>([]);
    const [hiddenVoyageIds, setHiddenVoyageIds] = useState<Set<string>>(new Set());
    const [trackBusyId, setTrackBusyId] = useState<string | null>(null);
    // Voyage ↔ passage-plan links (drives the page's dynamic destination).
    const [planRoutes, setPlanRoutes] = useState<RouteOrTrack[]>([]);
    const [planLinks, setPlanLinks] = useState<Map<string, string>>(new Map());
    const [linkPickerFor, setLinkPickerFor] = useState<string | null>(null);

    // Ref for the hero URL element — used by the auto-fit effect below
    // to grow/shrink the font so the whole link fits on one line. Must
    // live above the early-returns so hooks order is stable.
    const urlRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(true);
    const copyTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    const operationEpochRef = useRef(0);
    const planLinksRef = useRef<Map<string, string>>(new Map());

    const clearCopyTimers = useCallback(() => {
        for (const timer of copyTimersRef.current) clearTimeout(timer);
        copyTimersRef.current.clear();
    }, []);

    const operationIsCurrent = useCallback(
        (scope: AuthIdentityScope): boolean => mountedRef.current && isAuthIdentityScopeCurrent(scope),
        [],
    );

    const loadCrewBoats = useCallback(async (scope: AuthIdentityScope): Promise<CrewBoatLog[] | null> => {
        if (!supabase || !isAuthIdentityScopeCurrent(scope) || !scope.userId) return [];
        try {
            const { data: authData } = await supabase.auth.getUser();
            const myId = authData.user?.id;
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (!myId || myId !== scope.userId) return [];

            // Boats I'm a member of where I'm not the owner.
            const { data: memberships, error: membershipError } = await supabase
                .from('boat_members')
                .select('boat_id, first_name, boats!inner(id, name, owner_id)')
                .eq('user_id', myId);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (membershipError) return [];

            const crewRows = (memberships ?? []).filter((m: unknown) => {
                const row = m as { boat_id?: unknown; boats?: { owner_id?: unknown; name?: unknown } };
                return (
                    typeof row.boat_id === 'string' &&
                    typeof row.boats?.name === 'string' &&
                    row.boats.owner_id !== myId
                );
            });
            if (crewRows.length === 0) return [];

            // My personal voyage-log configs across those boats.
            const boatIds = crewRows.map((r: unknown) => (r as { boat_id: string }).boat_id);
            const { data: configs, error: configError } = await supabase
                .from('voyage_log_configs')
                .select('boat_id, handle, enabled')
                .eq('owner_id', myId)
                .eq('scope', 'personal')
                .in('boat_id', boatIds);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (configError) return [];
            const byBoat = new Map(
                (configs ?? [])
                    .filter((c: unknown) => {
                        const row = c as { boat_id?: unknown; handle?: unknown; enabled?: unknown };
                        return (
                            typeof row.boat_id === 'string' &&
                            boatIds.includes(row.boat_id) &&
                            typeof row.handle === 'string' &&
                            typeof row.enabled === 'boolean'
                        );
                    })
                    .map((c: unknown) => [
                        (c as { boat_id: string }).boat_id,
                        c as { handle: string; enabled: boolean },
                    ]),
            );

            return crewRows.map((m: unknown) => {
                const row = m as { boat_id: string; first_name: string | null; boats: { name: string } };
                return {
                    boatId: row.boat_id,
                    boatName: row.boats.name,
                    firstName: row.first_name,
                    config: byBoat.get(row.boat_id) ?? null,
                };
            });
        } catch {
            return isAuthIdentityScopeCurrent(scope) ? [] : null;
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            clearCopyTimers();
        };
    }, [clearCopyTimers]);

    useEffect(() => {
        const scope = identityScope;
        let cancelled = false;
        operationEpochRef.current += 1;
        clearCopyTimers();

        // Clear every private/transient field for the new identity.
        setDataGeneration(scope.generation);
        setConfig(null);
        setLoading(true);
        setBusy(false);
        setKeyRevealed(false);
        setCopiedField(null);
        setCrewBoats([]);
        setCrewBusyBoatId(null);
        setSetupError(null);
        setPublicTracks([]);
        setHiddenVoyageIds(new Set());
        setTrackBusyId(null);
        setPlanRoutes([]);
        setPlanLinks(new Map());
        setLinkPickerFor(null);
        planLinksRef.current = new Map();

        void Promise.all([VoyageLogService.getConfig(), loadCrewBoats(scope)])
            .then(([nextConfig, nextCrewBoats]) => {
                if (cancelled || !operationIsCurrent(scope) || nextCrewBoats === null) return;
                setConfig(nextConfig);
                setCrewBoats(nextCrewBoats);
            })
            .catch(() => {
                // A blank current-account surface is safer than retaining data
                // from an earlier identity after an unexpected loader throw.
            })
            .finally(() => {
                if (!cancelled && operationIsCurrent(scope)) {
                    setLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [clearCopyTimers, identityScope, loadCrewBoats, operationIsCurrent]);

    // Load the public-tracks list once the log is confirmed enabled. Server
    // summaries only — those are exactly the voyages the public page can draw.
    useEffect(() => {
        const scope = identityScope;
        if (dataGeneration !== scope.generation) return;
        if (!config?.enabled) {
            setPublicTracks([]);
            setHiddenVoyageIds(new Set());
            setPlanLinks(new Map());
            setPlanRoutes([]);
            setLinkPickerFor(null);
            return;
        }

        let cancelled = false;
        void Promise.all([
            ShipLogService.getVoyageSummaries(),
            VoyageLogService.getHiddenVoyageIds(),
            VoyageLogService.getPlanLinks(),
            fetchRoutesAndTracks(true).catch(() => ({
                routes: [] as RouteOrTrack[],
                tracks: [] as RouteOrTrack[],
            })),
        ])
            .then(([summaries, hidden, links, routesAndTracks]) => {
                if (cancelled || !operationIsCurrent(scope)) return;
                const sorted = [...summaries].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 50);
                const ownedVoyageIds = new Set(summaries.map((summary) => summary.voyageId));
                setPublicTracks(sorted);
                setHiddenVoyageIds(hidden);
                setPlanLinks(links);
                // RoutesAndTracks has a process cache. Filter against this
                // identity's server summaries so an A cache cannot enter B.
                setPlanRoutes(
                    routesAndTracks.routes
                        .filter((route) => !route.isLocal && ownedVoyageIds.has(route.id))
                        .sort((a, b) => b.timestamp - a.timestamp)
                        .slice(0, 10),
                );
            })
            .catch(() => {
                if (!cancelled && operationIsCurrent(scope)) {
                    setPublicTracks([]);
                    setHiddenVoyageIds(new Set());
                    setPlanLinks(new Map());
                    setPlanRoutes([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [config?.enabled, config?.id, dataGeneration, identityScope, operationIsCurrent]);

    const handleTrackVisibility = useCallback(
        async (voyageId: string, hidden: boolean) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            const immutableVoyageId = String(voyageId);
            if (!operationIsCurrent(scope)) return;

            setTrackBusyId(immutableVoyageId);
            triggerHaptic('light');
            // Optimistic — revert only while the same identity still owns it.
            setHiddenVoyageIds((prev) => {
                const next = new Set(prev);
                if (hidden) next.add(immutableVoyageId);
                else next.delete(immutableVoyageId);
                return next;
            });
            const ok = await VoyageLogService.setVoyageHidden(immutableVoyageId, hidden);
            if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
            if (!ok) {
                setHiddenVoyageIds((prev) => {
                    const next = new Set(prev);
                    if (hidden) next.delete(immutableVoyageId);
                    else next.add(immutableVoyageId);
                    return next;
                });
                toast.error(VoyageLogService.lastError ?? 'Could not update — check signal');
            }
            setTrackBusyId(null);
        },
        [identityScope, operationIsCurrent],
    );

    const handlePlanLink = useCallback(
        async (voyageId: string, planId: string | null) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            const immutableVoyageId = String(voyageId);
            const immutablePlanId = planId === null ? null : String(planId);
            if (!operationIsCurrent(scope)) return;

            setLinkPickerFor(null);
            triggerHaptic('light');
            const prev = planLinksRef.current.get(immutableVoyageId) ?? null;
            setPlanLinks((current) => {
                const next = new Map(current);
                if (immutablePlanId) next.set(immutableVoyageId, immutablePlanId);
                else next.delete(immutableVoyageId);
                return next;
            });
            const ok = await VoyageLogService.setVoyagePlanLink(immutableVoyageId, immutablePlanId);
            if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
            if (!ok) {
                setPlanLinks((current) => {
                    const next = new Map(current);
                    if (prev) next.set(immutableVoyageId, prev);
                    else next.delete(immutableVoyageId);
                    return next;
                });
                toast.error(VoyageLogService.lastError ?? 'Could not update the link — check signal');
            }
        },
        [identityScope, operationIsCurrent],
    );
    // Ref mirror so handlePlanLink's revert reads the latest map without
    // re-creating the callback per change.
    planLinksRef.current = planLinks;

    // Auto-fit the public URL hero text to its container — start at
    // 22px and shrink one px at a time until the whole link fits on
    // one line. Re-runs whenever the handle changes OR the container
    // resizes (rotation, settings sheet resize, etc.). Long handles
    // get smaller, short ones stay big.
    useEffect(() => {
        const el = urlRef.current;
        const parent = el?.parentElement;
        if (!el || !parent) return;
        const fit = () => {
            const max = parent.clientWidth;
            let size = 22;
            el.style.fontSize = `${size}px`;
            while (el.scrollWidth > max && size > 9) {
                size -= 1;
                el.style.fontSize = `${size}px`;
            }
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(parent);
        return () => ro.disconnect();
    }, [config?.handle]);

    const copy = useCallback(
        async (field: string, value: string) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            const immutableField = String(field);
            const immutableValue = String(value);
            if (!operationIsCurrent(scope)) return;
            try {
                await navigator.clipboard.writeText(immutableValue);
                if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
                clearCopyTimers();
                setCopiedField(immutableField);
                triggerHaptic('light');
                const timer = setTimeout(() => {
                    copyTimersRef.current.delete(timer);
                    if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
                    setCopiedField((current) => (current === immutableField ? null : current));
                }, 2000);
                copyTimersRef.current.add(timer);
            } catch {
                /* clipboard unavailable — value is still visible to copy by hand */
            }
        },
        [clearCopyTimers, identityScope, operationIsCurrent],
    );

    const handleSetUp = useCallback(async () => {
        const scope = identityScope;
        const epoch = operationEpochRef.current;
        if (!operationIsCurrent(scope)) return;

        setBusy(true);
        setSetupError(null);
        const nextConfig = await VoyageLogService.ensureEnabled();
        if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
        setConfig(nextConfig);
        if (!nextConfig) {
            // Surface the actual reason — RLS, missing table, no auth, etc.
            // Without this the button just flashes and the punter has no
            // idea what went wrong.
            setSetupError(VoyageLogService.lastError ?? 'Setup failed for an unknown reason.');
        }
        setBusy(false);
        triggerHaptic('medium');
    }, [identityScope, operationIsCurrent]);

    const handleToggle = useCallback(
        async (next: boolean) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            if (!operationIsCurrent(scope)) return;

            setBusy(true);
            const nextConfig = await VoyageLogService.setEnabled(next);
            if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
            if (nextConfig) setConfig(nextConfig);
            setBusy(false);
            triggerHaptic('light');
        },
        [identityScope, operationIsCurrent],
    );

    // Create a personal voyage-log for a boat I'm crew on. Picks a sensible
    // default handle (<first>-on-<boat-slug>) and auto-suffixes on collision.
    const handleCreateCrewLog = useCallback(
        async (boat: CrewBoatLog) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            if (!supabase || !scope.userId || !operationIsCurrent(scope)) return;

            const immutableBoat = {
                boatId: String(boat.boatId),
                boatName: String(boat.boatName),
                firstName: boat.firstName === null ? null : String(boat.firstName),
            };
            setCrewBusyBoatId(immutableBoat.boatId);
            const { data: authData } = await supabase.auth.getUser();
            const myId = authData.user?.id;
            if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch || !myId || myId !== scope.userId) {
                if (operationIsCurrent(scope)) setCrewBusyBoatId(null);
                return;
            }
            const base = slugify(`${immutableBoat.firstName ?? 'crew'}-on-${immutableBoat.boatName}`);
            if (!base) {
                toast.error('Could not make a handle from this crew and boat name.');
                setCrewBusyBoatId(null);
                return;
            }
            let candidate = base;
            let attempt = 1;
            while (attempt < 20) {
                if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
                const { error } = await supabase.from('voyage_log_configs').insert({
                    owner_id: myId,
                    boat_id: immutableBoat.boatId,
                    handle: candidate,
                    scope: 'personal',
                    enabled: true,
                });
                if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
                if (!error) {
                    triggerHaptic('medium');
                    toast.success(`Live at ${candidate}.thalassawx.app`);
                    const nextCrewBoats = await loadCrewBoats(scope);
                    if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch || nextCrewBoats === null) {
                        return;
                    }
                    setCrewBoats(nextCrewBoats);
                    setCrewBusyBoatId(null);
                    return;
                }
                if (error.code !== '23505') {
                    toast.error('Could not create personal log.');
                    setCrewBusyBoatId(null);
                    return;
                }
                attempt += 1;
                candidate = `${base}-${attempt}`;
            }
            toast.error('Could not pick a unique handle — edit your name in Crew Management and retry.');
            setCrewBusyBoatId(null);
        },
        [identityScope, loadCrewBoats, operationIsCurrent],
    );

    const handleToggleCrewLog = useCallback(
        async (boat: CrewBoatLog, next: boolean) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            if (!supabase || !boat.config || !scope.userId || !operationIsCurrent(scope)) return;
            const immutableBoatId = String(boat.boatId);

            setCrewBusyBoatId(immutableBoatId);
            const { data: authData } = await supabase.auth.getUser();
            const myId = authData.user?.id;
            if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch || !myId || myId !== scope.userId) {
                if (operationIsCurrent(scope)) setCrewBusyBoatId(null);
                return;
            }
            const { error } = await supabase
                .from('voyage_log_configs')
                .update({ enabled: next })
                .eq('owner_id', myId)
                .eq('boat_id', immutableBoatId)
                .eq('scope', 'personal');
            if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
            if (error) {
                toast.error('Could not toggle.');
            } else {
                const nextCrewBoats = await loadCrewBoats(scope);
                if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch || nextCrewBoats === null) {
                    return;
                }
                setCrewBoats(nextCrewBoats);
                triggerHaptic('light');
            }
            setCrewBusyBoatId(null);
        },
        [identityScope, loadCrewBoats, operationIsCurrent],
    );

    const handleLiveTrackShare = useCallback(
        (next: boolean) => {
            const scope = identityScope;
            const epoch = operationEpochRef.current;
            if (!operationIsCurrent(scope)) return;

            triggerHaptic('light');
            onSave({ liveTrackShare: next });
            void import('../../services/shiplog/LiveTrickle')
                .then(async ({ purgeLiveTrack, markLiveTrickleFreshStart }) => {
                    if (!operationIsCurrent(scope) || operationEpochRef.current !== epoch) return;
                    if (next) {
                        // Forward-only consent: never publish the pre-toggle
                        // backlog in the queue.
                        await markLiveTrickleFreshStart();
                    } else {
                        // Opt-out is immediate for the captured account only.
                        const ok = await purgeLiveTrack();
                        if (operationIsCurrent(scope) && operationEpochRef.current === epoch && !ok) {
                            toast.error('Could not clear shared positions — check signal');
                        }
                    }
                })
                .catch(() => {
                    if (operationIsCurrent(scope) && operationEpochRef.current === epoch) {
                        toast.error('Could not update live-track sharing — check signal');
                    }
                });
        },
        [identityScope, onSave, operationIsCurrent],
    );

    const openPrivateUrl = useCallback(
        (url: string) => {
            if (!operationIsCurrent(identityScope)) return;
            const safeUrl = safeExternalHttpUrl(url, true);
            if (!safeUrl) {
                toast.error('Could not open an invalid voyage-log URL');
                return;
            }
            void Browser.open({ url: safeUrl });
        },
        [identityScope, operationIsCurrent],
    );

    const toggleKeyReveal = useCallback(() => {
        if (!operationIsCurrent(identityScope)) return;
        setKeyRevealed((revealed) => !revealed);
    }, [identityScope, operationIsCurrent]);

    const toggleLinkPicker = useCallback(
        (voyageId: string) => {
            if (!operationIsCurrent(identityScope)) return;
            const immutableVoyageId = String(voyageId);
            setLinkPickerFor((current) => (current === immutableVoyageId ? null : immutableVoyageId));
        },
        [identityScope, operationIsCurrent],
    );

    if (loading || dataGeneration !== identityScope.generation) {
        return (
            <div className="px-4 pb-8">
                <div className="h-24 rounded-2xl bg-white/[0.03] border border-white/[0.06] animate-pulse" />
            </div>
        );
    }

    // Per-boat crew section, re-used in both the no-own-config and have-own-
    // config branches below.
    const renderCrewSection = () =>
        crewBoats.length === 0 ? null : (
            <Section title="Boats you're crew on">
                {crewBoats.map((boat) => {
                    const handle = boat.config?.handle;
                    const isBusy = crewBusyBoatId === boat.boatId;
                    return (
                        <React.Fragment key={boat.boatId}>
                            <Row>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm text-white font-bold truncate">{boat.boatName}</div>
                                    <div className="text-xs text-gray-400 mt-1">
                                        {handle
                                            ? boat.config?.enabled
                                                ? 'Your personal page on this boat is live.'
                                                : 'Your personal page on this boat is switched off.'
                                            : 'You can publish your own log on this boat. Diary entries you mark public will appear on the combined log too, with your byline.'}
                                    </div>
                                </div>
                                {handle ? (
                                    <Toggle
                                        checked={!!boat.config?.enabled}
                                        onChange={(v) => void handleToggleCrewLog(boat, v)}
                                        label={`Toggle personal log for ${boat.boatName}`}
                                    />
                                ) : (
                                    <button
                                        onClick={() => void handleCreateCrewLog(boat)}
                                        disabled={isBusy}
                                        aria-label={`Create personal voyage log on ${boat.boatName}`}
                                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider disabled:opacity-50"
                                    >
                                        {isBusy ? 'Creating…' : 'Create page'}
                                    </button>
                                )}
                            </Row>
                            {handle && (
                                <Row>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs text-gray-500">Share link</div>
                                        <div className="text-xs font-mono text-sky-300 mt-1 truncate">
                                            {publicUrlForHandle(handle)}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => void copy(`crew-${boat.boatId}`, publicUrlForHandle(handle))}
                                        aria-label="Copy crew log share link"
                                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                                    >
                                        {copiedField === `crew-${boat.boatId}` ? 'Copied' : 'Copy'}
                                    </button>
                                </Row>
                            )}
                        </React.Fragment>
                    );
                })}
            </Section>
        );

    // ── Not set up yet ─────────────────────────────────────────────
    if (!config) {
        return (
            <div className="px-4 pb-8">
                <p className="text-sm text-gray-400 mb-6">
                    Your Voyage Log is a public page where the folks at home can follow your passage — your published
                    diary entries, your track on a map, and your latest position and barometer reading.
                </p>
                {renderCrewSection()}
                <Section title="Get started">
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white font-bold">Set up your own Voyage Log</div>
                            <div className="text-xs text-gray-400 mt-1">
                                Creates your public page and a shareable link. Nothing goes public until you publish an
                                entry — your diary stays private by default.
                            </div>
                        </div>
                        <button
                            onClick={() => void handleSetUp()}
                            disabled={busy}
                            aria-label="Set up your voyage log"
                            className="shrink-0 text-sm font-bold text-sky-400 hover:text-sky-300 px-3 py-1.5 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors disabled:opacity-50"
                        >
                            {busy ? 'Setting up…' : 'Set up'}
                        </button>
                    </Row>
                </Section>
                {setupError && (
                    <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                        <div className="text-[10px] font-black text-red-300 uppercase tracking-[0.2em] mb-2">
                            Setup failed
                        </div>
                        <div className="text-xs text-red-100 leading-relaxed font-mono break-words">{setupError}</div>
                        <div className="text-[11px] text-red-200/70 mt-2">
                            Screenshot this and send to Shane — it&apos;s the actual reason the database refused the
                            write.
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ── Set up — full control surface ──────────────────────────────
    const publicUrl = voyageLogPublicUrl(config.handle, config.api_key);
    const apiUrl = voyageLogApiUrl(config.handle, config.api_key);
    const maskedKey = `${config.api_key.slice(0, 6)}${'•'.repeat(18)}`;

    return (
        <div className="px-4 pb-8">
            {/* Hero — the punter's main "your log is live, here's the URL"
                takeaway. Reads at a glance, big-tap copy + open buttons. */}
            <div className="mb-5 rounded-2xl border border-sky-500/25 bg-gradient-to-br from-sky-500/10 to-cyan-500/[0.04] p-4">
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-xl">🌐</span>
                    <span className="text-[10px] font-black text-sky-300/80 uppercase tracking-[0.2em]">
                        Your Voyage Log is live
                    </span>
                </div>
                <div
                    ref={urlRef}
                    className="font-mono font-bold text-white whitespace-nowrap overflow-hidden"
                    title={publicUrl}
                >
                    {publicUrl}
                </div>
                <div className="flex gap-2 mt-3">
                    <button
                        onClick={() => openPrivateUrl(publicUrl)}
                        aria-label="Open your voyage log in browser"
                        className="flex-1 text-xs font-bold text-white bg-sky-600 hover:bg-sky-500 active:scale-95 transition-all px-3 py-2 rounded-lg uppercase tracking-wider"
                    >
                        Open
                    </button>
                    <button
                        onClick={() => void copy('url', publicUrl)}
                        aria-label="Copy your voyage log share link"
                        className="flex-1 text-xs font-bold text-sky-300 border border-sky-400/40 hover:bg-sky-500/10 active:scale-95 transition-all px-3 py-2 rounded-lg uppercase tracking-wider"
                    >
                        {copiedField === 'url' ? 'Copied!' : 'Copy link'}
                    </button>
                </div>
            </div>

            {/* What to do next — surface the not-obvious bits. The biggest
                "wait, why don't I see my entries on the page?" moment for
                new users is realising publish is opt-in per entry, so it
                gets billing here. */}
            <div className="mb-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="text-[10px] font-black text-gray-300 uppercase tracking-[0.2em] mb-3">
                    What to do next
                </div>
                <ol className="space-y-2.5 text-xs text-gray-300 leading-relaxed list-none">
                    <li className="flex gap-3">
                        <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-300 text-[10px] font-bold flex items-center justify-center">
                            1
                        </span>
                        <span>
                            <strong className="text-white">Share the link</strong> above with the folks following along
                            at home — they don&apos;t need an account or the app, just the URL.
                        </span>
                    </li>
                    <li className="flex gap-3">
                        <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-300 text-[10px] font-bold flex items-center justify-center">
                            2
                        </span>
                        <span>
                            <strong className="text-white">Write a diary entry</strong> and tap{' '}
                            <strong className="text-sky-300">Publish to Voyage Log</strong> in the prompt that appears
                            after you save. Entries default to private — only the ones you publish appear on the public
                            page.
                        </span>
                    </li>
                    <li className="flex gap-3">
                        <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-300 text-[10px] font-bold flex items-center justify-center">
                            3
                        </span>
                        <span>
                            <strong className="text-white">Track and telemetry sync automatically</strong> while
                            you&apos;re sailing — position, speed, wind, barometer all show up on the public page in
                            real time. No action needed.
                        </span>
                    </li>
                </ol>
            </div>

            <Section title="Voyage Log">
                <Row>
                    <div className="flex-1">
                        <div className="text-sm text-white font-bold">Public Voyage Log</div>
                        <div className="text-xs text-gray-400 mt-1">
                            {config.enabled
                                ? 'Your log is live. Published entries, track, and telemetry are publicly readable.'
                                : 'Your log is switched off. The public page and API return nothing until you turn it back on.'}
                        </div>
                    </div>
                    <Toggle
                        checked={config.enabled}
                        onChange={(v) => void handleToggle(v)}
                        label="Public voyage log on/off"
                    />
                </Row>
                {config.enabled && (
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white font-bold">Show my current track</div>
                            <div className="text-xs text-gray-400 mt-1">
                                Draw your voyage on the public page as it happens — the track grows every couple of
                                minutes while you sail (when there&apos;s signal; gaps fill in as coverage returns).
                                Off, and nothing appears until you end the track and it uploads.
                            </div>
                        </div>
                        <Toggle
                            checked={settings.liveTrackShare === true}
                            onChange={handleLiveTrackShare}
                            label="Show my current track on/off"
                        />
                    </Row>
                )}
            </Section>

            <Section title="Your public page">
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-500">
                            Vessel handle: <span className="text-gray-300 font-mono">{config.handle}</span> — derived
                            from your vessel name. The URL above uses this as the subdomain.
                        </div>
                    </div>
                </Row>
            </Section>

            {config.enabled && publicTracks.length > 0 && (
                <Section title="Public tracks">
                    <Row>
                        <div className="flex-1">
                            <div className="text-xs text-gray-400">
                                Choose which voyages draw on your public page. Hiding a track only affects the page —
                                your own log keeps it. Use the Log page&apos;s bin to actually delete a voyage.
                            </div>
                        </div>
                    </Row>
                    {publicTracks.map((v) => {
                        const hidden = hiddenVoyageIds.has(v.voyageId);
                        const started = new Date(v.startedAt);
                        const label = started.toLocaleDateString('en-AU', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                        });
                        const kind = v.isPlannedRoute ? ' · planned route' : v.isImported ? ' · imported' : '';
                        const linkedPlanId = planLinks.get(v.voyageId) ?? null;
                        const linkedPlan = linkedPlanId ? planRoutes.find((r) => r.id === linkedPlanId) : null;
                        const canLink = !v.isPlannedRoute && !v.isImported && planRoutes.length > 0;
                        return (
                            <React.Fragment key={v.voyageId}>
                                <Row>
                                    <div className="flex-1 min-w-0">
                                        <div className={`text-sm font-bold ${hidden ? 'text-gray-500' : 'text-white'}`}>
                                            {label}
                                        </div>
                                        <div className="text-xs text-gray-400 mt-0.5">
                                            {v.totalDistanceNM.toFixed(1)} NM · {v.entryCount.toLocaleString()} points
                                            {kind}
                                            {hidden ? ' · hidden from page' : ''}
                                        </div>
                                        {canLink && (
                                            <button
                                                onClick={() => toggleLinkPicker(v.voyageId)}
                                                className="text-xs text-sky-400 mt-1 text-left"
                                            >
                                                Passage: {linkedPlan?.label ?? (linkedPlanId ? 'linked plan' : 'none')}{' '}
                                                ▸
                                            </button>
                                        )}
                                    </div>
                                    <Toggle
                                        checked={!hidden}
                                        onChange={(show) => {
                                            if (trackBusyId) return;
                                            void handleTrackVisibility(v.voyageId, !show);
                                        }}
                                        label={`Show voyage ${label} on public page`}
                                    />
                                </Row>
                                {linkPickerFor === v.voyageId && (
                                    <Row>
                                        <div className="flex-1 flex flex-col gap-1">
                                            {planRoutes.map((r) => (
                                                <button
                                                    key={r.id}
                                                    onClick={() => void handlePlanLink(v.voyageId, r.id)}
                                                    className={`text-left text-xs py-1.5 px-2 rounded-lg ${
                                                        linkedPlanId === r.id
                                                            ? 'bg-sky-500/20 text-sky-300'
                                                            : 'bg-white/5 text-gray-300'
                                                    }`}
                                                >
                                                    {r.label}
                                                    <span className="text-gray-500"> · {r.sublabel}</span>
                                                </button>
                                            ))}
                                            <button
                                                onClick={() => void handlePlanLink(v.voyageId, null)}
                                                className="text-left text-xs py-1.5 px-2 rounded-lg bg-white/5 text-gray-400"
                                            >
                                                No linked passage
                                            </button>
                                        </div>
                                    </Row>
                                )}
                            </React.Fragment>
                        );
                    })}
                </Section>
            )}

            <Section title="API access">
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-400">
                            Building your own front-end? The voyage-log API serves your published log as JSON. The key
                            below is a publishable token — it's safe to ship in a public page, and you can rotate it by
                            turning the log off and on.
                        </div>
                    </div>
                </Row>
                <Row>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-bold">API key</div>
                        <div className="text-xs font-mono text-gray-300 mt-1 truncate">
                            {keyRevealed ? config.api_key : maskedKey}
                        </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                        <button
                            onClick={toggleKeyReveal}
                            aria-label={keyRevealed ? 'Hide API key' : 'Reveal API key'}
                            className="text-xs font-bold text-gray-400 hover:text-gray-200 px-2.5 py-1 rounded border border-white/10 hover:border-white/20 transition-colors uppercase tracking-wider"
                        >
                            {keyRevealed ? 'Hide' : 'Show'}
                        </button>
                        <button
                            onClick={() => void copy('key', config.api_key)}
                            aria-label="Copy API key"
                            className="text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                        >
                            {copiedField === 'key' ? 'Copied' : 'Copy'}
                        </button>
                    </div>
                </Row>
                <Row>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-bold">API endpoint</div>
                        <div className="text-xs font-mono text-gray-400 mt-1 truncate">{apiUrl}</div>
                    </div>
                    <button
                        onClick={() => void copy('api', apiUrl)}
                        aria-label="Copy API endpoint URL"
                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                    >
                        {copiedField === 'api' ? 'Copied' : 'Copy'}
                    </button>
                </Row>
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-400">
                            Full response shape, error codes, and a fetch example are in the API docs.
                        </div>
                    </div>
                    <button
                        onClick={() => void Browser.open({ url: 'https://thalassawx.app/voyage-log-api' })}
                        aria-label="Open the Voyage Log API documentation"
                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                    >
                        API docs
                    </button>
                </Row>
            </Section>

            {renderCrewSection()}
        </div>
    );
};
