import React from 'react';

/**
 * Skeleton loader components for shimmer loading states
 * Uses CSS animation for smooth pulse effect
 */

interface SkeletonProps {
    className?: string;
}

// Base skeleton with shimmer animation
export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
    <div className={`skeleton-shimmer ${className}`} />
);

// Chat channel list skeleton
export const SkeletonChannelList: React.FC = () => (
    <div className="px-4 py-3 space-y-2 animate-in fade-in duration-300">
        <Skeleton className="h-2.5 w-20 mb-3" />
        {[0, 1, 2, 3, 4].map((i) => (
            <div
                key={i}
                className="flex items-center gap-3.5 p-3.5 rounded-2xl bg-white/2 border border-white/3 stagger-item"
                style={{ animationDelay: `${i * 60}ms` }}
            >
                <Skeleton className="w-11 h-11 rounded-xl!" />
                <div className="flex-1 space-y-1.5">
                    <Skeleton className={`h-4 ${i % 2 === 0 ? 'w-2/5' : 'w-1/3'}`} />
                    <Skeleton className={`h-3 ${i % 2 === 0 ? 'w-3/5' : 'w-2/3'}`} />
                </div>
                <Skeleton className="w-6 h-6 rounded-full!" />
            </div>
        ))}
    </div>
);

// Chat message list skeleton — alternating left/right bubbles
export const SkeletonMessageList: React.FC = () => (
    <div className="px-4 py-3 space-y-3 animate-in fade-in duration-300">
        {[
            { side: 'left', w: 'w-3/5', lines: 2 },
            { side: 'right', w: 'w-2/5', lines: 1 },
            { side: 'left', w: 'w-4/5', lines: 3 },
            { side: 'right', w: 'w-1/2', lines: 1 },
            { side: 'left', w: 'w-3/5', lines: 2 },
            { side: 'right', w: 'w-2/5', lines: 2 },
        ].map((msg, i) => (
            <div
                key={i}
                className={`flex ${msg.side === 'right' ? 'justify-end' : 'justify-start'} stagger-item`}
                style={{ animationDelay: `${i * 60}ms` }}
            >
                <div className={`${msg.w} max-w-[80%]`}>
                    {msg.side === 'left' && (
                        <div className="flex items-center gap-2 mb-1.5">
                            <Skeleton className="w-6 h-6 rounded-full!" />
                            <Skeleton className="h-3 w-16" />
                        </div>
                    )}
                    <div
                        className={`rounded-2xl p-3.5 ${
                            msg.side === 'right'
                                ? 'bg-sky-500/6 border border-sky-500/8 rounded-br-lg'
                                : 'bg-white/3 border border-white/3 rounded-bl-lg'
                        }`}
                    >
                        <div className="space-y-1.5">
                            {Array.from({ length: msg.lines }).map((_, j) => (
                                <Skeleton key={j} className={`h-3 ${j === msg.lines - 1 ? 'w-3/4' : 'w-full'}`} />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        ))}
    </div>
);
