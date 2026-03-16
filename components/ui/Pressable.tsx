/**
 * Pressable — Accessible interactive container.
 *
 * Wraps a div that responds to both click and keyboard (Enter/Space).
 * Automatically adds role="button", tabIndex, and onKeyDown handler.
 * Use this instead of raw `<div onClick={...}>` for any non-button
 * interactive element that a keyboard user should be able to activate.
 *
 * Usage:
 *   <Pressable onClick={handleTap} label="Open settings">
 *     <SettingsIcon /> Settings
 *   </Pressable>
 */
import React, { useCallback } from 'react';

interface PressableProps {
    /** Click/press handler */
    onClick: (e?: React.MouseEvent | React.KeyboardEvent) => void;
    /** Accessible label (for screen readers) */
    label?: string;
    /** Optional ARIA role override (default: "button") */
    role?: string;
    /** Optional className */
    className?: string;
    /** Optional disabled state */
    disabled?: boolean;
    /** Children */
    children: React.ReactNode;
    /** Additional props to pass through */
    style?: React.CSSProperties;
    /** Optional test id */
    'data-testid'?: string;
}

export const Pressable: React.FC<PressableProps> = ({
    onClick,
    label,
    role: ariaRole = 'button',
    className,
    disabled = false,
    children,
    style,
    'data-testid': testId,
}) => {
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick(e);
            }
        },
        [onClick, disabled],
    );

    return (
        <div
            role={ariaRole}
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-disabled={disabled || undefined}
            className={className}
            style={style}
            onClick={disabled ? undefined : onClick}
            onKeyDown={handleKeyDown}
            data-testid={testId}
        >
            {children}
        </div>
    );
};
