/**
 * MedicalFirstAidCard — Crew medical info & first aid kit compliance for Passage Planning.
 *
 * Covers crew allergies/medications, emergency contacts, and first aid kit
 * classification based on passage type (coastal, offshore, ocean).
 * Australian Maritime Safety standards for kit categories.
 */

import React, { useEffect, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync, useScopedReadinessStorageState } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface MedicalFirstAidCardProps {
    voyageId?: string;
    onReviewedChange?: (reviewed: boolean) => void;
}

const STORAGE_KEY = 'thalassa_medical_firstaid';

/* ── Kit Classifications ── */

interface KitCategory {
    key: string;
    name: string;
    description: string;
    color: string;
    items: string[];
}

/** Kit-tab chrome, keyed by the category's colour. Module constants: these
 *  were literals rebuilt inside the render loops of a card that re-renders on
 *  every checklist tap. */
const KIT_TAB_CLASSES: Record<string, { selected: string; idle: string }> = {
    sky: { selected: 'bg-sky-500/15 border-sky-500/30 text-sky-300', idle: 'bg-white/3 border-white/8 text-gray-400' },
    amber: {
        selected: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
        idle: 'bg-white/3 border-white/8 text-gray-400',
    },
    red: { selected: 'bg-red-500/15 border-red-500/30 text-red-300', idle: 'bg-white/3 border-white/8 text-gray-400' },
};

const KIT_COLOR_STYLES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    sky: { bg: 'bg-sky-500/4', border: 'border-sky-500/15', text: 'text-sky-400', dot: 'bg-sky-400' },
    amber: { bg: 'bg-amber-500/4', border: 'border-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400' },
    red: { bg: 'bg-red-500/4', border: 'border-red-500/15', text: 'text-red-400', dot: 'bg-red-400' },
};

/** Telemedical advice services, by country. */
const TELEMED_PRESETS = [
    { label: '🇦🇺 AMSA', number: '+61 2 6230 6811' },
    { label: '🇮🇹 CIRM Rome', number: '+39 06 5923 0858' },
    { label: '🇺🇸 USCG', number: '+1 301 295 8104' },
    { label: '🇳🇿 RCCNZ', number: '+64 4 577 8030' },
];

const KIT_CATEGORIES: KitCategory[] = [
    {
        key: 'cat_c',
        name: 'Category C — Coastal',
        description: 'Within 15 NM of safe haven · Day trips & coastal sailing',
        color: 'sky',
        items: [
            'Adhesive bandages (assorted)',
            'Triangular bandages ×2',
            'Sterile wound dressings',
            'Adhesive tape',
            'Disposable gloves',
            'CPR face shield',
            'Scissors & tweezers',
            'Antiseptic wipes',
            'Seasickness tablets',
            'Sunburn cream',
        ],
    },
    {
        key: 'cat_b',
        name: 'Category B — Offshore',
        description: 'Within 200 NM of safe haven · Overnight & multi-day coastal',
        color: 'amber',
        items: [
            'Everything in Cat C plus:',
            'SAM splints / air splints',
            'Cervical collar',
            'Burn dressings (gel type)',
            'Oral rehydration salts',
            'Eye wash & eye pads',
            'Emergency thermal blankets ×2',
            'Broad-spectrum antibiotics',
            'Strong analgesics (prescription)',
            'Injectable adrenaline (EpiPen)',
            'Suture kit / wound closure strips',
            "Ship Captain's Medical Guide",
        ],
    },
    {
        key: 'cat_a',
        name: 'Category A — Ocean',
        description: 'Beyond 200 NM · Bluewater & transoceanic passages',
        color: 'red',
        items: [
            'Everything in Cat B plus:',
            'IV cannulation kit & fluids',
            'Chest seal (Hyfin/Asherman)',
            'Tourniquet (CAT type)',
            'Dental emergency kit',
            'Urinary catheter kit',
            'Prescription pain management',
            'Broad-spectrum injectable antibiotics',
            'Stethoscope & BP cuff',
            'Pulse oximeter',
            'Telemedical advice contact (see below)',
            'Extended medical guide (WHO IMGS)',
        ],
    },
];

/* ── Checklist Items ── */

