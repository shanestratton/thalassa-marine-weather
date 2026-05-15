/**
 * ReadinessCardStack — All 8 passage readiness cards.
 *
 * Extracted from CrewManagement to reduce monolithic size.
 * Each card is a <details> accordion with delegation badge + inner card.
 */

import React, { useEffect } from 'react';
import { type CrewMember } from '../../services/CrewService';
import { type VoyageRow } from '../CrewManagement';

import { WeatherBriefingCard } from '../passage/WeatherBriefingCard';
import { EssentialReservesCard } from '../passage/EssentialReservesCard';
import { PassageSummaryCard } from '../passage/PassageSummaryCard';
import { AidToNavigationCard } from '../passage/AidToNavigationCard';
import { WatchScheduleCard } from '../passage/WatchScheduleCard';
import { CommsPlanCard } from '../passage/CommsPlanCard';
import { VesselCheckCard } from '../passage/VesselCheckCard';
import { MedicalFirstAidCard } from '../passage/MedicalFirstAidCard';
import { CustomsClearanceCard } from '../passage/CustomsClearanceCard';
import { isSameCountry } from '../../data/customsDb';
import { GalleyCard } from '../chat/GalleyCard';
import { DelegationBadge } from './DelegationBadge';
import { VesselProfileSummary } from '../passage/VesselProfileSummary';
import { WeatherWindowCard } from '../passage/WeatherWindowCard';
import { OceanCurrentsCard } from '../passage/OceanCurrentsCard';

interface ReadinessCardStackProps {
    selectedPassageId: string;
    draftVoyages: VoyageRow[];
    visibleCrew: CrewMember[];
    planCrewCount: number;
    // Card states
    weatherReviewed: boolean;
    reservesReady: boolean;
    vesselChecked: boolean;
    medicalReady: boolean;
    watchBriefed: boolean;
    commsReady: boolean;
    customsCleared: boolean;
    navAcknowledged: boolean;
    customsProgress: { total: number; checked: number };
    // Card state setters
    onWeatherChange: (v: boolean) => void;
    onReservesChange: (v: boolean) => void;
    onVesselCheckChange: (v: boolean) => void;
    onMedicalChange: (v: boolean) => void;
    onWatchChange: (v: boolean) => void;
    onCommsChange: (v: boolean) => void;
    onCustomsChange: (total: number, checked: number) => void;
    onNavChange: (v: boolean) => void;
    // Delegation
    cardDelegations: Record<string, string>;
    delegationMenuOpen: string | null;
    onDelegationMenuToggle: (key: string | null) => void;
    onAssignCard: (cardKey: string, crewEmail: string | null) => void;
    // Passage Intelligence states
    vesselProfileReady?: boolean;
    comfortProfileReady?: boolean;
    weatherWindowReady?: boolean;
    currentsBriefed?: boolean;
    onVesselProfileChange?: (v: boolean) => void;
    onComfortProfileChange?: (v: boolean) => void;
    onWeatherWindowChange?: (v: boolean) => void;
    onCurrentsChange?: (v: boolean) => void;
}

/* ── Chevron icon reused by all cards ── */
const ChevronDown = () => (
    <svg
        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
    >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
);

/* ── Accordion header styling helper ── */
const summaryClasses = (isReady: boolean, isAmber = false) => {
    if (isReady) {
        return 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]';
    }
    if (isAmber) {
        return 'bg-gradient-to-r from-amber-500/[0.06] to-orange-500/[0.03] border-amber-500/15 hover:from-amber-500/[0.1] hover:to-orange-500/[0.06]';
    }
    return 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]';
};

const iconClasses = (isReady: boolean, isAmber = false) => {
    if (isReady) return 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20';
    if (isAmber) return 'from-amber-500/20 to-orange-500/10 border-amber-500/20';
    return 'from-red-500/20 to-orange-500/10 border-red-500/20';
};

const subtitleColor = (isReady: boolean, isAmber = false) => {
    if (isReady) return 'text-emerald-400/70';
    if (isAmber) return 'text-amber-400/70';
    return 'text-red-400/70';
};

/* ── Single Readiness Card Accordion ── */
interface CardAccordionProps {
    isReady: boolean;
    isAmber?: boolean;
    emoji: string;
    readyEmoji?: string;
    title: string;
    subtitle: string;
    readySubtitle: string;
    cardKey: string;
    delegations: Record<string, string>;
    crewList: CrewMember[];
    delegationMenuOpen: string | null;
    onMenuToggle: (key: string | null) => void;
    onAssign: (cardKey: string, crewEmail: string | null) => void;
    children: React.ReactNode;
}

