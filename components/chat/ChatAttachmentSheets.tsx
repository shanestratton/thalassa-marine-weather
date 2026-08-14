/**
 * ChatAttachmentSheets — Pin drop, POI picker, track picker, report modal, track disclaimer.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React, { useEffect, useRef } from 'react';
import { ChatMessage } from '../../services/ChatService';
import { PinService, SavedPin } from '../../services/PinService';
import { ShipLogEntry } from '../../types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PinSelectionSource } from '../../hooks/chat/usePinDrop';
import { getStaticMapUrl } from './chatUtils';
import { OverlayPortal } from '../ui/OverlayPortal';
import { SafeImage } from '../ui/SafeImage';

// --- Report Modal ---
export interface ReportModalProps {
    reportingMsg: ChatMessage;
    reportSent: boolean;
    reportError?: string | null;
    reportSubmitting?: boolean;
    reportReason: 'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other';
    setReportReason: (v: 'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other') => void;
    onSubmit: () => void;
    onClose: () => void;
}

export const ReportModal: React.FC<ReportModalProps> = React.memo(
    ({
        reportingMsg,
        reportSent,
        reportError = null,
        reportSubmitting = false,
        reportReason,
        setReportReason,
        onSubmit,
        onClose,
    }) => {
        const closeButtonRef = useRef<HTMLButtonElement>(null);
        const dialogRef = useFocusTrap<HTMLDivElement>(true, {
            initialFocusRef: closeButtonRef,
            onEscape: () => {
                if (!reportSubmitting) onClose();
            },
        });

        // Submitting replaces the focused action row. Move focus to the
        // acknowledgement action instead of leaving it on document.body.
        useEffect(() => {
            if (reportSent) closeButtonRef.current?.focus();
        }, [reportSent]);

        return (
            <OverlayPortal
                className="flex items-center justify-center"
                role="presentation"
                onClick={() => {
                    if (!reportSubmitting) onClose();
                }}
            >
                <div className="absolute inset-0 bg-black/60" />
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="report-message-title"
                    aria-describedby={
                        reportSent
                            ? 'report-success-description'
                            : `report-message-context${reportError ? ' report-submit-error' : ''}`
                    }
                    aria-busy={reportSubmitting}
                    className="relative w-[85%] max-w-sm p-5 rounded-2xl bg-slate-900/95 border border-white/[0.08] shadow-2xl fade-slide-down"
                    onClick={(e) => e.stopPropagation()}
                >
                    {reportSent ? (
                        <div className="text-center py-6">
                            <div className="text-4xl mb-3" aria-hidden="true">
                                ✅
                            </div>
                            <p id="report-message-title" className="text-sm font-medium text-white/70">
                                Report submitted
                            </p>
                            <p id="report-success-description" className="text-[11px] text-white/60 mt-1">
                                Our moderators will review it shortly
                            </p>
                            <button
                                ref={closeButtonRef}
                                onClick={onClose}
                                className="mt-5 w-full py-2.5 rounded-xl bg-white/[0.06] text-xs text-white/70 hover:bg-white/[0.1] transition-colors"
                            >
                                Done
                            </button>
                        </div>
                    ) : (
                        <>
                            <p id="report-message-title" className="text-sm font-bold text-white/80 mb-1">
                                Report Message
                            </p>
                            <p id="report-message-context" className="text-[11px] text-white/60 mb-4 truncate">
                                From {reportingMsg.display_name}: "{reportingMsg.message.substring(0, 50)}"
                            </p>
                            <div className="space-y-1.5 mb-4">
                                {(['spam', 'harassment', 'hate_speech', 'inappropriate', 'other'] as const).map((r) => (
                                    <button
                                        aria-label={`Report reason: ${r.replace('_', ' ')}`}
                                        aria-pressed={reportReason === r}
                                        key={r}
                                        onClick={() => setReportReason(r)}
                                        disabled={reportSubmitting}
                                        className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all ${
                                            reportReason === r
                                                ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
                                                : 'bg-white/[0.02] border border-white/[0.04] text-white/60 hover:bg-white/[0.04]'
                                        }`}
                                    >
                                        {r === 'spam' && 'Spam'}
                                        {r === 'harassment' && 'Harassment'}
                                        {r === 'hate_speech' && 'Hate speech'}
                                        {r === 'inappropriate' && 'Inappropriate'}
                                        {r === 'other' && 'Other'}
                                    </button>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    ref={closeButtonRef}
                                    aria-label="Cancel report"
                                    onClick={onClose}
                                    disabled={reportSubmitting}
                                    className="flex-1 py-2.5 rounded-xl bg-white/[0.03] text-xs text-white/60 hover:bg-white/[0.06] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    aria-label="Submit report"
                                    onClick={onSubmit}
                                    disabled={reportSubmitting}
                                    className="flex-1 py-2.5 rounded-xl bg-amber-500/15 text-xs text-amber-400 font-medium hover:bg-amber-500/25 transition-colors disabled:opacity-50"
                                >
                                    {reportSubmitting ? 'Submitting…' : 'Submit Report'}
                                </button>
                            </div>
                            {reportError && (
                                <p id="report-submit-error" role="alert" className="mt-3 text-xs text-red-300">
                                    {reportError}
                                </p>
                            )}
                        </>
                    )}
                </div>
            </OverlayPortal>
        );
    },
);
ReportModal.displayName = 'ReportModal';

const formatCoordinates = (latitude: number, longitude: number): string =>
    `${Math.abs(latitude).toFixed(4)}°${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(4)}°${longitude < 0 ? 'W' : 'E'}`;

const formatFixAge = (timestamp: number | null): string => {
    if (!timestamp || !Number.isFinite(timestamp)) return 'Fresh GPS fix';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
    if (seconds < 10) return 'Captured just now';
    if (seconds < 60) return `Captured ${seconds}s ago`;
    return `Captured ${Math.floor(seconds / 60)}m ago`;
};

// --- Current location sheet ---
export interface PinDropSheetProps {
    pinLat: number;
    pinLng: number;
    pinCaption: string;
    setPinCaption: (v: string) => void;
    pinLoading: boolean;
    pinSource: PinSelectionSource;
    pinAccuracy: number | null;
    pinTimestamp: number | null;
    locationError: string | null;
    saveToMyPlaces: boolean;
    setSaveToMyPlaces: (value: boolean) => void;
    sending: boolean;
    onSendPin: () => void;
    onRetryLocation: () => void;
    onChoosePlace: () => void;
    onClose: () => void;
}

export const PinDropSheet: React.FC<PinDropSheetProps> = React.memo(
    ({
        pinLat,
        pinLng,
        pinCaption,
        setPinCaption,
        pinLoading,
        pinSource,
        pinAccuracy,
        pinTimestamp,
        locationError,
        saveToMyPlaces,
        setSaveToMyPlaces,
        sending,
        onSendPin,
        onRetryLocation,
        onChoosePlace,
        onClose,
    }) => {
        const canShare = pinSource === 'current' && Number.isFinite(pinLat) && Number.isFinite(pinLng);
        return (
            <section
                role="region"
                aria-label="Share my current location"
                className="flex-shrink-0 border-t border-emerald-400/[0.14] bg-slate-900 px-4 py-4 shadow-[0_-12px_30px_rgba(0,0,0,0.16)]"
            >
                <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-300/70 mb-1">
                            One-time share
                        </p>
                        <h3 className="text-base font-bold text-white/90">Share my location</h3>
                        <p className="text-[11px] text-white/45 mt-1">
                            Sends one GPS snapshot to this channel — never live tracking.
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={sending}
                        className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] text-white/60 hover:text-white/90 disabled:opacity-40 transition-colors flex items-center justify-center flex-shrink-0"
                        aria-label="Close current location sheet"
                    >
                        ✕
                    </button>
                </div>
                {pinLoading ? (
                    <div
                        className="flex items-center justify-center gap-3 py-8 rounded-2xl bg-white/[0.025] border border-white/[0.06]"
                        aria-live="polite"
                    >
                        <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                        <span className="text-sm text-white/60">Finding a fresh GPS fix…</span>
                    </div>
                ) : locationError || !canShare ? (
                    <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4" role="alert">
                        <div className="flex gap-3">
                            <span className="w-9 h-9 rounded-xl bg-amber-400/10 flex items-center justify-center flex-shrink-0">
                                ⌁
                            </span>
                            <div>
                                <p className="text-sm font-semibold text-amber-100">Location unavailable</p>
                                <p className="text-[11px] leading-relaxed text-amber-100/60 mt-1">
                                    {locationError || 'A fresh GPS fix is needed before it can be shared.'}
                                </p>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-4">
                            <button
                                type="button"
                                onClick={onRetryLocation}
                                className="min-h-[44px] rounded-xl bg-amber-300/10 border border-amber-200/20 text-xs font-bold text-amber-100 active:scale-[0.98] transition-transform"
                            >
                                Try again
                            </button>
                            <button
                                type="button"
                                onClick={onChoosePlace}
                                className="min-h-[44px] rounded-xl bg-white/[0.05] border border-white/[0.09] text-xs font-bold text-white/75 active:scale-[0.98] transition-transform"
                            >
                                Drop a place
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2.5 mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="w-7 h-7 rounded-lg bg-emerald-300/15 text-emerald-200 flex items-center justify-center">
                                    ●
                                </span>
                                <div className="min-w-0">
                                    <p className="text-xs font-bold text-emerald-100">Current GPS fix</p>
                                    <p className="text-[10px] text-emerald-100/60 mt-0.5">
                                        {formatFixAge(pinTimestamp)}
                                    </p>
                                </div>
                            </div>
                            {pinAccuracy != null && Number.isFinite(pinAccuracy) && (
                                <span className="text-[10px] font-semibold text-emerald-100/75 whitespace-nowrap">
                                    ±{Math.round(pinAccuracy)} m
                                </span>
                            )}
                        </div>
                        <div className="relative w-full h-[136px] rounded-2xl overflow-hidden border border-white/[0.1] mb-2">
                            <SafeImage
                                src={getStaticMapUrl(pinLat, pinLng)}
                                alt="Map preview of your current location"
                                className="w-full h-full object-cover"
                                loading="eager"
                            />
                            {/* Pin marker overlay — centered on the map */}
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <div className="relative -mt-5">
                                    <svg
                                        width="24"
                                        height="32"
                                        viewBox="0 0 24 32"
                                        fill="none"
                                        xmlns="http://www.w3.org/2000/svg"
                                    >
                                        <path
                                            d="M12 0C5.373 0 0 5.373 0 12c0 9 12 20 12 20s12-11 12-20c0-6.627-5.373-12-12-12z"
                                            fill="#ef4444"
                                        />
                                        <circle cx="12" cy="12" r="5" fill="white" />
                                    </svg>
                                    {/* Drop shadow beneath pin */}
                                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-3 h-1 rounded-full bg-black/40 blur-[2px]" />
                                </div>
                            </div>
                        </div>
                        <p className="text-[11px] text-white/45 mb-3 text-center tabular-nums">
                            📍 {formatCoordinates(pinLat, pinLng)}
                        </p>
                        <div className="flex items-center gap-2">
                            <input
                                id="current-location-note"
                                type="text"
                                value={pinCaption}
                                onChange={(e) => setPinCaption(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && canShare && !sending && onSendPin()}
                                placeholder="Add a note (optional)"
                                aria-label="Location note"
                                className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-3 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-emerald-400/40 transition-colors min-h-[46px]"
                                maxLength={120}
                            />
                            <button
                                type="button"
                                aria-label="Share current location"
                                onClick={onSendPin}
                                disabled={!canShare || sending}
                                className="px-4 min-h-[46px] rounded-xl bg-emerald-400/20 border border-emerald-300/20 hover:bg-emerald-400/30 disabled:opacity-40 text-sm text-emerald-50 font-bold transition-all active:scale-95 whitespace-nowrap"
                            >
                                {sending ? 'Sharing…' : 'Share'}
                            </button>
                        </div>
                        <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={saveToMyPlaces}
                                onChange={(event) => setSaveToMyPlaces(event.target.checked)}
                                className="w-4 h-4 accent-emerald-400"
                            />
                            <span className="text-[11px] text-white/50">Save this in My Places too</span>
                        </label>
                    </>
                )}
            </section>
        );
    },
);
PinDropSheet.displayName = 'PinDropSheet';

