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
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
    /**
     * Where Back goes, for the chevron's name ("Back to Vessel"). Defaults to
     * the parent crumb when there is one, else "Go back".
     */
    backLabel?: string;
    /**
     * The title takes every line it needs instead of two (132-B20): for a page
     * named by something the skipper typed, where the whole name is the point.
     * 'Watermaker, high-pressure pump and pre-filters' lost two of its lines
     * as the Equipment page's h1.
     */
    wrapTitle?: boolean;
}

/** Characters in the title's longest word — the one that must fit on a line. */
const longestWordLength = (title: string) =>
    title.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 1);

export const PageHeader: React.FC<PageHeaderProps> = ({
    title,
    subtitle,
    onBack,
    action,
    status,
    breadcrumbs,
    backLabel,
    wrapTitle,
}) => {
    const lastCrumb = breadcrumbs ? breadcrumbs.length - 1 : -1;
    // The chevron is named by its destination, and the parent crumb that goes
    // to the same place is hidden from assistive tech: pages carried two back
    // controls, 'Back to Ship's Office' and an unnamed 'Go back' (UX scorecard
    // run 7). The crumb stays a touch target for sighted users.
    const parentCrumb = breadcrumbs && lastCrumb > 0 ? breadcrumbs[lastCrumb - 1] : undefined;
    const chevronLabel = backLabel ?? (parentCrumb ? `Back to ${parentCrumb}` : undefined);
    // Use one title: when the trail ends on the page's own name (DIARY over
    // DIARY on every Ship's Office page), the visible copy is dropped and the
    // crumb stays for screen readers only (UX scorecard run 6).
    const isTitleCrumb = (crumb: string, i: number) =>
        i === lastCrumb && crumb.trim().toLowerCase() === title.trim().toLowerCase();
    // Words never split and never clip: the title column is a size container,
    // and the type steps down from 20 px (never below 14 px) until the longest
    // word fits its width. 0.8 em is a conservative per-character advance for
    // Inter ExtraBold capitals with tracking-wider. Without this, MAINTENANCE
    // rendered as 'MAINTENAN' at 393 pt. Browsers without container units
    // drop the declaration and keep the stylesheet's 20 px.
    const wordFits = `calc(100cqi / ${(longestWordLength(title) * 0.8).toFixed(1)})`;
    // A wrapping title also steps down until the whole of it would sit on
    // about two lines (132-B20): 'Autopilot drive, below-deck hydraulic ram'
    // took six lines of 18 px type beside '‹ EQUIPMENT' at 375 pt.
    const titleFontSize = wrapTitle
        ? `clamp(14px, min(${wordFits}, calc(200cqi / ${(title.length * 0.8).toFixed(1)})), 20px)`
        : `clamp(14px, ${wordFits}, 20px)`;
    // A trail that is only 'parent (= Back) › this page (= the h1)' tells a
    // screen reader nothing the chevron and the heading have not; hide it whole.
    const trailIsRedundant =
        !!breadcrumbs && breadcrumbs.every((crumb, i) => isTitleCrumb(crumb, i) || (i === lastCrumb - 1 && !!onBack));
    // 'Parent › this page' says nothing the chevron cannot: the parent's name
    // sits beside the chevron ('‹ VESSEL') instead of on a line of its own,
    // which cost ~28 pt above every sub-page title (UX scorecard run 10,
    // settings-header-375). Deeper or non-title trails keep the eyebrow.
    const inlineParent =
        onBack && breadcrumbs && lastCrumb === 1 && isTitleCrumb(breadcrumbs[1], 1) ? breadcrumbs[0] : undefined;

    // The title comes before the parent's name (132-B20): where the name beside
    // the chevron leaves the title's column narrower than its longest word at
    // the 14 px floor ('MAINTENANCE' read 'MAINTENA' beside '‹ BOAT BINDER' at
    // 320 pt), the name gives way and the chevron goes back alone. Its spoken
    // name still says where ('Back to Boat Binder'). A wrapping title is never
    // cut, but past two lines beside the name the name gives way too: 'AUTOPILOT
    // DRIVE, BELOW-DECK HYDRAULIC RAM' took six lines at 320 pt.
    //
    // Only where that helps: if the title is still cut without the name, or no
    // shorter, the name comes back, and a wrapping title breaks a word too wide
    // for any column rather than lose part of it. Measured, not guessed: the
    // room depends on the face, the words, the width and the action beside the
    // title, so a new width, title or action, the title changing width, or the
    // app's font arriving tries again. The ⋮ that Checklists and Equipment show
    // once there is something in them narrowed the title with nothing watching
    // it: 'CHECKLISTS' was cut by 18 px at 320 pt. Layout effects, so no try is
    // ever painted.
    const headerRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const hasAction = !!action;
    /** Bumped when the header's or the title's width changes: measure again. */
    const [remeasure, setRemeasure] = useState(0);
    /**
     * Where the parent's name gave way: the width, action and title it gave way
     * at; the title's height then, when it gave way for length alone; and
     * whether that helped (unknown until measured without it). null while the
     * name shows.
     */
    const [gaveWay, setGaveWay] = useState<{ at: string; height?: number; helped?: boolean } | null>(null);
    useEffect(() => {
        const header = headerRef.current;
        const h1 = titleRef.current;
        if (!inlineParent || !header || !h1) return;
        let live = true;
        // The app's face drawn: every word has a new width, so start again with the name.
        void document.fonts?.ready.then(() => live && setGaveWay(null));
        const widths = () => `${header.clientWidth}:${h1.clientWidth}`;
        let seen = widths();
        const observer =
            typeof ResizeObserver === 'undefined'
                ? null
                : new ResizeObserver(() => {
                      if (widths() === seen) return;
                      seen = widths();
                      if (live) setRemeasure((n) => n + 1);
                  });
        observer?.observe(header);
        observer?.observe(h1);
        return () => {
            live = false;
            observer?.disconnect();
        };
    }, [inlineParent]);
    useLayoutEffect(() => {
        const header = headerRef.current;
        const h1 = titleRef.current;
        if (!inlineParent || !header || !h1) return;
        const at = `${header.clientWidth}:${hasAction}:${title}`;
        if (gaveWay && gaveWay.at !== at) {
            setGaveWay(null);
            return;
        }
        // Cut across (a word wider than the column) or down (a name past the clamp's two lines).
        const cut = h1.scrollWidth > h1.clientWidth + 1 || h1.scrollHeight > h1.clientHeight + 1;
        const height = h1.clientHeight;
        const long = !!wrapTitle && height > 2 * parseFloat(window.getComputedStyle(h1).lineHeight) + 1;
        if (!gaveWay) {
            if (cut) setGaveWay({ at });
            else if (long) setGaveWay({ at, height });
        } else if (gaveWay.helped === undefined) {
            setGaveWay({ ...gaveWay, helped: !cut && (gaveWay.height === undefined || height < gaveWay.height - 1) });
        }
    }, [inlineParent, title, hasAction, wrapTitle, gaveWay, remeasure]);
    const parentBeside = !gaveWay || gaveWay.helped === false ? inlineParent : undefined;
    const breakWords = wrapTitle && gaveWay?.helped === false;

    return (
        // data-page-header: toasts anchor below it (components/Toast.tsx).
        <div ref={headerRef} data-page-header className="shrink-0 px-4 pt-4 pb-3">
            {/* Breadcrumb trail */}
            {breadcrumbs && breadcrumbs.length > 0 && !inlineParent && (
                // The gap under the trail is the crumb's reach below its line
                // (see the parent crumb below), so the crumb's 44 px and the
                // chevron's 44 px sit one above the other without touching.
                <nav
                    aria-label="Breadcrumb"
                    aria-hidden={trailIsRedundant || undefined}
                    className="mb-[calc(28px_-_1rem)] flex items-center gap-1.5"
                >
                    {breadcrumbs.map((crumb, i) => (
                        <React.Fragment key={i}>
                            {i > 0 && !isTitleCrumb(crumb, i) && (
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
                            {isTitleCrumb(crumb, i) ? (
                                <span aria-current="page" className="sr-only">
                                    {crumb}
                                </span>
                            ) : i === lastCrumb - 1 && onBack ? (
                                // The parent crumb goes where Back goes — it looked like a
                                // link and did nothing. Its own box is the 44 px hit area:
                                // a 16 px line, the header's whole top padding (1rem) above
                                // it and the rest (28px - 1rem) below, down to where the
                                // chevron row starts; negative margins take the padding back
                                // so the trail keeps its place. It was a ::before, so the box
                                // measured 54 x 15 and its reach overlapped the back chevron
                                // by 4 px (UX scorecard run 9). Pixel sums, not rem steps:
                                // the root font is fluid (4vw), and 44 must stay 44.
                                <button
                                    type="button"
                                    onClick={onBack}
                                    aria-hidden="true"
                                    tabIndex={-1}
                                    className="-mt-4 -mb-[calc(28px_-_1rem)] pt-4 pb-[calc(28px_-_1rem)] text-xs leading-[16px] font-bold uppercase tracking-widest text-gray-400 hover:text-gray-200 transition-colors"
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

            {/* items-start: Back and the action line up with the title row, not
                with the middle of the whole block. With status pills under the
                title they sat ~12 pt lower than on sibling pages (UX scorecard
                run 7). The column's 44 px floor keeps a one-line title centred
                on the 44 px controls. */}
            <div className="flex items-start gap-3">
                {/* data-page-back: App's edge swipe presses this chevron, so the
                    gesture and the button can never disagree on where back is.
                    `contents` keeps the button itself the flex item. */}
                {onBack && (
                    <span data-page-back className="contents">
                        <BackButton onClick={onBack} label={chevronLabel} text={parentBeside} />
                    </span>
                )}

                <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center [container-type:inline-size]">
                    {/* A wrapping title still hides what runs past its column, so
                        a word too wide for it is measured, never drawn under the
                        action. */}
                    <h1
                        ref={titleRef}
                        className={`ui-page-title ${wrapTitle ? 'overflow-hidden' : 'line-clamp-2'} text-xl font-extrabold leading-tight text-white uppercase tracking-wider ${breakWords ? '[overflow-wrap:anywhere]' : '[overflow-wrap:normal]'} [word-break:normal] [hyphens:manual]`}
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