const CardAccordion: React.FC<CardAccordionProps> = ({
    isReady,
    isAmber = false,
    emoji,
    readyEmoji = '✅',
    title,
    subtitle,
    readySubtitle,
    cardKey,
    delegations,
    crewList,
    delegationMenuOpen,
    onMenuToggle,
    onAssign,
    children,
}) => (
    <div className="mb-4">
        <details className="group">
            <summary
                className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${summaryClasses(isReady, isAmber)}`}
            >
                <div
                    className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${iconClasses(isReady, isAmber)}`}
                >
                    {isReady ? readyEmoji : emoji}
                </div>
                <div className="flex-1 text-left">
                    <p className="text-lg font-semibold text-white inline-flex items-center">
                        {title}
                        <DelegationBadge
                            cardKey={cardKey}
                            delegations={delegations}
                            crewList={crewList}
                            menuOpen={delegationMenuOpen}
                            onMenuToggle={onMenuToggle}
                            onAssign={onAssign}
                        />
                    </p>
                    <p className={`text-sm ${subtitleColor(isReady, isAmber)}`}>{isReady ? readySubtitle : subtitle}</p>
                </div>
                <ChevronDown />
            </summary>
            <div className="mt-2 animate-in slide-in-from-top-2 duration-200">{children}</div>
        </details>
    </div>
);

/**
 * Group header — coloured bar + uppercase label + X/Y readiness chip
 * + chevron. The chevron rotates on its own when the enclosing
 * `<details>` element is open, via the `group-open:rotate-180` class
 * inside ChevronDown — see line 71. Headers are designed to live
 * inside a `<summary>` so tapping anywhere on them toggles their group.
 */
