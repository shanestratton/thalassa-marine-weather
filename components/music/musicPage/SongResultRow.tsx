import React, { useState } from 'react';
import { SafeImage } from '../../ui/SafeImage';
import { GeneratedPlaylistArtwork } from './GeneratedPlaylistArtwork';
import { CheckIcon, ExternalLinkIcon, PlusIcon } from './icons';
import type { SongResultRowProps } from './types';

export const SongResultRow: React.FC<SongResultRowProps> = ({ song, adding, added, redirected, onAdd }) => {
    const [imageFailed, setImageFailed] = useState(false);
    const showRemote = !!song.artworkUrl && !imageFailed;
    return (
        <button
            onClick={onAdd}
            disabled={adding || added}
            aria-label={`${added ? 'Added' : redirected ? 'Opened' : adding ? 'Adding' : 'Add'} ${song.title} by ${
                song.artist
            }${song.album ? ` from ${song.album}` : ''}`}
            className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl transition-colors text-left ${
                added ? 'bg-emerald-500/10' : redirected ? 'bg-amber-500/10' : 'hover:bg-sky-500/6 active:bg-sky-400/10'
            }`}
        >
            <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-white/5">
                {showRemote ? (
                    <SafeImage
                        src={song.artworkUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={() => setImageFailed(true)}
                        fallback={<GeneratedPlaylistArtwork name={song.title} />}
                    />
                ) : (
                    <GeneratedPlaylistArtwork name={song.title} />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-medium truncate">{song.title}</div>
                <div className="text-white/50 text-xs truncate mt-0.5">
                    {song.artist}
                    {song.album ? ` · ${song.album}` : ''}
                </div>
            </div>
            <div className="w-8 h-8 flex items-center justify-center shrink-0">
                {adding ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
                ) : added ? (
                    <CheckIcon className="w-5 h-5 text-emerald-400" />
                ) : redirected ? (
                    <ExternalLinkIcon className="w-5 h-5 text-amber-300" />
                ) : (
                    <PlusIcon className="h-5 w-5 text-sky-300" />
                )}
            </div>
        </button>
    );
};
