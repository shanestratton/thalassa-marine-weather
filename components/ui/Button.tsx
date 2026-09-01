/**
 * Button — the primitive theme.ts was already written for.
 *
 * The 2026-08-27 UI audit found the design system's two most valuable token
 * sets had no consumers at all: `t.button.*` (primary/secondary/danger/ghost)
 * and `t.touchTarget.*` (the 44pt guarantees inherited from the deleted CVA
 * file), against 1,126 raw <button> elements across 245 files. Buttons are
 * the most repeated interactive element in any app and carried zero
 * abstraction, so every one of them re-decided its own padding, radius,
 * press feedback and — the part that matters at sea — its hit area.
 *
 * This component is deliberately thin. It does not invent a look; it renders
 * the tokens that already exist, reads them from the theme STORE so a button
 * follows the offshore/onshore environment without its caller thinking about
 * it, and guarantees the touch target. Anything a caller passes in className
 * is appended, so bespoke buttons stay possible — the point is that the
 * ordinary ones stop being bespoke.
 *
 * Deliberately NOT handled here: the app's many one-off map/HUD controls with
 * their own geometry. Forcing those through a variant prop would produce a
 * primitive with fifteen escape hatches, which is how component libraries die.
 */
import React from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { touchTarget } from '../../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'default' | 'sm' | 'icon';

const SIZE_CLASS: Record<ButtonSize, string> = {
    default: touchTarget.button,
    /** The one sanctioned sub-44pt case: dense secondary rows. */
    sm: touchTarget.buttonSm,
    icon: touchTarget.icon,
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ variant = 'secondary', size = 'default', className = '', type = 'button', children, ...rest }, ref) => {
        const theme = useThemeStore((s) => s.theme);
        return (
            <button
                ref={ref}
                type={type}
                className={[
                    theme.button[variant],
                    SIZE_CLASS[size],
                    // The global :focus-visible ring in index.css covers the
                    // keyboard case; this only keeps the browser default from
                    // doubling up on it.
                    'focus:outline-hidden',
                    className,
                ]
                    .filter(Boolean)
                    .join(' ')}
                {...rest}
            >
                {children}
            </button>
        );
    },
);

Button.displayName = 'Button';
