/**
 * InviteCrewModal — Invite form content for crew invitations.
 *
 * Renders inside a ModalSheet (centred, focus-trapped, role=dialog — see
 * components/ui/ModalSheet.tsx) with email input, a role picker, vessel
 * register selection, error display, the send CTA and 'Create a crew code'.
 *
 * Shane 2026-09-08 (vessel claim/release decision): the invite is the ONLY
 * way onto a hull someone else has claimed, so a relief or delivery skipper
 * is invited as a co-skipper instead of being handed the boat. That needs a
 * role picker here, and the manifest code (createManifestInvite) surfaced for
 * the first time — until now no UI created one, only JoinVessel redeemed it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { t } from '../../theme';
import {
    type CrewPermissions,
    type CrewRole,
    type SharedRegister,
    INVITE_REGISTERS,
    PASSAGE_REGISTERS,
    REGISTER_LABELS,
    createManifestInvite,
    crewInvitePermissions,
} from '../../services/CrewService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { RegisterButton } from './RegisterButton';

/**
 * Roles offered at invite time, in display order. Deckhand first because it
 * is the default the invite always wrote before the picker existed.
 */
export const INVITE_ROLE_OPTIONS: ReadonlyArray<{ role: CrewRole; label: string; hint: string }> = [
    {
        role: 'deckhand',
        label: 'Deckhand',
        hint: "Ship's stores and galley, plus whatever you tick below.",
    },
    {
        role: 'navigator',
        label: 'Navigator',
        hint: 'Deckhand access plus nav, weather and the log.',
    },
    {
        role: 'co-skipper',
        label: 'Co-skipper',
        // Not "every register": Equipment, R&M and Documents are gated on
        // shared_registers (can_access_vessel_register), so they still need
        // the tick even for a co-skipper; the preset only carries stores, nav,
        // weather and the log.
        hint: 'Relief or delivery skipper — stores, nav, weather and the log, plus whatever you tick below. Tick Instrument Panel to share the live panel.',
    },
    {
        role: 'punter',
        label: 'Punter',
        hint: 'Along for the ride — only what you tick below.',
    },
];

/**
 * Registers a crew code cannot carry. manifest_invites has no
 * shared_registers column: redeem_manifest_invite rebuilds the crew row's
 * shared_registers from the permissions JSONB (20260723100000:233-252) and
 * only knows stores, galley and the four passage flags.
 *
 * - Equipment, R&M, Documents: no JSONB flag at all, so a code redeemed with
 *   them ticked lands as a row that can_access_vessel_register refuses.
 * - Instrument Panel: the flag EXISTS (can_view_instruments) and the
 *   telemetry read policy honours it, but redeem never mirrors it into
 *   shared_registers — and the skipper's roster chips (SwipeableCrewCard) and
 *   the Edit Permissions modal (CrewManagement.handleEditMember) both read
 *   shared_registers. A code that carried the flag would show the crew the
 *   live panel while the skipper's roster said it was NOT shared, and the
 *   next Edit Permissions save would silently flip it off. Shane 2026-09-07
 *   made the panel an explicit, visible share, so a code does not carry it;
 *   the email invite (writes both columns) or Edit Permissions afterwards do.
 *
 * Only the email invite writes shared_registers directly. The modal says so
 * inline rather than minting a code that silently grants less than ticked.
 */
export const REGISTERS_NOT_ON_CREW_CODE: ReadonlyArray<SharedRegister> = [
    'instruments',
    'equipment',
    'maintenance',
    'documents',
];

/**
 * The JSONB a crew code carries: the same grant an email invite for this role
 * and these registers would write, minus the Instrument Panel share, for the
 * reason on REGISTERS_NOT_ON_CREW_CODE. crewInvitePermissions stays the single
 * definition of what an invite grants; this is the code-shaped view of it.
 */
export function crewCodePermissions(role: CrewRole, registers: ReadonlyArray<SharedRegister>): CrewPermissions {
    return { ...crewInvitePermissions(role, [...registers]), can_view_instruments: false };
}

