/**
 * SignInButton — the one sign-in control.
 *
 * Sign-in was drawn three ways: an amber primary on Account, a teal full-width
 * slab on the Vessel hub and a chevron row on Voyage Log (UX scorecard run 7).
 * Every entry point renders this instead: the house primary, sentence case,
 * with the caller's own words when the action needs context ("Sign in to make
 * this the primary device"). Opening the sign-in sheet stays the caller's job.
 */
import React from 'react';
import { Button } from './Button';

interface SignInButtonProps {
    onClick: () => void;
    /** Visible label. Defaults to "Sign in". */
    label?: string;
    /** Stretch to the width of its column (cards, empty states). */
    fullWidth?: boolean;
    disabled?: boolean;
    /** Layout classes only (margins, alignment). */
    className?: string;
}

export const SignInButton: React.FC<SignInButtonProps> = ({
    onClick,
    label = 'Sign in',
    fullWidth = false,
    disabled,
    className = '',
}) => (
    <Button
        variant="primary"
        onClick={onClick}
        disabled={disabled}
        className={[fullWidth ? 'w-full' : 'px-8', className].filter(Boolean).join(' ')}
    >
        {label}
    </Button>
);
