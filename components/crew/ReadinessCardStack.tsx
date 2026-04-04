/**
 * ReadinessCardStack — All 8 passage readiness cards.
 *
 * Extracted from CrewManagement to reduce monolithic size.
 * Each card is a <details> accordion with delegation badge + inner card.
 */

import React, { useEffect } from 'react';
import { type CrewMember } from '../../services/CrewService';
import { type Voyage } from '../../services/VoyageService';

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
import { VesselProfileCard } from '../passage/VesselProfileCard';
import { ComfortProfileCard } from '../passage/ComfortProfileCard';
import { WeatherWindowCard } from '../passage/WeatherWindowCard';
import { OceanCurrentsCard } from '../passage/OceanCurrentsCard';

interface ReadinessCardStackProps {
    selectedPassageId: string;
    draftVoyages: Voyage[];
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

    // Passage Intelligence readiness summary
    const piReadyCount = [vesselProfileReady, comfortProfileReady, weatherWindowReady, currentsBriefed].filter(
        Boolean,
    ).length;

    // Auto-clear customs for domestic routes
    const isDomestic = !!(departPort && destPort && isSameCountry(departPort, destPort));
    useEffect(() => {
        if (isDomestic && !customsCleared) {
            onCustomsChange(1, 1);
        }
    }, [isDomestic, customsCleared, onCustomsChange]);

    return (
        <>
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
                                departPort={activeVoyage.departure_port || undefined}
                                destPort={activeVoyage.destination_port || undefined}
                                departureTime={activeVoyage.departure_time}
                                eta={activeVoyage.eta}
                            />
                        </div>
                    </details>
                </div>
            )}

            {/* ═══ PASSAGE INTELLIGENCE GROUP ═══ */}
            <div className="mb-2">
                <div className="flex items-center gap-2 mb-3 mt-1">
                    <div
                        className={`w-1 h-4 rounded-full ${piReadyCount === 4 ? 'bg-emerald-400' : 'bg-violet-400'}`}
                    />
                    <span
                        className={`text-[11px] font-black uppercase tracking-[0.2em] ${piReadyCount === 4 ? 'text-emerald-400' : 'text-violet-400'}`}
                    >
                        Passage Intelligence
                    </span>
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            piReadyCount === 4
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-violet-500/10 border-violet-500/20 text-violet-400'
                        }`}
                    >
                        {piReadyCount}/4
                    </span>
                </div>

                {/* PI-1: VESSEL PROFILE */}
                <CardAccordion
                    isReady={vesselProfileReady}
                    emoji="⚓"
                    title="Vessel Profile"
                    subtitle="Hull type · LOA · Cruising speed"
                    readySubtitle="✅ Performance profile configured"
                    cardKey="vessel_profile"
                    {...delegationProps}
                >
                    <VesselProfileCard voyageId={selectedPassageId} onReviewedChange={onVesselProfileChange} />
                </CardAccordion>

                {/* PI-2: COMFORT PROFILE */}
                <CardAccordion
                    isReady={comfortProfileReady}
                    emoji="⛵"
                    title="Comfort Profile"
                    subtitle="Wind · Wave · Angle thresholds"
                    readySubtitle="✅ Comfort limits configured"
                    cardKey="comfort_profile"
                    {...delegationProps}
                >
                    <ComfortProfileCard voyageId={selectedPassageId} onReviewedChange={onComfortProfileChange} />
                </CardAccordion>

                {/* PI-3: WEATHER WINDOWS */}
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
                        onReviewedChange={onWeatherWindowChange}
                    />
                </CardAccordion>

                {/* PI-4: OCEAN CURRENTS */}
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
                        onReviewedChange={onCurrentsChange}
                    />
                </CardAccordion>
            </div>

            {/* 2. WEATHER BRIEFING */}
            <CardAccordion
                isReady={weatherReviewed}
                emoji="🌤️"
                title="Weather Briefing"
                subtitle="Review models & forecast before departure"
                readySubtitle="✅ Briefing reviewed — conditions accepted"
                cardKey="weather_briefing"
                {...delegationProps}
            >
                <WeatherBriefingCard
                    voyageId={selectedPassageId}
                    departPort={departPort || undefined}
                    destPort={destPort || undefined}
                    onReviewedChange={onWeatherChange}
                />
            </CardAccordion>

            {/* 3. ESSENTIAL RESERVES */}
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

            {/* 4. VESSEL PRE-CHECK */}
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

            {/* 5. MEDICAL & FIRST AID */}
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

            {/* 6. VOYAGE PROVISIONING */}
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

            {/* 7. WATCH SCHEDULE */}
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
                    onReviewedChange={onWatchChange}
                />
            </CardAccordion>

            {/* 8. COMMUNICATIONS PLAN */}
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

            {/* 9. CUSTOMS & IMMIGRATION (conditional) */}
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
                                        Both ports are in the same country. No international clearance, immigration, or
                                        customs procedures are needed for this passage.
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

            {/* 10. AID TO NAVIGATION — always last */}
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
        </>
    );
};
