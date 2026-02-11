/**
 * Shared primitive UI components for Settings panels.
 * Section, Row, Toggle — used by all settings tabs.
 */
import React from 'react';

// ── Section ──────────────────────────────────────────────────
export const Section = React.memo(({ title, children }: { title: string, children?: React.ReactNode }) => (
    <div className="space-y-4 mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h3 className="text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-blue-500 uppercase tracking-[0.15em] px-1 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-sky-500 shadow-lg shadow-sky-500/50"></div>
            {title}
        </h3>
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl backdrop-blur-sm overflow-hidden shadow-lg shadow-black/10">
            {children}
        </div>
    </div>
));
Section.displayName = 'Section';

// ── Row ──────────────────────────────────────────────────────
export const Row = React.memo(({ children, className = '', onClick }: { children: React.ReactNode, className?: string, onClick?: () => void }) => (
    <div
        className={`p-4 border-b border-white/5 last:border-0 flex items-center justify-between gap-4 ${className} ${onClick ? 'cursor-pointer hover:bg-white/5 transition-colors' : ''}`}
        onClick={onClick}
    >
        {children}
    </div>
));
Row.displayName = 'Row';

// ── Toggle ───────────────────────────────────────────────────
export const Toggle = React.memo(({ checked, onChange }: { checked: boolean, onChange: (v: boolean) => void }) => (
    <div
        className="relative inline-flex items-center cursor-pointer p-2 -mr-2 group"
        onClick={(e) => {
            e.stopPropagation();
            onChange(!checked);
        }}
    >
        <div className={`w-11 h-6 rounded-full transition-all duration-300 ${checked
            ? 'bg-gradient-to-r from-sky-500 to-blue-600 shadow-lg shadow-sky-500/30'
            : 'bg-slate-700'}`}>
            <div className={`absolute top-3 w-4 h-4 bg-white rounded-full shadow-md transition-all duration-300 ${checked ? 'left-6' : 'left-3'}`}></div>
        </div>
    </div>
));
Toggle.displayName = 'Toggle';

// ── Common props passed to every settings tab ────────────────
import { UserSettings } from '../../types';

export interface SettingsTabProps {
    settings: UserSettings;
    onSave: (settings: Partial<UserSettings>) => void;
}
