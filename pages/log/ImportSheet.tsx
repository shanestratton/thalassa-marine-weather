/**
 * ImportSheet — Import action sheet extracted from LogPage.
 * Full-screen panel for browsing community tracks and importing GPX files.
 */
import React, { useRef, useState } from 'react';

interface ImportSheetProps {
    onClose: () => void;
    onImportGPXFile: (file: File) => Promise<void>;
    onShowCommunityBrowser: () => void;
    onImportComplete: () => void;
}

export const ImportSheet: React.FC<ImportSheetProps> = ({
    onClose,
    onImportGPXFile,
    onShowCommunityBrowser,
    onImportComplete: _onImportComplete,
}) => {
    const gpxFileInputRef = useRef<HTMLInputElement>(null);
    const [isImportingGPX, setIsImportingGPX] = useState(false);

    return (
        <div className="fixed inset-0 z-[950] flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
            {/* Header bar */}
            <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                            <svg
                                className="w-4.5 h-4.5 text-amber-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                                />
                            </svg>
                        </div>
                        <h2 className="text-lg font-bold text-white">Import Tracks</h2>
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
                <p className="text-sm text-slate-400 mt-2">Browse and download community-shared tracks</p>
            </div>

            {/* Content — vertically centered */}
            <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                <div className="space-y-4 max-w-2xl mx-auto w-full">
                    {/* Import GPX File Card — hidden for now */}
                    {/* eslint-disable-next-line no-constant-binary-expression */}
                    {false && (
                        <button
                            aria-label="Import GPX file"
                            onClick={() => {
                                if (!isImportingGPX) gpxFileInputRef.current?.click();
                            }}
                            className={`w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all relative overflow-hidden ${
                                isImportingGPX
                                    ? 'bg-slate-800/30 border-slate-700/30 cursor-not-allowed opacity-50'
                                    : 'bg-gradient-to-r from-amber-500/15 to-amber-600/5 border-amber-500/20 hover:border-amber-400/40'
                            }`}
                        >
                            <div className="w-14 h-14 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                                <svg
                                    className="w-7 h-7 text-amber-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={1.5}
                                        d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                    />
                                </svg>
                            </div>
                            {isImportingGPX && (
                                <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center z-10">
                                    <div className="flex items-center gap-3">
                                        <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin"></div>
                                        <span className="text-amber-300 text-sm font-medium">Importing…</span>
                                    </div>
                                </div>
                            )}
                            <div className="flex-1 text-left">
                                <div className="text-white font-bold text-lg">Import GPX File</div>
                                <div className="text-slate-400 text-sm mt-1">
                                    Import from OpenCPN, Navionics, or any chartplotter export
                                </div>
                            </div>
                            <svg
                                className="w-5 h-5 text-slate-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                        </button>
                    )}

                    {/* Browse Community Card */}
                    <button
                        aria-label="Browse community tracks"
                        onClick={onShowCommunityBrowser}
                        className="w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all bg-gradient-to-r from-purple-500/15 to-purple-600/5 border-purple-500/20 hover:border-purple-400/40"
                    >
                        <div className="w-14 h-14 rounded-xl bg-purple-500/20 flex items-center justify-center shrink-0">
                            <svg
                                className="w-7 h-7 text-purple-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">Browse Community</div>
                            <div className="text-slate-400 text-sm mt-1">Download tracks shared by other sailors</div>
                        </div>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    {/* Provenance notice */}
                    <div className="bg-slate-800/40 border border-white/5 rounded-xl px-4 py-3">
                        <div className="flex items-start gap-2">
                            <span className="text-amber-400 text-sm mt-0.5">ℹ️</span>
                            <p className="text-sm text-slate-400 leading-relaxed">
                                Imported tracks are marked with an{' '}
                                <span className="text-amber-400 font-bold">Imported</span> badge and cannot be used for
                                official deck logs or re-shared to the community.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Hidden GPX file input */}
            <input
                ref={gpxFileInputRef}
                type="file"
                accept=".gpx,.xml"
                className="hidden"
                onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setIsImportingGPX(true);
                    try {
                        await onImportGPXFile(file);
                    } finally {
                        setIsImportingGPX(false);
                        onClose();
                    }
                    e.target.value = '';
                }}
            />
        </div>
    );
};
