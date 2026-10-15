/**
 * EquipmentDetail — Full detail view for a single equipment item.
 *
 * Extracted from EquipmentList to reduce component size.
 */

import React from 'react';
import type { EquipmentItem } from '../../../types';
import { createLogger } from '../../../utils/createLogger';
import { triggerHaptic } from '../../../utils/system';
import { DocumentSyncService } from '../../../services/vessel/DocumentSyncService';
import { CheckIcon, XIcon } from '../../icons/UIIcons';
import { formatDisplayDate } from '../../../utils/displayDate';
import { PageHeader } from '../../ui/PageHeader';
import { CATEGORY_ICONS, FALLBACK_CATEGORY_ICON, warrantyInForce } from './SwipeableEquipmentCard';

const log = createLogger('EquipmentDetail');

interface EquipmentDetailProps {
    item: EquipmentItem;
    onBack: () => void;
    onEdit: () => void;
    /** Omitted on a skipper's shared Equipment: deletes there are the skipper's. */
    onDelete?: () => void;
}

export const EquipmentDetail: React.FC<EquipmentDetailProps> = ({ item, onBack, onEdit, onDelete }) => {
    const warrantyActive = warrantyInForce(item.warranty_expiry);
    const CategoryIcon = CATEGORY_ICONS[item.category] ?? FALLBACK_CATEGORY_ICON;

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

    const openManual = async () => {
        if (item.manual_uri) {
            await DocumentSyncService.openDownload(item.manual_uri);
        }
    };

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                {/* The house header (132-B20): the item's name is the page's
                    h1 under the Equipment crumb, and Edit is the one 44 pt
                    control in its action slot, where the other binder pages
                    keep theirs. The name was an h2 with no h1 above it, and
                    Edit a 56 px button floating over the page's last rows. */}
                <PageHeader
                    title={item.equipment_name}
                    subtitle={
                        <p className="flex items-center gap-1.5 text-label text-gray-400 font-bold uppercase tracking-widest">
                            <CategoryIcon className="h-3.5 w-3.5 shrink-0" />
                            {item.category}
                        </p>
                    }
                    onBack={onBack}
                    breadcrumbs={['Equipment', item.equipment_name]}
                    backLabel="Back to equipment list"
                    action={
                        <button
                            type="button"
                            onClick={onEdit}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                            aria-label="Edit equipment"
                        >
                            <svg
                                aria-hidden="true"
                                className="w-5 h-5 text-sky-400"
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
                    }
                />

                {/* Scrollable content, its last row (Delete equipment) clear
                    of the tab bar: the extra 5rem for the Edit FAB went with it. */}
                <div
                    className="flex-1 overflow-y-auto px-4 min-h-0 space-y-3"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 1rem)' }}
                >
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
                                <p className="text-sm font-bold text-white">{item.make || '--'}</p>
                            </div>
                            <div>
                                <p className="text-label text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                    Model
                                </p>
                                <p className="text-sm font-bold text-white">{item.model || '--'}</p>
                            </div>
                        </div>

                        {/* Serial */}
                        <div className="mt-4">
                            <p className="text-label text-gray-400 uppercase tracking-widest font-bold mb-1">
                                Serial number
                            </p>
                            <div className="flex items-center gap-2">
                                <p className="text-sm font-mono font-bold text-sky-400">{item.serial_number || '--'}</p>
                                {item.serial_number && (
                                    <button
                                        onClick={copySerial}
                                        className="hit-target-44 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
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
                                    {formatDisplayDate(item.installation_date, { weekday: false })}
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
                            Warranty status
                        </h3>
                        {warrantyActive === true && (
                            <>
                                <p className="flex items-center gap-1.5 text-sm font-black text-emerald-400">
                                    <CheckIcon className="h-4 w-4 shrink-0" />
                                    Active
                                </p>
                                {/* Full-strength ink on both small date lines (132-B20):
                                    the expired one, red-400 at 70%, read 3.8:1 on its card. */}
                                <p className="text-label text-emerald-400 font-bold mt-1">
                                    Expires {formatDisplayDate(item.warranty_expiry, { weekday: false })}
                                </p>
                            </>
                        )}
                        {warrantyActive === false && (
                            <>
                                <p className="flex items-center gap-1.5 text-sm font-black text-red-400">
                                    <XIcon className="h-4 w-4 shrink-0" />
                                    Expired
                                </p>
                                <p className="text-label text-red-400 font-bold mt-1">
                                    Expired {formatDisplayDate(item.warranty_expiry, { weekday: false })}
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
                            aria-label="Open manual (PDF)"
                            onClick={openManual}
                            className="w-full py-4 bg-linear-to-r from-sky-600/20 to-sky-600/20 border border-sky-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-sky-600/30 hover:to-sky-600/30 transition-all active:scale-[0.98]"
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
                            <span className="text-sm font-black text-sky-400">Open manual (PDF)</span>
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
                    {onDelete && (
                        <button
                            aria-label={`Delete ${item.equipment_name}`}
                            onClick={onDelete}
                            className="w-full py-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-sm font-bold text-red-400 hover:bg-red-500/20 transition-all active:scale-[0.98]"
                        >
                            Delete equipment
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
