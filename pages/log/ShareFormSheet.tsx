/**
 * ShareFormSheet — Community share form extracted from LogPage.
 * Full-screen form for sharing a voyage to the community.
 */
import React from 'react';
import { RegionAutocomplete } from '../../components/RegionAutocomplete';
import { TrackCategory } from '../../services/TrackSharingService';

interface ShareFormSheetProps {
    onClose: () => void;
    onBack: () => void;
    onShowCommunityBrowser: () => void;
    onShareToCommunity: (data: { title: string; description: string; category: TrackCategory; region: string }) => void;
    shareAutoTitle: string;
    shareAutoRegion: string;
}

export const ShareFormSheet: React.FC<ShareFormSheetProps> = ({
    onClose,
    onBack,
    onShowCommunityBrowser,
    onShareToCommunity,
    shareAutoTitle,
    shareAutoRegion,
}) => {
    return (
        <div className="fixed inset-0 z-[950] flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
            <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <button
                            aria-label="Back"
                            onClick={onBack}
                            className="p-1.5 text-slate-400 hover:text-white transition-colors -ml-1"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M15 19l-7-7 7-7"
                                />
                            </svg>
                        </button>
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                            <svg
                                className="w-4.5 h-4.5 text-purple-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                                />
                            </svg>
                        </div>
                        <h2 className="text-lg font-bold text-white">Community Share</h2>
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
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3 max-w-2xl mx-auto w-full">
                    {/* Offline Banner */}
                    {typeof navigator !== 'undefined' && !navigator.onLine && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
                            <span>📡</span>
                            <span>Sharing requires internet. Your tracks are saved locally.</span>
                        </div>
                    )}

                    {/* Share Track Form */}
                    <div className="rounded-2xl bg-gradient-to-b from-purple-500/10 to-slate-900/80 border border-purple-500/20 p-4 space-y-3">
                        <div>
                            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                                Title *
                            </label>
                            <input
                                id="share-title"
                                type="text"
                                placeholder={shareAutoTitle || 'e.g. "Moreton Bay Anchorage"'}
                                className="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                                Description
                            </label>
                            <textarea
                                id="share-description"
                                rows={2}
                                placeholder="Brief description of the route, conditions, or points of interest..."
                                className="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all resize-none"
                            />
                        </div>
                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                                    Category
                                </label>
                                <select
                                    id="share-category"
                                    defaultValue="coastal"
                                    className="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white text-sm font-medium focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all appearance-none cursor-pointer"
                                    style={{
                                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
                                        backgroundRepeat: 'no-repeat',
                                        backgroundPosition: 'right 12px center',
                                    }}
                                >
                                    <option value="anchorage">⚓ Anchorage</option>
                                    <option value="port_entry">🏗 Port Entry</option>
                                    <option value="marina_exit">🚤 Marina Exit</option>
                                    <option value="harbour_entry">⛵ Harbour Entry</option>
                                    <option value="bar_crossing">🌊 Bar Crossing</option>
                                    <option value="reef_passage">🪸 Reef Passage</option>
                                    <option value="coastal">🏖 Coastal</option>
                                    <option value="offshore">🌊 Offshore</option>
                                    <option value="walking">🚶 Walking</option>
                                    <option value="driving">🚗 Driving</option>
                                </select>
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                                    Region
                                </label>
                                <RegionAutocomplete
                                    id="share-region"
                                    defaultValue={shareAutoRegion}
                                    placeholder='e.g. "QLD, Australia"'
                                    inputClassName="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all"
                                />
                            </div>
                        </div>
                        <button
                            aria-label="Submit share"
                            onClick={() => {
                                const rawTitle = (
                                    document.getElementById('share-title') as HTMLInputElement
                                )?.value?.trim();
                                const title = rawTitle || shareAutoTitle;
                                const description =
                                    (
                                        document.getElementById('share-description') as HTMLTextAreaElement
                                    )?.value?.trim() || '';
                                const category =
                                    (document.getElementById('share-category') as HTMLSelectElement)?.value ||
                                    'coastal';
                                const region =
                                    (document.getElementById('share-region') as HTMLInputElement)?.value?.trim() ||
                                    shareAutoRegion;
                                if (!title) {
                                    (document.getElementById('share-title') as HTMLInputElement)?.focus();
                                    return;
                                }
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                onShareToCommunity({ title, description, category: category as any, region });
                            }}
                            className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40 active:scale-[0.98] transition-all"
                        >
                            🚀 Share Track
                        </button>
                    </div>

                    {/* Browse Community */}
                    <button
                        aria-label="Browse shared tracks"
                        onClick={onShowCommunityBrowser}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl bg-gradient-to-r from-sky-500/15 to-sky-600/5 border border-sky-500/20 hover:border-sky-400/40 active:scale-[0.98] transition-all"
                    >
                        <div className="w-10 h-10 rounded-xl bg-sky-500/20 flex items-center justify-center shrink-0">
                            <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-sm">Browse Community</div>
                            <div className="text-slate-400 text-xs">Discover anchorages, passages &amp; routes</div>
                        </div>
                        <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
};