const CHECKLIST_ITEMS = [
    {
        key: 'crew_allergies',
        icon: '⚠️',
        label: 'Crew allergies & medications recorded',
        detail: 'All crew have declared allergies, current medications, and medical conditions',
        critical: true,
    },
    {
        key: 'blood_types',
        icon: '🩸',
        label: 'Blood types recorded',
        detail: 'Blood type for each crew member is documented',
        critical: true,
    },
    {
        key: 'next_of_kin',
        icon: '📞',
        label: 'Emergency contacts / next of kin',
        detail: 'Each crew member has a nominated emergency contact on file',
        critical: true,
    },
    {
        key: 'medical_fitness',
        icon: '💪',
        label: 'Crew medical fitness declared',
        detail: 'All crew have confirmed they are fit to make this passage',
        critical: true,
    },
    {
        key: 'kit_onboard',
        icon: '🏥',
        label: 'Appropriate first aid kit on board',
        detail: 'Kit category matches passage type (see classification below)',
        critical: true,
    },
    {
        key: 'kit_checked',
        icon: '📋',
        label: 'Kit contents checked & in date',
        detail: 'All items present, medications not expired, dressings sterile',
        critical: true,
    },
    {
        key: 'epipen',
        icon: '💉',
        label: 'EpiPen / anaphylaxis kit (if needed)',
        detail: 'On board if any crew has known severe allergies',
        critical: false,
    },
    {
        key: 'seasickness',
        icon: '🤢',
        label: 'Seasickness medication available',
        detail: 'Stugeron, Kwells, patches — available before departure',
        critical: false,
    },
    {
        key: 'first_aid_trained',
        icon: '🎓',
        label: 'First aid trained crew identified',
        detail: 'At least one crew member holds a current first aid certificate',
        critical: true,
    },
];

