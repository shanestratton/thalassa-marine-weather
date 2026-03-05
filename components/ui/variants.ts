/**
 * CVA Variants — Type-safe design token system for Thalassa.
 *
 * All reusable class patterns are defined here as CVA variants.
 * Components import these functions and call them with typed props
 * instead of hand-crafting className strings.
 *
 * ┌─────────────────────────────────────────┐
 * │ 5 colours · 8 sizes · 4 radii · 2 fonts │
 * └─────────────────────────────────────────┘
 */
import { cva, type VariantProps } from 'class-variance-authority';

// ═══════════════════════════════════════════════
// BADGE — Status pills, category labels, counters
// ═══════════════════════════════════════════════

export const badge = cva(
    'inline-flex items-center font-bold uppercase tracking-wider border',
    {
        variants: {
            color: {
                sky: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
                emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
                amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
                red: 'bg-red-500/10 border-red-500/20 text-red-400',
                purple: 'bg-purple-500/10 border-purple-500/20 text-purple-400',
                neutral: 'bg-white/[0.06] border-white/10 text-white/70',
            },
            size: {
                sm: 'px-1.5 py-0.5 text-[11px] rounded-full',
                md: 'px-2 py-0.5 text-[11px] rounded-full',
                lg: 'px-3 py-1 text-xs rounded-xl',
            },
        },
        defaultVariants: {
            color: 'sky',
            size: 'md',
        },
    }
);

export type BadgeProps = VariantProps<typeof badge>;

// ═══════════════════════════════════════════════
// CARD — Surface containers
// ═══════════════════════════════════════════════

export const card = cva(
    'border shadow-lg',
    {
        variants: {
            variant: {
                default: 'bg-white/[0.04] border-white/[0.06]',
                elevated: 'bg-white/[0.06] border-white/10',
                interactive: 'bg-white/[0.04] border-white/[0.06] hover:bg-white/[0.06] transition-all active:scale-[0.98]',
                gradient: 'bg-gradient-to-br from-white/[0.04] to-white/[0.02] border-white/[0.06]',
            },
            radius: {
                lg: 'rounded-lg',
                xl: 'rounded-xl',
                '2xl': 'rounded-2xl',
            },
            padding: {
                none: '',
                sm: 'p-3',
                md: 'p-4',
                lg: 'p-5',
            },
        },
        defaultVariants: {
            variant: 'default',
            radius: '2xl',
            padding: 'md',
        },
    }
);

export type CardProps = VariantProps<typeof card>;

// ═══════════════════════════════════════════════
// BUTTON — All interactive buttons
// ═══════════════════════════════════════════════

export const button = cva(
    'inline-flex items-center justify-center font-bold uppercase tracking-wider transition-all active:scale-[0.97]',
    {
        variants: {
            variant: {
                primary: 'bg-gradient-to-r from-sky-500 to-sky-600 text-white shadow-lg shadow-sky-500/20 border border-sky-400/30',
                secondary: 'bg-white/[0.06] border border-white/10 text-white hover:bg-white/10',
                ghost: 'bg-transparent text-white/60 hover:text-white hover:bg-white/5',
                danger: 'bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20',
                success: 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20',
            },
            size: {
                sm: 'px-3 py-1.5 text-[11px] rounded-xl min-h-[36px]',
                md: 'px-4 py-2.5 text-xs rounded-xl min-h-[44px]',
                lg: 'px-6 py-3.5 text-sm rounded-2xl min-h-[48px]',
                icon: 'w-11 h-11 rounded-xl min-w-[44px] min-h-[44px]',
            },
        },
        defaultVariants: {
            variant: 'secondary',
            size: 'md',
        },
    }
);

export type ButtonProps = VariantProps<typeof button>;

// ═══════════════════════════════════════════════
// INPUT — Form fields
// ═══════════════════════════════════════════════

export const input = cva(
    'w-full bg-white/[0.06] border border-white/10 text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors',
    {
        variants: {
            size: {
                sm: 'px-3 py-2 text-xs rounded-lg',
                md: 'px-3.5 py-2.5 text-sm rounded-xl',
                lg: 'px-4 py-3 text-base rounded-xl',
            },
        },
        defaultVariants: {
            size: 'md',
        },
    }
);

export type InputProps = VariantProps<typeof input>;

// ═══════════════════════════════════════════════
// SECTION LABEL — Zone headers (e.g., "Ship's Office")
// ═══════════════════════════════════════════════

export const sectionLabel = cva(
    'text-[11px] font-black uppercase tracking-[0.2em]',
    {
        variants: {
            color: {
                sky: 'text-sky-400',
                emerald: 'text-emerald-400',
                amber: 'text-amber-400',
                red: 'text-red-400',
                purple: 'text-purple-400',
                muted: 'text-gray-500',
            },
        },
        defaultVariants: {
            color: 'sky',
        },
    }
);

export type SectionLabelProps = VariantProps<typeof sectionLabel>;

// ═══════════════════════════════════════════════
// SKELETON — Loading placeholders
// ═══════════════════════════════════════════════

export const skeleton = cva(
    'skeleton-shimmer',
    {
        variants: {
            shape: {
                rect: 'rounded-lg',
                circle: 'rounded-full',
                card: 'rounded-2xl',
            },
        },
        defaultVariants: {
            shape: 'rect',
        },
    }
);

export type SkeletonProps = VariantProps<typeof skeleton>;

// ═══════════════════════════════════════════════
// ACCENT THEMES — Colour scheme for themed cards
// ═══════════════════════════════════════════════

export const accentCard = cva(
    'border rounded-xl transition-all',
    {
        variants: {
            color: {
                sky: 'bg-gradient-to-br from-sky-500/15 to-sky-500/15 border-sky-500/20',
                emerald: 'bg-gradient-to-br from-emerald-500/15 to-emerald-500/15 border-emerald-500/20',
                amber: 'bg-gradient-to-br from-amber-500/15 to-amber-500/15 border-amber-500/20',
                red: 'bg-gradient-to-br from-red-500/15 to-red-500/15 border-red-500/20',
                purple: 'bg-gradient-to-br from-purple-500/15 to-purple-500/15 border-purple-500/20',
            },
            interactive: {
                true: 'hover:scale-[1.02] active:scale-[0.98] cursor-pointer',
                false: '',
            },
        },
        defaultVariants: {
            color: 'sky',
            interactive: false,
        },
    }
);

export type AccentCardProps = VariantProps<typeof accentCard>;

// ═══════════════════════════════════════════════
// MENU ITEM — Dropdown / context menu rows
// ═══════════════════════════════════════════════

export const menuItem = cva(
    'w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3',
    {
        variants: {
            variant: {
                default: '',
                danger: 'text-red-400 hover:bg-red-500/10',
                bordered: 'border-t border-white/5',
            },
        },
        defaultVariants: {
            variant: 'default',
        },
    }
);

export type MenuItemProps = VariantProps<typeof menuItem>;
