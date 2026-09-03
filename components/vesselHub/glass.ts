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
    listContainer: {
        background: 'var(--vessel-list-bg, rgba(20, 25, 35, 0.5))',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--vessel-list-border, rgba(255, 255, 255, 0.06))',
        borderRadius: '16px',
        overflow: 'hidden' as const,
    } as React.CSSProperties,
};

// Passage Planning is the doorway to the whole voyage workflow — readiness
// cards, crew, watches, float plan, Cast Off — and as a plain office row it
// disappeared into the list (Shane 2026-08-26: "make the passage planning
// card more recognisable... maybe a bit of a hue around it"). Violet is the
// planning identity everywhere else (the readiness group headers), so the
// bezel matches the destination. Same treatment shape as the emerald safety
// group below — a calm hue, not an alarm.
export const PASSAGE_PLANNING_GROUP = {
    background:
        'var(--vessel-passage-group-bg, linear-gradient(135deg, rgba(139, 92, 246, 0.16) 0%, rgba(76, 29, 149, 0.08) 48%, rgba(20, 25, 35, 0.08) 100%))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid var(--vessel-passage-group-border, rgba(167, 139, 250, 0.32))',
    borderRadius: '16px',
    overflow: 'hidden' as const,
    boxShadow: '0 0 0 1px rgba(139, 92, 246, 0.07), 0 10px 26px rgba(109, 40, 217, 0.14)',
} as React.CSSProperties;

// ── Bathymetric contour background SVG ──
export const CONTOUR_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cdefs%3E%3Cpattern id='c' patternUnits='userSpaceOnUse' width='100' height='100'%3E%3Cpath d='M50 10 C60 25,85 30,90 50 C95 70,75 85,50 90 C25 95,10 75,10 50 C10 25,30 5,50 10Z' fill='none' stroke='rgba(100,140,180,0.04)' stroke-width='0.5'/%3E%3Cpath d='M50 25 C55 35,70 38,75 50 C80 62,68 72,50 75 C32 78,22 65,22 50 C22 35,38 28,50 25Z' fill='none' stroke='rgba(100,140,180,0.03)' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='400' height='400' fill='url(%23c)'/%3E%3C/svg%3E")`;
