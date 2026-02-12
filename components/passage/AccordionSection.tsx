/**
 * AccordionSection — Collapsible passage plan section with smooth animation.
 * Used throughout VoyageResults to give each information block a consistent
 * expand/collapse UI with a heading bar, icon, and optional summary badge.
 */
import React, { useState, useRef, useEffect, ReactNode } from 'react';

interface AccordionSectionProps {
    /** Section title (uppercase tracking-widest) */
    title: string;
    /** Optional subtitle beneath the title */
    subtitle?: string;
    /** Icon element to render in the header */
    icon: ReactNode;
    /** Accent color name: sky, emerald, indigo, red, orange, amber, blue, purple */
    accent?: string;
    /** Summary badge(s) shown in collapsed header — e.g. "245 nm" */
    badge?: ReactNode;
    /** Whether the section starts expanded */
    defaultOpen?: boolean;
    /** Content to render inside the collapsible body */
    children: ReactNode;
    /** Extra className on root container */
    className?: string;
}

const ACCENT_MAP: Record<string, { icon: string; border: string; glow: string; badge: string }> = {
    sky: { icon: 'text-sky-400', border: 'border-sky-500/20', glow: 'bg-sky-500/5', badge: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
    emerald: { icon: 'text-emerald-400', border: 'border-emerald-500/20', glow: 'bg-emerald-500/5', badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
    indigo: { icon: 'text-indigo-400', border: 'border-indigo-500/20', glow: 'bg-indigo-500/5', badge: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20' },
    red: { icon: 'text-red-400', border: 'border-red-500/20', glow: 'bg-red-500/5', badge: 'bg-red-500/10 text-red-300 border-red-500/20' },
    orange: { icon: 'text-orange-400', border: 'border-orange-500/20', glow: 'bg-orange-500/5', badge: 'bg-orange-500/10 text-orange-300 border-orange-500/20' },
    amber: { icon: 'text-amber-400', border: 'border-amber-500/20', glow: 'bg-amber-500/5', badge: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
    blue: { icon: 'text-blue-400', border: 'border-blue-500/20', glow: 'bg-blue-500/5', badge: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
    purple: { icon: 'text-purple-400', border: 'border-purple-500/20', glow: 'bg-purple-500/5', badge: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
};

export const AccordionSection: React.FC<AccordionSectionProps> = React.memo(({
    title,
    subtitle,
    icon,
    accent = 'sky',
    badge,
    defaultOpen = false,
    children,
    className = '',
}) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    const contentRef = useRef<HTMLDivElement>(null);
    const [contentHeight, setContentHeight] = useState<number>(0);

    const colors = ACCENT_MAP[accent] || ACCENT_MAP.sky;

    useEffect(() => {
        if (contentRef.current) {
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    setContentHeight(entry.contentRect.height);
                }
            });
            observer.observe(contentRef.current);
            // Initial measurement
            setContentHeight(contentRef.current.scrollHeight);
            return () => observer.disconnect();
        }
    }, []);

    return (
        <div className={`bg-slate-900/80 border border-white/10 rounded-2xl overflow-hidden shadow-xl relative ${className}`}>
            {/* Ambient glow */}
            <div className={`absolute top-0 right-0 w-64 h-64 ${colors.glow} rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none opacity-50`} />

            {/* Header Bar — always visible */}
            <button
                onClick={() => setIsOpen(o => !o)}
                className="w-full flex items-center gap-3 px-5 py-4 text-left group relative z-10 transition-colors hover:bg-white/[0.03]"
                aria-expanded={isOpen}
            >
                {/* Icon */}
                <div className={`p-2 rounded-xl bg-white/5 ${colors.icon} shrink-0 group-hover:scale-105 transition-transform`}>
                    {icon}
                </div>

                {/* Title + Subtitle */}
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-white uppercase tracking-widest truncate">{title}</h3>
                    {subtitle && <p className="text-[10px] text-gray-500 font-medium truncate mt-0.5">{subtitle}</p>}
                </div>

                {/* Badge — visible when collapsed */}
                {badge && !isOpen && (
                    <div className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${colors.badge} shrink-0 animate-in fade-in duration-200`}>
                        {badge}
                    </div>
                )}

                {/* Chevron Toggle */}
                <div className={`w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center shrink-0 transition-all duration-300 ${isOpen ? 'rotate-45 bg-white/10' : 'rotate-0'}`}>
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                </div>
            </button>

            {/* Collapsible Content */}
            <div
                className="transition-[max-height,opacity] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-hidden"
                style={{
                    maxHeight: isOpen ? `${contentHeight + 32}px` : '0px',
                    opacity: isOpen ? 1 : 0,
                }}
            >
                <div ref={contentRef} className="px-5 pb-5">
                    {/* Separator */}
                    <div className={`h-px ${isOpen ? 'bg-white/5' : 'bg-transparent'} mb-4 -mx-5 transition-colors`} />
                    {children}
                </div>
            </div>
        </div>
    );
});

AccordionSection.displayName = 'AccordionSection';
