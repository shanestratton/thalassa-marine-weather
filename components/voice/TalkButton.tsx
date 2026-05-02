/**
 * TalkButton — tap-to-toggle voice button (single Bosun blue variant).
 *
 * One big blue Bosun button. The brain it routes to (cloud Haiku or local
 * 3B on the Pi) is decided by the caller based on connectivity, and is
 * shown in the subtitle ("Bosun cloud" / "Bosun local (3B)") rather than
 * by switching button styling — there is one Bosun, the brain swaps in
 * behind it.
 *
 * Tap-to-toggle gesture:
 *   - Tap once to start listening (button glows + pulses)
 *   - Tap again to stop and send the transcript
 *   - Haptic tick on each tap
 */
import React, { useCallback } from 'react';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

export type TalkButtonState = 'idle' | 'recording' | 'sending' | 'awaiting' | 'playing' | 'error';

interface TalkButtonProps {
    state: TalkButtonState;
    /** Caption under the button — typically the active brain ("Bosun cloud", "Bosun local (3B)"). */
    subtitle?: string;
    /** Disable the button (greyed out, no tap) */
    disabled?: boolean;
    /** Tap to toggle listening on/off. Caller decides which transition based on state. */
    onTap: () => void;
}

const STATE_HINT: Record<TalkButtonState, string> = {
    idle: 'Tap to talk',
    recording: 'Tap to send',
    sending: 'Sending...',
    awaiting: 'Thinking...',
    playing: 'Speaking',
    error: 'Try again',
};

/** Marine-blue Bosun gradient (matches AvNav badge family). */
const GRADIENT_IDLE = 'bg-gradient-to-br from-sky-500 via-blue-600 to-blue-800';
const GRADIENT_HOT = 'bg-gradient-to-br from-sky-400 via-blue-500 to-blue-700 ring-4 ring-sky-300/60';
const SHADOW_IDLE =
    '0 16px 50px rgba(37, 99, 235, 0.4), inset 0 2px 12px rgba(255, 255, 255, 0.2), inset 0 -6px 20px rgba(0, 0, 0, 0.25)';
const SHADOW_HOT =
    '0 0 60px rgba(56, 189, 248, 0.5), inset 0 4px 20px rgba(255, 255, 255, 0.3), inset 0 -8px 24px rgba(0, 0, 0, 0.3)';

const AnchorIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2a2.5 2.5 0 0 0-2.5 2.5c0 1.06.66 1.96 1.59 2.32V8H8v2h3.09v8.93c-2.21-.31-4.05-1.6-5.06-3.43L8 14H3v5l1.91-1.92C6.49 19.69 9.06 21 12 21s5.51-1.31 7.09-3.92L21 19v-5h-5l2 2.5c-1.01 1.83-2.85 3.12-5.05 3.43V10H16V8h-3.09V6.82C13.84 6.46 14.5 5.56 14.5 4.5A2.5 2.5 0 0 0 12 2zm0 2a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1z" />
    </svg>
);

export const TalkButton: React.FC<TalkButtonProps> = ({ state, subtitle, disabled, onTap }) => {
    const triggerHaptic = useCallback(async (style: ImpactStyle) => {
        try {
            await Haptics.impact({ style });
        } catch {
            /* no haptics on web/dev — ignore */
        }
    }, []);

    const handleClick = useCallback(() => {
        if (disabled || state === 'sending' || state === 'awaiting') return;
        void triggerHaptic(state === 'recording' ? ImpactStyle.Medium : ImpactStyle.Light);
        onTap();
    }, [disabled, state, onTap, triggerHaptic]);

    const isRecording = state === 'recording';
    const isBusy = state === 'sending' || state === 'awaiting';

    const gradientClass = disabled
        ? 'bg-gradient-to-br from-slate-700 via-slate-800 to-slate-900'
        : isRecording
          ? GRADIENT_HOT
          : GRADIENT_IDLE;

    const shadow = disabled
        ? '0 4px 16px rgba(0, 0, 0, 0.3), inset 0 2px 8px rgba(255, 255, 255, 0.05)'
        : isRecording
          ? SHADOW_HOT
          : SHADOW_IDLE;

    const iconColor = disabled ? 'text-slate-500' : 'text-white';
    const labelColor = disabled ? 'text-slate-500' : 'text-white';
    const ringColor = 'bg-sky-400/20';

    return (
        <div className="relative flex flex-col items-center gap-3 select-none">
            {/* Pulse rings while recording */}
            {isRecording && (
                <>
                    <span
                        className={`absolute top-[88px] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200px] h-[200px] rounded-full ${ringColor} animate-ping pointer-events-none`}
                    />
                    <span
                        className={`absolute top-[88px] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[240px] h-[240px] rounded-full ${ringColor} opacity-50 animate-ping [animation-delay:0.4s] pointer-events-none`}
                    />
                </>
            )}

            <button
                onClick={handleClick}
                onContextMenu={(e) => e.preventDefault()}
                disabled={disabled || isBusy}
                aria-label={`Bosun - ${STATE_HINT[state]}`}
                className={`
                    relative z-10 w-[160px] h-[160px] rounded-full
                    flex items-center justify-center
                    transition-all duration-150 ease-out
                    ${gradientClass}
                    ${
                        disabled
                            ? 'cursor-not-allowed opacity-60'
                            : isBusy
                              ? 'cursor-wait'
                              : isRecording
                                ? 'scale-105'
                                : 'cursor-pointer hover:scale-[1.03] active:scale-95'
                    }
                `}
                style={{ boxShadow: shadow }}
            >
                <div className="flex flex-col items-center gap-1.5 pointer-events-none">
                    <span className={iconColor}>
                        <AnchorIcon className={`w-12 h-12 ${isRecording ? 'animate-pulse' : ''}`} />
                    </span>
                    <span className={`text-base font-bold tracking-wide ${labelColor}`}>Bosun</span>
                </div>
            </button>

            <div className="flex flex-col items-center gap-0.5 min-h-[36px]">
                {subtitle && (
                    <p
                        className={`text-[10px] uppercase tracking-widest font-bold ${
                            disabled ? 'text-slate-600' : 'text-sky-300'
                        }`}
                    >
                        {subtitle}
                    </p>
                )}
                <p className="text-[11px] text-gray-400">{STATE_HINT[state]}</p>
                {isBusy && (
                    <div className="flex gap-1 mt-1">
                        <span className="w-1 h-1 rounded-full animate-bounce bg-sky-400" />
                        <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:0.15s] bg-sky-400" />
                        <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:0.3s] bg-sky-400" />
                    </div>
                )}
            </div>
        </div>
    );
};