// --- Place picker sheet ---
export interface PoiPickerSheetProps {
    pinLat: number;
    pinLng: number;
    pinCaption: string;
    setPinCaption: (v: string) => void;
    pinLoading: boolean;
    pinSource: PinSelectionSource;
    locationError: string | null;
    savedPins: SavedPin[];
    onSelectSavedPin: (pin: SavedPin) => void;
    saveToMyPlaces: boolean;
    setSaveToMyPlaces: (value: boolean) => void;
    sending: boolean;
    poiMapRef: React.RefObject<HTMLDivElement>;
    onSendPoi: () => void;
    onClose: () => void;
    /** Snap the marker back to the user's live GPS position. */
    onRecenterToMyLocation?: () => void;
    /** Geocode a place name and pan the map there. */
    onSearch?: (query: string) => void;
    /** Whether a geocoding search is currently in flight. */
    searching?: boolean;
}

export const PoiPickerSheet: React.FC<PoiPickerSheetProps> = React.memo(
    ({
        pinLat,
        pinLng,
        pinCaption,
        setPinCaption,
        pinLoading,
        pinSource,
        locationError,
        savedPins,
        onSelectSavedPin,
        saveToMyPlaces,
        setSaveToMyPlaces,
        sending,
        poiMapRef,
        onSendPoi,
        onClose,
        onRecenterToMyLocation,
        onSearch,
        searching = false,
    }) => {
        const [search, setSearch] = React.useState('');
        const handleSearch = () => {
            const q = search.trim();
            if (!q || !onSearch) return;
            onSearch(q);
        };
        const hasSelection = pinSource !== null && Number.isFinite(pinLat) && Number.isFinite(pinLng);
        return (
            <section
                role="region"
                aria-label="Drop a pin"
                // thalassa-keyboard-safe-sheet owns the height cap now, in
                // place of the hard-coded 68vh that used to sit here. This
                // sheet scrolls internally, which is precisely the case the
                // app-wide keyboard guard cannot rescue — see the class
                // comment in index.css. Share my location (PinDropSheet,
                // above) needs no such treatment: no internal scroll box.
                className="thalassa-keyboard-safe-sheet flex-shrink-0 border-t border-sky-400/[0.14] bg-slate-900 px-4 py-4 overflow-y-auto shadow-[0_-12px_30px_rgba(0,0,0,0.16)]"
            >
                <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-sky-300/70 mb-1">
                            Share a place
                        </p>
                        <h3 className="text-base font-bold text-white/90">Drop a pin</h3>
                        <p className="text-[11px] text-white/45 mt-1">
                            Search, tap the chart, or drag the pin to the exact spot.
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={sending}
                        className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] text-white/60 hover:text-white/90 disabled:opacity-40 transition-colors flex items-center justify-center flex-shrink-0"
                        aria-label="Close place picker"
                    >
                        ✕
                    </button>
                </div>
                {pinLoading ? (
                    <div
                        className="flex items-center justify-center gap-3 py-8 rounded-2xl bg-white/[0.025] border border-white/[0.06]"
                        aria-live="polite"
                    >
                        <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                        <span className="text-sm text-white/60">Preparing the chart…</span>
                    </div>
                ) : (
                    <>
                        {locationError && (
                            <p
                                className="rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-3 py-2 text-[11px] text-amber-100/70 mb-3"
                                role="status"
                            >
                                {locationError}
                            </p>
                        )}
                        {/* Search bar — type a place name (chandlery, customs
                            office, suburb) and we pan the map there. Much
                            faster than dragging the marker to a far spot. */}
                        {onSearch && (
                            <div className="flex items-center gap-2 mb-3">
                                <input
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                    placeholder="Search a place or marina…"
                                    aria-label="Search for a place"
                                    className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-3 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-sky-500/40 transition-colors min-h-[46px]"
                                />
                                <button
                                    type="button"
                                    onClick={handleSearch}
                                    disabled={searching}
                                    aria-label="Search for a place"
                                    className="min-w-[46px] min-h-[46px] rounded-xl bg-sky-500/20 border border-sky-300/15 hover:bg-sky-500/30 text-white/80 disabled:opacity-50"
                                >
                                    {searching ? '…' : '🔎'}
                                </button>
                            </div>
                        )}
                        {savedPins.length > 0 && (
                            <div className="mb-3">
                                <p className="text-[10px] font-black uppercase tracking-[0.15em] text-white/50 mb-1.5">
                                    Recent places
                                </p>
                                <div
                                    className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1"
                                    style={{ scrollbarWidth: 'none' }}
                                >
                                    {savedPins.map((savedPin) => (
                                        <button
                                            type="button"
                                            key={savedPin.id}
                                            onClick={() => onSelectSavedPin(savedPin)}
                                            aria-label={`Use saved place ${savedPin.caption}`}
                                            className="flex-shrink-0 max-w-[180px] flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.08] active:scale-[0.98] transition-all text-left min-h-[44px]"
                                        >
                                            <span className="text-sm">📌</span>
                                            <span className="min-w-0">
                                                <span className="block truncate text-xs font-semibold text-white/75">
                                                    {savedPin.caption}
                                                </span>
                                                <span className="block truncate text-[10px] text-white/40 tabular-nums">
                                                    {PinService.formatCoords(savedPin.latitude, savedPin.longitude)}
                                                </span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {/* Bigger map for easier tap/drag targeting. Was
                            200 px — too cramped for any motion bigger
                            than a kerb. 320 px gives enough room to drag
                            across a marina. */}
                        <div
                            ref={poiMapRef as React.RefObject<HTMLDivElement>}
                            aria-label="Interactive chart picker"
                            className="relative w-full h-[320px] rounded-2xl overflow-hidden border border-white/[0.1] mb-3"
                        >
                            {/* Floating "snap to my location" button —
                                overlays the map so the user always has a
                                one-tap way back to their actual GPS
                                position when they've dragged around. */}
                            {onRecenterToMyLocation && (
                                <button
                                    type="button"
                                    onClick={onRecenterToMyLocation}
                                    aria-label="Use my current location for this pin"
                                    className="absolute bottom-3 right-3 z-10 min-h-[42px] px-3 rounded-xl bg-slate-900/90 border border-white/15 backdrop-blur active:scale-95 transition-transform flex items-center justify-center gap-1.5 shadow-lg text-xs font-bold text-white/80"
                                >
                                    <span>📍</span>
                                    <span>My location</span>
                                </button>
                            )}
                        </div>
                        <div
                            className={`rounded-xl border px-3 py-2.5 mb-3 ${hasSelection ? 'border-sky-300/15 bg-sky-400/[0.05]' : 'border-white/[0.07] bg-white/[0.025]'}`}
                            aria-live="polite"
                        >
                            <p className="text-[11px] font-semibold text-white/70">
                                {hasSelection
                                    ? pinSource === 'current'
                                        ? 'Current location selected'
                                        : 'Pinned place selected'
                                    : 'Choose a place on the chart'}
                            </p>
                            <p className="text-[10px] text-white/40 mt-0.5 tabular-nums">
                                {hasSelection
                                    ? `📍 ${formatCoordinates(pinLat, pinLng)}`
                                    : 'Search above, tap the chart, or drag a pin.'}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={pinCaption}
                                onChange={(e) => setPinCaption(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && hasSelection && !sending && onSendPoi()}
                                placeholder="Name or note (optional)"
                                aria-label="Place name or note"
                                className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-3 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-sky-500/40 transition-colors min-h-[46px]"
                                maxLength={120}
                            />
                            <button
                                type="button"
                                aria-label="Share pin"
                                onClick={onSendPoi}
                                disabled={!hasSelection || sending}
                                className="px-4 min-h-[46px] rounded-xl bg-sky-500/20 border border-sky-300/20 hover:bg-sky-500/30 disabled:opacity-40 text-sm text-sky-50 font-bold transition-all active:scale-95 whitespace-nowrap"
                            >
                                {sending ? 'Sharing…' : 'Share pin'}
                            </button>
                        </div>
                        <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={saveToMyPlaces}
                                onChange={(event) => setSaveToMyPlaces(event.target.checked)}
                                className="w-4 h-4 accent-sky-400"
                            />
                            <span className="text-[11px] text-white/50">Save this in My Places too</span>
                        </label>
                    </>
                )}
            </section>
        );
    },
);
PoiPickerSheet.displayName = 'PoiPickerSheet';

// --- Track Picker Sheet ---
export interface TrackPickerSheetProps {
    voyageList: {
        voyageId: string;
        entryCount: number;
        distance: number;
        startTime: string;
        endTime: string;
        entries: ShipLogEntry[];
    }[];
    trackLoadingVoyages: boolean;
    trackSharing: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSendTrack: (v: any) => void;
    onClose: () => void;
}

export const TrackPickerSheet: React.FC<TrackPickerSheetProps> = React.memo(
    ({ voyageList, trackLoadingVoyages, trackSharing, onSendTrack, onClose }) => (
        <div className="flex-shrink-0 border-t border-white/[0.06] bg-slate-900 px-4 py-3 max-h-[320px] overflow-hidden">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-white/80">Share a Voyage</h3>
                <button
                    onClick={onClose}
                    className="text-white/60 hover:text-white/80 text-lg transition-colors px-2"
                    aria-label="Close attachment sheet"
                >
                    ✕
                </button>
            </div>
            {trackLoadingVoyages ? (
                <div className="flex items-center justify-center py-8">
                    <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                    <span className="ml-3 text-sm text-white/60">Loading voyages...</span>
                </div>
            ) : voyageList.length === 0 ? (
                <div className="text-center py-8">
                    <p className="text-xl mb-2">🚫</p>
                    <p className="text-sm text-white/60 font-medium">No voyages to share</p>
                    <p className="text-xs text-white/60 mt-1">Record a voyage first using the Ship's Log</p>
                </div>
            ) : (
                <div className="space-y-2 overflow-y-auto max-h-[240px] pb-1" style={{ scrollbarWidth: 'thin' }}>
                    {voyageList.map((v) => {
                        const start = new Date(v.startTime);
                        const end = new Date(v.endTime);
                        const dateStr = start.toLocaleDateString('en-AU', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                        });
                        const durationHrs =
                            Math.round(((end.getTime() - start.getTime()) / (1000 * 60 * 60)) * 10) / 10;
                        return (
                            <div
                                key={v.voyageId}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all"
                            >
                                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-sky-500/15 flex items-center justify-center">
                                    <span className="text-lg">⛵</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-white/70 font-medium truncate">{dateStr}</p>
                                    <p className="text-[11px] text-white/60 tabular-nums">
                                        {v.distance}nm · {v.entryCount} pts · {durationHrs}h
                                    </p>
                                </div>
                                <button
                                    aria-label="Send attachment"
                                    onClick={() => onSendTrack(v)}
                                    disabled={trackSharing}
                                    className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-xs text-emerald-400/80 font-bold transition-all active:scale-95 disabled:opacity-40"
                                >
                                    {trackSharing ? (
                                        <div className="w-4 h-4 border-2 border-emerald-500/30 rounded-full border-t-teal-500 animate-spin" />
                                    ) : (
                                        'Share'
                                    )}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    ),
);
TrackPickerSheet.displayName = 'TrackPickerSheet';

// --- Track Import Disclaimer Modal ---
export interface TrackDisclaimerModalProps {
    track: { trackId: string; title: string };
    onImport: (trackId: string, title: string) => void;
    onClose: () => void;
}

export const TrackDisclaimerModal: React.FC<TrackDisclaimerModalProps> = React.memo(({ track, onImport, onClose }) => {
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: cancelButtonRef,
        onEscape: onClose,
    });

    return (
        <OverlayPortal
            className="flex items-center justify-center bg-black/70 p-6"
            role="presentation"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="track-disclaimer-title"
                aria-describedby="track-disclaimer-description"
                className="w-full max-w-sm bg-slate-900/95 border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 pt-5 pb-3">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-amber-400 text-lg" aria-hidden="true">
                            ⚠️
                        </span>
                        <h2 id="track-disclaimer-title" className="text-base font-black text-white">
                            Navigation Disclaimer
                        </h2>
                    </div>
                    <div
                        id="track-disclaimer-description"
                        className="bg-amber-900/20 border border-amber-500/20 rounded-xl px-3 py-2.5 mb-3"
                    >
                        <p className="text-xs text-amber-400/80 leading-relaxed">
                            This track was shared by another sailor and is{' '}
                            <span className="font-bold text-amber-300">not verified</span>. Depths vary with tide,
                            weather, and vessel draft.{' '}
                            <span className="font-bold text-amber-300">Not suitable for navigation.</span>
                        </p>
                    </div>
                    <p className="text-xs text-white/60 leading-relaxed">
                        It will be imported to your ship's log as a community track with an{' '}
                        <span className="text-amber-400 font-bold">Imported</span> badge.
                    </p>
                </div>
                <div className="px-5 pb-5 flex gap-2 pt-2">
                    <button
                        ref={cancelButtonRef}
                        aria-label="Cancel track import"
                        onClick={onClose}
                        className="flex-1 py-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm font-bold transition-all active:scale-95"
                    >
                        Cancel
                    </button>
                    <button
                        aria-label="Import shared track to ship's log"
                        onClick={() => onImport(track.trackId, track.title)}
                        className="flex-1 py-2.5 rounded-xl bg-sky-600 text-white text-sm font-bold transition-all active:scale-95 shadow-lg shadow-sky-500/20"
                    >
                        ⬇ Import Track
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
});
TrackDisclaimerModal.displayName = 'TrackDisclaimerModal';
