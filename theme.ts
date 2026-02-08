/**
 * Thalassa Design Tokens — Dual Theme System
 * ─────────────────────────────────────────────────────────────────
 * Two theme palettes: OFFSHORE (ocean blues) and ONSHORE (earth tones).
 * Both are dark-mode — the difference is colour temperature and accents.
 *
 * Usage (static — backward compatible):
 *   import { t } from '../theme';
 *   <div className={t.card.base}>...</div>
 *
 * Usage (dynamic — theme-aware):
 *   import { useTheme } from '../context/ThemeContext';
 *   const t = useTheme();
 *   <div className={t.card.base}>...</div>
 */

import type { Environment } from './services/EnvironmentService';

// ── Shared Types ────────────────────────────────────────────────

export interface ThemeColors {
    bg: {
        base: string;
        elevated: string;
        surface: string;
        surfaceAlt: string;
        inset: string;
        insetDeep: string;
        glass: string;
        overlay: string;
    };
    text: {
        primary: string;
        secondary: string;
        tertiary: string;
        muted: string;
        disabled: string;
    };
    accent: {
        sky: { bg: string; bgActive: string; text: string; border: string; borderActive: string };
        amber: { bg: string; bgActive: string; text: string; border: string; borderActive: string };
        emerald: { bg: string; bgActive: string; text: string; border: string; borderActive: string };
        red: { bg: string; bgActive: string; text: string; border: string; borderActive: string };
        purple: { bg: string; bgActive: string; text: string; border: string; borderActive: string };
    };
    border: {
        subtle: string;
        default: string;
        strong: string;
        glass: string;
    };
}

export interface ThemeTokens {
    colors: ThemeColors;
    typography: typeof typography;
    spacing: typeof spacing;
    radii: typeof radii;
    card: { base: string; glass: string; inset: string; insetRelaxed: string };
    button: { primary: string; secondary: string; danger: string; ghost: string; toggleOff: string };
    modal: { backdrop: string; panel: string; header: string; body: string; close: string };
    header: { bar: string; glass: string };
    input: { base: string; code: string; slider: string };
    badge: typeof badge;
    animation: typeof animation;
    border: ThemeColors['border'];
    /** Which environment this theme represents */
    environment: Environment;
}


// ══════════════════════════════════════════════════════════════════
//   OFFSHORE THEME — Deep ocean, cool blues, sky accents
// ══════════════════════════════════════════════════════════════════

const offshoreColors: ThemeColors = {
    bg: {
        base: 'bg-slate-950',
        elevated: 'bg-slate-900',
        surface: 'bg-slate-900/70',
        surfaceAlt: 'bg-slate-900/50',
        inset: 'bg-slate-800/50',
        insetDeep: 'bg-slate-800/60',
        glass: 'bg-slate-900/80 backdrop-blur-xl',
        overlay: 'bg-black/60 backdrop-blur-md',
    },
    text: {
        primary: 'text-white',
        secondary: 'text-slate-300',
        tertiary: 'text-slate-400',
        muted: 'text-slate-500',
        disabled: 'text-slate-600',
    },
    accent: {
        sky: {
            bg: 'bg-sky-500/10',
            bgActive: 'bg-sky-500/20',
            text: 'text-sky-400',
            border: 'border-sky-500/20',
            borderActive: 'border-sky-500/40',
        },
        amber: {
            bg: 'bg-amber-500/10',
            bgActive: 'bg-amber-500/30',
            text: 'text-amber-400',
            border: 'border-amber-500/20',
            borderActive: 'border-amber-500/60',
        },
        emerald: {
            bg: 'bg-emerald-500/10',
            bgActive: 'bg-emerald-500/20',
            text: 'text-emerald-400',
            border: 'border-emerald-500/20',
            borderActive: 'border-emerald-500/40',
        },
        red: {
            bg: 'bg-red-500/10',
            bgActive: 'bg-red-500/20',
            text: 'text-red-400',
            border: 'border-red-500/20',
            borderActive: 'border-red-500/40',
        },
        purple: {
            bg: 'bg-purple-500/10',
            bgActive: 'bg-purple-500/30',
            text: 'text-purple-400',
            border: 'border-purple-500/20',
            borderActive: 'border-purple-500/60',
        },
    },
    border: {
        subtle: 'border border-white/5',
        default: 'border border-white/10',
        strong: 'border border-white/20',
        glass: 'border border-white/[0.06]',
    },
};