function listLabels(registers: ReadonlyArray<SharedRegister>): string {
    const labels = registers.map((register) => REGISTER_LABELS[register]);
    if (labels.length <= 1) return labels.join('');
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The inline caution shown before a code is minted and repeated beside it. */
function crewCodeCaution(registers: ReadonlyArray<SharedRegister>): string | null {
    const dropped = REGISTERS_NOT_ON_CREW_CODE.filter((register) => registers.includes(register));
    const passage = PASSAGE_REGISTERS.filter((register) => registers.includes(register));
    const lines: string[] = [];
    if (dropped.length > 0) {
        lines.push(
            `A crew code can't carry ${listLabels(dropped)} — use Send Invite to share ${dropped.length > 1 ? 'those' : 'that'}.`,
        );
    }
    if (passage.length > 0) {
        // The code has no voyage_id, so can_access_passage matches every one
        // of the owner's passages (20260723104000: membership.voyage_id IS NULL).
        lines.push(`On a code, ${listLabels(passage)} covers every one of your passages, not just the one selected.`);
    }
    return lines.length > 0 ? lines.join(' ') : null;
}

export interface InviteCrewModalProps {
    inviteEmail: string;
    inviteRole: CrewRole;
    inviteRegisters: SharedRegister[];
    inviteLoading: boolean;
    inviteError: string | null;
    inviteSuccess: boolean;
    onEmailChange: (v: string) => void;
    onRoleChange: (role: CrewRole) => void;
    onToggleRegister: (reg: SharedRegister) => void;
    onInvite: () => void;
    /** Closes the host ModalSheet from the crew-code panel's Done button. */
    onDone?: () => void;
}

interface IssuedCrewCode {
    code: string;
    role: CrewRole;
    /** The address the code is reserved for, when the skipper typed one. */
    email: string | null;
    /** What this code will NOT do that the ticks suggested, if anything. */
    caution: string | null;
}

type CopyState = 'idle' | 'copied' | 'failed';

export const InviteCrewModal: React.FC<InviteCrewModalProps> = ({
    inviteEmail,
    inviteRole,
    inviteRegisters,
    inviteLoading,
    inviteError,
    inviteSuccess,
    onEmailChange,
    onRoleChange,
    onToggleRegister,
    onInvite,
    onDone,
}) => {
    // Crew-code state lives here rather than in CrewManagement: the code is a
    // one-shot result shown inside this modal and discarded with it.
    const [crewCode, setCrewCode] = useState<IssuedCrewCode | null>(null);
    const [codeLoading, setCodeLoading] = useState(false);
    const [codeError, setCodeError] = useState<string | null>(null);
    const [copyState, setCopyState] = useState<CopyState>('idle');
    const codeRequestVersion = useRef(0);
    const codeRef = useRef<HTMLParagraphElement>(null);

    // Swapping the form for the code panel unmounts the button that had
    // focus, and the ModalSheet's focus trap only places focus when the sheet
    // opens — so without this, focus falls to <body> and a screen reader is
    // never told the code exists. Land on the code itself so it is read out.
    useEffect(() => {
        if (crewCode) codeRef.current?.focus({ preventScroll: true });
    }, [crewCode]);

    const selectedRole = INVITE_ROLE_OPTIONS.find((option) => option.role === inviteRole) ?? INVITE_ROLE_OPTIONS[0];
    const trimmedEmail = inviteEmail.trim();
    const codeCaution = crewCodeCaution(inviteRegisters);

    const handleCreateCode = async () => {
        // Identity fence: capture the scope before the await and refuse to
        // touch state for a different account afterwards.
        const scope = getAuthIdentityScope();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        const version = ++codeRequestVersion.current;
        const role = inviteRole;
        const registers = [...inviteRegisters];
        const email = trimmedEmail;

        setCodeLoading(true);
        setCodeError(null);

        // The code carries the role preset and JSONB flags the email invite
        // for this role and these registers would write, minus the Instrument
        // Panel share. It is NOT the same access: redeem_manifest_invite
        // rebuilds shared_registers from the JSONB, so Instrument Panel,
        // Equipment, R&M and Documents cannot ride a code and a passage
        // register on a code is unscoped — crewCodeCaution() says so beside
        // the button and again beside the issued code.
        const result = await createManifestInvite(role, crewCodePermissions(role, registers), email || undefined);
        if (version !== codeRequestVersion.current || !isAuthIdentityScopeCurrent(scope)) return;

        setCodeLoading(false);
        if (result.success && result.code) {
            setCrewCode({ code: result.code, role, email: email || null, caution: crewCodeCaution(registers) });
            setCopyState('idle');
        } else {
            setCodeError(result.error || 'Could not create a crew code');
        }
    };

    const handleCopy = async () => {
        if (!crewCode) return;
        const scope = getAuthIdentityScope();
        try {
            if (!navigator.clipboard) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(crewCode.code);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setCopyState('copied');
        } catch {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setCopyState('failed');
        }
    };

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

    if (crewCode) {
        // The code is a bearer credential and a decision point for the
        // skipper (copy it, hand it over), so it is a panel inside the
        // centred modal — never a toast.
        const codeRoleLabel =
            INVITE_ROLE_OPTIONS.find((option) => option.role === crewCode.role)?.label ?? crewCode.role;
        return (
            <div className="p-6" data-testid="crew-code-panel">
                <div className="text-center py-4 space-y-4">
                    <p className="text-[11px] uppercase font-bold text-gray-400 tracking-wide">
                        Crew code · {codeRoleLabel}
                    </p>
                    <p
                        ref={codeRef}
                        tabIndex={-1}
                        data-testid="crew-code"
                        aria-label={`Crew code ${crewCode.code}`}
                        className="text-4xl font-black font-mono tracking-[0.25em] text-white select-all outline-none"
                    >
                        {crewCode.code}
                    </p>
                    <p className="text-sm text-gray-400">
                        Hand this to your crew — they enter it on their Join a Vessel screen. It works once and expires
                        in 7 days.
                    </p>
                    {crewCode.email && (
                        <p className="text-xs text-amber-200/90">
                            Reserved for {crewCode.email} — only that account can redeem it.
                        </p>
                    )}
                    {crewCode.caution && (
                        <p data-testid="crew-code-caution" className="text-xs text-amber-200/90">
                            {crewCode.caution}
                        </p>
                    )}

                    <button
                        type="button"
                        aria-label="Copy crew code"
                        onClick={handleCopy}
                        className="w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 hover:bg-gray-100"
                    >
                        {copyState === 'copied' ? 'Copied' : 'Copy code'}
                    </button>
                    {copyState === 'failed' && (
                        <p role="alert" className="text-xs text-red-200">
                            Copy didn&apos;t work here — read the code out or write it down.
                        </p>
                    )}

                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setCrewCode(null);
                                setCopyState('idle');
                            }}
                            className={`flex-1 min-h-[44px] py-3 ${t.border.default} rounded-xl text-sm font-bold text-gray-200 bg-white/5 hover:bg-white/10 transition-colors`}
                        >
                            Make another
                        </button>
                        {onDone && (
                            <button
                                type="button"
                                onClick={onDone}
                                className={`flex-1 min-h-[44px] py-3 ${t.border.default} rounded-xl text-sm font-bold text-gray-200 bg-white/5 hover:bg-white/10 transition-colors`}
                            >
                                Done
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 space-y-5">
            {/* Email input */}
            <div>
                <label
                    htmlFor="invite-crew-email"
                    className="text-[11px] uppercase font-bold text-gray-400 mb-1.5 ml-1 block tracking-wide"
                >
                    Crew Email Address
                </label>
                <input
                    id="invite-crew-email"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => onEmailChange(e.target.value)}
                    onFocus={scrollInputAboveKeyboard}
                    placeholder="firstmate@email.com"
                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-hidden transition-colors`}
                    autoFocus
                />
            </div>

            {/* Role picker — segmented control */}
            <div>
                <p
                    id="invite-crew-role-label"
                    className="text-[11px] uppercase font-bold text-gray-400 mb-1.5 ml-1 block tracking-wide"
                >
                    Role
                </p>
                <div
                    role="radiogroup"
                    aria-labelledby="invite-crew-role-label"
                    className={`grid grid-cols-4 gap-1 p-1 bg-slate-900 ${t.border.default} rounded-xl`}
                >
                    {INVITE_ROLE_OPTIONS.map((option) => {
                        const selected = option.role === inviteRole;
                        return (
                            <button
                                key={option.role}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => onRoleChange(option.role)}
                                className={`min-h-[44px] px-1 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${
                                    selected
                                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                                        : 'text-gray-300 border border-transparent hover:bg-white/5'
                                }`}
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>
                <p className="text-xs text-gray-400 mt-2 ml-1">{selectedRole.hint}</p>
            </div>

            {/* Register selection — grouped */}
            <div className="space-y-4">
                {/* Vessel Registers */}
                <div>
                    <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                        Share Access
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        {INVITE_REGISTERS.map((reg) => (
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
                aria-label="Send crew invitation"
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

            {/* Crew code — the in-person alternative to an email invite */}
            <div className="pt-4 border-t border-white/10 space-y-3">
                <p className="text-xs text-gray-400 ml-1">
                    {trimmedEmail
                        ? `Or hand ${trimmedEmail} a code instead — same role; only that account can redeem it.`
                        : 'No email? Hand over a code instead — same role, entered on their Join a Vessel screen.'}
                </p>
                {codeCaution && (
                    <p data-testid="crew-code-caution" className="text-xs text-amber-200/90 ml-1">
                        {codeCaution}
                    </p>
                )}
                {codeError && (
                    <div
                        role="alert"
                        className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200"
                    >
                        {codeError}
                    </div>
                )}
                <button
                    type="button"
                    aria-label="Create a crew code"
                    onClick={handleCreateCode}
                    disabled={codeLoading || inviteLoading}
                    className={`w-full min-h-[44px] py-3 ${t.border.default} rounded-xl text-sm font-bold text-white bg-white/5 hover:bg-white/10 transition-all active:scale-95 flex items-center justify-center gap-2 ${codeLoading ? 'opacity-60' : ''}`}
                >
                    {codeLoading ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                        'Create a crew code'
                    )}
                </button>
            </div>
        </div>
    );
};
