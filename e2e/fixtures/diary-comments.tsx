import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SwipeableDiaryCard } from '../../components/diary/SwipeableDiaryCard';
import type { DiaryEntry } from '../../services/DiaryService';
import '../../index.css';

const sample: DiaryEntry = {
    id: 'fixture-diary',
    user_id: 'fixture-owner',
    title: 'Sunday at anchor in Mackay',
    body: 'A quiet day in the marina.',
    mood: 'epic',
    photos: [],
    audio_url: null,
    latitude: null,
    longitude: null,
    location_name: 'Mackay Marina',
    weather_summary: '',
    voyage_id: null,
    tags: [],
    is_public: true,
    created_at: '2026-09-21T06:30:00+10:00',
    updated_at: '2026-09-21T06:30:00+10:00',
};

function Fixture() {
    const [reviewed, setReviewed] = useState(false);
    const [selected, setSelected] = useState(false);
    return (
        <main className="h-full overflow-y-auto bg-slate-950 p-4 text-white">
            <h1 className="mb-1 text-2xl font-black">Diary</h1>
            <p className="mb-6 text-xs text-slate-400">Layout fixture · no cloud requests or real comments</p>
            <div className="space-y-3">
                {[2, 1, 0].map((count, index) => (
                    <SwipeableDiaryCard
                        key={index}
                        entry={{
                            ...sample,
                            id: `fixture-${index}`,
                            title: index === 2 ? 'A glorious passage north' : sample.title,
                        }}
                        pendingCommentCount={reviewed ? 0 : count}
                        selected={index === 1 && selected}
                        onToggleSelect={() => setSelected((value) => !value)}
                        onTap={() => {}}
                        onEdit={() => {}}
                        onDelete={() => {}}
                    />
                ))}
            </div>
            <button
                className="mt-6 min-h-11 rounded-xl bg-slate-800 px-4 text-sm"
                onClick={() => setReviewed((value) => !value)}
            >
                {reviewed ? 'Restore pending fixture' : 'Simulate all reviewed'}
            </button>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