// ══════════════════════════════════════════════════════════════════
//   ONSHORE THEME — Warm earth tones, stone grays, amber/sand accents
// ══════════════════════════════════════════════════════════════════

const onshoreColors: ThemeColors = {
    bg: {
        base: 'bg-stone-950',
        elevated: 'bg-stone-900',
        surface: 'bg-stone-900/70',
        surfaceAlt: 'bg-stone-900/50',
        inset: 'bg-stone-800/50',
        insetDeep: 'bg-stone-800/60',
        glass: 'bg-stone-900/80 backdrop-blur-xl',
        overlay: 'bg-black/60 backdrop-blur-md',
    },
    text: {
        primary: 'text-white',
        secondary: 'text-stone-300',
        tertiary: 'text-stone-400',
        muted: 'text-stone-500',
        disabled: 'text-stone-600',
    },
    accent: {
        sky: {
            bg: 'bg-amber-500/10',
            bgActive: 'bg-amber-500/20',
            text: 'text-amber-400',
            border: 'border-amber-500/20',
            borderActive: 'border-amber-500/40',
        },
        amber: {
            bg: 'bg-orange-500/10',
            bgActive: 'bg-orange-500/30',
            text: 'text-orange-400',
            border: 'border-orange-500/20',
            borderActive: 'border-orange-500/60',
        },
        emerald: {
            bg: 'bg-emerald-500/10',
            bgActive: 'bg-emerald-500/20',
            text: 'text-emerald-400',
            border: 'border-emerald-500/20',
            borderActive: 'border-emerald-500/40',
        },
        red: {
            bg: 'bg-red-500/10',
            bgActive: 'bg-red-500/20',
            text: 'text-red-400',
            border: 'border-red-500/20',
            borderActive: 'border-red-500/40',
        },
        purple: {
            bg: 'bg-rose-500/10',
            bgActive: 'bg-rose-500/30',
            text: 'text-rose-400',
            border: 'border-rose-500/20',
            borderActive: 'border-rose-500/60',
        },
    },
    border: {
        subtle: 'border border-white/5',
        default: 'border border-white/10',
        strong: 'border border-white/20',
        glass: 'border border-white/[0.06]',
    },
};


// ── Shared Tokens (same for both themes) ────────────────────────

export const typography = {
    pageTitle: 'text-lg font-black text-white tracking-tight',
    sectionTitle: 'text-sm font-bold text-white',
    dataLg: 'text-lg font-black text-white font-mono',
    dataMd: 'text-base font-black text-white font-mono',
    dataSm: 'text-sm font-black text-white font-mono',
    label: 'text-sm text-slate-400 uppercase tracking-wider',
    labelSm: 'text-sm text-slate-400 uppercase tracking-wider',
    body: 'text-sm text-slate-300',
    bodyMuted: 'text-sm text-slate-400',
    caption: 'text-sm text-slate-400',
    unit: 'text-sm text-slate-400',
} as const;

export const spacing = {
    page: 'p-3',
    pageX: 'px-3',
    pageY: 'py-3',
    card: 'p-2.5',
    cardCompact: 'p-2',
    cardRelaxed: 'p-3',
    stack: 'space-y-2',
    stackRelaxed: 'space-y-3',
    navClearance: 'pb-24',
} as const;

export const radii = {
    pill: 'rounded-full',
    control: 'rounded-lg',
    card: 'rounded-xl',
    modal: 'rounded-2xl',
} as const;

export const badge = {
    red: 'bg-red-500/20 text-red-400',
    amber: 'bg-amber-500/20 text-amber-400',
    sky: 'bg-sky-500/20 text-sky-400',
    emerald: 'bg-emerald-500/20 text-emerald-400',
    purple: 'bg-purple-500/20 text-purple-400',
    pill: 'text-sm font-bold uppercase tracking-wider px-2 py-0.5 rounded-full',
} as const;

export const animation = {
    press: 'active:scale-95',
    pressSubtle: 'active:scale-[0.97]',
    pressDeep: 'active:scale-[0.98]',
    pulse: 'animate-pulse',
    spin: 'animate-spin',
} as const;


// ── Theme Builder ───────────────────────────────────────────────

