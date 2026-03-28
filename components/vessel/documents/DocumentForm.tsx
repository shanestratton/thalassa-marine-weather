/**
 * DocumentForm — Add / Edit document form modal content.
 *
 * Extracted from DocumentsHub to reduce monolithic size.
 */

import React, { useRef } from 'react';
import type { DocumentCategory } from '../../../types';
import { FormField } from '../../ui/FormField';
import { triggerHaptic } from '../../../utils/system';

export const CATEGORIES: { id: DocumentCategory; label: string; icon: string }[] = [
    { id: 'Registration', label: 'Registration', icon: '🚢' },
    { id: 'Insurance', label: 'Insurance', icon: '🛡️' },
    { id: 'Crew Visas/IDs', label: 'Crew IDs', icon: '🪪' },
    { id: 'Radio/MMSI', label: 'Radio/MMSI', icon: '📻' },
    { id: 'Customs Clearances', label: 'Customs', icon: '🛂' },
    { id: 'User Manuals', label: 'Manuals', icon: '📖' },
];

interface DocumentFormProps {
    isEdit: boolean;
    formName: string;
    formCategory: DocumentCategory;
    formIssueDate: string;
    formExpiryDate: string;
    formNotes: string;
    formFileUri: string | null;
    formFileName: string | null;
    onNameChange: (v: string) => void;
    onCategoryChange: (v: DocumentCategory) => void;
    onIssueDateChange: (v: string) => void;
    onExpiryDateChange: (v: string) => void;
    onNotesChange: (v: string) => void;
    onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRemoveFile: () => void;
    onSave: () => void;
}

export const DocumentForm: React.FC<DocumentFormProps> = ({
    isEdit,
    formName,
    formCategory,
    formIssueDate,
    formExpiryDate,
    formNotes,
    formFileUri,
    formFileName,
    onNameChange,
    onCategoryChange,
    onIssueDateChange,
    onExpiryDateChange,
    onNotesChange,
    onFileSelect,
    onRemoveFile,
    onSave,
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    return (
        <>
            {/* Category */}
            <div className="mb-3">
                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1.5">
                    Category
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                    {CATEGORIES.map((cat) => (
                        <button
                            aria-label="Form Category"
                            key={cat.id}
                            onClick={() => onCategoryChange(cat.id)}
                            className={`py-1.5 rounded-full text-label font-bold transition-all text-center ${formCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
                        >
                            {cat.icon} {cat.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Document Name */}
            <div className="mb-3">
                <FormField
                    label="Document Name"
                    value={formName}
                    onChange={onNameChange}
                    placeholder="Vessel Registration, Hull Insurance 2026..."
                    required
                />
            </div>

            {/* Dates */}
            <div className="grid grid-cols-2 gap-2 mb-3 overflow-hidden">
                <FormField label="Issue Date" type="date" value={formIssueDate} onChange={onIssueDateChange} />
                <FormField label="Expiry Date" type="date" value={formExpiryDate} onChange={onExpiryDateChange} />
            </div>

            {/* Attach Document */}
            <div className="mb-3">
                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1">
                    Attach Document
                </label>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx"
                    onChange={onFileSelect}
                    className="hidden"
                />
                {formFileUri ? (
                    <div className="flex items-center gap-2 bg-white/5 border border-emerald-500/20 rounded-xl px-3 py-2.5">
                        <svg
                            className="w-4 h-4 text-emerald-400 shrink-0"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"
                            />
                        </svg>
                        <span className="text-sm text-emerald-400 font-bold truncate flex-1">{formFileName}</span>
                        <button
                            type="button"
                            onClick={onRemoveFile}
                            className="p-1 rounded-full hover:bg-white/10 transition-colors shrink-0"
                            aria-label="Remove attachment"
                        >
                            <svg
                                className="w-3.5 h-3.5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                ) : (
                    <button
                        aria-label="Input Ref"
                        type="button"
                        onClick={() => {
                            fileInputRef.current?.click();
                            triggerHaptic('light');
                        }}
                        className="w-full flex items-center justify-center gap-2 bg-white/5 border border-dashed border-white/[0.15] rounded-xl px-3 py-3 text-sm text-gray-400 hover:text-white hover:border-sky-500/30 hover:bg-white/[0.06] transition-all active:scale-[0.98]"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"
                            />
                        </svg>
                        Attach PDF, Photo or Document
                    </button>
                )}
            </div>

            {/* Notes */}
            <div className="mb-4">
                <FormField
                    label="Notes (Optional)"
                    type="textarea"
                    value={formNotes}
                    onChange={onNotesChange}
                    placeholder="Policy number, agent contact..."
                    rows={2}
                />
            </div>

            {!formName.trim() && (
                <p className="text-micro text-amber-400/80 text-center mt-2">Document name is required</p>
            )}
            <button
                aria-label="Save"
                onClick={onSave}
                disabled={!formName.trim()}
                className={`w-full py-3 mt-1 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 ${
                    isEdit
                        ? 'bg-gradient-to-r from-sky-600 to-sky-600 shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                        : 'bg-gradient-to-r from-emerald-600 to-emerald-600 shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500'
                }`}
            >
                {isEdit ? 'Save Changes' : 'Add Document'}
            </button>
        </>
    );
};
