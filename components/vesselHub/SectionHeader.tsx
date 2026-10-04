/**
 * Section headings for the Vessel Hub: the static label. (The collapsible
 * header built on it went with the folded "Connections & music" group, Shane
 * 2026-10-04: the hub's menu rows are one box, nothing folded.)
 */
import React from 'react';

/** The Settings pages' section-label style (SettingsPrimitives' Section and
 *  SettingsModal's menu labels), so the hub, the Boat Binder and Settings
 *  wear one heading: a sky dot and sky caps. It used to be a coloured bar in a
 *  different hue per section (pink Music, cyan Settings & Connect), which read
 *  as decoration beside the safety deck's state colours (UX scorecard run 7,
 *  C-section-heading-styles / C-vessel-seven-accents). text-sky-300 takes the
 *  daylight ink from styles/legibility.css like the Settings headings do. */
const LABEL_TEXT = 'ui-section-heading text-label font-bold uppercase tracking-[0.15em] text-sky-300';

/** span, not div: a heading may only hold phrasing content. As a flex item it
 *  is blockified, so it still takes w/h. */
const LabelDot: React.FC = () => (
    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 shadow-lg shadow-sky-500/50" />
);

/** Static section label: an h2 in the one hub heading style. */
export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({
    children,
    className = '',
}) => (
    <h2 className={`${LABEL_TEXT} flex items-center gap-2 ${className}`}>
        <LabelDot />
        {children}
    </h2>
);