function buildTheme(colors: ThemeColors, env: Environment): ThemeTokens {
    return {
        colors,
        typography,
        spacing,
        radii,
        badge,
        animation,
        border: colors.border,
        environment: env,

        card: {
            base: `${colors.bg.surface} ${radii.card} ${colors.border.default} ${spacing.card}`,
            glass: `${colors.bg.glass} ${radii.card} ${colors.border.glass}`,
            inset: `${colors.bg.inset} ${radii.control} p-1.5 text-center`,
            insetRelaxed: `${colors.bg.inset} ${radii.control} p-2 text-center`,
        },

        button: {
            primary: env === 'offshore'
                ? 'w-full py-3.5 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 rounded-xl text-white text-base font-black transition-all active:scale-[0.98] shadow-lg shadow-amber-900/30 disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2'
                : 'w-full py-3.5 bg-gradient-to-r from-emerald-700 to-emerald-600 hover:from-emerald-600 hover:to-emerald-500 rounded-xl text-white text-base font-black transition-all active:scale-[0.98] shadow-lg shadow-emerald-900/30 disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2',
            secondary: `py-2 ${colors.bg.inset} backdrop-blur ${colors.border.default} ${radii.card} text-sm font-bold transition-all active:scale-[0.97]`,
            danger: `py-2 bg-red-500/[0.08] backdrop-blur border border-red-500/20 ${radii.card} text-red-400 text-sm font-bold transition-all active:scale-[0.97] hover:bg-red-500/[0.12]`,
            ghost: `px-3 py-1.5 bg-white/5 hover:bg-white/10 ${radii.control} text-sm font-bold transition-all active:scale-95`,
            toggleOff: `flex-1 py-1.5 ${radii.control} text-sm font-bold ${colors.bg.insetDeep} ${colors.border.subtle} ${colors.text.muted}`,
        },

        modal: {
            backdrop: `fixed inset-0 z-[9999] flex items-center justify-center ${colors.bg.overlay} p-6`,
            panel: `w-full max-w-sm ${colors.bg.elevated}/95 backdrop-blur-xl border border-white/15 ${radii.modal} shadow-2xl overflow-hidden`,
            header: 'flex items-center justify-between px-5 pt-5 pb-3',
            body: 'px-5 pb-5 space-y-4',
            close: `p-1.5 ${radii.control} bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors`,
        },

        header: {
            bar: `${colors.bg.base}/90 backdrop-blur-lg border-b border-white/5 px-4 py-2 shrink-0`,
            glass: `shrink-0 px-4 py-2.5 bg-gradient-to-r from-${env === 'offshore' ? 'slate' : 'stone'}-900/80 via-${env === 'offshore' ? 'slate' : 'stone'}-950/90 to-${env === 'offshore' ? 'slate' : 'stone'}-900/80 backdrop-blur-xl border-b border-white/[0.06]`,
        },

        input: {
            base: `${colors.bg.insetDeep} ${colors.border.default} ${radii.control} px-3 py-2 text-white focus:border-sky-500 focus:outline-none`,
            code: `${colors.bg.insetDeep} border border-white/10 ${radii.control} px-3 py-2.5 text-white text-center font-mono tracking-[0.3em] placeholder-slate-700 focus:border-sky-500 focus:outline-none`,
            slider: `w-full h-1.5 ${env === 'offshore' ? 'bg-slate-800' : 'bg-stone-800'} rounded-full appearance-none cursor-pointer`,
        },
    };
}


// ── Built Themes ────────────────────────────────────────────────

export const offshoreTheme: ThemeTokens = buildTheme(offshoreColors, 'offshore');
export const onshoreTheme: ThemeTokens = buildTheme(onshoreColors, 'onshore');

/** Get theme for a given environment */
export function getThemeForEnvironment(env: Environment): ThemeTokens {
    return env === 'onshore' ? onshoreTheme : offshoreTheme;
}


// ── Backward-Compatible Exports ─────────────────────────────────
// These exist so the 56 files that `import { t } from '../theme'`
// continue to work without modification. They always get offshore.

export const colors = offshoreColors;

export const card = offshoreTheme.card;
export const button = offshoreTheme.button;
export const modal = offshoreTheme.modal;
export const header = offshoreTheme.header;
export const input = offshoreTheme.input;

/** Shorthand for common imports: `import { t } from '../theme'` */
export const t: ThemeTokens = offshoreTheme;

export default t;
