/**
 * CustomsClearanceCard — Comprehensive maritime customs & clearance guide.
 *
 * Country-specific procedures, contacts, required documents, yacht export rules,
 * and links to detailed walkthroughs. This is where Thalassa shines — giving
 * sailors exactly the info they need for the bureaucratic circus of international sailing.
 *
 * The tabs, flags and port-of-entry check come from the synchronous port
 * index (data/customsPortIndex.ts). The guide itself (29 countries of
 * procedures, contacts and documents) is a packaged data file loaded the
 * first time a card opens (data/customsDb.ts, build-126 bundle diet), so
 * the card shows a loading line for that moment, never "Limited Data".
 *
 * When neither port is one the index can place, the card says it cannot
 * tell whether the passage crosses a border, and gives the skipper one check
 * to tick instead of a document list (130-09).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { VoyagePlan } from '../../types';
import { PhoneIcon, RadioTowerIcon, AlertTriangleIcon, ExternalLinkIcon, MapPinIcon } from '../Icons';
import { findCountryData, difficultyStyle, loadCustomsClearance, peekCustomsClearance } from '../../data/customsDb';
import { CUSTOMS_PORT_INDEX, findCountryKey, isPortOfEntry, placesNeither } from '../../data/customsPortIndex';
import { useReadinessSync, useScopedReadinessStorageState } from '../../hooks/useReadinessSync';
import { safeExternalHttpUrl } from '../../utils/safeUrl';

/** The one item to tick when neither port is one the index can place
 *  (130-09): the skipper's own check of whether the passage crosses a border. */
const BORDER_CHECK_KEY = 'border:checked';

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */

interface CustomsClearanceCardProps {
    voyageId?: string;
    voyagePlan: VoyagePlan;
    /** Callback with (totalDocs, checkedDocs) whenever checked state changes */
    onCheckedChange?: (total: number, checked: number) => void;
}

