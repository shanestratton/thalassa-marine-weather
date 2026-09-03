/**
 * SharePassageButton — Share passage brief via iOS Share Sheet.
 *
 * Three clear products:
 *   🛟 Float Plan  — private safety handoff with overdue action + SAR details
 *   💬 Quick Brief — route summary for casual sharing
 *   📄 Export PDF  — professional passage dossier
 *
 * Uses:
 *   - PassageBriefService for data assembly
 *   - PassagePdfService for PDF generation
 *   - @capacitor/share for native share sheet
 *   - Filesystem for temp PDF storage (required for iOS share)
 */

import React, { useState, useCallback, useId, useRef } from 'react';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { generatePassageBrief, type PassageBriefData } from '../../services/PassageBriefService';
import { generatePassagePdf, getPassagePdfFileName } from '../../services/PassagePdfService';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';
import { useMenuNavigation } from '../../hooks/useMenuNavigation';
import { ModalSheet } from '../ui/ModalSheet';
import { FloatPlanSheet, type FloatPlanPreset } from '../vessel/FloatPlanSheet';

const log = createLogger('SharePassage');

interface SharePassageButtonProps {
    briefData: PassageBriefData | null;
    className?: string;
}

interface ShareFailure {
    kind: 'text' | 'pdf';
    message: string;
    fallbackText: string;
}

function passageFallbackText(data: PassageBriefData): string {
    try {
        return generatePassageBrief(data).textVersion;
    } catch {
        return [
            'THALASSA PASSAGE BRIEF',
            `${data.origin?.name || 'Unknown origin'} to ${data.destination?.name || 'Unknown destination'}`,
            data.departureTime ? `Departure: ${new Date(data.departureTime).toLocaleString()}` : 'Departure: not set',
            Number.isFinite(data.totalDistanceNM) ? `Distance: ${data.totalDistanceNM} NM` : '',
            Number.isFinite(data.estimatedDuration) ? `Estimated duration: ${data.estimatedDuration} hours` : '',
            'Verify all route, weather, depth and timing information independently before departure.',
        ]
            .filter(Boolean)
            .join('\n');
    }
}

