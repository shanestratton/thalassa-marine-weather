/**
 * ChecklistsPage — Pre-departure and operational checklists.
 *
 * Layout mirrors DocumentsHub for consistency.
 * Initial stub — checklist items and categories TBD.
 */
import React, { useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import { SlideToAction } from '../ui/SlideToAction';
import { EmptyState } from '../ui/EmptyState';
import { triggerHaptic } from '../../utils/system';

interface ChecklistsPageProps {
    onBack: () => void;
}

export const ChecklistsPage: React.FC<ChecklistsPageProps> = ({ onBack }) => {
    const [searchQuery, setSearchQuery] = useState('');

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">

                <PageHeader
                    title="Checklists"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Checklists']}
                    subtitle={
                        <p className="text-label text-gray-500 font-bold uppercase tracking-widest">
                            0 Checklists
                        </p>
                    }
                    action={
                        <button
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                            aria-label="Page actions"
                        >
                            <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="5" r="1.5" />
                                <circle cx="12" cy="12" r="1.5" />
                                <circle cx="12" cy="19" r="1.5" />
                            </svg>
                        </button>
                    }
                />

                {/* Search */}
                <div className="shrink-0 px-4 pb-3">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search checklists..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none focus:border-sky-500/30"
                    />
                </div>

                {/* Checklists list (scrollable) */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    <EmptyState
                        icon={
                            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                        }
                        title="No Checklists Yet"
                        subtitle="Slide below to create your first checklist."
                        className="py-16"
                    />
                </div>

                {/* Add Checklist CTA (fixed at bottom) */}
                <div className="shrink-0 px-4 pt-2 bg-slate-950" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    <SlideToAction
                        label="Slide to Add Checklist"
                        thumbIcon={
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                        }
                        onConfirm={() => {
                            triggerHaptic('medium');
                            // TODO: open add checklist form
                        }}
                        theme="emerald"
                    />
                </div>
            </div>
        </div>
    );
};
