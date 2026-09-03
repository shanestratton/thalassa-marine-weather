import React from 'react';

export const SpeakerChip: React.FC<{ speaker: { name: string; icon: string } | null; onPick: () => void }> = ({
    speaker,
    onPick,
}) => (
    <button
        type="button"
        onClick={onPick}
        aria-label={speaker ? `Playing on ${speaker.name}. Choose a speaker` : 'Choose a speaker'}
        className="inline-flex max-w-40 min-h-[44px] items-center gap-1.5 rounded-full border border-sky-400/25 bg-slate-950/60 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-sky-200 backdrop-blur-md transition active:scale-95"
    >
        <span aria-hidden="true">{speaker?.icon ?? '🔈'}</span>
        <span className="truncate">{speaker?.name ?? 'Speaker'}</span>
    </button>
);
