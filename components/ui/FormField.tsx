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
}) => {
    const isDate = type === 'date';
    const isTextarea = type === 'textarea';
    const inputClass = `${isDate ? DATE_INPUT : BASE_INPUT}${mono ? ' font-mono' : ''} ${className}`.trim();

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
                    className={inputClass}
                />
            )}
        </div>
    );
};
