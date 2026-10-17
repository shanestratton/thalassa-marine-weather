import React from 'react';

/** A stroke icon from components/icons; each one is aria-hidden. */
export type BinderCategoryIcon = (props: { className?: string }) => React.JSX.Element;

export interface BinderCategoryChoice<T extends string> {
    id: T;
    /** The words on the button. */
    label: string;
    Icon?: BinderCategoryIcon;
    /** Its spoken name, where the page has long given it one ('Select Rigging category'). */
    name?: string;
}

/**
 * The Stores category grid for every binder sheet (132-B19): three across,
 * the icon above a label that wraps. The Equipment, Documents and
 * Maintenance chips put icon and word on one line in a third of the sheet,
 * and at 320 px in wide fonts 'Electronics' and 'Registration' ran out of
 * their pills. A choice with no icon (a schedule) is a plain 44 pt cell.
 */
export function BinderCategoryGrid<T extends string>({
    label,
    choices,
    value,
    onChange,
}: {
    /** The group's spoken name. */
    label: string;
    choices: readonly BinderCategoryChoice<T>[];
    value: T;
    onChange: (id: T) => void;
}) {
    return (
        <div role="group" aria-label={label} className="grid grid-cols-3 gap-1 mt-0.5 sm:gap-1.5">
            {choices.map(({ id, label: words, Icon, name }) => (
                <button
                    key={id}
                    type="button"
                    aria-label={name ?? words}
                    aria-pressed={value === id}
                    onClick={() => onChange(id)}
                    className={`flex min-w-0 ${Icon ? 'min-h-[56px]' : 'min-h-[44px]'} flex-col items-center justify-center gap-1 rounded-lg px-0.5 py-1.5 text-[10px] sm:text-xs leading-tight font-bold text-center transition-all ${
                        value === id
                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                            : 'bg-white/5 text-gray-400 border border-white/5'
                    }`}
                >
                    {Icon && <Icon className="h-4 w-4 shrink-0" />}
                    {/* A slash is a place to wrap: 'Radio/MMSI' broke as 'Radio/MMS' over 'I'. */}
                    <span className="w-full min-w-0 text-balance [overflow-wrap:anywhere]">
                        {words.replace(/\//g, '/​')}
                    </span>
                </button>
            ))}
        </div>
    );
}
