import React from 'react';
import { t } from '../../theme';
import { VoyagePlan, VesselProfile } from '../../types';
import { MapPinIcon, PhoneIcon, RadioTowerIcon, AlertTriangleIcon, WindIcon } from '../Icons';
import { fmtCoord } from '../../utils/coords';

interface EmergencyPlanProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
}

/* ─── Regional emergency contacts database ────────────────────── */
interface EmergencyContact {
    service: string;
    frequency?: string;
    phone: string;
    region: string;
}

const EMERGENCY_CONTACTS_DB: Record<string, EmergencyContact[]> = {
    Australia: [
        { service: 'Australian Maritime Safety Authority (AMSA)', frequency: '156.8 MHz (VHF-16)', phone: '1800 641 792', region: 'Australia' },
        { service: 'Marine Rescue NSW', frequency: '156.8 MHz (VHF-16)', phone: '1800 622 468', region: 'NSW' },
        { service: 'Volunteer Marine Rescue QLD', frequency: '156.8 MHz (VHF-16)', phone: '07 3635 3600', region: 'QLD' },
        { service: 'Water Police', frequency: '156.8 MHz (VHF-16)', phone: '000', region: 'Australia' },
    ],
    'New Zealand': [
        { service: 'Maritime NZ RCCNZ', frequency: '156.8 MHz (VHF-16)', phone: '+64 4 577 8030', region: 'NZ' },
        { service: 'Coastguard NZ', frequency: '156.8 MHz (VHF-16)', phone: '*500 (mobile)', region: 'NZ' },
        { service: 'NZ Police', frequency: '', phone: '111', region: 'NZ' },
    ],
    'United States': [
        { service: 'US Coast Guard', frequency: '156.8 MHz (VHF-16)', phone: '1-800-221-8724', region: 'USA' },
        { service: 'Marine Rescue Coordination', frequency: '156.8 MHz (VHF-16)', phone: '911', region: 'USA' },
    ],
    'United Kingdom': [
        { service: 'HM Coastguard', frequency: '156.8 MHz (VHF-16)', phone: '999 / 112', region: 'UK' },
        { service: 'RNLI Lifeboat', frequency: '156.8 MHz (VHF-16)', phone: '999', region: 'UK' },
    ],
    France: [
        { service: 'CROSS (Centre Régional)', frequency: '156.8 MHz (VHF-16)', phone: '196', region: 'France' },
    ],
    Indonesia: [
        { service: 'BASARNAS (Search & Rescue)', frequency: '156.8 MHz (VHF-16)', phone: '+62 21 348 32908', region: 'Indonesia' },
    ],
    'Papua New Guinea': [
        { service: 'National Maritime Safety Authority', frequency: '156.8 MHz (VHF-16)', phone: '+675 320 0211', region: 'PNG' },
    ],
    Fiji: [
        { service: 'Fiji Navy MRCC', frequency: '156.8 MHz (VHF-16)', phone: '+679 331 5470', region: 'Fiji' },
    ],
    default: [
        { service: 'International Maritime Distress', frequency: '156.8 MHz (VHF-16)', phone: 'VHF Ch 16', region: 'International' },
        { service: 'Inmarsat Maritime', frequency: '1544 MHz', phone: 'Fleet 77', region: 'Global' },
    ],
};

function getContactsForCountry(country: string | undefined): EmergencyContact[] {
    if (!country) return EMERGENCY_CONTACTS_DB.default;
    // Try exact match first
    if (EMERGENCY_CONTACTS_DB[country]) return EMERGENCY_CONTACTS_DB[country];
    // Try partial match
    const key = Object.keys(EMERGENCY_CONTACTS_DB).find(k =>
        country.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(country.toLowerCase())
    );
    return key ? EMERGENCY_CONTACTS_DB[key] : EMERGENCY_CONTACTS_DB.default;
}