export const MedicalFirstAidCard: React.FC<MedicalFirstAidCardProps> = ({ voyageId, onReviewedChange }) => {
    const [checkedItems, setCheckedItems] = useScopedReadinessStorageState<Record<string, boolean>>(
        STORAGE_KEY,
        voyageId,
        {},
    );
    const [selectedKit, setSelectedKit] = useScopedReadinessStorageState<string>(`${STORAGE_KEY}_kit`, voyageId, '');
    const [telemedNumber, setTelemedNumber] = useScopedReadinessStorageState<string>(
        `${STORAGE_KEY}_telemed`,
        voyageId,
        '',
    );

    const { syncCheck } = useReadinessSync(voyageId, 'medical', checkedItems, setCheckedItems, STORAGE_KEY);

    const criticalItems = CHECKLIST_ITEMS.filter((i) => i.critical);
    const allCriticalDone = criticalItems.every((i) => checkedItems[i.key]);
    const checkedCount = CHECKLIST_ITEMS.filter((i) => checkedItems[i.key]).length;

    const toggleItem = useCallback(
        (key: string) => {
            setCheckedItems((prev) => {
                const next = { ...prev, [key]: !prev[key] };
                syncCheck(key, next[key]);
                return next;
            });
            triggerHaptic('light');
        },
        [setCheckedItems, syncCheck],
    );

    const selectKit = useCallback(
        (key: string) => {
            setSelectedKit(key);
            triggerHaptic('light');
        },
        [setSelectedKit],
    );

    const updateTelemedNumber = useCallback(
        (value: string) => {
            setTelemedNumber(value);
        },
        [setTelemedNumber],
    );

    useEffect(() => {
        onReviewedChange?.(allCriticalDone);
    }, [allCriticalDone, onReviewedChange]);

    return (
        <div className="space-y-4">
            {/* ── Medical Checklist ── */}
            <div className="bg-white/3 border border-white/6 rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    🏥 Medical & Emergency
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            allCriticalDone
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-red-500/10 border-red-500/20 text-red-400'
                        }`}
                    >
                        {checkedCount}/{CHECKLIST_ITEMS.length}
                    </span>
                </h4>
                <div className="space-y-1.5">
                    {CHECKLIST_ITEMS.map((item) => {
                        const isChecked = !!checkedItems[item.key];
                        return (
                            <button
                                key={item.key}
                                onClick={() => toggleItem(item.key)}
                                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                                    isChecked
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : item.critical
                                          ? 'bg-red-500/5 border border-red-500/15 hover:bg-red-500/10'
                                          : 'bg-white/2 border border-white/6 hover:bg-white/5'
                                }`}
                            >
                                <div
                                    className={`w-[18px] h-[18px] mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                        isChecked
                                            ? 'bg-emerald-500 border-emerald-500'
                                            : item.critical
                                              ? 'border-red-500/50 bg-transparent'
                                              : 'border-gray-500 bg-transparent'
                                    }`}
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
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                        <span className="text-sm">{item.icon}</span>
                                        <span
                                            className={`text-xs font-bold ${
                                                isChecked ? 'text-emerald-300' : 'text-white'
                                            }`}
                                        >
                                            {item.label}
                                        </span>
                                    </div>
                                    <p
                                        className={`text-[11px] leading-relaxed ${
                                            isChecked ? 'text-emerald-400/50 line-through' : 'text-gray-400'
                                        }`}
                                    >
                                        {item.detail}
                                    </p>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Kit Classification Selector ── */}
            <div className="bg-white/3 border border-white/6 rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-1">
                    🧰 First Aid Kit Classification
                </h4>
                <p className="text-[11px] text-gray-400 mb-3">Select your passage type to see required kit contents</p>

                {/* Kit type selector */}
                <div className="flex gap-2 mb-3">
                    {KIT_CATEGORIES.map((cat) => {
                        const isSelected = selectedKit === cat.key;
                        const tab = KIT_TAB_CLASSES[cat.color];
                        return (
                            <button
                                key={cat.key}
                                onClick={() => selectKit(cat.key)}
                                aria-pressed={isSelected}
                                className={`min-h-[44px] flex-1 py-2 px-2 rounded-xl text-center border transition-all active:scale-[0.97] ${
                                    isSelected ? tab.selected : tab.idle
                                }`}
                            >
                                <span className="text-[11px] font-bold uppercase tracking-wider block">
                                    {cat.key === 'cat_c' ? 'Coastal' : cat.key === 'cat_b' ? 'Offshore' : 'Ocean'}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* Selected kit contents */}
                {selectedKit &&
                    (() => {
                        const cat = KIT_CATEGORIES.find((c) => c.key === selectedKit);
                        if (!cat) return null;
                        const style = KIT_COLOR_STYLES[cat.color];
                        return (
                            <div className={`${style.bg} border ${style.border} rounded-xl p-3`}>
                                <h5 className={`text-xs font-bold ${style.text} mb-1`}>{cat.name}</h5>
                                <p className="text-[11px] text-gray-400 mb-2">{cat.description}</p>
                                <div className="space-y-1">
                                    {cat.items.map((item, i) => (
                                        <div key={i} className="flex items-start gap-2">
                                            <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${style.dot}`} />
                                            <span className="text-[11px] text-gray-300">{item}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })()}
            </div>

            {/* ── Telemedical Contact ── */}
            <div className="bg-white/3 border border-white/6 rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-1 flex items-center gap-2">
                    📞 Telemedical Advice (TMAS)
                </h4>
                <p className="text-[11px] text-gray-400 mb-3">
                    International format with country code (e.g. +61 2 9373 4000)
                </p>
                <input
                    type="tel"
                    value={telemedNumber}
                    onChange={(e) => updateTelemedNumber(e.target.value)}
                    placeholder="+__ ___ ___ ____"
                    className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-white/4 border border-white/8 text-white text-sm font-mono placeholder:text-gray-500 focus:outline-hidden focus:border-sky-500/30 focus:bg-sky-500/3 transition-all"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {TELEMED_PRESETS.map((preset) => (
                        <button
                            key={preset.number}
                            onClick={() => {
                                updateTelemedNumber(preset.number);
                                triggerHaptic('light');
                            }}
                            className={`px-2 py-1 min-h-[44px] rounded-lg text-[11px] font-bold uppercase tracking-wider border transition-all active:scale-[0.97] ${
                                telemedNumber === preset.number
                                    ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                    : 'bg-white/3 border-white/8 text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Summary ── */}
            <div
                className={`flex items-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                    allCriticalDone ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/15'
                }`}
            >
                <span className="text-lg">{allCriticalDone ? '✅' : '🏥'}</span>
                <div>
                    <p className={`text-xs font-bold ${allCriticalDone ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {allCriticalDone
                            ? 'Medical readiness confirmed'
                            : `${criticalItems.length - criticalItems.filter((i) => checkedItems[i.key]).length} critical items remaining`}
                    </p>
                    <p
                        className={`text-[11px] mt-0.5 ${allCriticalDone ? 'text-emerald-400/60' : 'text-amber-400/60'}`}
                    >
                        {allCriticalDone
                            ? 'Crew medical info recorded · Kit verified'
                            : 'All critical medical items must be confirmed'}
                    </p>
                </div>
            </div>
        </div>
    );
};
