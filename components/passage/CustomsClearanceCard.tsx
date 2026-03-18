/**
 * CustomsClearanceCard — Comprehensive maritime customs & clearance guide.
 *
 * Country-specific procedures, contacts, required documents, yacht export rules,
 * and links to detailed walkthroughs. This is where Thalassa shines — giving
 * sailors exactly the info they need for the bureaucratic circus of international sailing.
 *
 * Data is sourced from data/customsDb.ts (28 countries, 1,100+ lines of clearance data).
 */

import React, { useState } from 'react';
import { VoyagePlan } from '../../types';
import { PhoneIcon, RadioTowerIcon, AlertTriangleIcon, ShareIcon, MapPinIcon } from '../Icons';
import { findCountryData, difficultyStyle } from '../../data/customsDb';

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */

interface CustomsClearanceCardProps {
    voyagePlan: VoyagePlan;
}

export const CustomsClearanceCard: React.FC<CustomsClearanceCardProps> = ({ voyagePlan }) => {
    const customs = voyagePlan.customs;
    const [activeTab, setActiveTab] = useState<'depart' | 'arrive'>('depart');

    if (!customs?.required) return null;

    const departCountry = customs.departingCountry;
    const arriveCountry = customs.destinationCountry;
    const departData = findCountryData(departCountry);
    const arriveData = findCountryData(arriveCountry);

    // Which clearance data to show
    const activeData = activeTab === 'depart' ? departData : arriveData;
    const activeCountryName = activeTab === 'depart' ? departCountry || 'Departure' : arriveCountry || 'Arrival';

    return (
        <div className="space-y-4">
            {/* ── Country Tabs ── */}
            <div className="flex gap-2 bg-white/[0.03] rounded-xl p-1 border border-white/[0.06]">
                {departCountry && (
                    <button
                        onClick={() => setActiveTab('depart')}
                        className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
                            activeTab === 'depart'
                                ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30 shadow-lg shadow-sky-500/10'
                                : 'text-gray-400 hover:text-gray-300 hover:bg-white/5 border border-transparent'
                        }`}
                    >
                        {departData?.flag || '🚢'} Departing {departCountry}
                    </button>
                )}
                <button
                    onClick={() => setActiveTab('arrive')}
                    className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
                        activeTab === 'arrive'
                            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-lg shadow-emerald-500/10'
                            : 'text-gray-400 hover:text-gray-300 hover:bg-white/5 border border-transparent'
                    }`}
                >
                    {arriveData?.flag || '🏁'} Arriving {arriveCountry}
                </button>
            </div>

            {activeData ? (
                <div className="animate-in fade-in duration-200 space-y-4">
                    {/* ── Difficulty Badge ── */}
                    <div
                        className={`flex items-center justify-between px-4 py-2.5 rounded-xl border ${difficultyStyle[activeData.difficulty].bg} ${difficultyStyle[activeData.difficulty].border}`}
                    >
                        <div className="flex items-center gap-2">
                            <span className="text-lg">{activeData.flag}</span>
                            <span
                                className={`text-xs font-black uppercase tracking-widest ${difficultyStyle[activeData.difficulty].text}`}
                            >
                                {difficultyStyle[activeData.difficulty].label}
                            </span>
                        </div>
                        {activeData.fees && (
                            <span className="text-[11px] text-gray-400 font-mono">{activeData.fees}</span>
                        )}
                    </div>

                    {/* ── Step-by-Step Procedure ── */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                        <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                            📋 {activeTab === 'depart' ? 'Departure' : 'Arrival'} Clearance Steps
                        </h4>
                        <div className="space-y-2">
                            {(activeTab === 'depart' ? activeData.departureProcedure : activeData.arrivalProcedure).map(
                                (step, i) => (
                                    <div key={i} className="flex items-start gap-3 group">
                                        <span className="w-5 h-5 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-[11px] font-black text-sky-400 shrink-0 mt-0.5 group-hover:bg-sky-500/30 transition-colors">
                                            {i + 1}
                                        </span>
                                        <p className="text-xs text-gray-300 leading-relaxed">{step}</p>
                                    </div>
                                ),
                            )}
                        </div>
                    </div>

                    {/* ── Yacht Export Warning (Australia etc.) ── */}
                    {activeTab === 'depart' && activeData.yachtExport && (
                        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-red-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                                ⚠️ Yacht Export Required
                            </h4>
                            <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-line">
                                {activeData.yachtExport}
                            </p>
                            {activeData.guideUrl && (
                                <a
                                    href={activeData.guideUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-3 flex items-center gap-2 w-fit px-4 py-2.5 bg-gradient-to-r from-sky-500/20 to-indigo-500/20 hover:from-sky-500/30 hover:to-indigo-500/30 border border-sky-500/30 rounded-xl text-xs font-bold text-sky-300 hover:text-white transition-all active:scale-[0.98] shadow-lg shadow-sky-500/10"
                                >
                                    <ShareIcon className="w-3.5 h-3.5" />
                                    {activeData.guideLabel || 'View Complete Guide'}
                                </a>
                            )}
                        </div>
                    )}

                    {/* ── Guide Link (if not yacht export) ── */}
                    {activeData.guideUrl && !(activeTab === 'depart' && activeData.yachtExport) && (
                        <a
                            href={activeData.guideUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 w-fit px-4 py-2.5 bg-gradient-to-r from-sky-500/20 to-indigo-500/20 hover:from-sky-500/30 hover:to-indigo-500/30 border border-sky-500/30 rounded-xl text-xs font-bold text-sky-300 hover:text-white transition-all active:scale-[0.98]"
                        >
                            <ShareIcon className="w-3.5 h-3.5" />
                            {activeData.guideLabel || 'View Complete Guide'}
                        </a>
                    )}

                    {/* ── Required Documents ── */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                        <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                            📄 Required Documents
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {activeData.requiredDocuments.map((doc, i) => (
                                <div
                                    key={i}
                                    className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                                        doc.critical
                                            ? 'bg-amber-500/5 border border-amber-500/15'
                                            : 'bg-white/5 border border-white/5'
                                    }`}
                                >
                                    <span
                                        className={`shrink-0 mt-0.5 ${doc.critical ? 'text-amber-400' : 'text-gray-400'}`}
                                    >
                                        {doc.critical ? '⚠️' : '📎'}
                                    </span>
                                    <div className="min-w-0">
                                        <span className={doc.critical ? 'text-amber-200 font-bold' : 'text-gray-300'}>
                                            {doc.name}
                                        </span>
                                        {doc.notes && (
                                            <div className="text-[11px] text-gray-400 mt-0.5">{doc.notes}</div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* ── Contacts ── */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                        <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                            📞 Key Contacts — {activeCountryName}
                        </h4>
                        <div className="space-y-2">
                            {activeData.contacts.map((contact, i) => (
                                <div key={i} className="bg-white/5 border border-white/5 rounded-xl px-4 py-3">
                                    <div className="text-xs font-bold text-white mb-1.5">{contact.name}</div>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                        {contact.phone && (
                                            <a
                                                href={`tel:${contact.phone}`}
                                                className="flex items-center gap-1.5 text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors"
                                            >
                                                <PhoneIcon className="w-3 h-3 shrink-0" />
                                                <span className="font-mono">{contact.phone}</span>
                                            </a>
                                        )}
                                        {contact.email && (
                                            <a
                                                href={`mailto:${contact.email}`}
                                                className="flex items-center gap-1.5 text-[11px] text-sky-400 hover:text-sky-300 transition-colors"
                                            >
                                                <span className="shrink-0">✉️</span>
                                                <span className="font-mono">{contact.email}</span>
                                            </a>
                                        )}
                                        {contact.vhf && (
                                            <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
                                                <RadioTowerIcon className="w-3 h-3 shrink-0" />
                                                <span className="font-mono">{contact.vhf}</span>
                                            </div>
                                        )}
                                        {contact.website && (
                                            <a
                                                href={contact.website}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white transition-colors"
                                            >
                                                <ShareIcon className="w-3 h-3 shrink-0" />
                                                <span className="truncate max-w-[180px]">Website</span>
                                            </a>
                                        )}
                                    </div>
                                    {contact.notes && (
                                        <div className="text-[11px] text-gray-400 mt-1">{contact.notes}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* ── Ports of Entry ── */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                        <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-2 flex items-center gap-2">
                            <MapPinIcon className="w-3.5 h-3.5 text-emerald-400" /> Designated Ports of Entry
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                            {activeData.portsOfEntry.map((port, i) => (
                                <span
                                    key={i}
                                    className="text-[11px] text-gray-300 bg-white/5 border border-white/5 rounded-full px-2.5 py-1 hover:bg-sky-500/10 hover:border-sky-500/20 hover:text-sky-200 transition-colors cursor-default"
                                >
                                    {port}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* ── Important Notes ── */}
                    {activeData.importantNotes.length > 0 && (
                        <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-amber-300 uppercase tracking-widest mb-2 flex items-center gap-2">
                                <AlertTriangleIcon className="w-3.5 h-3.5" /> Important Notes
                            </h4>
                            <div className="space-y-1.5">
                                {activeData.importantNotes.map((note, i) => (
                                    <p key={i} className="text-xs text-gray-300 leading-relaxed">
                                        {note}
                                    </p>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ── Gemini AI Additional Context ── */}
                    {((activeTab === 'depart' && customs?.departureProcedures) ||
                        (activeTab === 'arrive' && customs?.procedures)) && (
                        <div className="bg-indigo-500/5 border border-indigo-500/15 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-indigo-300 uppercase tracking-widest mb-2 flex items-center gap-2">
                                🤖 AI Route-Specific Notes
                            </h4>
                            <p className="text-xs text-gray-300 leading-relaxed">
                                {activeTab === 'depart' ? customs?.departureProcedures : customs?.procedures}
                            </p>
                        </div>
                    )}
                </div>
            ) : (
                /* ── Fallback: Gemini AI data only (country not in our DB) ── */
                <div className="space-y-4">
                    <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-4">
                        <div className="flex items-start gap-2.5">
                            <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                            <div>
                                <h5 className="text-xs font-bold text-amber-300 mb-1">Limited Data Available</h5>
                                <p className="text-xs text-gray-400 leading-relaxed">
                                    We don't have detailed clearance procedures for {activeCountryName} in our database
                                    yet. Below is the AI-generated information from your passage plan. Always verify
                                    with the relevant authorities before departure.
                                </p>
                            </div>
                        </div>
                    </div>

                    {activeTab === 'depart' && customs?.departureProcedures && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                            <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-2">
                                Departure Procedures — {departCountry}
                            </h4>
                            <p className="text-xs text-gray-300 leading-relaxed">{customs.departureProcedures}</p>
                        </div>
                    )}

                    {activeTab === 'arrive' && customs?.procedures && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                            <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-2">
                                Arrival Procedures — {arriveCountry}
                            </h4>
                            <p className="text-xs text-gray-300 leading-relaxed">{customs.procedures}</p>
                        </div>
                    )}

                    {customs?.contactPhone && (
                        <div className="bg-white/5 border border-white/[0.06] rounded-xl px-4 py-3">
                            <div className="flex items-center gap-2 text-emerald-400">
                                <PhoneIcon className="w-3.5 h-3.5" />
                                <a
                                    href={`tel:${customs.contactPhone}`}
                                    className="text-sm font-mono hover:text-emerald-300 transition-colors"
                                >
                                    {customs.contactPhone}
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
