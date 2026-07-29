/**
 * LoadErrorState — "we could not load this", as distinct from "there is
 * nothing here".
 *
 * Several Ship's Office pages collapsed a failed fetch into their empty state:
 * the request threw, a toast flashed for a few seconds, and what remained on
 * screen was an illustration reading "No safety equipment logged". On a marine
 * app that is not a cosmetic bug — it tells the skipper their flare and liferaft
 * records are absent when in fact they simply could not be fetched, and it does
 * so in the calm, illustrated voice of a legitimately empty list.
 *
 * The distinction this component exists to preserve:
 *   empty  → the boat genuinely has no records; the CTA is "add one".
 *   error  → we do not know what the boat has; the CTA is "try again".
 *
 * Built on EmptyState so the layout and spacing stay identical to the empty
 * case, because the difference should be the WORDS and the action, not a
 * separate visual language.
 */
import React from 'react';
import { EmptyState } from './EmptyState';

interface LoadErrorStateProps {
    /** What failed to load, lower case: "your stores", "the maintenance log". */
    what: string;
    onRetry: () => void;
    /** Overrides the default copy when a page needs something more specific. */
    description?: string;
}

export const LoadErrorState: React.FC<LoadErrorStateProps> = ({ what, onRetry, description }) => (
    <EmptyState
        icon={
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
            </svg>
        }
        title={`Couldn't load ${what}`}
        description={
            description ??
            `This is a loading problem, not an empty list — your records are still there. Check your connection and try again.`
        }
        actionLabel="Try again"
        onAction={onRetry}
    />
);