const SharePassageButton: React.FC<SharePassageButtonProps> = ({ briefData, className = '' }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [showFloatPlan, setShowFloatPlan] = useState(false);
    const [shareFailure, setShareFailure] = useState<ShareFailure | null>(null);
    const [fallbackCopyState, setFallbackCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
    // Nothing prints or shares until the passage plan is actually complete —
    // a float plan naming "?" as the destination or carrying no departure
    // time is worse than none, because someone ashore will act on it
    // (Shane 2026-08-04: "do not allow it to be printed unless the passage
    // plan has been completed").
    const planComplete = Boolean(
        briefData &&
        briefData.origin?.name &&
        briefData.destination?.name &&
        briefData.departureTime &&
        Number.isFinite(briefData.totalDistanceNM) &&
        briefData.totalDistanceNM > 0 &&
        Number.isFinite(briefData.estimatedDuration) &&
        briefData.estimatedDuration > 0,
    );
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const closeMenu = useCallback(() => setMenuOpen(false), []);
    const menuRef = useMenuNavigation<HTMLDivElement>(menuOpen, {
        triggerRef,
        onClose: closeMenu,
    });

    const handleShareText = useCallback(async () => {
        if (!briefData) return;
        setShareFailure(null);
        setFallbackCopyState('idle');
        setSharing(true);
        triggerHaptic('medium');

        try {
            const brief = generatePassageBrief(briefData);

            await Share.share({
                title: `⛵ ${brief.title}`,
                text: brief.textVersion,
                dialogTitle: 'Share Passage Brief',
            });

            log.info('[share] Text brief shared');
        } catch (err) {
            log.warn('[share] Text share failed:', err);
            setShareFailure({
                kind: 'text',
                message: 'Thalassa could not confirm that the passage brief was shared.',
                fallbackText: passageFallbackText(briefData),
            });
        } finally {
            setSharing(false);
            setMenuOpen(false);
        }
    }, [briefData]);

    const handleSharePdf = useCallback(async () => {
        if (!briefData) return;
        setShareFailure(null);
        setFallbackCopyState('idle');
        setSharing(true);
        triggerHaptic('medium');

        try {
            const pdfBlob = generatePassagePdf(briefData);
            const fileName = getPassagePdfFileName(briefData);

            // Convert blob to base64 for Filesystem write
            const reader = new FileReader();
            const base64 = await new Promise<string>((resolve, reject) => {
                reader.onload = () => {
                    const result = reader.result as string;
                    // Strip data URI prefix
                    const base64Data = result.split(',')[1];
                    resolve(base64Data);
                };
                reader.onerror = reject;
                reader.readAsDataURL(pdfBlob);
            });

            // Write to temp directory
            const saved = await Filesystem.writeFile({
                path: fileName,
                data: base64,
                directory: Directory.Cache,
            });

            // Share the file
            await Share.share({
                title: `⛵ Passage Brief: ${briefData.origin.name} → ${briefData.destination.name}`,
                url: saved.uri,
                dialogTitle: 'Share Passage PDF',
            });

            log.info(`[share] PDF shared: ${fileName}`);

            // Cleanup temp file after a delay
            setTimeout(async () => {
                try {
                    await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache });
                } catch {
                    /* ignore cleanup errors */
                }
            }, 30_000);
        } catch (err) {
            log.warn('[share] PDF share failed:', err);
            setShareFailure({
                kind: 'pdf',
                message: 'The passage PDF could not be created or handed to the share sheet.',
                fallbackText: passageFallbackText(briefData),
            });
        } finally {
            setSharing(false);
            setMenuOpen(false);
        }
    }, [briefData]);

    const retryFailedShare = useCallback(() => {
        if (!shareFailure) return;
        const kind = shareFailure.kind;
        setShareFailure(null);
        if (kind === 'pdf') void handleSharePdf();
        else void handleShareText();
    }, [handleSharePdf, handleShareText, shareFailure]);

    const copyFallbackText = useCallback(async () => {
        if (!shareFailure) return;
        try {
            await navigator.clipboard.writeText(shareFailure.fallbackText);
            setFallbackCopyState('copied');
            triggerHaptic('light');
        } catch (error) {
            log.warn('[share] Manual fallback copy failed:', error);
            setFallbackCopyState('failed');
        }
    }, [shareFailure]);

    if (!briefData) return null;

    const floatPlanPreset: FloatPlanPreset | null =
        briefData.origin && briefData.destination
            ? {
                  route: {
                      name: briefData.routeName,
                      from: briefData.origin.name,
                      to: briefData.destination.name,
                      distanceNM: briefData.totalDistanceNM,
                      waypoints: [
                          { lat: briefData.origin.lat, lon: briefData.origin.lon },
                          ...(briefData.turnWaypoints?.length
                              ? briefData.turnWaypoints.map((point) => ({ lat: point.lat, lon: point.lon }))
                              : (briefData.viaWaypoints ?? []).map((point) => ({ lat: point.lat, lon: point.lon }))),
                          { lat: briefData.destination.lat, lon: briefData.destination.lon },
                      ],
                  },
                  departureMs: new Date(briefData.departureTime).getTime(),
                  etaMs:
                      new Date(briefData.departureTime).getTime() +
                      Number(briefData.estimatedDuration || 0) * 3_600_000,
                  personsOnBoard: briefData.crewCount,
              }
            : null;

    return (
        <div className={`relative ${className}`}>
            {/* Main FAB */}
            <button
                ref={triggerRef}
                onClick={() => {
                    setMenuOpen((v) => !v);
                    triggerHaptic('light');
                }}
                disabled={sharing}
                className={`
                    w-11 h-11 rounded-2xl flex items-center justify-center
                    shadow-2xl transition-all active:scale-95
                    ${
                        menuOpen
                            ? 'bg-sky-500/30 border border-sky-500/50 text-sky-300'
                            : 'bg-slate-900/90 border border-white/8 text-gray-400 hover:text-white'
                    }
                    ${sharing ? 'opacity-60 animate-pulse' : ''}
                `}
                aria-label={menuOpen ? 'Close share passage menu' : 'Open share passage menu'}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-controls={menuOpen ? menuId : undefined}
            >
                <span className="text-lg">📤</span>
            </button>

            {/* Dropdown */}
            {menuOpen && (
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label="Share passage plan"
                    className="absolute bottom-14 right-0 w-52 bg-slate-900/95 backdrop-blur-xl border border-white/8 rounded-2xl shadow-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-200"
                    style={{ backdropFilter: 'blur(24px)' }}
                >
                    <div role="presentation" className="px-3 py-2 border-b border-white/6">
                        <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest">
                            Share Passage Plan
                        </p>
                    </div>

                    {/* A real float plan: overdue action, POB, rescue contact,
                        vessel identity and safety equipment. */}
                    <button
                        role="menuitem"
                        onClick={() => {
                            if (!planComplete || !floatPlanPreset) return;
                            setMenuOpen(false);
                            setShowFloatPlan(true);
                            triggerHaptic('medium');
                        }}
                        disabled={sharing || !planComplete}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-40"
                    >
                        <span className="text-xl">🛟</span>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Float Plan</p>
                            <p className="text-[11px] text-gray-500">
                                {planComplete
                                    ? 'Safety handoff · text, WhatsApp, email'
                                    : 'Finish the passage plan first'}
                            </p>
                        </div>
                    </button>

                    <div role="separator" className="h-px bg-white/4 mx-3" />

                    {/* Passage data without the safety promise of a float plan. */}
                    <button
                        role="menuitem"
                        onClick={handleShareText}
                        disabled={sharing || !planComplete}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-40"
                    >
                        <span className="text-xl">💬</span>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Quick Passage Brief</p>
                            <p className="text-[11px] text-gray-500">
                                {planComplete ? 'Route summary · casual sharing' : 'Finish the passage plan first'}
                            </p>
                        </div>
                    </button>

                    <div role="separator" className="h-px bg-white/4 mx-3" />

                    {/* PDF Export */}
                    <button
                        role="menuitem"
                        onClick={handleSharePdf}
                        disabled={sharing || !planComplete}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-40"
                    >
                        <span className="text-xl">📄</span>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Full PDF</p>
                            <p className="text-[11px] text-gray-500">
                                {planComplete ? 'Professional brief · Email, AirDrop' : 'Finish the passage plan first'}
                            </p>
                        </div>
                    </button>

                    {/* Close on outside tap */}
                    <div className="px-3 py-1.5 border-t border-white/6">
                        <button
                            role="menuitem"
                            onClick={closeMenu}
                            className="w-full min-h-[44px] text-center text-[11px] text-gray-500 font-bold uppercase tracking-wider py-1 hover:text-gray-400 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Click-away overlay when menu open */}
            {menuOpen && (
                <div role="presentation" aria-hidden="true" className="fixed inset-0 z-40" onClick={closeMenu} />
            )}

            <ModalSheet
                isOpen={showFloatPlan && floatPlanPreset !== null}
                onClose={() => setShowFloatPlan(false)}
                title="Float plan"
                maxWidth="max-w-3xl"
                zIndex="z-1200"
            >
                {floatPlanPreset && <FloatPlanSheet preset={floatPlanPreset} onClose={() => setShowFloatPlan(false)} />}
            </ModalSheet>

            <ModalSheet
                isOpen={shareFailure !== null}
                onClose={() => setShareFailure(null)}
                title="Share did not complete"
                maxWidth="max-w-xl"
                zIndex="z-1250"
            >
                {shareFailure && (
                    <div className="space-y-4 p-1">
                        <div
                            role="alert"
                            aria-live="assertive"
                            className="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm font-semibold text-red-100"
                        >
                            {shareFailure.message} Nothing has been marked as sent. Retry, or copy the text below and
                            send it manually.
                        </div>

                        <div>
                            <label
                                htmlFor="passage-share-manual-fallback"
                                className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300"
                            >
                                Passage brief text — copy and send it yourself
                            </label>
                            <textarea
                                id="passage-share-manual-fallback"
                                readOnly
                                value={shareFailure.fallbackText}
                                onFocus={(event) => event.currentTarget.select()}
                                rows={10}
                                className="w-full resize-y rounded-xl border border-white/10 bg-slate-950/80 p-3 font-mono text-xs leading-relaxed text-slate-100 outline-hidden focus:border-sky-400"
                            />
                        </div>

                        <div aria-live="polite" className="min-h-5 text-xs text-slate-300">
                            {fallbackCopyState === 'copied' && 'Fallback text copied. Choose and verify the recipient.'}
                            {fallbackCopyState === 'failed' &&
                                'Clipboard access is unavailable. Select the text above and copy it manually.'}
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <button
                                type="button"
                                onClick={retryFailedShare}
                                disabled={sharing}
                                className="min-h-[44px] rounded-xl bg-sky-500 px-4 py-3 text-sm font-black text-slate-950 disabled:opacity-50"
                            >
                                {sharing ? 'Retrying…' : `Retry ${shareFailure.kind === 'pdf' ? 'PDF' : 'share'}`}
                            </button>
                            <button
                                type="button"
                                onClick={() => void copyFallbackText()}
                                className="min-h-[44px] rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-bold text-white"
                            >
                                Copy fallback text
                            </button>
                        </div>
                    </div>
                )}
            </ModalSheet>
        </div>
    );
};

export default SharePassageButton;
