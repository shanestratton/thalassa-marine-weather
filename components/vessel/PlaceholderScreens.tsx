/**
 * Placeholder screens for VesselHub Ship's Office cards.
 * Stubbed out for navigation routing — ready to build into.
 */
import React from 'react';

interface PlaceholderProps {
    onBack: () => void;
}

// ── Inventory & Spares ──
export const InventoryPage: React.FC<PlaceholderProps> = ({ onBack }) => (
    <PlaceholderScreen
        title="Inventory & Spares"
        subtitle="Track consumables, spare parts, and provisioning"
        icon={<BoxIcon />}
        accentColor="amber"
        onBack={onBack}
    />
);

// ── Maintenance & Expiry ──
export const MaintenancePage: React.FC<PlaceholderProps> = ({ onBack }) => (
    <PlaceholderScreen
        title="Maintenance & Expiry"
        subtitle="Schedule tasks, track certificates, and safety equipment"
        icon={<WrenchIcon />}
        accentColor="sky"
        onBack={onBack}
    />
);

// ── NMEA Network Gateway ──
export const NmeaGatewayPage: React.FC<PlaceholderProps> = ({ onBack }) => (
    <PlaceholderScreen
        title="NMEA Network"
        subtitle="Instrument data, connection status, and diagnostics"
        icon={<SignalIcon />}
        accentColor="violet"
        onBack={onBack}
    />
);

// ── Shared placeholder layout ──
const PlaceholderScreen: React.FC<{
    title: string;
    subtitle: string;
    icon: React.ReactNode;
    accentColor: string;
    onBack: () => void;
}> = ({ title, subtitle, icon, accentColor, onBack }) => {
    const colors: Record<string, { text: string; bg: string; border: string }> = {
        amber: { text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
        sky: { text: 'text-sky-400', bg: 'bg-sky-500/10', border: 'border-sky-500/20' },
        violet: { text: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/20' },
    };
    const c = colors[accentColor] || colors.sky;

    return (
        <div className="w-full max-w-2xl mx-auto px-4 py-6 animate-in fade-in duration-300">
            {/* Back button */}
            <button onClick={onBack} className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-6">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                <span className="text-sm font-bold">Vessel</span>
            </button>

            {/* Header */}
            <div className="flex items-center gap-4 mb-8">
                <div className={`p-4 rounded-2xl ${c.bg} border ${c.border}`}>
                    <div className={c.text}>{icon}</div>
                </div>
                <div>
                    <h1 className="text-2xl font-black text-white tracking-wide">{title}</h1>
                    <p className="text-xs text-gray-500">{subtitle}</p>
                </div>
            </div>

            {/* Coming soon */}
            <div className={`${c.bg} border ${c.border} rounded-2xl p-8 text-center`}>
                <div className={`text-4xl mb-3 ${c.text}`}>🚧</div>
                <h3 className="text-lg font-black text-white mb-2">Coming Soon</h3>
                <p className="text-sm text-gray-400 max-w-sm mx-auto">
                    This module is under construction. Stay tuned for the next update.
                </p>
            </div>
        </div>
    );
};

// ── Icons ──
const BoxIcon = () => (
    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
    </svg>
);

const WrenchIcon = () => (
    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36" />
    </svg>
);

const SignalIcon = () => (
    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
    </svg>
);
