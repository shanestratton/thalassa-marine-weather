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

import React, { useCallback, useEffect, useRef, useState } from 'react';
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

export const VoyageLogTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
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

    const loadCrewBoats = useCallback(async () => {
        if (!supabase) return;
        const { data: authData } = await supabase.auth.getUser();
        const myId = authData.user?.id;
        if (!myId) return;

        // Boats I'm a member of where I'm not the owner.
        const { data: memberships } = await supabase
            .from('boat_members')
            .select('boat_id, first_name, boats!inner(id, name, owner_id)')
            .eq('user_id', myId);

        const crewRows = (memberships ?? []).filter(
            (m: unknown) => (m as { boats: { owner_id: string } }).boats.owner_id !== myId,
        );
        if (crewRows.length === 0) {
            setCrewBoats([]);
            return;
        }

        // My personal voyage-log configs across those boats.
        const boatIds = crewRows.map((r: unknown) => (r as { boat_id: string }).boat_id);
        const { data: configs } = await supabase
            .from('voyage_log_configs')
            .select('boat_id, handle, enabled')
            .eq('owner_id', myId)
            .eq('scope', 'personal')
            .in('boat_id', boatIds);
        const byBoat = new Map(
            (configs ?? []).map((c: unknown) => [
                (c as { boat_id: string }).boat_id,
                c as { handle: string; enabled: boolean },
            ]),
        );

        setCrewBoats(
            crewRows.map((m: unknown) => {
                const row = m as { boat_id: string; first_name: string | null; boats: { name: string } };
                return {
                    boatId: row.boat_id,
                    boatName: row.boats.name,
                    firstName: row.first_name,
                    config: byBoat.get(row.boat_id) ?? null,
                };
            }),
        );
    }, []);

    useEffect(() => {
        let cancelled = false;
        void VoyageLogService.getConfig().then((c) => {
            if (!cancelled) {
                setConfig(c);
                setLoading(false);
            }
        });
        void loadCrewBoats();
        return () => {
            cancelled = true;
        };
    }, [loadCrewBoats]);

    // Load the public-tracks list once the log is confirmed enabled. Server
    // summaries only — those are exactly the voyages the public page can draw.
    useEffect(() => {
        if (!config?.enabled) return;
        let cancelled = false;
        void Promise.all([
            ShipLogService.getVoyageSummaries(),
            VoyageLogService.getHiddenVoyageIds(),
            VoyageLogService.getPlanLinks(),
            fetchRoutesAndTracks().catch(() => ({ routes: [] as RouteOrTrack[], tracks: [] as RouteOrTrack[] })),
        ]).then(([summaries, hidden, links, routesAndTracks]) => {
            if (cancelled) return;
            const sorted = [...summaries].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 50);
            setPublicTracks(sorted);
            setHiddenVoyageIds(hidden);
            setPlanLinks(links);
            // Local-only plans can't drive the public page (not on the server
            // yet) — keep them out of the link picker.
            setPlanRoutes(
                routesAndTracks.routes
                    .filter((r) => !r.isLocal)
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, 10),
            );
        });
        return () => {
            cancelled = true;
        };
    }, [config?.enabled]);

    const handleTrackVisibility = useCallback(async (voyageId: string, hidden: boolean) => {
        setTrackBusyId(voyageId);
        triggerHaptic('light');
        // Optimistic — revert on failure.
        setHiddenVoyageIds((prev) => {
            const next = new Set(prev);
            if (hidden) next.add(voyageId);
            else next.delete(voyageId);
            return next;
        });
        const ok = await VoyageLogService.setVoyageHidden(voyageId, hidden);
        if (!ok) {
            setHiddenVoyageIds((prev) => {
                const next = new Set(prev);
                if (hidden) next.delete(voyageId);
                else next.add(voyageId);
                return next;
            });
            toast.error(VoyageLogService.lastError ?? 'Could not update — check signal');
        }
        setTrackBusyId(null);
    }, []);

    const handlePlanLink = useCallback(async (voyageId: string, planId: string | null) => {
        setLinkPickerFor(null);
        triggerHaptic('light');
        const prev = planLinksRef.current.get(voyageId) ?? null;
        setPlanLinks((m) => {
            const next = new Map(m);
            if (planId) next.set(voyageId, planId);
            else next.delete(voyageId);
            return next;
        });
        const ok = await VoyageLogService.setVoyagePlanLink(voyageId, planId);
        if (!ok) {
            setPlanLinks((m) => {
                const next = new Map(m);
                if (prev) next.set(voyageId, prev);
                else next.delete(voyageId);
                return next;
            });
            toast.error(VoyageLogService.lastError ?? 'Could not update the link — check signal');
        }
    }, []);
    // Ref mirror so handlePlanLink's revert reads the latest map without
    // re-creating the callback per change.
    const planLinksRef = useRef<Map<string, string>>(new Map());
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

    const copy = useCallback(async (field: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopiedField(field);
            triggerHaptic('light');
            setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 2000);
        } catch {
            /* clipboard unavailable — value is still visible to copy by hand */
        }
    }, []);

    const handleSetUp = useCallback(async () => {
        setBusy(true);
        setSetupError(null);
        const c = await VoyageLogService.ensureEnabled();
        setConfig(c);
        if (!c) {
            // Surface the actual reason — RLS, missing table, no auth, etc.
            // Without this the button just flashes and the punter has no
            // idea what went wrong.
            setSetupError(VoyageLogService.lastError ?? 'Setup failed for an unknown reason.');
        }
        setBusy(false);
        triggerHaptic('medium');
    }, []);

    const handleToggle = useCallback(async (next: boolean) => {
        setBusy(true);
        const c = await VoyageLogService.setEnabled(next);
        if (c) setConfig(c);
        setBusy(false);
        triggerHaptic('light');
    }, []);

    // Create a personal voyage-log for a boat I'm crew on. Picks a sensible
    // default handle (<first>-on-<boat-slug>) and auto-suffixes on collision.
    const handleCreateCrewLog = useCallback(
        async (boat: CrewBoatLog) => {
            if (!supabase) return;
            setCrewBusyBoatId(boat.boatId);
            const { data: authData } = await supabase.auth.getUser();
            const myId = authData.user?.id;
            if (!myId) {
                setCrewBusyBoatId(null);
                return;
            }
            const base = slugify(`${boat.firstName ?? 'crew'}-on-${boat.boatName}`);
            let candidate = base;
            let attempt = 1;
            while (attempt < 20) {
                const { error } = await supabase.from('voyage_log_configs').insert({
                    owner_id: myId,
                    boat_id: boat.boatId,
                    handle: candidate,
                    scope: 'personal',
                    enabled: true,
                });
                if (!error) {
                    triggerHaptic('medium');
                    toast.success(`Live at ${candidate}.thalassawx.app`);
                    await loadCrewBoats();
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
        [loadCrewBoats],
    );

    const handleToggleCrewLog = useCallback(
        async (boat: CrewBoatLog, next: boolean) => {
            if (!supabase || !boat.config) return;
            setCrewBusyBoatId(boat.boatId);
            const { data: authData } = await supabase.auth.getUser();
            const myId = authData.user?.id;
            if (!myId) {
                setCrewBusyBoatId(null);
                return;
            }
            const { error } = await supabase
                .from('voyage_log_configs')
                .update({ enabled: next })
                .eq('owner_id', myId)
                .eq('boat_id', boat.boatId)
                .eq('scope', 'personal');
            if (error) {
                toast.error('Could not toggle.');
            } else {
                await loadCrewBoats();
                triggerHaptic('light');
            }
            setCrewBusyBoatId(null);
        },
        [loadCrewBoats],
    );

    if (loading) {
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
                        onClick={() => void Browser.open({ url: publicUrl })}
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
                            <div className="text-sm text-white font-bold">Share position live</div>
                            <div className="text-xs text-gray-400 mt-1">
                                While a voyage is recording, send a position to your public page every couple of minutes
                                (when there&apos;s signal — gaps fill in as coverage returns). The full track still
                                uploads when the voyage ends.
                            </div>
                        </div>
                        <Toggle
                            checked={settings.liveTrackShare === true}
                            onChange={(v) => {
                                triggerHaptic('light');
                                onSave({ liveTrackShare: v });
                                void import('../../services/shiplog/LiveTrickle').then(
                                    ({ purgeLiveTrack, markLiveTrickleFreshStart }) => {
                                        if (v) {
                                            // Forward-only consent: never publish
                                            // the pre-toggle backlog in the queue.
                                            void markLiveTrickleFreshStart();
                                        } else {
                                            // Opt-out is immediate: pull every
                                            // already-shared position off the page.
                                            void purgeLiveTrack().then((ok) => {
                                                if (!ok) toast.error('Could not clear shared positions — check signal');
                                            });
                                        }
                                    },
                                );
                            }}
                            label="Live position sharing on/off"
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
                                                onClick={() =>
                                                    setLinkPickerFor(linkPickerFor === v.voyageId ? null : v.voyageId)
                                                }
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
                            onClick={() => setKeyRevealed((r) => !r)}
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
