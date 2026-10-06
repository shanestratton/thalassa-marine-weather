/**
 * "Who sees it": Private, Crew or Public, with one line saying what the choice
 * means. The server enforces every rule here too (fish never Public; Crew
 * needs a boat; Public is three hours late and on a grid); this only keeps
 * the punter from choosing what would be refused.
 */
import React, { useId, useRef } from 'react';
import type { SightingGroup, SightingVisibility } from '../../services/sightings/types';
import { SightingIcon, type SightingIconName } from './SightingGlyphs';

const OPTIONS: Array<{ value: SightingVisibility; label: string; icon: SightingIconName }> = [
    { value: 'private', label: 'Private', icon: 'lock' },
    { value: 'crew', label: 'Crew', icon: 'crew' },
    { value: 'public', label: 'Public', icon: 'globe' },
];

export interface VisibilityPickerProps {
    value: SightingVisibility;
    group: SightingGroup;
    signedIn: boolean;
    /** The sighting has a boat (Crew needs one). */
    hasVessel: boolean;
    /** "your 2 crew on the Tern Away", for the Crew line. */
    crewAudience: string;
    /** The server has it: the crew see it now (else once it is sent). */
    sent?: boolean;
    /** A public copy would sit on the 8 km grid (threatened, once threatened, or no species named yet); the public ocean page shows it only as an area count. */
    coarse: boolean;
    /** A species is named (a coarse group-only row is 8 km only until it is). */
    named?: boolean;
    creditPublic: boolean;
    onChange: (value: SightingVisibility) => void;
    onCreditChange: (credit: boolean) => void;
}

export function visibilityExplainer(
    props: Omit<VisibilityPickerProps, 'onChange' | 'onCreditChange' | 'creditPublic'>,
) {
    const { value, group, signedIn, hasVessel, crewAudience, coarse, sent = true, named = true } = props;
    const lines: string[] = [];
    if (!signedIn) {
        lines.push('Only you, on this phone. Sign in to keep it in your account and share it.');
        return lines;
    }
    if (value === 'private') lines.push('Only you. It stays in your account.');
    if (value === 'crew') lines.push(`Crew: ${crewAudience} see it ${sent ? 'now' : 'once it’s sent'}.`);
    if (value === 'public') {
        const grid = !coarse ? '1 km' : named ? '8 km (threatened)' : '8 km until you name the species';
        lines.push(`Everyone, 3 hours later, blurred to about ${grid}. Photos and notes stay with the crew.`);
        // ocean.thalassawx.app shows anyone less than signed-in Thalassa
        // users see (20261006120000_ocean_public_read.sql).
        if (coarse) {
            lines.push(
                'Anyone else on the web sees less: the public ocean map shows it only as an area count in a 10 km square, once 3 boats have logged it there.',
            );
        } else {
            lines.push(
                'The sea temperature from your instruments, if any, goes on its species page in 1 °C bands once 3 boats have logged it.',
            );
        }
        lines.push('Deleting it or making it private clears the public map within about 15 minutes.');
    }
    if (group === 'fish') lines.push('Fish stay off the public map. Catch spots are yours.');
    else if (!hasVessel && value !== 'public')
        lines.push('Crew needs a boat: add your vessel, or join a skipper’s crew.');
    return lines;
}

export const VisibilityPicker: React.FC<VisibilityPickerProps> = (props) => {
    const { value, group, signedIn, hasVessel, creditPublic, onChange, onCreditChange } = props;
    const labelId = useId();
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const enabled = (v: SightingVisibility) =>
        signedIn && (v === 'private' || (v === 'crew' ? hasVessel : group !== 'fish'));

    const move = (from: number, step: number) => {
        for (let n = 1; n <= OPTIONS.length; n += 1) {
            const i = (from + step * n + OPTIONS.length * 3) % OPTIONS.length;
            if (enabled(OPTIONS[i].value)) {
                onChange(OPTIONS[i].value);
                refs.current[i]?.focus();
                return;
            }
        }
    };

    return (
        <div>
            <div id={labelId} className="mb-1.5 sg-eyebrow">
                Who sees it
            </div>
            <div role="radiogroup" aria-labelledby={labelId} className="sg-seg flex gap-1 p-1">
                {OPTIONS.map((option, i) => {
                    const on = value === option.value;
                    const ok = enabled(option.value);
                    return (
                        <button
                            key={option.value}
                            ref={(el) => {
                                refs.current[i] = el;
                            }}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-disabled={!ok || undefined}
                            tabIndex={on ? 0 : -1}
                            onClick={() => ok && !on && onChange(option.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    move(i, 1);
                                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    move(i, -1);
                                }
                            }}
                            className="sg-toggle sg-seg-btn"
                        >
                            <SightingIcon name={option.icon} className="h-[15px] w-[15px]" />
                            {option.label}
                        </button>
                    );
                })}
            </div>
            <div aria-live="polite" className="mt-1.5 space-y-0.5 text-[12.5px] leading-snug sg-muted">
                {visibilityExplainer(props).map((line) => (
                    <p key={line}>{line}</p>
                ))}
            </div>
            {signedIn && value === 'public' && props.coarse && (
                <p className="mt-1 sg-note">
                    No log-handle credit on the 8 km grid: your public log’s track would show where it was.
                </p>
            )}
            {signedIn && value === 'public' && !props.coarse && (
                <label className="mt-1 flex min-h-[44px] cursor-pointer items-center gap-3 text-[13px] font-semibold text-white/85">
                    <input
                        type="checkbox"
                        checked={creditPublic}
                        onChange={(e) => onCreditChange(e.target.checked)}
                        className="h-5 w-5 accent-sky-500"
                    />
                    Credit my public log handle (otherwise “A Thalassa sailor”)
                </label>
            )}
        </div>
    );
};
