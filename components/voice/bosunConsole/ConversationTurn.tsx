import React from 'react';
import type { VoiceQueryResponse, VoiceTurn } from '../../../types/voice';

// ───────────────────────────────────────────────────────────────────────
// ConversationTurn
// ───────────────────────────────────────────────────────────────────────

export const ConversationTurn = React.memo<{
    turn: VoiceTurn;
    onReplay: (response: VoiceQueryResponse) => void;
}>(({ turn, onReplay }) => {
    const isBosun = turn.response.source === 'bosun';
    // Attribution: turns the local skipper authored have no userName
    // (we set it on remote turns only). When userName is set, the turn
    // came from a crewmate and we label it. "You said" stays for self.
    const speakerLabel = turn.userName ? `${turn.userName} said` : 'You said';
    const isCrew = Boolean(turn.userName);
    return (
        <div className="space-y-2">
            <div
                className={`px-4 py-3 rounded-2xl ${
                    isCrew ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-white/5 border border-white/10'
                }`}
            >
                <p
                    className={`text-[10px] uppercase tracking-widest mb-1 ${
                        isCrew ? 'text-amber-300' : 'text-gray-400'
                    }`}
                >
                    {speakerLabel}
                </p>
                <p className="text-sm text-white">{turn.transcript}</p>
            </div>
            <div
                className={`px-4 py-3 rounded-2xl ${
                    isBosun ? 'bg-sky-500/10 border border-sky-500/20' : 'bg-slate-200/10 border border-slate-300/20'
                }`}
            >
                <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${isBosun ? 'bg-sky-400' : 'bg-slate-300'}`} />
                        {isBosun ? 'Calypso on the boat' : 'Calypso cloud'}
                    </p>
                    {turn.response.audio_b64 && (
                        <button
                            onClick={() => onReplay(turn.response)}
                            className="hit-target-44 px-2 py-2 -mr-2 text-[10px] uppercase tracking-widest text-sky-400 hover:text-sky-300 flex items-center gap-1"
                            aria-label="Replay this answer"
                        >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                            Replay
                        </button>
                    )}
                </div>
                <p className="text-sm text-white whitespace-pre-wrap">{turn.response.answer_text}</p>
                {turn.response.tool_calls && turn.response.tool_calls.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-white/10">
                        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Tools used</p>
                        {turn.response.tool_calls.map((tc, i) => (
                            <p key={i} className="text-[11px] text-gray-400">
                                {tc.name.replace(/^thalassa_/, '').replace(/_/g, ' ')}
                                {tc.status === 'success' ? '' : ` — ${tc.status}`}
                            </p>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});
ConversationTurn.displayName = 'ConversationTurn';
