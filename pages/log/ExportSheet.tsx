/**
 * Export Action Sheet — extracted from LogPage.
 *
 * Full-screen panel with PDF and GPX export options.
 */
import React, { useState } from 'react';

interface ExportSheetProps {
    onClose: () => void;
    selectedVoyageId: string | null;
    hasNonDeviceEntries: boolean;
    onExportPDF: () => Promise<void>;
    onExportGPX: () => Promise<void>;
}

export const ExportSheet: React.FC<ExportSheetProps> = ({
    onClose,
    selectedVoyageId,
    hasNonDeviceEntries,
    onExportPDF,
    onExportGPX,
}) => {
    const [isExportingPDF, setIsExportingPDF] = useState(false);
    const [isExportingGPX, setIsExportingGPX] = useState(false);

    return (
        <div className="fixed inset-0 z-[950] flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
            {/* Header bar */}
            <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-sky-500/20 flex items-center justify-center">
                            <svg
                                className="w-4.5 h-4.5 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                />
                            </svg>
                        </div>
                        <h2 className="text-lg font-bold text-white">Export Voyage</h2>
                    </div>
                    <button
                        aria-label="Close"
                        onClick={onClose}
                        className="p-2 text-slate-400 hover:text-white transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>
                <p className="text-sm text-slate-400 mt-2">
                    {selectedVoyageId ? 'Export the selected voyage' : 'Export all voyage data'}
                </p>
            </div>

            {/* Content — vertically centered */}
            <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                <div className="space-y-4 max-w-2xl mx-auto w-full">
                    {/* PDF Card */}
                    <button
                        aria-label="Export as PDF"
                        onClick={async () => {
                            if (!hasNonDeviceEntries && !isExportingPDF) {
                                setIsExportingPDF(true);
                                try {
                                    await onExportPDF();
                                } finally {
                                    setIsExportingPDF(false);
                                }
                                onClose();
                            }
                        }}
                        disabled={hasNonDeviceEntries}
                        className={`w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all relative overflow-hidden ${
                            hasNonDeviceEntries || isExportingPDF
                                ? 'bg-slate-800/30 border-slate-700/30 cursor-not-allowed opacity-50'
                                : 'bg-gradient-to-r from-sky-500/15 to-sky-600/5 border-sky-500/20 hover:border-sky-400/40'
                        }`}
                    >
                        <div className="w-14 h-14 rounded-xl bg-sky-500/20 flex items-center justify-center shrink-0">
                            <svg className="w-7 h-7 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                                />
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M9 13h6m-6 4h4"
                                />
                            </svg>
                        </div>
                        {isExportingPDF && (
                            <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center z-10">
                                <div className="flex items-center gap-3">
                                    <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
                                    <span className="text-sky-300 text-sm font-medium">Generating PDF…</span>
                                </div>
                            </div>
                        )}
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">Official Deck Log</div>
                            {hasNonDeviceEntries ? (
                                <div className="text-amber-400 text-sm mt-1">
                                    ⚠️ Unavailable — contains imported or community data
                                </div>
                            ) : (
                                <div className="text-slate-400 text-sm mt-1">
                                    PDF with charts, positions &amp; weather data
                                </div>
                            )}
                        </div>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    {/* GPX Card */}
                    <button
                        aria-label="Export as GPX"
                        onClick={async () => {
                            if (!isExportingGPX) {
                                setIsExportingGPX(true);
                                try {
                                    await onExportGPX();
                                } finally {
                                    setIsExportingGPX(false);
                                }
                            }
                        }}
                        className={`w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all relative overflow-hidden ${
                            isExportingGPX
                                ? 'bg-slate-800/30 border-slate-700/30 cursor-not-allowed opacity-50'
                                : 'bg-gradient-to-r from-emerald-500/15 to-emerald-600/5 border-emerald-500/20 hover:border-emerald-400/40'
                        }`}
                    >
                        <div className="w-14 h-14 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                            <svg
                                className="w-7 h-7 text-emerald-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                                />
                            </svg>
                        </div>
                        {isExportingGPX && (
                            <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center z-10">
                                <div className="flex items-center gap-3">
                                    <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
                                    <span className="text-emerald-300 text-sm font-medium">Exporting GPX…</span>
                                </div>
                            </div>
                        )}
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">GPS Track (GPX)</div>
                            <div className="text-slate-400 text-sm mt-1">
                                Export to OpenCPN, Navionics, or any chartplotter
                            </div>
                        </div>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
};
