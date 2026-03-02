/**
 * FormField — Shared form input component for Ship's Office forms.
 *
 * Eliminates 115+ duplicate className strings across vessel components.
 * Supports text, number, date, and textarea variants.
 */
import React from 'react';

interface FormFieldProps {
    label: string;
    type?: 'text' | 'number' | 'date' | 'textarea';
    value: string | number;
    onChange: (value: string) => void;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
    min?: number;
    /** Additional className to append */
    className?: string;
    /** Use monospace font (for barcodes, serials) */
    mono?: boolean;
    /** Input mode for mobile keyboard (e.g. 'numeric') */
    inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url';
    /** Textarea rows (default: 3) */
    rows?: number;
    /** Error message — shows red border + message */
    error?: string;
    /** Hint text below the field */
    hint?: string;
    /** onFocus handler (e.g. for scrollIntoView keyboard avoidance) */
    onFocus?: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

const BASE_INPUT = 'w-full min-w-0 mt-0.5 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm outline-none focus:border-sky-500/30 transition-colors placeholder:text-gray-500';
const DATE_INPUT = 'w-full min-w-0 mt-0.5 bg-white/5 border border-white/10 rounded-xl px-2 py-2 text-[13px] text-white outline-none focus:border-sky-500/30 transition-colors [color-scheme:dark]';

export const FormField: React.FC<FormFieldProps> = ({
    label,
    type = 'text',
    value,
    onChange,
    placeholder,
    required,
    disabled,
    autoFocus,
    min,
    className = '',
    mono,
    inputMode,
    rows = 3,
    error,
    hint,
    onFocus,
}) => {
    const isDate = type === 'date';
    const isTextarea = type === 'textarea';
    const borderClass = error
        ? 'border-red-500/40 focus:border-red-500/60'
        : 'border-white/10 focus:border-sky-500/30';
    const baseClass = isDate
        ? `w-full min-w-0 mt-0.5 bg-white/5 border ${borderClass} rounded-xl px-2 py-2 text-[13px] text-white outline-none transition-colors [color-scheme:dark]`
        : `w-full min-w-0 mt-0.5 bg-white/5 border ${borderClass} rounded-xl px-3 py-2 text-white text-sm outline-none transition-colors placeholder:text-gray-500`;
    const inputClass = `${baseClass}${mono ? ' font-mono' : ''} ${className}`.trim();

    return (
        <div className={isDate ? 'min-w-0 overflow-hidden' : undefined}>
            <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">
                {label}{required ? ' *' : ''}
            </label>
            {isTextarea ? (
                <textarea
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    autoFocus={autoFocus}
                    rows={rows}
                    onFocus={onFocus as React.FocusEventHandler<HTMLTextAreaElement>}
                    className={`${inputClass} resize-none`}
                />
            ) : (
                <input
                    type={type}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    autoFocus={autoFocus}
                    min={min}
                    inputMode={inputMode}
                    onFocus={onFocus as React.FocusEventHandler<HTMLInputElement>}
                    className={inputClass}
                />
            )}
            {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
            {hint && !error && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}
        </div>
    );
};
