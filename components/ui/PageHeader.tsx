/**
 * PageHeader — Shared page header component.
 *
 * Extracts the repeated back-button + title + subtitle + action pattern
 * used across 12+ pages into a single reusable component.
 *
 * Usage:
 *   <PageHeader
 *     title="Maintenance"
 *     subtitle="Tasks & Expiry"
 *     onBack={() => navigate(-1)}
 *     action={<MenuButton />}
 *   />
 */
import React from 'react';

interface PageHeaderProps {
    title: string;
    subtitle?: string | React.ReactNode;
    onBack?: () => void;
    action?: React.ReactNode;
    /** Optional status pills displayed between title and action */
    status?: React.ReactNode;
    /** Optional breadcrumb trail: ['Settings', 'Notifications'] */
    breadcrumbs?: string[];
}

export const PageHeader: React.FC<PageHeaderProps> = ({
    title,
    subtitle,
    onBack,
    action,
    status,
    breadcrumbs,
}) => (
    <div className="shrink-0 px-4 pt-4 pb-3">
        {/* Breadcrumb trail */}
        {breadcrumbs && breadcrumbs.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2">
                {breadcrumbs.map((crumb, i) => (
                    <React.Fragment key={i}>
                        {i > 0 && (
                            <svg className="w-3 h-3 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                            </svg>
                        )}
                        <span className={`text-[11px] font-bold uppercase tracking-widest ${i === breadcrumbs.length - 1 ? 'text-sky-400' : 'text-gray-600'
                            }`}>
                            {crumb}
                        </span>
                    </React.Fragment>
                ))}
            </div>
        )}

        <div className="flex items-center gap-3">
            {onBack && (
                <button
                    onClick={onBack}
                    aria-label="Go back"
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center press"
                >
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
            )}

            <div className="flex-1 min-w-0">
                <h1 className="text-xl font-extrabold text-white uppercase tracking-wider truncate">{title}</h1>
                {subtitle && (
                    typeof subtitle === 'string'
                        ? <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">{subtitle}</p>
                        : subtitle
                )}
            </div>

            {status && (
                <div className="flex items-center gap-1.5">
                    {status}
                </div>
            )}

            {action}
        </div>
    </div>
);