export const CustomsClearanceCard: React.FC<CustomsClearanceCardProps> = ({
    voyageId,
    voyagePlan,
    onCheckedChange,
}) => {
    const customs = voyagePlan.customs;
    const [activeTab, setActiveTab] = useState<'depart' | 'arrive'>('depart');
    const [checkedDocs, setCheckedDocs] = useScopedReadinessStorageState<Record<string, boolean>>(
        'thalassa_customs_docs',
        voyageId,
        {},
    );

    const { syncCheck } = useReadinessSync(
        voyageId,
        'customs_clearance',
        checkedDocs,
        setCheckedDocs,
        'thalassa_customs_docs',
    );

    const toggleDoc = useCallback(
        (key: string) => {
            setCheckedDocs((prev) => {
                const next = { ...prev, [key]: !prev[key] };
                syncCheck(key, next[key]);
                return next;
            });
        },
        [setCheckedDocs, syncCheck],
    );

    // Notify parent of checked state changes. Deps are the PRIMITIVE customs
    // fields, not the customs object: the parent rebuilds voyagePlan inline
    // every render, and an object dep re-fired this effect per parent render.
    const customsRequired = customs?.required ?? false;
    const customsDepartCountry = customs?.departingCountry ?? '';
    const customsArriveCountry = customs?.destinationCountry ?? '';

    // The clearance guide, from memory if an earlier card loaded it.
    const [guide, setGuide] = useState(peekCustomsClearance);
    const [guideFailed, setGuideFailed] = useState(false);
    useEffect(() => {
        if (guide || !customsRequired) return;
        let live = true;
        loadCustomsClearance().then(
            (loaded) => {
                if (live) setGuide(loaded);
            },
            () => {
                if (live) setGuideFailed(true);
            },
        );
        return () => {
            live = false;
        };
    }, [guide, customsRequired]);

    useEffect(() => {
        if (!onCheckedChange || !customsRequired) return;
        // Neither port is one the index can place, so there is no guide to
        // follow: the skipper's own border check is the one item (130-09).
        if (placesNeither(customsDepartCountry, customsArriveCountry)) {
            onCheckedChange(1, checkedDocs[BORDER_CHECK_KEY] ? 1 : 0);
            return;
        }
        // No count until there are documents to count: the guide holds them.
        if (!guide) return;
        const departData = findCountryData(customsDepartCountry, guide);
        const arriveData = findCountryData(customsArriveCountry, guide);
        const allDocs = [
            ...(departData?.requiredDocuments || []).map((d) => `depart:${d.name}`),
            ...(arriveData?.requiredDocuments || []).map((d) => `arrive:${d.name}`),
        ];
        const total = allDocs.length;
        const checked = allDocs.filter((k) => checkedDocs[k]).length;
        onCheckedChange(total, checked);
    }, [checkedDocs, customsRequired, customsDepartCountry, customsArriveCountry, onCheckedChange, guide]);

    if (!customs?.required) return null;

    // The plan's customs.departingCountry / destinationCountry can
    // arrive as either a country name ('Australia') or a port string
    // ('Newport, QLD', 'Sydney'). findCountryKey places both, by whole
    // words (130-09), so we get the country data regardless. For the
    // user-facing labels and POE check we keep the original port input
    // on hand too.
    const departInput = customs.departingCountry;
    const arriveInput = customs.destinationCountry;
    // Name, flag and ports of entry from the index, at once; the rest of
    // the record once the guide has loaded.
    const departKey = findCountryKey(departInput);
    const arriveKey = findCountryKey(arriveInput);
    const departIndex = departKey ? CUSTOMS_PORT_INDEX[departKey] : undefined;
    const arriveIndex = arriveKey ? CUSTOMS_PORT_INDEX[arriveKey] : undefined;
    const departData = findCountryData(departInput, guide);
    const arriveData = findCountryData(arriveInput, guide);

    // Display name: prefer the resolved country (e.g. 'Australia') over
    // the raw port input ('Newport, QLD'). Falls back to the input if
    // the country couldn't be resolved.
    const departLabel = departIndex?.country || departInput || 'Departure';
    const arriveLabel = arriveIndex?.country || arriveInput || 'Arrival';

    // Whether the user's typed port is a designated port of entry for the
    // resolved country. If not, the user must clear at one of the listed
    // POEs — not the port they're sitting at. Matched as whole words, as
    // the country is: 'Port Moselle, NC' is 'Nouméa (Port Moselle)'.
    const departPortIsPOE = isPortOfEntry(departInput, departKey);
    const arrivePortIsPOE = isPortOfEntry(arriveInput, arriveKey);
    // Neither port is one the index can place: we cannot tell whether this
    // passage crosses a border, and say so rather than guess (130-09).
    const neitherPortKnown = placesNeither(departInput, arriveInput);
    const borderChecked = !!checkedDocs[BORDER_CHECK_KEY];

    // Which clearance data to show
    const activeData = activeTab === 'depart' ? departData : arriveData;
    // The country and its ports of entry, from the index: ready on the first
    // paint, and still there when the guide cannot be read.
    const activeIndex = activeTab === 'depart' ? departIndex : arriveIndex;
    // A covered country whose guide is still on its way, or could not be read.
    const activeCovered = Boolean(activeIndex);
    const guideLoading = activeCovered && !guide && !guideFailed;
    const guideUnavailable = activeCovered && guideFailed;
    const activeCountryName = activeTab === 'depart' ? departLabel : arriveLabel;
    const activePortInput = activeTab === 'depart' ? departInput : arriveInput;
    const activePortIsPOE = activeTab === 'depart' ? departPortIsPOE : arrivePortIsPOE;
    const activeGuideUrl = safeExternalHttpUrl(activeData?.guideUrl, true);

    return (
        <div className="space-y-4">
            {/* ── Country Tabs ── */}
            <div className="flex gap-2 bg-white/3 rounded-xl p-1 border border-white/6">
                {departInput && (
                    <button
                        aria-label={`Departing ${departLabel}`}
                        onClick={() => setActiveTab('depart')}
                        className={`flex-1 min-h-[44px] py-2.5 px-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
                            activeTab === 'depart'
                                ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30 shadow-lg shadow-sky-500/10'
                                : 'text-gray-400 hover:text-gray-300 hover:bg-white/5 border border-transparent'
                        }`}
                    >
                        {departIndex?.flag || '🚢'} Departing {departLabel}
                    </button>
                )}
                <button
                    aria-label={`Arriving ${arriveLabel}`}
                    onClick={() => setActiveTab('arrive')}
                    className={`flex-1 min-h-[44px] py-2.5 px-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
                        activeTab === 'arrive'
                            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-lg shadow-emerald-500/10'
                            : 'text-gray-400 hover:text-gray-300 hover:bg-white/5 border border-transparent'
                    }`}
                >
                    {arriveIndex?.flag || '🏁'} Arriving {arriveLabel}
                </button>
            </div>

            {/* ── POE warning ────────────────────────────────────────
                User's actual port isn't a designated port of entry —
                they MUST clear at one of the country's POEs. Without
                this banner the user sees Australia's clearance info
                and assumes they can do it from Newport, when really
                they need to detour to Brisbane / Bundaberg / etc.
                Where the guide lists only some of a country's ports of
                entry (the United States), a port it leaves out may still
                be one: the banner says the guide can't tell and whom to
                ask, and sends the skipper nowhere (132-B23 review). */}
            {activeIndex && activePortInput && !activePortIsPOE && activeIndex.portsOfEntry.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl p-4">
                    <div className="flex items-start gap-3">
                        <span className="text-xl">⚠️</span>
                        {activeIndex.checkOtherPortsWith ? (
                            <div className="flex-1">
                                <p className="text-xs font-bold text-amber-300 uppercase tracking-widest mb-1">
                                    {activePortInput} isn't one of the ports this guide lists
                                </p>
                                <p className="text-[11px] text-amber-200/90 leading-relaxed">
                                    {`This guide lists only some of this country's ports of entry, so ${activePortInput} may still be one. Check with ${activeIndex.checkOtherPortsWith} ${
                                        activeTab === 'depart'
                                            ? 'before you leave.'
                                            : 'where to report when you arrive.'
                                    }`}
                                </p>
                            </div>
                        ) : (
                            <div className="flex-1">
                                <p className="text-xs font-bold text-amber-300 uppercase tracking-widest mb-1">
                                    {activePortInput} is not a designated port of entry
                                </p>
                                <p className="text-[11px] text-amber-200/90 leading-relaxed mb-2">
                                    {activeTab === 'depart'
                                        ? `You'll need to clear out at one of ${activeIndex.country}'s designated ports of entry before departing internationally:`
                                        : `You'll need to clear in at one of ${activeIndex.country}'s designated ports of entry on arrival — flying the Q flag until cleared:`}
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {activeIndex.portsOfEntry.map((port, i) => (
                                        <span
                                            key={i}
                                            className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-full px-2.5 py-1"
                                        >
                                            {port}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

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
                    <div className="bg-white/3 border border-white/6 rounded-xl p-4">
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
                            {activeGuideUrl && (
                                <a
                                    href={activeGuideUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    referrerPolicy="no-referrer"
                                    className="mt-3 flex items-center gap-2 w-fit px-4 py-2.5 bg-linear-to-r from-sky-500/20 to-indigo-500/20 hover:from-sky-500/30 hover:to-indigo-500/30 border border-sky-500/30 rounded-xl text-xs font-bold text-sky-300 hover:text-white transition-all active:scale-[0.98] shadow-lg shadow-sky-500/10"
                                >
                                    <ExternalLinkIcon className="w-3.5 h-3.5" />
                                    {activeData.guideLabel || 'View Complete Guide'}
                                </a>
                            )}
                        </div>
                    )}

                    {/* ── Guide Link (if not yacht export) ── */}
                    {activeGuideUrl && !(activeTab === 'depart' && activeData.yachtExport) && (
                        <a
                            href={activeGuideUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            className="flex items-center gap-2 w-fit px-4 py-2.5 bg-linear-to-r from-sky-500/20 to-indigo-500/20 hover:from-sky-500/30 hover:to-indigo-500/30 border border-sky-500/30 rounded-xl text-xs font-bold text-sky-300 hover:text-white transition-all active:scale-[0.98]"
                        >
                            <ExternalLinkIcon className="w-3.5 h-3.5" />
                            {activeData.guideLabel || 'View Complete Guide'}
                        </a>
                    )}

                    {/* ── Required Documents (Checklist) ── */}
                    <div className="bg-white/3 border border-white/6 rounded-xl p-4">
                        <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                            📄 Required Documents
                            <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-500/10 border border-sky-500/20 text-sky-400">
                                {
                                    activeData.requiredDocuments.filter((d) => checkedDocs[`${activeTab}:${d.name}`])
                                        .length
                                }
                                /{activeData.requiredDocuments.length}
                            </span>
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {activeData.requiredDocuments.map((doc, i) => {
                                const key = `${activeTab}:${doc.name}`;
                                const isChecked = !!checkedDocs[key];
                                return (
                                    <button
                                        key={i}
                                        onClick={() => toggleDoc(key)}
                                        className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs text-left transition-all active:scale-[0.98] ${
                                            isChecked
                                                ? 'bg-emerald-500/10 border border-emerald-500/20'
                                                : doc.critical
                                                  ? 'bg-amber-500/5 border border-amber-500/15 hover:bg-amber-500/10'
                                                  : 'bg-white/5 border border-white/5 hover:bg-white/8'
                                        }`}
                                    >
                                        <div
                                            className={`w-4.5 h-4.5 mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                                isChecked
                                                    ? 'bg-emerald-500 border-emerald-500'
                                                    : doc.critical
                                                      ? 'border-amber-500/50 bg-transparent'
                                                      : 'border-gray-500 bg-transparent'
                                            }`}
                                            style={{ width: 18, height: 18 }}
                                        >
                                            {isChecked && (
                                                <svg
                                                    className="w-3 h-3 text-white"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={3}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M4.5 12.75l6 6 9-13.5"
                                                    />
                                                </svg>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <span
                                                className={`${
                                                    isChecked
                                                        ? 'text-emerald-300 line-through opacity-70'
                                                        : doc.critical
                                                          ? 'text-amber-200 font-bold'
                                                          : 'text-gray-300'
                                                }`}
                                            >
                                                {doc.name}
                                            </span>
                                            {doc.notes && (
                                                <div className="text-[11px] text-gray-400 mt-0.5">{doc.notes}</div>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── Contacts ── */}
                    <div className="bg-white/3 border border-white/6 rounded-xl p-4">
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
                                                className="flex items-center gap-1.5 min-h-[44px] text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                                            >
                                                <PhoneIcon className="w-3 h-3 shrink-0" />
                                                <span className="font-mono">{contact.phone}</span>
                                            </a>
                                        )}
                                        {contact.email && (
                                            <a
                                                href={`mailto:${contact.email}`}
                                                className="flex items-center gap-1.5 min-h-[44px] text-xs text-sky-400 hover:text-sky-300 transition-colors"
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
                                        {(() => {
                                            const website = safeExternalHttpUrl(contact.website, true);
                                            return website ? (
                                                <a
                                                    href={website}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    referrerPolicy="no-referrer"
                                                    className="flex items-center gap-1 min-h-[44px] text-xs text-gray-400 hover:text-white transition-colors"
                                                >
                                                    <ExternalLinkIcon className="w-3 h-3 shrink-0" />
                                                    <span className="truncate max-w-[180px]">Website</span>
                                                </a>
                                            ) : null;
                                        })()}
                                    </div>
                                    {contact.notes && (
                                        <div className="text-[11px] text-gray-400 mt-1">{contact.notes}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* ── Ports of Entry ── */}
                    <div className="bg-white/3 border border-white/6 rounded-xl p-4">
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
            ) : guideLoading ? (
                /* ── The guide is loading (first card this session) ── */
                <p role="status" className="px-1 py-3 text-xs text-gray-400">
                    Loading the clearance guide for {activeCountryName}…
                </p>
            ) : (
                /* ── Fallback: Gemini AI data only (country not in our DB, or the guide could not be read) ── */
                <div className="space-y-4">
                    <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-4">
                        <div className="flex items-start gap-2.5">
                            <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                            <div>
                                <h5 className="text-xs font-bold text-amber-300 mb-1">
                                    {neitherPortKnown
                                        ? "Can't Tell If This Passage Crosses a Border"
                                        : guideUnavailable
                                          ? 'Clearance Guide Unavailable'
                                          : 'Limited Data Available'}
                                </h5>
                                <p className="text-xs text-gray-400 leading-relaxed">
                                    {neitherPortKnown ? (
                                        `We don't recognise ${departInput} or ${arriveInput}, so we can't tell whether they are in the same country. If this passage leaves the country, you'll need to clear out before you go and clear in at a port of entry when you arrive.`
                                    ) : (
                                        <>
                                            {guideUnavailable
                                                ? `The clearance guide could not be loaded just now, so the procedures for ${activeCountryName} are not shown.`
                                                : `We don't have detailed clearance procedures for ${activeCountryName} in our database yet.`}{' '}
                                            Below is the AI-generated information from your passage plan. Always verify
                                            with the relevant authorities before departure.
                                        </>
                                    )}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* ── The skipper's own border check (130-09): the one item
                        to tick when neither port is one we can place, so an
                        unknown passage is neither waved through as domestic
                        nor locked out of Cast Off. ── */}
                    {neitherPortKnown && (
                        <button
                            type="button"
                            aria-pressed={borderChecked}
                            onClick={() => toggleDoc(BORDER_CHECK_KEY)}
                            className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs text-left transition-all active:scale-[0.98] ${
                                borderChecked
                                    ? 'bg-emerald-500/10 border border-emerald-500/20'
                                    : 'bg-amber-500/5 border border-amber-500/15 hover:bg-amber-500/10'
                            }`}
                        >
                            <div
                                className={`mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                    borderChecked ? 'bg-emerald-500 border-emerald-500' : 'border-amber-500/50'
                                }`}
                                style={{ width: 18, height: 18 }}
                            >
                                {borderChecked && (
                                    <svg
                                        className="w-3 h-3 text-white"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={3}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                    </svg>
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <span className={borderChecked ? 'text-emerald-300' : 'text-amber-200 font-bold'}>
                                    I've checked whether this passage crosses a border
                                </span>
                                <div className="text-[11px] text-gray-400 mt-0.5">
                                    If it does, I know where to clear out and where to clear in.
                                </div>
                            </div>
                        </button>
                    )}

                    {activeTab === 'depart' && customs?.departureProcedures && (
                        <div className="bg-white/3 border border-white/6 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-2">
                                Departure Procedures — {departLabel}
                            </h4>
                            <p className="text-xs text-gray-300 leading-relaxed">{customs.departureProcedures}</p>
                        </div>
                    )}

                    {activeTab === 'arrive' && customs?.procedures && (
                        <div className="bg-white/3 border border-white/6 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-2">
                                Arrival Procedures — {arriveLabel}
                            </h4>
                            <p className="text-xs text-gray-300 leading-relaxed">{customs.procedures}</p>
                        </div>
                    )}

                    {customs?.contactPhone && (
                        <div className="bg-white/5 border border-white/6 rounded-xl px-4 py-3">
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
