/**
 * SharePassageButton — Share passage brief via iOS Share Sheet.
 *
 * Two modes:
 *   📤 Quick Brief — plain text, ideal for WhatsApp/iMessage
 *   📄 Export PDF  — professional PDF via jsPDF, ideal for Email/AirDrop
 *
 * Uses:
 *   - PassageBriefService for data assembly
 *   - PassagePdfService for PDF generation
 *   - @capacitor/share for native share sheet
 *   - Filesystem for temp PDF storage (required for iOS share)
 */

import React, { useState, useCallback } from 'react';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding as _Encoding } from '@capacitor/filesystem';
import { generatePassageBrief, type PassageBriefData } from '../../services/PassageBriefService';
import { generatePassagePdf, getPassagePdfFileName } from '../../services/PassagePdfService';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SharePassage');

interface SharePassageButtonProps {
    briefData: PassageBriefData | null;
    className?: string;
}

const SharePassageButton: React.FC<SharePassageButtonProps> = ({ briefData, className = '' }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const [sharing, setSharing] = useState(false);

    const handleShareText = useCallback(async () => {
        if (!briefData) return;
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
        } finally {
            setSharing(false);
            setMenuOpen(false);
        }
    }, [briefData]);

    const handleSharePdf = useCallback(async () => {
        if (!briefData) return;
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
        } finally {
            setSharing(false);
            setMenuOpen(false);
        }
    }, [briefData]);

    if (!briefData) return null;

    return (
        <div className={`relative ${className}`}>
            {/* Main FAB */}
            <button
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
                            : 'bg-slate-900/90 border border-white/[0.08] text-gray-400 hover:text-white'
                    }
                    ${sharing ? 'opacity-60 animate-pulse' : ''}
                `}
                aria-label="Share passage plan"
            >
                <span className="text-lg">📤</span>
            </button>

            {/* Dropdown */}
            {menuOpen && (
                <div
                    className="absolute bottom-14 right-0 w-52 bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-200"
                    style={{ backdropFilter: 'blur(24px)' }}
                >
                    <div className="px-3 py-2 border-b border-white/[0.06]">
                        <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
                            Share Passage Plan
                        </p>
                    </div>

                    {/* Quick Brief (text) */}
                    <button
                        onClick={handleShareText}
                        disabled={sharing}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10"
                    >
                        <span className="text-xl">💬</span>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Quick Brief</p>
                            <p className="text-[11px] text-gray-500">Plain text · WhatsApp, iMessage</p>
                        </div>
                    </button>

                    <div className="h-px bg-white/[0.04] mx-3" />

                    {/* PDF Export */}
                    <button
                        onClick={handleSharePdf}
                        disabled={sharing}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10"
                    >
                        <span className="text-xl">📄</span>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Full PDF</p>
                            <p className="text-[11px] text-gray-500">Professional brief · Email, AirDrop</p>
                        </div>
                    </button>

                    {/* Close on outside tap */}
                    <div className="px-3 py-1.5 border-t border-white/[0.06]">
                        <button
                            onClick={() => setMenuOpen(false)}
                            className="w-full text-center text-[10px] text-gray-500 font-bold uppercase tracking-wider py-1 hover:text-gray-400 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Click-away overlay when menu open */}
            {menuOpen && <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />}
        </div>
    );
};

export default SharePassageButton;
