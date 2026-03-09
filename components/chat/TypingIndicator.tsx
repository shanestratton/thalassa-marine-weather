/**
 * TypingIndicator — Animated typing dots that appear when
 * someone is composing a message. Shows a subtle shimmer
 * bubble with three bouncing dots.
 */
import React from 'react';

interface TypingIndicatorProps {
    /** Display name of the person typing (optional) */
    name?: string;
}

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({ name }) => (
    <div className="flex items-start gap-2.5 px-4 py-1 fade-slide-down" aria-live="polite" aria-label={name ? `${name} is typing` : 'Someone is typing'}>
        {/* Avatar placeholder */}
        <div className="w-12 h-8 flex items-end justify-center flex-shrink-0">
            <div className="w-6 h-6 rounded-full bg-white/[0.04] flex items-center justify-center">
                <span className="text-[11px]">💬</span>
            </div>
        </div>
        {/* Typing bubble */}
        <div className="bg-white/[0.03] border border-white/[0.04] rounded-2xl rounded-bl-lg px-4 py-2.5 flex items-center gap-1">
            <span className="typing-dot w-1.5 h-1.5 rounded-full bg-white/30" style={{ animationDelay: '0ms' }} />
            <span className="typing-dot w-1.5 h-1.5 rounded-full bg-white/30" style={{ animationDelay: '160ms' }} />
            <span className="typing-dot w-1.5 h-1.5 rounded-full bg-white/30" style={{ animationDelay: '320ms' }} />
        </div>
        {name && (
            <span className="text-[11px] text-white/20 self-center">{name} is typing…</span>
        )}
    </div>
);
