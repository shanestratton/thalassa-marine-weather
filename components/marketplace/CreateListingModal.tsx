/**
 * CreateListingModal — Create a new marketplace listing
 * Extracted from MarketplacePage for code organization.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    MarketplaceService,
    MarketplaceListing,
    ListingCategory,
    LISTING_CATEGORIES,
    LISTING_CONDITIONS,
    CATEGORY_ICONS,
    CreateListingInput,
    HullMaterial,
    EngineType,
    FuelType,
    HULL_MATERIALS,
    ENGINE_TYPES,
    FUEL_TYPES,
    BOAT_FEATURES,
} from '../../services/MarketplaceService';
import { BgGeoManager } from '../../services/BgGeoManager';
import { Capacitor } from '@capacitor/core';
import { haversineNm, getConditionColor, MAX_PHOTOS } from './helpers';
import { sanitizeText, validateListingTitle, validatePrice, validateDescription } from '../../utils/inputValidation';

interface CreateListingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (listing: MarketplaceListing) => void;
}

const CreateListingModal: React.FC<CreateListingModalProps> = ({ isOpen, onClose, onCreated }) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [price, setPrice] = useState('');
    const [currency, setCurrency] = useState<string>('AUD');
    const [category, setCategory] = useState<ListingCategory | null>(null);
    const [condition, setCondition] = useState<string | null>(null);
    const [locCountry, setLocCountry] = useState('');
    const [locState, setLocState] = useState('');
    const [locSuburb, setLocSuburb] = useState('');
    const [images, setImages] = useState<File[]>([]);
    const [imagePreviews, setImagePreviews] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'details' | 'photos'>('details');
    const [gpsLat, setGpsLat] = useState<number | null>(null);
    const [gpsLon, setGpsLon] = useState<number | null>(null);
    const [locationWarning, setLocationWarning] = useState<string | null>(null);
    const autoFilledLocRef = useRef<{ lat: number; lon: number } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // ── Keyboard height detection — same pattern as DiaryPage/AuthModal ──
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    useEffect(() => {
        if (!isOpen) {
            setKeyboardHeight(0);
            return;
        }
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard')
                .then(({ Keyboard }) => {
                    const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                        setKeyboardHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                        // Scroll focused input into view WITHIN the scroll container only
                        setTimeout(() => {
                            const focused = document.activeElement as HTMLElement;
                            const container = scrollRef.current;
                            if (!focused || !container) return;
                            if (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') return;
                            // Calculate position of focused element relative to scroll container
                            const focusRect = focused.getBoundingClientRect();
                            const containerRect = container.getBoundingClientRect();
                            const offsetInContainer = focusRect.top - containerRect.top + container.scrollTop;
                            // Scroll so the input sits roughly 1/3 from the top of the container
                            const targetScroll = offsetInContainer - containerRect.height * 0.3;
                            container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
                        }, 50);
                    });
                    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                        setKeyboardHeight(0);
                    });
                    cleanup = () => {
                        showHandle.then((h) => h.remove());
                        hideHandle.then((h) => h.remove());
                    };
                })
                .catch(() => {
                    /* Keyboard plugin not available */
                });
        } else {
            const vp = window.visualViewport;
            if (vp) {
                const handleResize = () => {
                    const kbHeight = window.innerHeight - vp.height;
                    setKeyboardHeight(kbHeight > 50 ? kbHeight : 0);
                };
                vp.addEventListener('resize', handleResize);
                cleanup = () => vp.removeEventListener('resize', handleResize);
            }
        }

        return () => {
            cleanup?.();
            setKeyboardHeight(0);
        };
    }, [isOpen]);

    // ── Boat-specific state ──
    const [boatMake, setBoatMake] = useState('');
    const [boatModel, setBoatModel] = useState('');
    const [boatYear, setBoatYear] = useState('');
    const [boatLoa, setBoatLoa] = useState('');
    const [boatBeam, setBoatBeam] = useState('');
    const [boatDraft, setBoatDraft] = useState('');
    const [boatHull, setBoatHull] = useState<HullMaterial | null>(null);
    const [boatEngineType, setBoatEngineType] = useState<EngineType | null>(null);
    const [boatEngineMake, setBoatEngineMake] = useState('');
    const [boatHp, setBoatHp] = useState('');
    const [boatHours, setBoatHours] = useState('');
    const [boatFuel, setBoatFuel] = useState<FuelType | null>(null);
    const [boatBerths, setBoatBerths] = useState('');
    const [boatCabins, setBoatCabins] = useState('');
    const [boatHeads, setBoatHeads] = useState('');
    const [boatRego, setBoatRego] = useState('');
    const [boatSurveyed, setBoatSurveyed] = useState(false);
    const [boatFeatures, setBoatFeatures] = useState<string[]>([]);

    const isBoat = category === 'Boats';

    // Get GPS + auto-fill location on open
    useEffect(() => {
        if (!isOpen) return;
        const pos = BgGeoManager.getLastPosition();
        if (pos) {
            setGpsLat(pos.latitude);
            setGpsLon(pos.longitude);
            autoFilledLocRef.current = { lat: pos.latitude, lon: pos.longitude };
            // Reverse-geocode to auto-fill Country / State / Suburb
            fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${pos.latitude}&lon=${pos.longitude}&format=json&zoom=10`,
            )
                .then((r) => r.json())
                .then((data) => {
                    if (data?.address) {
                        setLocCountry(data.address.country || '');
                        setLocState(data.address.state || data.address.region || '');
                        setLocSuburb(
                            data.address.suburb || data.address.town || data.address.city || data.address.village || '',
                        );
                    }
                })
                .catch(() => {
                    /* best effort */
                });
        }
    }, [isOpen]);

    /** Check if user-edited location is suspiciously far from GPS */
    const checkLocationDistance = useCallback(async (country: string, state: string, suburb: string) => {
        if (!autoFilledLocRef.current) {
            setLocationWarning(null);
            return;
        }
        const query = [suburb, state, country].filter(Boolean).join(', ');
        if (!query) {
            setLocationWarning(null);
            return;
        }
        try {
            const r = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
            );
            const results = await r.json();
            if (results?.[0]) {
                const dist = haversineNm(
                    autoFilledLocRef.current.lat,
                    autoFilledLocRef.current.lon,
                    parseFloat(results[0].lat),
                    parseFloat(results[0].lon),
                );
                if (dist > 100) {
                    setLocationWarning(
                        `⚠️ This location is ~${Math.round(dist)}nm from your current GPS position. Buyers may see this as suspicious.`,
                    );
                } else {
                    setLocationWarning(null);
                }
            }
        } catch {
            setLocationWarning(null);
        }
    }, []);

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const newImages = [...images, ...files].slice(0, MAX_PHOTOS);
        setImages(newImages);
        // Generate previews
        const previews: string[] = [];
        for (const f of newImages) {
            previews.push(URL.createObjectURL(f));
        }
        setImagePreviews(previews);
    };

    const removeImage = (idx: number) => {
        const newImages = images.filter((_, i) => i !== idx);
        const newPreviews = imagePreviews.filter((_, i) => i !== idx);
        setImages(newImages);
        setImagePreviews(newPreviews);
    };

    const reset = () => {
        setTitle('');
        setDescription('');
        setPrice('');
        setCurrency('AUD');
        setCategory(null);
        setCondition(null);
        setLocCountry('');
        setLocState('');
        setLocSuburb('');
        setLocationWarning(null);
        autoFilledLocRef.current = null;
        setImages([]);
        setImagePreviews([]);
        setStep('details');
        setError(null);
        setSubmitting(false);
        // Boat fields
        setBoatMake('');
        setBoatModel('');
        setBoatYear('');
        setBoatLoa('');
        setBoatBeam('');
        setBoatDraft('');
        setBoatHull(null);
        setBoatEngineType(null);
        setBoatEngineMake('');
        setBoatHp('');
        setBoatHours('');
        setBoatFuel(null);
        setBoatBerths('');
        setBoatCabins('');
        setBoatHeads('');
        setBoatRego('');
        setBoatSurveyed(false);
        setBoatFeatures([]);
    };

    const handleSubmit = async () => {
        const titleCheck = validateListingTitle(title);
        if (!titleCheck.valid) {
            setError(titleCheck.error!);
            return;
        }
        const priceCheck = validatePrice(price);
        if (!priceCheck.valid) {
            setError(priceCheck.error!);
            return;
        }
        if (description) {
            const descCheck = validateDescription(description);
            if (!descCheck.valid) {
                setError(descCheck.error!);
                return;
            }
        }
        if (!category) {
            setError('Select a category');
            return;
        }
        if (!condition) {
            setError('Select condition');
            return;
        }

        setSubmitting(true);
        setError(null);

        const input: CreateListingInput = {
            title: sanitizeText(title),
            description: sanitizeText(description) || undefined,
            price: parseFloat(price),
            currency,
            category,
            condition: condition as any,
            images: images.length > 0 ? images : undefined,
            latitude: gpsLat || undefined,
            longitude: gpsLon || undefined,
            location_name:
                [locSuburb.trim(), locState.trim(), locCountry.trim()].filter(Boolean).join(', ') || undefined,
        };

        // Attach boat details if Boats category
        if (isBoat) {
            input.boat_details = {
                make: boatMake.trim() || undefined,
                model: boatModel.trim() || undefined,
                year: boatYear ? parseInt(boatYear) : undefined,
                loa_ft: boatLoa ? parseFloat(boatLoa) : undefined,
                beam_ft: boatBeam ? parseFloat(boatBeam) : undefined,
                draft_ft: boatDraft ? parseFloat(boatDraft) : undefined,
                hull_material: boatHull || undefined,
                engine_type: boatEngineType || undefined,
                engine_make: boatEngineMake.trim() || undefined,
                engine_hp: boatHp ? parseInt(boatHp) : undefined,
                engine_hours: boatHours ? parseInt(boatHours) : undefined,
                fuel_type: boatFuel || undefined,
                berths: boatBerths ? parseInt(boatBerths) : undefined,
                cabins: boatCabins ? parseInt(boatCabins) : undefined,
                heads: boatHeads ? parseInt(boatHeads) : undefined,
                rego_number: boatRego.trim() || undefined,
                surveyed: boatSurveyed || undefined,
                features: boatFeatures.length > 0 ? boatFeatures : undefined,
            };
        }

        const result = await MarketplaceService.createListing(input);
        setSubmitting(false);

        if (result) {
            onCreated(result);
            reset();
            onClose();
        } else {
            setError('Failed to create listing. Try again.');
        }
    };

    if (!isOpen) return null;

    const CURRENCIES = ['AUD', 'USD', 'EUR', 'GBP', 'NZD'];

    // Keyboard padding for scroll area — same as DiaryPage approach
    // Don't move the modal, just shrink the scroll area
    const scrollPadBottom = keyboardHeight > 0 ? `${keyboardHeight}px` : '0px';

    return (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70" onClick={onClose}>
            <div
                className="w-full max-w-lg bg-slate-950 border-t border-white/10 rounded-3xl shadow-2xl flex flex-col"
                style={{
                    maxHeight:
                        'calc(100dvh - 5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 8px)',
                    marginBottom: 'calc(4rem + env(safe-area-inset-bottom, 0px) + 8px)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — sticky at top of modal */}
                <div className="shrink-0 flex items-center justify-between px-5 py-4 bg-slate-900/95 border-b border-white/[0.06] rounded-t-3xl">
                    <button
                        onClick={() => {
                            reset();
                            onClose();
                        }}
                        className="text-xs text-white/60 font-medium"
                    >
                        Cancel
                    </button>
                    <h2 className="text-sm font-bold text-white">
                        {isBoat ? 'List a Boat for Sale' : 'List Gear for Sale'}
                    </h2>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !title.trim() || !price || !category || !condition}
                        className={`text-xs font-bold ${submitting || !title.trim() || !price || !category || !condition ? 'text-white/30' : 'text-sky-400'}`}
                    >
                        {submitting ? '⏳' : 'Post'}
                    </button>
                </div>

                <div
                    ref={scrollRef}
                    className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-5"
                    style={{ paddingBottom: scrollPadBottom, WebkitOverflowScrolling: 'touch' as any }}
                >
                    {/* Error */}
                    {error && (
                        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                            {error}
                        </div>
                    )}

                    {/* Category */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">
                            Category
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {LISTING_CATEGORIES.map((cat) => (
                                <button
                                    key={cat}
                                    onClick={() => setCategory(cat)}
                                    className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                                        category === cat
                                            ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                            : 'bg-white/[0.04] border-white/10 text-white/60 hover:border-white/20'
                                    }`}
                                >
                                    {CATEGORY_ICONS[cat]} {cat}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                            {isBoat ? 'Listing Title' : 'Title'}
                        </label>
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={isBoat ? 'e.g. 2019 Beneteau Oceanis 40.1' : 'e.g. Raymarine Axiom 12 MFD'}
                            maxLength={100}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                            Description
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Describe the item, any defects, model year, etc."
                            rows={3}
                            maxLength={1000}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/80 placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors resize-none"
                        />
                    </div>

                    {/* ═══ BOAT-SPECIFIC FIELDS ═══ */}
                    {isBoat && (
                        <>
                            {/* Make & Model */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Make
                                    </label>
                                    <input
                                        value={boatMake}
                                        onChange={(e) => setBoatMake(e.target.value)}
                                        placeholder="Beneteau"
                                        maxLength={60}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Model
                                    </label>
                                    <input
                                        value={boatModel}
                                        onChange={(e) => setBoatModel(e.target.value)}
                                        placeholder="Oceanis 40.1"
                                        maxLength={60}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                            </div>

                            {/* Year & LOA */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Year Built
                                    </label>
                                    <input
                                        value={boatYear}
                                        onChange={(e) => setBoatYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                        placeholder="2019"
                                        inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Length (ft)
                                    </label>
                                    <input
                                        value={boatLoa}
                                        onChange={(e) => setBoatLoa(e.target.value.replace(/[^0-9.]/g, ''))}
                                        placeholder="40"
                                        inputMode="decimal"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                            </div>

                            {/* Beam & Draft */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Beam (ft)
                                    </label>
                                    <input
                                        value={boatBeam}
                                        onChange={(e) => setBoatBeam(e.target.value.replace(/[^0-9.]/g, ''))}
                                        placeholder="13"
                                        inputMode="decimal"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Draft (ft)
                                    </label>
                                    <input
                                        value={boatDraft}
                                        onChange={(e) => setBoatDraft(e.target.value.replace(/[^0-9.]/g, ''))}
                                        placeholder="6.5"
                                        inputMode="decimal"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                            </div>

                            {/* Hull Material */}
                            <div>
                                <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">
                                    Hull Material
                                </label>
                                <div className="flex flex-wrap gap-1.5">
                                    {HULL_MATERIALS.map((h) => (
                                        <button
                                            key={h}
                                            onClick={() => setBoatHull(h)}
                                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-all ${
                                                boatHull === h
                                                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                                    : 'bg-white/[0.04] border-white/10 text-white/60'
                                            }`}
                                        >
                                            {h}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Engine section */}
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] space-y-3">
                                <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider block">
                                    Engine
                                </label>
                                <div className="flex flex-wrap gap-1.5">
                                    {ENGINE_TYPES.map((et) => (
                                        <button
                                            key={et}
                                            onClick={() => setBoatEngineType(et)}
                                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-all ${
                                                boatEngineType === et
                                                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                                    : 'bg-white/[0.04] border-white/10 text-white/60'
                                            }`}
                                        >
                                            {et}
                                        </button>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <input
                                            value={boatEngineMake}
                                            onChange={(e) => setBoatEngineMake(e.target.value)}
                                            placeholder="Engine make (e.g. Yanmar)"
                                            maxLength={40}
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                        />
                                    </div>
                                    <div className="w-20">
                                        <input
                                            value={boatHp}
                                            onChange={(e) => setBoatHp(e.target.value.replace(/\D/g, ''))}
                                            placeholder="HP"
                                            inputMode="numeric"
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                        />
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <input
                                            value={boatHours}
                                            onChange={(e) => setBoatHours(e.target.value.replace(/\D/g, ''))}
                                            placeholder="Engine hours"
                                            inputMode="numeric"
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                        />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex flex-wrap gap-1">
                                            {FUEL_TYPES.map((f) => (
                                                <button
                                                    key={f}
                                                    onClick={() => setBoatFuel(f)}
                                                    className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition-all ${
                                                        boatFuel === f
                                                            ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                                            : 'bg-white/[0.04] border-white/10 text-white/50'
                                                    }`}
                                                >
                                                    {f}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Accommodation */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Berths
                                    </label>
                                    <input
                                        value={boatBerths}
                                        onChange={(e) => setBoatBerths(e.target.value.replace(/\D/g, ''))}
                                        placeholder="6"
                                        inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Cabins
                                    </label>
                                    <input
                                        value={boatCabins}
                                        onChange={(e) => setBoatCabins(e.target.value.replace(/\D/g, ''))}
                                        placeholder="3"
                                        inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Heads
                                    </label>
                                    <input
                                        value={boatHeads}
                                        onChange={(e) => setBoatHeads(e.target.value.replace(/\D/g, ''))}
                                        placeholder="2"
                                        inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                            </div>

                            {/* Rego & Survey */}
                            <div className="flex gap-2 items-end">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                        Rego Number
                                    </label>
                                    <input
                                        value={boatRego}
                                        onChange={(e) => setBoatRego(e.target.value)}
                                        placeholder="Optional"
                                        maxLength={30}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <button
                                    onClick={() => setBoatSurveyed(!boatSurveyed)}
                                    className={`px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${
                                        boatSurveyed
                                            ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                                            : 'bg-white/[0.04] border-white/10 text-white/50'
                                    }`}
                                >
                                    {boatSurveyed ? '✅ Surveyed' : '📋 Surveyed?'}
                                </button>
                            </div>

                            {/* Features (tag chips) */}
                            <div>
                                <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">
                                    Features & Equipment
                                </label>
                                <div className="flex flex-wrap gap-1.5">
                                    {BOAT_FEATURES.filter((v, i, a) => a.indexOf(v) === i).map((feat) => {
                                        const selected = boatFeatures.includes(feat);
                                        return (
                                            <button
                                                key={feat}
                                                onClick={() =>
                                                    setBoatFeatures((prev) =>
                                                        selected ? prev.filter((f) => f !== feat) : [...prev, feat],
                                                    )
                                                }
                                                className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition-all ${
                                                    selected
                                                        ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                                        : 'bg-white/[0.03] border-white/[0.06] text-white/40'
                                                }`}
                                            >
                                                {selected ? '✓ ' : ''}
                                                {feat}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Condition */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">
                            Condition
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {LISTING_CONDITIONS.map((cond) => (
                                <button
                                    key={cond}
                                    onClick={() => setCondition(cond)}
                                    className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                                        condition === cond
                                            ? `${getConditionColor(cond)}`
                                            : 'bg-white/[0.04] border-white/10 text-white/60 hover:border-white/20'
                                    }`}
                                >
                                    {cond}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Price + Currency */}
                    <div className="flex gap-3">
                        <div className="flex-1">
                            <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                Price
                            </label>
                            <input
                                value={price}
                                onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                                placeholder="0.00"
                                inputMode="decimal"
                                className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-emerald-400 font-mono placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                        </div>
                        <div className="w-24">
                            <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                                Currency
                            </label>
                            <select
                                value={currency}
                                onChange={(e) => setCurrency(e.target.value)}
                                className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white outline-none"
                            >
                                {CURRENCIES.map((c) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Location (Country / State / Suburb — privacy safe, auto-filled from GPS) */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                            Location {gpsLat ? '(auto-filled from GPS)' : ''}
                        </label>
                        <div className="flex gap-2 flex-wrap">
                            <input
                                value={locCountry}
                                onChange={(e) => {
                                    setLocCountry(e.target.value);
                                    checkLocationDistance(e.target.value, locState, locSuburb);
                                }}
                                placeholder="Country"
                                className="flex-1 px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                            <input
                                value={locState}
                                onChange={(e) => {
                                    setLocState(e.target.value);
                                    checkLocationDistance(locCountry, e.target.value, locSuburb);
                                }}
                                placeholder="State"
                                className="flex-1 px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                            <input
                                value={locSuburb}
                                onChange={(e) => {
                                    setLocSuburb(e.target.value);
                                    checkLocationDistance(locCountry, locState, e.target.value);
                                }}
                                placeholder="Suburb"
                                className="flex-1 px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                        </div>
                        {locationWarning && (
                            <div className="mt-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400 leading-relaxed">
                                {locationWarning}
                            </div>
                        )}
                    </div>

                    {/* Photos */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">
                            Photos (up to {MAX_PHOTOS})
                        </label>
                        <div className="flex gap-2 flex-wrap">
                            {imagePreviews.map((url, i) => (
                                <div
                                    key={i}
                                    className="relative w-20 h-20 rounded-xl overflow-hidden border border-white/10"
                                >
                                    <img src={url} className="w-full h-full object-cover" alt="" />
                                    <button
                                        onClick={() => removeImage(i)}
                                        className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-black/70 text-white text-[11px]"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            {images.length < MAX_PHOTOS && (
                                <button
                                    onClick={() => fileRef.current?.click()}
                                    className="w-20 h-20 rounded-xl border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-white/60 hover:border-sky-500/30 hover:text-sky-400/50 transition-colors"
                                >
                                    <span className="text-xl">+</span>
                                    <span className="text-[11px] mt-0.5">Add</span>
                                </button>
                            )}
                        </div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={handleImageSelect}
                        />
                    </div>

                    {/* Bottom spacer inside scroll area */}
                    <div className="h-2" />
                </div>

                {/* Submit button — pinned outside scroll area */}
                <div className="shrink-0 px-5 py-3 border-t border-white/[0.06] bg-slate-950">
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !title.trim() || !price || !category || !condition}
                        className={`w-full py-3.5 rounded-2xl font-bold text-sm uppercase tracking-wider transition-all active:scale-[0.98] ${
                            submitting || !title.trim() || !price || !category || !condition
                                ? 'bg-white/[0.04] text-white/60 border border-white/[0.06]'
                                : 'bg-gradient-to-r from-sky-500 to-sky-500 text-white shadow-lg shadow-sky-500/20'
                        }`}
                    >
                        {submitting ? '⏳ Creating Listing...' : '🏪 Post to Marketplace'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export { CreateListingModal };