const GroupHeader: React.FC<{ label: string; ready: number; total: number }> = ({ label, ready, total }) => {
    const complete = total > 0 && ready === total;
    return (
        <div className="flex items-center gap-2 mb-3 mt-1">
            <div className={`w-1 h-4 rounded-full ${complete ? 'bg-emerald-400' : 'bg-violet-400'}`} />
            <span
                className={`text-[11px] font-black uppercase tracking-[0.2em] ${complete ? 'text-emerald-400' : 'text-violet-400'}`}
            >
                {label}
            </span>
            <span
                className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                    complete
                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                        : 'bg-violet-500/10 border-violet-500/20 text-violet-400'
                }`}
            >
                {ready}/{total}
            </span>
            <ChevronDown />
        </div>
    );
};

export const ReadinessCardStack: React.FC<ReadinessCardStackProps> = ({
    selectedPassageId,
    draftVoyages,
    visibleCrew,
    planCrewCount,
    weatherReviewed,
    reservesReady,
    vesselChecked,
    medicalReady,
    watchBriefed,
    commsReady,
    customsCleared,
    navAcknowledged,
    customsProgress,
    onWeatherChange,
    onReservesChange,
    onVesselCheckChange,
    onMedicalChange,
    onWatchChange,
    onCommsChange,
    onCustomsChange,
    onNavChange,
    cardDelegations,
    delegationMenuOpen,
    onDelegationMenuToggle,
    onAssignCard,
    // Passage Intelligence
    vesselProfileReady = false,
    comfortProfileReady = false,
    weatherWindowReady = false,
    currentsBriefed = false,
    onVesselProfileChange,
    onComfortProfileChange,
    onWeatherWindowChange,
    onCurrentsChange,
}) => {
    const activeVoyage = draftVoyages.find((v) => v.id === selectedPassageId);
    const departPort = activeVoyage?.departure_port;
    const destPort = activeVoyage?.destination_port;

    const delegationProps = {
        delegations: cardDelegations,
        crewList: visibleCrew,
        delegationMenuOpen,
        onMenuToggle: onDelegationMenuToggle,
        onAssign: onAssignCard,
    };

    // Group readiness counters — one X/Y chip per group header. Vessel
    // Profile moved out of Passage Intelligence into Vessel Readiness
    // (along with the other vessel-wide cards) per a 2026-05-15
    // reorganisation: "passage intelligence" now strictly means
    // route-derived intelligence (weather + currents), the route-
    // specific operational cards live under "Departure Brief", and
    // vessel-wide checks sit at the bottom in their own group.
    const piReadyCount = [weatherWindowReady, currentsBriefed].filter(Boolean).length;
    const briefReadyCount = [weatherReviewed, watchBriefed, customsCleared, navAcknowledged].filter(Boolean).length;
    const vesselReadyCount = [vesselProfileReady, reservesReady, vesselChecked, medicalReady, commsReady].filter(
        Boolean,
    ).length;

    // Auto-clear customs for domestic routes
    const isDomestic = !!(departPort && destPort && isSameCountry(departPort, destPort));
    useEffect(() => {
        if (isDomestic && !customsCleared) {
            onCustomsChange(1, 1);
        }
    }, [isDomestic, customsCleared, onCustomsChange]);

    // Rollup behaviour: when no passage is selected, the three group
    // headers stay visible but their cards collapse out. Gives the
    // skipper a hint of what's coming once they pick a passage,
    // without filling the page with placeholders. Once a passage IS
    // selected, every card mounts and either re-hydrates per-voyage
    // state from readiness_checks (PI + Departure Brief — fresh slate
    // for a brand-new route, partial state for a half-ticked one) or
    // stays as the vessel-wide state it already had (Vessel
    // Readiness — same localStorage keys regardless of voyage).
    const hasPassage = Boolean(selectedPassageId);

    return (
        <>
            {/* When no passage is picked, a single hint sits above the
                rolled-up group headers so the user knows why the cards
                are absent. */}
            {!hasPassage && (
                <div className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-center">
                    <p className="text-sm text-gray-400">
                        {draftVoyages.length === 0
                            ? 'Plan a route to start ticking off your passage readiness.'
                            : 'Pick an active passage above to start ticking off your readiness checks.'}
                    </p>
                </div>
            )}

            {/* 1. PASSAGE SUMMARY */}
            {activeVoyage && (
                <div className="mb-4">
                    <details className="group">
                        <summary className="w-full flex items-center gap-3 p-3 rounded-2xl border bg-gradient-to-r from-sky-500/[0.06] to-indigo-500/[0.03] border-sky-500/15 hover:from-sky-500/[0.1] hover:to-indigo-500/[0.06] transition-all cursor-pointer list-none">
                            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-500/20 to-indigo-500/10 border border-sky-500/20 flex items-center justify-center text-xl flex-shrink-0">
                                🧭
                            </div>
                            <div className="flex-1 text-left">
                                <p className="text-lg font-semibold text-white">Passage Summary</p>
                                <p className="text-sm text-sky-400/70">
                                    {activeVoyage.departure_port || '—'} → {activeVoyage.destination_port || '—'}
                                </p>
                            </div>
                            <ChevronDown />
                        </summary>
                        <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                            <PassageSummaryCard
                                voyageId={activeVoyage.id}
                                voyageName={activeVoyage.voyage_name || undefined}
                                departPort={activeVoyage.departure_port || undefined}
                                destPort={activeVoyage.destination_port || undefined}
                                departureTime={activeVoyage.departure_time}
                                eta={activeVoyage.eta}
                                /* Coords from the active voyage's first/last
                                   logbook points — single source of truth for
                                   the map. Without these the card had to fall
                                   back to PassageStore localStorage which can
                                   carry stale data from previous sessions and
                                   cause the map to render as a globe view
                                   with a (0,0) marker. */
                                departLat={activeVoyage.departureCoords?.lat}
                                departLon={activeVoyage.departureCoords?.lon}
                                arriveLat={activeVoyage.arrivalCoords?.lat}
                                arriveLon={activeVoyage.arrivalCoords?.lon}
                            />
                        </div>
                    </details>
                </div>
            )}

            {/* ═══ GROUP 1: PASSAGE INTELLIGENCE — route-derived intelligence.
                Renamed/narrowed 2026-05-15: Vessel Profile moved to the new
                Vessel Readiness group at the bottom (it's vessel-wide,
                not passage intelligence). */}
            <details className="group mb-2" open={hasPassage}>
                <summary className="list-none cursor-pointer">
                    <GroupHeader label="Passage Intelligence" ready={piReadyCount} total={2} />
                </summary>

                {/* PI-1: WEATHER WINDOWS */}
                <CardAccordion
                    isReady={weatherWindowReady}
                    emoji="🌊"
                    title="Weather Windows"
                    subtitle="When should I leave?"
                    readySubtitle="✅ Departure window accepted"
                    cardKey="weather_windows"
                    {...delegationProps}
                >
                    <WeatherWindowCard
                        voyageId={selectedPassageId}
                        activeVoyage={activeVoyage}
                        departure={activeVoyage?.departureCoords}
                        destination={activeVoyage?.arrivalCoords}
                        departureTime={activeVoyage?.departure_time}
                        onReviewedChange={onWeatherWindowChange}
                    />
                </CardAccordion>

                {/* PI-2: OCEAN CURRENTS */}
                <CardAccordion
                    isReady={currentsBriefed}
                    emoji="🌀"
                    title="Ocean Currents"
                    subtitle="Surface current briefing"
                    readySubtitle="✅ Current briefing acknowledged"
                    cardKey="ocean_currents"
                    {...delegationProps}
                >
                    <OceanCurrentsCard
                        voyageId={selectedPassageId}
                        activeVoyage={activeVoyage}
                        departure={activeVoyage?.departureCoords}
                        destination={activeVoyage?.arrivalCoords}
                        onReviewedChange={onCurrentsChange}
                    />
                </CardAccordion>
            </details>

            {/* ═══ GROUP 2: DEPARTURE BRIEF — route-specific operational. */}
            <details className="group mb-2" open={hasPassage}>
                <summary className="list-none cursor-pointer">
                    <GroupHeader label="Departure Brief" ready={briefReadyCount} total={4} />
                </summary>

                {/* DB-1: PRE-DEPARTURE WEATHER */}
                <CardAccordion
                    isReady={weatherReviewed}
                    emoji="🌤️"
                    title="Pre-Departure Weather"
                    subtitle="Review models & forecast for departure"
                    readySubtitle="✅ Departure forecast reviewed"
                    cardKey="weather_briefing"
                    {...delegationProps}
                >
                    <WeatherBriefingCard
                        voyageId={selectedPassageId}
                        departPort={departPort || undefined}
                        destPort={destPort || undefined}
                        departureCoords={activeVoyage?.departureCoords}
                        departureTime={activeVoyage?.departure_time || null}
                        eta={activeVoyage?.eta || null}
                        onReviewedChange={onWeatherChange}
                    />
                </CardAccordion>

                {/* DB-2: VOYAGE PROVISIONING — no CardAccordion wrapper, the
                    Galley widget has its own card chrome and no boolean
                    "reviewed" signal, so it's not counted in briefReadyCount. */}
                <div className="mb-4">
                    <GalleyCard
                        className=""
                        registeredCrewCount={visibleCrew.length}
                        cardDelegations={cardDelegations}
                        delegationMenuOpen={delegationMenuOpen}
                        onDelegationMenuToggle={onDelegationMenuToggle}
                        onAssignCard={onAssignCard}
                        crewList={visibleCrew}
                    />
                </div>

                {/* DB-3: WATCH SCHEDULE */}
                <CardAccordion
                    isReady={watchBriefed}
                    emoji="⏰"
                    title="Watch Schedule"
                    subtitle={`${planCrewCount} crew · Set watch rotation`}
                    readySubtitle="✅ Watch rotation briefed to crew"
                    cardKey="watch_schedule"
                    {...delegationProps}
                >
                    <WatchScheduleCard
                        voyageId={selectedPassageId}
                        crewCount={planCrewCount}
                        departureTimeIso={activeVoyage?.departure_time || null}
                        passageDurationHours={activeVoyage?.durationHours}
                        voyageName={activeVoyage?.voyage_name || null}
                        onReviewedChange={onWatchChange}
                    />
                </CardAccordion>

                {/* DB-4: CUSTOMS & IMMIGRATION (conditional) */}
                {departPort &&
                    destPort &&
                    (() => {
                        if (isDomestic) {
                            return (
                                <CardAccordion
                                    isReady={true}
                                    emoji="🛂"
                                    title="Customs & Immigration"
                                    subtitle={`${departPort} → ${destPort}`}
                                    readySubtitle="✅ Domestic route — no clearance required"
                                    cardKey="customs_clearance"
                                    {...delegationProps}
                                >
                                    <div className="p-4 text-center">
                                        <p className="text-2xl mb-2">🏠</p>
                                        <p className="text-sm font-bold text-emerald-400 mb-1">No Customs Required</p>
                                        <p className="text-xs text-gray-400 leading-relaxed max-w-xs mx-auto">
                                            Both ports are in the same country. No international clearance, immigration,
                                            or customs procedures are needed for this passage.
                                        </p>
                                    </div>
                                </CardAccordion>
                            );
                        }

                        const minimalPlan = {
                            customs: {
                                required: true,
                                departingCountry: departPort,
                                destinationCountry: destPort,
                            },
                        };
                        return (
                            <CardAccordion
                                isReady={customsCleared}
                                emoji="🛂"
                                title="Customs & Immigration"
                                subtitle={
                                    customsProgress.total > 0
                                        ? `${customsProgress.checked}/${customsProgress.total} documents · ${departPort} → ${destPort}`
                                        : `${departPort} → ${destPort}`
                                }
                                readySubtitle="✅ All documents cleared"
                                cardKey="customs_clearance"
                                {...delegationProps}
                            >
                                <CustomsClearanceCard
                                    voyageId={selectedPassageId}
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    voyagePlan={minimalPlan as any}
                                    onCheckedChange={onCustomsChange}
                                />
                            </CardAccordion>
                        );
                    })()}

                {/* DB-5: AID TO NAVIGATION — final pre-cast-off gate. */}
                <CardAccordion
                    isReady={navAcknowledged}
                    isAmber={!navAcknowledged}
                    emoji="⚓"
                    title="Aid to Navigation"
                    subtitle="Legal disclaimers · Skipper's acknowledgment"
                    readySubtitle="✅ All acknowledgments accepted"
                    cardKey="aid_to_navigation"
                    {...delegationProps}
                >
                    <AidToNavigationCard
                        voyageId={selectedPassageId}
                        onAcknowledgedChange={onNavChange}
                        allOtherCardsReady={
                            customsCleared && weatherReviewed && reservesReady && watchBriefed && commsReady
                        }
                    />
                </CardAccordion>
            </details>

            {/* ═══ GROUP 3: VESSEL READINESS — vessel-wide checks, last.
                Same cards also live in Settings → Vessel Readiness so the
                skipper can tick them off without an active passage. State
                is shared (localStorage + readiness_checks). */}
            <details className="group mb-2" open={hasPassage}>
                <summary className="list-none cursor-pointer">
                    <GroupHeader label="Vessel Readiness" ready={vesselReadyCount} total={5} />
                </summary>

                {/* VR-1: VESSEL PROFILE — read-only summary, canonical
                    source is settings.vessel from onboarding. */}
                <CardAccordion
                    isReady={vesselProfileReady}
                    emoji="⚓"
                    title="Vessel Profile"
                    subtitle="Confirm active boat for routing"
                    readySubtitle="✅ Vessel ready for routing"
                    cardKey="vessel_profile"
                    {...delegationProps}
                >
                    <VesselProfileSummary onReviewedChange={onVesselProfileChange} />
                </CardAccordion>

                {/* VR-2: ESSENTIAL RESERVES */}
                <CardAccordion
                    isReady={reservesReady}
                    emoji="⛽"
                    title="Essential Reserves"
                    subtitle="Fuel · Water · Gas · Safety"
                    readySubtitle="✅ All critical reserves confirmed"
                    cardKey="essential_reserves"
                    {...delegationProps}
                >
                    <EssentialReservesCard voyageId={selectedPassageId} onReviewedChange={onReservesChange} />
                </CardAccordion>

                {/* VR-3: VESSEL PRE-CHECK */}
                <CardAccordion
                    isReady={vesselChecked}
                    emoji="🔧"
                    title="Vessel Pre-Check"
                    subtitle="Engine · Electrical · Hull · Safety"
                    readySubtitle="✅ All vessel systems verified"
                    cardKey="vessel_check"
                    {...delegationProps}
                >
                    <VesselCheckCard voyageId={selectedPassageId} onReviewedChange={onVesselCheckChange} />
                </CardAccordion>

                {/* VR-4: MEDICAL & FIRST AID */}
                <CardAccordion
                    isReady={medicalReady}
                    emoji="🏥"
                    title="Medical & First Aid"
                    subtitle="Allergies · Emergency contacts · First aid kit"
                    readySubtitle="✅ Crew medical info recorded · Kit verified"
                    cardKey="medical"
                    {...delegationProps}
                >
                    <MedicalFirstAidCard voyageId={selectedPassageId} onReviewedChange={onMedicalChange} />
                </CardAccordion>

                {/* VR-5: COMMUNICATIONS PLAN */}
                <CardAccordion
                    isReady={commsReady}
                    emoji="📡"
                    title="Communications Plan"
                    subtitle="Radio · Position reports · Shore contact"
                    readySubtitle="✅ Comms plan confirmed · Shore contact set"
                    cardKey="comms_plan"
                    {...delegationProps}
                >
                    <CommsPlanCard voyageId={selectedPassageId} onReviewedChange={onCommsChange} />
                </CardAccordion>
            </details>
        </>
    );
};
