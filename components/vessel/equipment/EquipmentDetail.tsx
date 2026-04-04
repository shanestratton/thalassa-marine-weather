/**
 * EquipmentDetail — Full detail view for a single equipment item.
 *
 * Extracted from EquipmentList to reduce component size.
 */

import React from 'react';
import type { EquipmentItem } from '../../../types';
import { createLogger } from '../../../utils/createLogger';
import { triggerHaptic } from '../../../utils/system';
import { CATEGORY_ICONS } from './SwipeableEquipmentCard';

const log = createLogger('EquipmentDetail');

interface EquipmentDetailProps {
    item: EquipmentItem;
    onBack: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

export const EquipmentDetail: React.FC<EquipmentDetailProps> = ({ item, onBack, onEdit, onDelete }) => {
    const warrantyActive = item.warranty_expiry ? new Date(item.warranty_expiry).getTime() > Date.now() : null;

    const copySerial = () => {
        navigator.clipboard
            .writeText(item.serial_number)
            .then(() => {
                triggerHaptic('light');
            })
            .catch((e) => {
                log.warn(`[EquipmentList]`, e);
            });
    };

    const openManual = () => {
        if (item.manual_uri) {
            window.open(item.manual_uri, '_blank');
        }
    };

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={onBack}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                            aria-label="Back to equipment list"
                        >
                            <svg
                                className="w-5 h-5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <div className="flex-1">
                            <h2 className="text-lg font-black text-white">{item.equipment_name}</h2>
                            <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                                {CATEGORY_ICONS[item.category]} {item.category}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Scrollable content */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {/* Specs card */}
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                        <h3 className="text-label text-gray-400 font-bold uppercase tracking-widest mb-4">
                            Specifications
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <p className="text-label text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                    Make
                                </p>
                                <p className="text-sm font-bold text-white">{item.make || '—'}</p>
                            </div>
                            <div>
                                <p className="text-label text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                    Model
                                </p>
                                <p className="text-sm font-bold text-white">{item.model || '—'}</p>
                            </div>
                        </div>

                        {/* Serial */}
                        <div className="mt-4">
                            <p className="text-label text-gray-400 uppercase tracking-widest font-bold mb-1">
                                Serial Number
                            </p>
                            <div className="flex items-center gap-2">
                                <p className="text-sm font-mono font-bold text-sky-400">{item.serial_number || '—'}</p>
                                {item.serial_number && (
                                    <button
                                        onClick={copySerial}
                                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                                        title="Copy serial number"
                                        aria-label="Copy serial number"
                                    >
                                        <svg
                                            className="w-4 h-4 text-gray-400 hover:text-sky-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                            />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Install date */}
                        {item.installation_date && (
                            <div className="mt-4">
                                <p className="text-label text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                    Installed
                                </p>
                                <p className="text-sm font-bold text-white">
                                    {new Date(item.installation_date).toLocaleDateString()}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Warranty status */}
                    <div
                        className={`border rounded-2xl p-5 ${
                            warrantyActive === true
                                ? 'bg-emerald-500/10 border-emerald-500/30'
                                : warrantyActive === false
                                  ? 'bg-red-500/10 border-red-500/30'
                                  : 'bg-white/5 border-white/10'
                        }`}
                    >
                        <h3 className="text-label text-gray-400 font-bold uppercase tracking-widest mb-2">
                            Warranty Status
                        </h3>
                        {warrantyActive === true && (
                            <>
                                <p className="text-sm font-black text-emerald-400">✓ Active</p>
                                <p className="text-label text-emerald-400/70 font-bold mt-1">
                                    Expires {new Date(item.warranty_expiry!).toLocaleDateString()}
                                </p>
                            </>
                        )}
                        {warrantyActive === false && (
                            <>
                                <p className="text-sm font-black text-red-400">✗ Expired</p>
                                <p className="text-label text-red-400/70 font-bold mt-1">
                                    Expired {new Date(item.warranty_expiry!).toLocaleDateString()}
                                </p>
                            </>
                        )}
                        {warrantyActive === null && (
                            <p className="text-sm font-bold text-gray-400">No warranty date set</p>
                        )}
                    </div>

                    {/* Open Manual button */}
                    {item.manual_uri && (
                        <button
                            aria-label="Enter manual mode"
                            onClick={openManual}
                            className="w-full py-4 bg-gradient-to-r from-sky-600/20 to-sky-600/20 border border-sky-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-sky-600/30 hover:to-sky-600/30 transition-all active:scale-[0.98]"
                        >
                            <svg
                                className="w-6 h-6 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                                />
                            </svg>
                            <span className="text-sm font-black text-sky-400 uppercase tracking-[0.15em]">
                                Open Manual (PDF)
                            </span>
                        </button>
                    )}

                    {/* Notes */}
                    {item.notes && (
                        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                            <h3 className="text-label text-gray-400 font-bold uppercase tracking-widest mb-2">Notes</h3>
                            <p className="text-sm text-gray-300 leading-relaxed">{item.notes}</p>
                        </div>
                    )}

                    {/* Delete button */}
                    <button
                        aria-label="Delete this item"
                        onClick={onDelete}
                        className="w-full py-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-sm font-bold text-red-400 hover:bg-red-500/20 transition-all active:scale-[0.98]"
                    >
                        Delete Equipment
                    </button>
                </div>

                {/* Edit FAB */}
                <button
                    onClick={onEdit}
                    className="fixed bottom-24 right-6 w-14 h-14 bg-sky-500 rounded-full flex items-center justify-center shadow-lg shadow-sky-500/30 hover:bg-sky-400 transition-all active:scale-90 z-50"
                    aria-label="Edit equipment"
                >
                    <svg
                        className="w-6 h-6 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                    </svg>
                </button>
            </div>
        </div>
    );
};
