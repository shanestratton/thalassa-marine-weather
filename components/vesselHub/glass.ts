/**
 * Vessel Hub surface constants — the glass card/list treatments, the Passage
 * Planning bezel and the bathymetric background.
 *
 * SAFETY_CONTROL_GROUP / SAFETY_CONTROL_CARD / ALERT_SAFETY_CONTROL_CARD
 * deliberately stay in components/VesselHub.tsx: tests/VesselHubSafetyControls
 * asserts those declarations by name in that file.
 */
import React from 'react';

// ── Glassmorphism constants ──
export const GLASS = {
    card: {
        background: 'var(--vessel-card-bg, rgba(20, 25, 35, 0.6))',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--vessel-card-border, rgba(255, 255, 255, 0.08))',
        borderRadius: '16px',
    } as React.CSSProperties,
    // The same surface as `card`, so a grouped list and a single card read as
    // one treatment (UX scorecard run 7, C-vessel-seven-accents: "a different
    // card treatment per card"). It adds only the clip for its dividers.
    listContainer: {
        background: 'var(--vessel-card-bg, rgba(20, 25, 35, 0.6))',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--vessel-card-border, rgba(255, 255, 255, 0.08))',
        borderRadius: '16px',
        overflow: 'hidden' as const,
    } as React.CSSProperties,
};

// Passage Planning is the doorway to the whole voyage workflow — readiness
// cards, crew, watches, float plan, Cast Off — and as a plain office row it
// disappeared into the list (Shane 2026-08-26: "make the passage planning
// card more recognisable... maybe a bit of a hue around it"). The hue is the
// hub's one accent, sky, not the violet it first wore: beside the safety
// deck's red, amber and green, a decorative purple glow made colour stop
// meaning anything (UX scorecard run 7, C-vessel-seven-accents). Same
// treatment shape as the emerald safety group — a calm hue, not an alarm.
// The tint sits on the hub's card surface, so daylight gets a pale sky card
// beside the white ones instead of a grey, see-through one.
export const PASSAGE_PLANNING_GROUP = {
    background:
        'var(--vessel-passage-group-bg, linear-gradient(135deg, rgba(14, 165, 233, 0.16) 0%, rgba(14, 165, 233, 0.05) 100%) var(--vessel-card-bg, rgba(20, 25, 35, 0.6)))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid var(--vessel-passage-group-border, rgba(125, 211, 252, 0.3))',
    borderRadius: '16px',
    overflow: 'hidden' as const,
    boxShadow: '0 0 0 1px rgba(14, 165, 233, 0.06), 0 10px 26px rgba(3, 105, 161, 0.14)',
} as React.CSSProperties;

// ── Bathymetric contour background SVG ──
export const CONTOUR_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cdefs%3E%3Cpattern id='c' patternUnits='userSpaceOnUse' width='100' height='100'%3E%3Cpath d='M50 10 C60 25,85 30,90 50 C95 70,75 85,50 90 C25 95,10 75,10 50 C10 25,30 5,50 10Z' fill='none' stroke='rgba(100,140,180,0.04)' stroke-width='0.5'/%3E%3Cpath d='M50 25 C55 35,70 38,75 50 C80 62,68 72,50 75 C32 78,22 65,22 50 C22 35,38 28,50 25Z' fill='none' stroke='rgba(100,140,180,0.03)' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='400' height='400' fill='url(%23c)'/%3E%3C/svg%3E")`;
