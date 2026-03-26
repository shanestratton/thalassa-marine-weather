/**
 * InviteCrewModal — Invite form content for crew invitations.
 *
 * Renders inside a ModalSheet with email input, grouped register
 * selection (Vessel + Passage registers), error display, and send CTA.
 */
import React from 'react';
import { t } from '../../theme';
import {
    type SharedRegister,
    VESSEL_REGISTERS,
    PASSAGE_REGISTERS,
} from '../../services/CrewService';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { RegisterButton } from './RegisterButton';

export interface InviteCrewModalProps {
    inviteEmail: string;
    inviteRegisters: SharedRegister[];
    inviteLoading: boolean;
    inviteError: string | null;
    inviteSuccess: boolean;
    onEmailChange: (v: string) => void;
    onToggleRegister: (reg: SharedRegister) => void;
    onInvite: () => void;
}

export const InviteCrewModal: React.FC<InviteCrewModalProps> = ({
    inviteEmail,
    inviteRegisters,
    inviteLoading,
    inviteError,
    inviteSuccess,
    onEmailChange,
    onToggleRegister,
    onInvite,
}) => {
    if (inviteSuccess) {
        return (
            <div className="p-6">
                <div className="text-center py-6">
                    <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-500/30">
                        <svg
                            className="w-8 h-8 text-emerald-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                    </div>
                    <h3 className="text-lg font-bold text-white mb-1">Invite Sent!</h3>
                    <p className="text-sm text-gray-400">{inviteEmail} will see the invite in their app.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 space-y-5">
            {/* Email input */}
            <div>
                <label className="text-[11px] uppercase font-bold text-gray-400 mb-1.5 ml-1 block tracking-wide">
                    Crew Email Address
                </label>
                <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => onEmailChange(e.target.value)}
                    onFocus={scrollInputAboveKeyboard}
                    placeholder="firstmate@email.com"
                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none transition-colors`}
                    autoFocus
                />
            </div>

            {/* Register selection — grouped */}
            <div className="space-y-4">
                {/* Vessel Registers */}
                <div>
                    <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                        Vessel Registers
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        {VESSEL_REGISTERS.map((reg) => (
                            <RegisterButton
                                key={reg}
                                reg={reg}
                                selected={inviteRegisters.includes(reg)}
                                onToggle={() => onToggleRegister(reg)}
                            />
                        ))}
                    </div>
                </div>

                {/* Passage Planning */}
                <div>
                    <label className="text-[11px] uppercase font-bold text-sky-400 mb-2 ml-1 block tracking-wide">
                        🧭 Passage Planning
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        {PASSAGE_REGISTERS.map((reg) => (
                            <RegisterButton
                                key={reg}
                                reg={reg}
                                selected={inviteRegisters.includes(reg)}
                                onToggle={() => onToggleRegister(reg)}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* Error */}
            {inviteError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200">
                    {inviteError}
                </div>
            )}

            {/* Send button */}
            <button
                aria-label="Invite"
                onClick={onInvite}
                disabled={inviteLoading || !inviteEmail.trim() || inviteRegisters.length === 0}
                className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 ${!inviteEmail.trim() || inviteRegisters.length === 0 ? 'opacity-50' : 'hover:bg-gray-100'}`}
            >
                {inviteLoading ? (
                    <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
                ) : (
                    `Send Invite (${inviteRegisters.length} register${inviteRegisters.length !== 1 ? 's' : ''})`
                )}
            </button>
        </div>
    );
};