// Weather diversion scenarios
const diversionScenarios = [
    {
        condition: 'Wind > 30kts',
        action: 'Head for nearest safe harbour',
        recommendation: 'Monitor VHF-16 for small craft advisories. Reduce speed and secure deck.',
        icon: '💨',
    },
    {
        condition: 'Wave Height > 3m',
        action: 'Consider heave-to or divert to shelter',
        recommendation: 'Reduce sail area, prepare storm equipment. Close all hatches.',
        icon: '🌊',
    },
    {
        condition: 'Visibility < 1nm',
        action: 'Activate nav lights, reduce speed',
        recommendation: 'Sound fog signals, use radar if available, post dedicated lookout.',
        icon: '🌫️',
    },
    {
        condition: 'Equipment Failure',
        action: 'Assess severity, divert if critical',
        recommendation: 'Have backup navigation (handheld GPS, paper charts, compass).',
        icon: '⚙️',
    },
];

export const EmergencyPlan: React.FC<EmergencyPlanProps> = ({ voyagePlan, vessel }) => {
    const crewCount = vessel.crewCount || 2;

    // Get region-specific contacts for both ends of the voyage
    const departCountry = voyagePlan.customs?.departingCountry || voyagePlan.customs?.destinationCountry;
    const arriveCountry = voyagePlan.customs?.destinationCountry;

    const departContacts = getContactsForCountry(departCountry);
    const arriveContacts = getContactsForCountry(arriveCountry);

    // Deduplicate if same country on both ends
    const sameCountry = departCountry && arriveCountry &&
        departCountry.toLowerCase() === arriveCountry.toLowerCase();

    // Safe harbours from Gemini
    const safeHarbours = voyagePlan.safeHarbours || [];

    return (
        <div className={`w-full bg-slate-900 ${t.border.default} rounded-2xl p-5 md:p-6 shadow-xl relative overflow-hidden`}>
            <div className="absolute top-0 left-0 w-96 h-96 bg-red-500/5 rounded-full blur-3xl -translate-y-1/2 -translate-x-1/2 pointer-events-none" />

            <div className="relative z-10">
                {/* Header */}
                <div className="flex justify-between items-start mb-5 border-b border-white/5 pb-4">
                    <div>
                        <h3 className="text-base font-bold text-white uppercase tracking-widest flex items-center gap-2">
                            <AlertTriangleIcon className="w-5 h-5 text-red-400" />
                            Emergency & Contingency
                        </h3>
                        <p className="text-xs text-slate-400 font-medium mt-0.5">Pre-planned safety options for this passage</p>
                    </div>
                    <div className="text-[11px] font-mono text-red-400 bg-red-500/10 px-2.5 py-1 rounded border border-red-500/20 uppercase tracking-widest font-bold">
                        Safety Critical
                    </div>
                </div>

                {/* ── SAFE HARBOURS (from Gemini AI) ── */}
                <div className="mb-5">
                    <h4 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-3">
                        <MapPinIcon className="w-4 h-4 text-emerald-400" />
                        Ports of Refuge Along Route
                    </h4>

                    {safeHarbours.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {safeHarbours.map((harbour, idx) => (
                                <div
                                    key={idx}
                                    className="bg-emerald-500/5 border border-emerald-500/15 rounded-xl p-4 hover:bg-emerald-500/10 transition-colors"
                                >
                                    <div className="flex items-start gap-2 mb-2">
                                        <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-[11px] font-black text-emerald-400 shrink-0 mt-0.5">
                                            {idx + 1}
                                        </div>
                                        <div className="min-w-0">
                                            <h5 className="text-sm font-bold text-white truncate">{harbour.name}</h5>
                                            <p className="text-[11px] text-gray-500 font-mono">
                                                {fmtCoord(harbour.lat, harbour.lon, 3)}
                                            </p>
                                        </div>
                                    </div>
                                    <p className="text-xs text-gray-400 leading-relaxed">{harbour.description}</p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-4">
                            <div className="flex items-start gap-2.5">
                                <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                                <div>
                                    <h5 className="text-xs font-bold text-amber-300 mb-1">Plan Your Port of Refuge</h5>
                                    <p className="text-xs text-gray-400 leading-relaxed">
                                        Before departure, identify at least one safe harbour along your route where you can divert
                                        if conditions deteriorate. Check your charts for sheltered anchorages, marinas with fuel and
                                        medical facilities, and harbours with all-tide access.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* ── EMERGENCY CONTACTS (region-specific) ── */}
                <div className="mb-5">
                    <h4 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-3">
                        <PhoneIcon className="w-4 h-4 text-amber-400" />
                        Emergency Contacts
                    </h4>

                    <div className="space-y-3">
                        {/* Departure region */}
                        {departCountry && (
                            <div>
                                <div className="text-[11px] text-sky-400 font-bold uppercase tracking-widest mb-2 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                                    {departCountry} {sameCountry ? '' : '(Departure)'}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {departContacts.map((contact, idx) => (
                                        <ContactCard key={`dep-${idx}`} contact={contact} />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Arrival region (if different country) */}
                        {arriveCountry && !sameCountry && (
                            <div className="pt-2">
                                <div className="text-[11px] text-emerald-400 font-bold uppercase tracking-widest mb-2 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                    {arriveCountry} (Arrival)
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {arriveContacts.map((contact, idx) => (
                                        <ContactCard key={`arr-${idx}`} contact={contact} />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Fallback if no countries detected */}
                        {!departCountry && !arriveCountry && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {EMERGENCY_CONTACTS_DB.default.map((contact, idx) => (
                                    <ContactCard key={idx} contact={contact} />
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* ── MAYDAY PROTOCOL ── */}
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-5">
                    <h5 className="text-xs font-bold text-red-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                        <RadioTowerIcon className="w-3.5 h-3.5" />
                        MAYDAY Protocol (VHF Ch 16)
                    </h5>
                    <div className="text-xs text-gray-300 space-y-0.5 font-mono leading-relaxed">
                        <div><span className="text-red-400 font-bold">1.</span> MAYDAY MAYDAY MAYDAY</div>
                        <div><span className="text-red-400 font-bold">2.</span> This is <span className="text-white">[VESSEL NAME]</span> × 3</div>
                        <div><span className="text-red-400 font-bold">3.</span> MMSI: <span className="text-white">[your MMSI]</span></div>
                        <div><span className="text-red-400 font-bold">4.</span> Position: <span className="text-white">[LAT / LON]</span></div>
                        <div><span className="text-red-400 font-bold">5.</span> Nature of distress</div>
                        <div><span className="text-red-400 font-bold">6.</span> Assistance required</div>
                        <div><span className="text-red-400 font-bold">7.</span> Souls on board: <span className="text-white font-bold">{crewCount}</span></div>
                        <div><span className="text-red-400 font-bold">8.</span> OVER</div>
                    </div>
                </div>

                {/* ── WEATHER DIVERSION PROCEDURES ── */}
                <div className="mb-5">
                    <h4 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-3">
                        <WindIcon className="w-4 h-4 text-amber-400" />
                        Weather Diversion Procedures
                    </h4>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {diversionScenarios.map((scenario, idx) => (
                            <div
                                key={idx}
                                className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 hover:bg-white/[0.06] transition-colors"
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-base mt-0.5">{scenario.icon}</span>
                                    <div className="flex-1 min-w-0">
                                        <h5 className="text-xs font-bold text-amber-300 mb-1">{scenario.condition}</h5>
                                        <p className="text-[11px] text-white mb-0.5">
                                            <span className="font-bold">Action:</span> {scenario.action}
                                        </p>
                                        <p className="text-[11px] text-gray-500">{scenario.recommendation}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* DISCLAIMER */}
                <div className="p-3 bg-amber-950/20 border border-amber-900/30 rounded-lg">
                    <p className="text-[11px] text-amber-200/80 leading-relaxed">
                        <span className="font-bold text-amber-400">⚠️ Important:</span> This emergency plan is generated
                        for reference only. Always verify safe harbour availability via VHF radio before diversion.
                        Maintain updated charts and contact information. The captain is solely responsible for crew
                        safety and vessel operations.
                    </p>
                </div>
            </div>
        </div>
    );
};

/* ── Contact Card micro-component ─────────────────────────────── */
const ContactCard: React.FC<{ contact: EmergencyContact }> = ({ contact }) => (
    <div className="bg-white/5 border border-white/[0.06] rounded-xl px-3 py-2.5">
        <h5 className="text-[11px] font-bold text-white mb-1.5 truncate">{contact.service}</h5>
        <div className="space-y-1">
            {contact.frequency && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
                    <RadioTowerIcon className="w-3 h-3 shrink-0" />
                    <span className="font-mono truncate">{contact.frequency}</span>
                </div>
            )}
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                <PhoneIcon className="w-3 h-3 shrink-0" />
                <span className="font-mono">{contact.phone}</span>
            </div>
        </div>
    </div>
);
