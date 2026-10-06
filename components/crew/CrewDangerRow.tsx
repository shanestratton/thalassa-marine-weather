/**
 * CrewDangerRow — the Crew & Float Plan page's one destructive action, as a
 * quiet red row at the very foot of the page (Shane 2026-10-06, the page's
 * new look): never beside Invite crew, Switch boat or any everyday button.
 *
 *   own boat:      Disband Entire Group — opens the unchanged confirm dialog
 *                  ("Type DISBAND to confirm").
 *   crewing view:  Leave <boat> — the same soft leave, with its Undo.
 */
import React, { useId } from 'react';

export const CrewDangerRow: React.FC<{
    label: string;
    /** One line under the row: what it does, read as its description. */
    hint: string;
    icon: React.ReactNode;
    onClick: () => void;
}> = ({ label, hint, icon, onClick }) => {
    const hintId = useId();
    return (
        <div
            className="mt-8 border-t pt-5"
            style={{ borderColor: 'var(--vessel-card-border, rgba(255, 255, 255, 0.08))' }}
        >
            <button type="button" onClick={onClick} aria-describedby={hintId} className="crew-danger-row">
                {icon}
                <span>{label}</span>
            </button>
            <p id={hintId} className="crew-muted mt-2 text-center text-[11px] leading-relaxed">
                {hint}
            </p>
        </div>
    );
};
