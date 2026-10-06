import React from 'react';
import { MAX_CHAT_MESSAGE_CHARS } from '../../services/chat/messagePolicy';
import type {
    PrivateMessagePilotConversation,
    PrivateMessagePilotMessage,
} from '../../services/chat/e2ee/privateMessagePilot';

const PILOT_LABEL = 'Encryption test—not reviewed';
function timeText(value: string | null): string {
    if (value === null) return 'Time unknown';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
        : 'Time unknown';
}
function deliveryText(message: PrivateMessagePilotMessage): string {
    switch (message.delivery) {
        case 'pending':
            return '· Pending native relay';
        case 'server_accepted':
            return '· Relay accepted';
        case 'received':
            return '· Received · Read status unknown';
        case 'rejected':
            return message.reason === null ? '· Rejected' : `· Rejected · ${message.reason.replace(/-/g, ' ')}`;
    }
}

export const PrivateMessagePilotNotice: React.FC<{ statusText?: string | null }> = ({ statusText }) => (
    <div className="mx-4 my-3 rounded-xl border border-amber-300/30 bg-amber-500/10 p-3" role="status">
        <p className="text-sm font-bold text-amber-200">{PILOT_LABEL}</p>
        <p className="mt-1 text-sm text-white/70">
            Isolated text-only pilot. Attachments, location shares and recipes are unavailable.
        </p>
        {statusText && <p className="mt-2 text-sm text-amber-100">{statusText}</p>}
    </div>
);

export const PrivateMessagePilotInbox: React.FC<{
    conversations: PrivateMessagePilotConversation[];
    onOpenThread: (userId: string, name: string) => void;
}> = React.memo(({ conversations, onOpenThread }) => (
    <div className="px-4 py-3 space-y-1.5" role="list" aria-label="Direct message conversations">
        {conversations.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
                <span className="text-3xl">✉️</span>
                <p className="mt-4 text-sm font-semibold text-white/70">No messages in the bottle</p>
                <p className="mt-1 text-xs text-white/50">Only the native pilot’s paired sailor can appear here.</p>
            </div>
        )}
        {conversations.map((conversation) => (
            <div key={conversation.user_id} role="listitem" aria-label={`Message ${conversation.display_name}`}>
                <button
                    type="button"
                    aria-label={`Message ${conversation.display_name}`}
                    onClick={() => onOpenThread(conversation.user_id, conversation.display_name)}
                    className="w-full min-h-[56px] rounded-2xl border border-white/10 bg-white/5 p-3.5 text-left"
                >
                    <div className="flex justify-between gap-3">
                        <p className="text-sm font-semibold text-white/85">{conversation.display_name}</p>
                        <span className="text-xs text-white/40">{timeText(conversation.last_at)}</span>
                    </div>
                    <p className="mt-1 text-xs text-white/60 truncate">
                        {conversation.last_message ??
                            (conversation.historyAvailable ? 'Message text unavailable' : 'Native history unavailable')}
                    </p>
                </button>
            </div>
        ))}
    </div>
));
PrivateMessagePilotInbox.displayName = 'PrivateMessagePilotInbox';

export const PrivateMessagePilotThread: React.FC<{
    thread: PrivateMessagePilotMessage[];
    partnerName?: string;
}> = React.memo(({ thread, partnerName }) => (
    <div className="flex flex-col min-h-full" role="log" aria-label="Direct messages">
        <div className="flex-1 px-4 py-3 space-y-2">
            {thread.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20">
                    <span className="text-3xl">👋</span>
                    <p className="mt-4 text-sm font-semibold text-white/70">Start a conversation</p>
                    <p className="mt-1 text-xs text-white/50">Say ahoy to {partnerName}.</p>
                </div>
            )}
            {thread.map((dm) => (
                <div key={dm.id} className={`flex ${dm.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
                    <div
                        className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                            dm.direction === 'outgoing'
                                ? 'bg-sky-500/15 border border-sky-500/15 rounded-br-lg'
                                : 'bg-white/4 border border-white/4 rounded-bl-lg'
                        }`}
                    >
                        <p className="text-base text-white/70 leading-relaxed select-text">
                            {dm.message ?? 'Message text unavailable'}
                        </p>
                        <p className="text-xs text-white/40 mt-1 tabular-nums">
                            {timeText(dm.created_at)}
                            <span className="ml-1" role="status">
                                {deliveryText(dm)}
                            </span>
                        </p>
                    </div>
                </div>
            ))}
        </div>
    </div>
));
PrivateMessagePilotThread.displayName = 'PrivateMessagePilotThread';

export interface PrivateMessagePilotComposeProps {
    dmText: string;
    setDmText: (value: string) => void;
    partnerName?: string;
    keyboardOffset: number;
    isUserBlocked: boolean;
    blockStatusLoading: boolean;
    blockStatusError: string | null;
    onRetryBlockStatus: () => void;
    onSendDM: () => void;
    pilotSendDisabled?: boolean;
}
export const PrivateMessagePilotCompose: React.FC<PrivateMessagePilotComposeProps> = React.memo(
    ({
        dmText,
        setDmText,
        partnerName,
        keyboardOffset,
        isUserBlocked,
        blockStatusLoading,
        blockStatusError,
        onRetryBlockStatus,
        onSendDM,
        pilotSendDisabled = true,
    }) => (
        <div
            className={`shrink-0 px-4 pt-2 ${keyboardOffset > 0 ? 'pb-2' : 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]'}`}
        >
            {(blockStatusLoading || blockStatusError) && (
                <div className="mb-2 flex items-center justify-between gap-2" role="status">
                    <p className="text-sm text-white/70">
                        {blockStatusLoading ? 'Checking messaging permissions…' : blockStatusError}
                    </p>
                    {blockStatusError && !blockStatusLoading && (
                        <button
                            type="button"
                            onClick={onRetryBlockStatus}
                            className="min-h-[44px] px-3 text-sm text-sky-300"
                        >
                            Retry
                        </button>
                    )}
                </div>
            )}
            {isUserBlocked ? (
                <p className="py-2 text-sm text-white/70" role="status">
                    Messaging is unavailable for this conversation.
                </p>
            ) : (
                <div className="flex items-center gap-2" role="toolbar" aria-label="Message compose">
                    <input
                        type="text"
                        value={dmText}
                        onChange={(event) => setDmText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            if (!dmText.trim() || blockStatusLoading || blockStatusError || pilotSendDisabled) return;
                            onSendDM();
                        }}
                        data-no-keyboard-scroll
                        enterKeyHint="send"
                        autoComplete="off"
                        placeholder={`Test text to ${partnerName ?? 'Paired sailor'}...`}
                        aria-label={`Message ${partnerName ?? 'Paired sailor'}`}
                        maxLength={MAX_CHAT_MESSAGE_CHARS}
                        className="min-w-0 flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-lg text-white min-h-[48px]"
                    />
                    <button
                        type="button"
                        onClick={onSendDM}
                        disabled={!dmText.trim() || blockStatusLoading || !!blockStatusError || pilotSendDisabled}
                        aria-label="Send direct message"
                        className="min-w-[44px] min-h-[44px] rounded-xl bg-purple-500 px-3 disabled:bg-white/5"
                    >
                        Send
                    </button>
                </div>
            )}
        </div>
    ),
);
PrivateMessagePilotCompose.displayName = 'PrivateMessagePilotCompose';
