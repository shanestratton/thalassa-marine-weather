import React from 'react';
import { PageHeader } from '../ui/PageHeader';
import { useUI } from '../../context/UIContext';
import BriefingCard from './BriefingCard';
/** Fixed push target. The dashboard's different point/official warnings cannot masquerade as this registration. */
export default function WeatherBriefingPage() {
    const { setPage } = useUI();
    return (
        <div className="flex h-full flex-col bg-slate-950 text-white">
            <PageHeader
                title="Weather briefing"
                subtitle="Registered vessel position"
                onBack={() => setPage('dashboard')}
            />
            <main className="flex-1 overflow-y-auto p-4 pb-24">
                <BriefingCard acceptPush />
            </main>
        </div>
    );
}
