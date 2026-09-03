import React from 'react';

/** Three-bar equaliser glyph for the current track row. Static bars when
 *  paused; the gentle stagger only runs while audio is actually moving. */
export const PlayingGlyph: React.FC<{ playing: boolean }> = ({ playing }) => (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-label={playing ? 'Playing' : 'Paused'}>
        {[0, 1, 2].map((bar) => (
            <span
                key={bar}
                className={`w-[3px] rounded-xs bg-sky-400 ${playing ? 'animate-pulse' : ''}`}
                style={{
                    height: bar === 1 ? '100%' : '60%',
                    animationDelay: playing ? `${bar * 180}ms` : undefined,
                }}
            />
        ))}
    </span>
);
