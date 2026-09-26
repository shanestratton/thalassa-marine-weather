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
 *     status={<StatusPills />}
 *     action={<MenuButton />}
 *   />
 *
 * One recipe for every page: back, breadcrumb when nested, title, grey
 * subtitle, optional status pills UNDER the title, and at most one 44 px
 * control in the action slot.
 */
import React from 'react';
import { BackButton } from './BackButton';

interface PageHeaderProps {
    title: string;
    subtitle?: string | React.ReactNode;
    onBack?: () => void;
    /** At most one 44 px control (a ⋮ menu, a single button). */
    action?: React.ReactNode;
    /** Optional status pills, shown on their own row under the title. */
    status?: React.ReactNode;
    /** Optional breadcrumb trail: ['Settings', 'Notifications'] */
    breadcrumbs?: string[];
}

/** Characters in the title's longest word — the one that must fit on a line. */
const longestWordLength = (title: string) =>
    title.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 1);

export const PageHeader: React.FC<PageHeaderProps> = ({ title, subtitle, onBack, action, status, breadcrumbs }) => {
    const lastCrumb = breadcrumbs ? breadcrumbs.length - 1 : -1;
    // Words never split and never clip: the title column is a size container,
    // and the type steps down from 20 px (never below 14 px) until the longest
    // word fits its width. 0.8 em is a conservative per-character advance for
    // Inter ExtraBold capitals with tracking-wider. Without this, MAINTENANCE
    // rendered as 'MAINTENAN' at 393 pt. Browsers without container units
    // drop the declaration and keep the stylesheet's 20 px.
    const titleFontSize = `clamp(14px, calc(100cqi / ${(longestWordLength(title) * 0.8).toFixed(1)}), 20px)`;

    return (
        <div className="shrink-0 px-4 pt-4 pb-3">
            {/* Breadcrumb trail */}
            {breadcrumbs && breadcrumbs.length > 0 && (
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 mb-2">
                    {breadcrumbs.map((crumb, i) => (
                        <React.Fragment key={i}>
                            {i > 0 && (
                                <svg
                                    aria-hidden="true"
                                    className="w-3 h-3 text-gray-400 shrink-0"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                </svg>
                            )}
                            {i === lastCrumb - 1 && onBack ? (
                                // The parent crumb goes where Back goes — it looked like a
                                // link and did nothing. The ::before stretches the 16 px
                                // line to a 44 px hit area (16 up into the header's top
                                // padding, 12 down) without growing the row. The 4 px it
                                // reaches past the gap lands on the back chevron (same
                                // destination) or the title's empty leading.
                                <button
                                    type="button"
                                    onClick={onBack}
                                    aria-label={`Back to ${crumb}`}
                                    className="relative text-xs font-bold uppercase tracking-widest text-gray-400 hover:text-gray-200 transition-colors before:absolute before:inset-x-0 before:-top-4 before:-bottom-3 before:content-['']"
                                >
                                    {crumb}
                                </button>
                            ) : (
                                <span
                                    aria-current={i === lastCrumb ? 'page' : undefined}
                                    className={`text-xs font-bold uppercase tracking-widest ${
                                        i === lastCrumb ? 'text-sky-400' : 'text-gray-400'
                                    }`}
                                >
                                    {crumb}
                                </span>
                            )}
                        </React.Fragment>
                    ))}
                </nav>
            )}

            <div className="flex items-center gap-3">
                {onBack && <BackButton onClick={onBack} />}

                <div className="flex-1 min-w-0 [container-type:inline-size]">
                    <h1
                        className="ui-page-title line-clamp-2 text-xl font-extrabold leading-tight text-white uppercase tracking-wider [overflow-wrap:normal] [word-break:normal] [hyphens:manual]"
                        style={{ fontSize: titleFontSize }}
                    >
                        {title}
                    </h1>
                    {subtitle &&
                        (typeof subtitle === 'string' ? (
                            // Bumped 11 → 12 px 2026-05-17. PageHeader sits at
                            // the top of every non-tab surface; the subtitle is
                            // the secondary label users rely on to confirm
                            // they're in the right place. At 11 px with the
                            // tracking-widest + uppercase + 400-weight grey it
                            // was sliding into illegibility on glare/spray.
                            <p className="ui-caption text-xs text-gray-300 uppercase tracking-widest">{subtitle}</p>
                        ) : (
                            subtitle
                        ))}
                    {/* Status sits under the title, never beside it: pills in the
                        title row squeezed MAINTENANCE, NMEA GATEWAY and ANCHOR
                        WATCH into clipped or four-line columns at 375–393 pt.
                        `empty:hidden` collapses the row when every pill renders
                        null (OfflineBadge while online). */}
                    {status && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">{status}</div>}
                </div>

                {action}
            </div>
        </div>
    );
};
