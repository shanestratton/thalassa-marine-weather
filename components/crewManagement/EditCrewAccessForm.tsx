/**
 * EditCrewAccessForm — the body of the "Edit Access" modal: byline parts and
 * the shared-register grid.
 *
 * Moved verbatim out of components/CrewManagement.tsx. The ModalSheet that
 * wraps it, and every piece of state it edits, still live in CrewManagement —
 * the setters and the identity guard are passed straight through so the
 * scope checks run exactly when they ran before.
 */
import React from 'react';
import {
    ALL_REGISTERS,
    ALWAYS_SHARED_REGISTERS,
    REGISTER_LABELS,
    type CrewMember,
    type SharedRegister,
} from '../../services/CrewService';
import { type AuthIdentityScope } from '../../services/authIdentityScope';
import { RegisterGlyph, TrashGlyph } from '../crew/crewGlyphs';

interface EditCrewAccessFormProps {
    editBoatMemberLoaded: boolean;
    editPrefix: string;
    setEditPrefix: (value: string) => void;
    editFirstName: string;
    setEditFirstName: (value: string) => void;
    editLastName: string;
    setEditLastName: (value: string) => void;
    editNickname: string;
    setEditNickname: (value: string) => void;
    editTarget: CrewMember | null;
    editRegisters: SharedRegister[];
    setEditRegisters: React.Dispatch<React.SetStateAction<SharedRegister[]>>;
    toggleRegister: (register: SharedRegister, list: SharedRegister[], setList: (v: SharedRegister[]) => void) => void;
    handleSavePermissions: () => Promise<void>;
    /**
     * Remove this person from the crew: the same soft remove (with Undo) as
     * swiping their card, so it can be done without the swipe.
     */
    onRemove?: () => void;
    scopeStillOwnsPage: (scope: AuthIdentityScope) => boolean;
    renderScope: AuthIdentityScope;
}

export const EditCrewAccessForm: React.FC<EditCrewAccessFormProps> = ({
    editBoatMemberLoaded,
    editPrefix,
    setEditPrefix,
    editFirstName,
    setEditFirstName,
    editLastName,
    setEditLastName,
    editNickname,
    setEditNickname,
    editTarget,
    editRegisters,
    setEditRegisters,
    toggleRegister,
    handleSavePermissions,
    onRemove,
    scopeStillOwnsPage,
    renderScope,
}) => {
    return (
        <div className="p-6 space-y-5">
            {/* Byline parts — shown only once the crew member has
                        accepted (boat_members row exists). Drives the
                        "by Emma" chip on the public voyage page. */}
            {editBoatMemberLoaded ? (
                <div>
                    <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                        Byline on the public voyage page
                    </label>
                    <div className="grid grid-cols-5 gap-2">
                        <input
                            type="text"
                            value={editPrefix}
                            onChange={(event) => {
                                if (scopeStillOwnsPage(renderScope)) setEditPrefix(event.target.value);
                            }}
                            placeholder="Capt."
                            aria-label="Title prefix (optional)"
                            className="col-span-2 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-hidden text-sm placeholder:text-gray-500"
                        />
                        <input
                            type="text"
                            value={editFirstName}
                            onChange={(event) => {
                                if (scopeStillOwnsPage(renderScope)) setEditFirstName(event.target.value);
                            }}
                            placeholder="First *"
                            aria-label="First name"
                            className="col-span-3 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-hidden text-sm placeholder:text-gray-500"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                        <input
                            type="text"
                            value={editLastName}
                            onChange={(event) => {
                                if (scopeStillOwnsPage(renderScope)) setEditLastName(event.target.value);
                            }}
                            placeholder="Surname"
                            aria-label="Surname"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-hidden text-sm placeholder:text-gray-500"
                        />
                        <input
                            type="text"
                            value={editNickname}
                            onChange={(event) => {
                                if (scopeStillOwnsPage(renderScope)) setEditNickname(event.target.value);
                            }}
                            placeholder="Nickname"
                            aria-label="Nickname"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-hidden text-sm placeholder:text-gray-500"
                        />
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1.5 ml-1">
                        Renders as:{' '}
                        <span className="text-sky-300 font-bold">
                            {[
                                editPrefix.trim(),
                                editFirstName.trim(),
                                editNickname.trim() && `"${editNickname.trim()}"`,
                                editLastName.trim(),
                            ]
                                .filter(Boolean)
                                .join(' ') || '—'}
                        </span>
                    </p>
                </div>
            ) : editTarget?.status === 'pending' ? (
                <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-3 text-[11px] text-amber-300/90">
                    Byline editing unlocks once this crew member accepts the invite.
                </div>
            ) : null}

            <div>
                <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                    Shared Registers
                </label>
                <div className="grid grid-cols-2 gap-2">
                    {ALL_REGISTERS.filter((reg) => !ALWAYS_SHARED_REGISTERS.includes(reg)).map((reg) => {
                        const selected = editRegisters.includes(reg);
                        return (
                            <button
                                aria-pressed={selected}
                                key={reg}
                                type="button"
                                onClick={() => {
                                    if (scopeStillOwnsPage(renderScope)) {
                                        toggleRegister(reg, editRegisters, setEditRegisters);
                                    }
                                }}
                                className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
                                    selected
                                        ? 'bg-sky-500/15 border-sky-500/40'
                                        : 'bg-white/3 border-white/6 hover:bg-white/5'
                                }`}
                            >
                                <div className="flex items-center gap-2">
                                    <RegisterGlyph register={reg} className="crew-accent h-4 w-4 shrink-0" />
                                    <p className={`text-xs font-bold ${selected ? 'text-sky-300' : 'text-white'}`}>
                                        {REGISTER_LABELS[reg]}
                                    </p>
                                </div>
                                <div
                                    className={`mt-2 w-4 h-4 rounded-md border-2 flex items-center justify-center ${selected ? 'bg-sky-500 border-sky-500' : 'border-white/20'}`}
                                >
                                    {selected && (
                                        <svg
                                            className="w-2.5 h-2.5 text-white"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M4.5 12.75l6 6 9-13.5"
                                            />
                                        </svg>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            <button
                aria-label="Save crew management changes"
                onClick={handleSavePermissions}
                disabled={editRegisters.length === 0}
                className="crew-cta w-full min-h-[48px]! text-sm"
            >
                Save Changes
            </button>

            {/* Removing is destructive: its own quiet red row, set apart from
                Save. It is the swipe's Remove, with the same Undo. */}
            {onRemove && editTarget && (
                <div
                    className="border-t pt-4"
                    style={{ borderColor: 'var(--vessel-card-border, rgba(255, 255, 255, 0.08))' }}
                >
                    <button
                        type="button"
                        onClick={() => {
                            if (scopeStillOwnsPage(renderScope)) onRemove();
                        }}
                        className="crew-danger-row"
                    >
                        <TrashGlyph />
                        <span>Remove from crew</span>
                    </button>
                </div>
            )}
        </div>
    );
};
