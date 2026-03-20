/**
 * ChatAttachmentSheets — Pin drop, POI picker, track picker, report modal, track disclaimer.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React from 'react';
import { ChatMessage } from '../../services/ChatService';
import { PinService, SavedPin } from '../../services/PinService';
import { ShipLogEntry } from '../../types';
import { getStaticMapUrl } from './chatUtils';

// --- Report Modal ---
export interface ReportModalProps {
    reportingMsg: ChatMessage;
    reportSent: boolean;
    reportReason: 'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other';
    setReportReason: (v: 'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other') => void;
    onSubmit: () => void;
    onClose: () => void;
}

export const ReportModal: React.FC<ReportModalProps> = React.memo(
    ({ reportingMsg, reportSent, reportReason, setReportReason, onSubmit, onClose }) => (
        <div className="absolute inset-0 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60" />
            <div
                className="relative w-[85%] max-w-sm p-5 rounded-2xl bg-slate-900/95 border border-white/[0.08] shadow-2xl fade-slide-down"
                onClick={(e) => e.stopPropagation()}
            >
                {reportSent ? (
                    <div className="text-center py-6">
                        <div className="text-4xl mb-3">✅</div>
                        <p className="text-sm font-medium text-white/70">Report submitted</p>
                        <p className="text-[11px] text-white/60 mt-1">Our moderators will review it shortly</p>
                    </div>
                ) : (
                    <>
                        <p className="text-sm font-bold text-white/80 mb-1">🚩 Report Message</p>
                        <p className="text-[11px] text-white/60 mb-4 truncate">
                            From {reportingMsg.display_name}: "{reportingMsg.message.substring(0, 50)}"
                        </p>
                        <div className="space-y-1.5 mb-4">
                            {(['spam', 'harassment', 'hate_speech', 'inappropriate', 'other'] as const).map((r) => (
                                <button
                                    aria-label="Report"
                                    key={r}
                                    onClick={() => setReportReason(r)}
                                    className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all ${
                                        reportReason === r
                                            ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
                                            : 'bg-white/[0.02] border border-white/[0.04] text-white/60 hover:bg-white/[0.04]'
                                    }`}
                                >
                                    {r === 'spam' && '📧 Spam'}
                                    {r === 'harassment' && '😡 Harassment'}
                                    {r === 'hate_speech' && '🚫 Hate Speech'}
                                    {r === 'inappropriate' && '⚠️ Inappropriate'}
                                    {r === 'other' && '📋 Other'}
                                </button>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <button
                                aria-label="Close"
                                onClick={onClose}
                                className="flex-1 py-2.5 rounded-xl bg-white/[0.03] text-xs text-white/60 hover:bg-white/[0.06] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                aria-label="Submit"
                                onClick={onSubmit}
                                className="flex-1 py-2.5 rounded-xl bg-amber-500/15 text-xs text-amber-400 font-medium hover:bg-amber-500/25 transition-colors"
                            >
                                Submit Report
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    ),
);
ReportModal.displayName = 'ReportModal';

// --- Pin Drop Sheet ---
export interface PinDropSheetProps {
    pinLat: number;
    pinLng: number;
    pinCaption: string;
    setPinCaption: (v: string) => void;
    setPinLat: (v: number) => void;
    setPinLng: (v: number) => void;
    pinLoading: boolean;
    savedPins: SavedPin[];
    onSendPin: () => void;
    onClose: () => void;
}

export const PinDropSheet: React.FC<PinDropSheetProps> = React.memo(
    ({
        pinLat,
        pinLng,
        pinCaption,
        setPinCaption,
        setPinLat,
        setPinLng,
        pinLoading,
        savedPins,
        onSendPin,
        onClose,
    }) => (
        <div className="flex-shrink-0 border-t border-white/[0.06] bg-slate-900 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-white/80">📍 Drop a Pin</h3>
                <button
                    onClick={onClose}
                    className="text-white/60 hover:text-white/60 text-lg transition-colors px-2"
                    aria-label="Close"
                >
                    ✕
                </button>
            </div>
            {pinLoading ? (
                <div className="flex items-center justify-center py-6">
                    <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                    <span className="ml-3 text-sm text-white/60">Getting GPS...</span>
                </div>
            ) : (
                <>
                    {savedPins.length > 0 && (
                        <div className="mb-2">
                            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/40 mb-1.5">
                                📌 Recent Pins
                            </p>
                            <div
                                className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1"
                                style={{ scrollbarWidth: 'none' }}
                            >
                                {savedPins.map((sp) => (
                                    <button
                                        aria-label="Pin"
                                        key={sp.id}
                                        onClick={() => {
                                            setPinLat(sp.latitude);
                                            setPinLng(sp.longitude);
                                            setPinCaption(sp.caption);
                                        }}
                                        className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] transition-all active:scale-95"
                                    >
                                        <span className="text-sm">📍</span>
                                        <div className="text-left">
                                            <p className="text-xs text-white/60 font-medium truncate max-w-[140px]">
                                                {sp.caption}
                                            </p>
                                            <p className="text-[11px] text-white/60 tabular-nums">
                                                {PinService.formatCoords(sp.latitude, sp.longitude)}
                                            </p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="w-full h-[120px] rounded-xl overflow-hidden border border-white/[0.08] mb-2">
                        <img
                            src={getStaticMapUrl(pinLat, pinLng)}
                            alt="Pin location"
                            className="w-full h-full object-cover"
                            loading="eager"
                        />
                    </div>
                    <p className="text-[11px] text-white/40 mb-2 text-center tabular-nums">
                        📍 {Math.abs(pinLat).toFixed(4)}°{pinLat < 0 ? 'S' : 'N'}, {Math.abs(pinLng).toFixed(4)}°
                        {pinLng < 0 ? 'W' : 'E'}
                    </p>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={pinCaption}
                            onChange={(e) => setPinCaption(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && onSendPin()}
                            placeholder="What's here? (e.g. Great anchorage)"
                            className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-sky-500/30 transition-colors"
                            maxLength={120}
                        />
                        <button
                            aria-label="Send"
                            onClick={onSendPin}
                            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-sky-500/20 to-sky-500/20 hover:from-sky-500/30 hover:to-sky-500/30 text-sm text-white/80 font-bold transition-all active:scale-95 whitespace-nowrap"
                        >
                            📍 Drop
                        </button>
                    </div>
                </>
            )}
        </div>
    ),
);
PinDropSheet.displayName = 'PinDropSheet';

// --- POI Picker Sheet ---
export interface PoiPickerSheetProps {
    pinLat: number;
    pinLng: number;
    pinCaption: string;
    setPinCaption: (v: string) => void;
    pinLoading: boolean;
    poiMapRef: React.RefObject<HTMLDivElement>;
    onSendPoi: () => void;
    onClose: () => void;
}

export const PoiPickerSheet: React.FC<PoiPickerSheetProps> = React.memo(
    ({ pinLat, pinLng, pinCaption, setPinCaption, pinLoading, poiMapRef, onSendPoi, onClose }) => (
        <div className="flex-shrink-0 border-t border-white/[0.06] bg-slate-900 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-white/80">🗺️ Share Point of Interest</h3>
                <button
                    onClick={onClose}
                    className="text-white/60 hover:text-white/60 text-lg transition-colors px-2"
                    aria-label="Close"
                >
                    ✕
                </button>
            </div>
            {pinLoading ? (
                <div className="flex items-center justify-center py-6">
                    <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                    <span className="ml-3 text-sm text-white/60">Getting GPS...</span>
                </div>
            ) : (
                <>
                    <div
                        ref={poiMapRef as React.RefObject<HTMLDivElement>}
                        className="w-full h-[200px] rounded-xl overflow-hidden border border-white/[0.08] mb-2"
                    />
                    <p className="text-[11px] text-white/40 mb-2 text-center tabular-nums">
                        📍 {Math.abs(pinLat).toFixed(4)}°{pinLat < 0 ? 'S' : 'N'}, {Math.abs(pinLng).toFixed(4)}°
                        {pinLng < 0 ? 'W' : 'E'}
                        <span className="ml-2 text-white/40">• Tap or drag to set location</span>
                    </p>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={pinCaption}
                            onChange={(e) => setPinCaption(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && onSendPoi()}
                            placeholder="Describe this spot..."
                            className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-sky-500/30 transition-colors"
                            maxLength={120}
                        />
                        <button
                            aria-label="Send"
                            onClick={onSendPoi}
                            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500/20 to-emerald-500/20 hover:from-emerald-500/30 hover:to-emerald-500/30 text-sm text-white/80 font-bold transition-all active:scale-95 whitespace-nowrap"
                        >
                            🗺️ Share
                        </button>
                    </div>
                </>
            )}
        </div>
    ),
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
                <h3 className="text-sm font-bold text-white/80">⛵ Share a Voyage</h3>
                <button
                    onClick={onClose}
                    className="text-white/60 hover:text-white/60 text-lg transition-colors px-2"
                    aria-label="Close"
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
                                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/15 to-sky-500/15 flex items-center justify-center">
                                    <span className="text-lg">⛵</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-white/70 font-medium truncate">{dateStr}</p>
                                    <p className="text-[11px] text-white/60 tabular-nums">
                                        {v.distance}nm · {v.entryCount} pts · {durationHrs}h
                                    </p>
                                </div>
                                <button
                                    aria-label="Send"
                                    onClick={() => onSendTrack(v)}
                                    disabled={trackSharing}
                                    className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500/15 to-emerald-500/15 hover:from-emerald-500/25 hover:to-emerald-500/25 text-xs text-emerald-400/80 font-bold transition-all active:scale-95 disabled:opacity-40"
                                >
                                    {trackSharing ? (
                                        <div className="w-4 h-4 border-2 border-emerald-500/30 rounded-full border-t-teal-500 animate-spin" />
                                    ) : (
                                        '⛵ Share'
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

export const TrackDisclaimerModal: React.FC<TrackDisclaimerModalProps> = React.memo(({ track, onImport, onClose }) => (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
        <div
            className="w-full max-w-sm bg-slate-900/95 border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="px-5 pt-5 pb-3">
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-amber-400 text-lg">⚠️</span>
                    <h2 className="text-base font-black text-white">Navigation Disclaimer</h2>
                </div>
                <div className="bg-amber-900/20 border border-amber-500/20 rounded-xl px-3 py-2.5 mb-3">
                    <p className="text-xs text-amber-400/80 leading-relaxed">
                        This track was shared by another sailor and is{' '}
                        <span className="font-bold text-amber-300">not verified</span>. Depths vary with tide, weather,
                        and vessel draft. <span className="font-bold text-amber-300">Not suitable for navigation.</span>
                    </p>
                </div>
                <p className="text-xs text-white/60 leading-relaxed">
                    It will be imported to your ship's log as a community track with an{' '}
                    <span className="text-amber-400 font-bold">Imported</span> badge.
                </p>
            </div>
            <div className="px-5 pb-5 flex gap-2 pt-2">
                <button
                    aria-label="Close"
                    onClick={onClose}
                    className="flex-1 py-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm font-bold transition-all active:scale-95"
                >
                    Cancel
                </button>
                <button
                    aria-label="Import"
                    onClick={() => onImport(track.trackId, track.title)}
                    className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-sky-600 to-sky-600 text-white text-sm font-bold transition-all active:scale-95 shadow-lg shadow-sky-500/20"
                >
                    ⬇ Import Track
                </button>
            </div>
        </div>
    </div>
));
TrackDisclaimerModal.displayName = 'TrackDisclaimerModal';
