/**
 * FormField — Shared form input component for Ship's Office forms.
 *
 * Eliminates 115+ duplicate className strings across vessel components.
 * Supports text, number, date, and textarea variants.
 * Auto-scrolls above the iOS keyboard + accessory bar on focus.
 */
import React, { useId } from 'react';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';

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
    /** Additional onFocus handler — keyboard scroll happens automatically */
    onFocus?: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

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
    const fieldId = useId();
    const errorId = error ? `${fieldId}-error` : undefined;
    const hintId = hint && !error ? `${fieldId}-hint` : undefined;
    const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

    const isDate = type === 'date';
    const isTextarea = type === 'textarea';
    const borderClass = error ? 'border-red-500/40 focus:border-red-500/60' : 'border-white/10 focus:border-sky-500/30';
    const baseClass = isDate
        ? `w-full max-w-full min-w-0 mt-0.5 bg-white/5 border ${borderClass} rounded-xl px-3 py-2 text-sm text-white outline-none transition-colors [color-scheme:dark] box-border`
        : `w-full min-w-0 mt-0.5 bg-white/5 border ${borderClass} rounded-xl px-3 py-2 text-white text-sm outline-none transition-colors placeholder:text-gray-400`;
    const inputClass = `${baseClass}${mono ? ' font-mono' : ''} ${className}`.trim();

    // Combined focus handler: auto keyboard scroll + optional custom handler
    const handleFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        scrollInputAboveKeyboard(e);
        onFocus?.(e);
    };

    return (
        <div className={isDate ? 'min-w-0 max-w-full overflow-hidden' : undefined}>
            <label htmlFor={fieldId} className="text-label font-bold text-gray-400 uppercase tracking-widest">
                {label}
                {required ? ' *' : ''}
            </label>
            {isTextarea ? (
                <textarea
                    id={fieldId}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    autoFocus={autoFocus}
                    rows={rows}
                    aria-required={required || undefined}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy}
                    onFocus={handleFocus as React.FocusEventHandler<HTMLTextAreaElement>}
                    className={`${inputClass} resize-none`}
                />
            ) : (
                <input
                    id={fieldId}
                    type={type}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    autoFocus={autoFocus}
                    min={min}
                    inputMode={inputMode}
                    aria-required={required || undefined}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy}
                    onFocus={handleFocus as React.FocusEventHandler<HTMLInputElement>}
                    className={inputClass}
                />
            )}
            {error && <p id={errorId} className="text-micro text-red-400 mt-1" role="alert">{error}</p>}
            {hint && !error && <p id={hintId} className="text-micro text-gray-400 mt-0.5">{hint}</p>}
        </div>
    );
};
