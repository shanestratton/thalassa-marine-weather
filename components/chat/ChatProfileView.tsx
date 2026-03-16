/**
 * ChatProfileView — Sailor profile editing (avatar, display name, vessel).
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React from 'react';

export interface ChatProfileViewProps {
    myAvatarUrl: string | null;
    uploadProgress: string | null;
    uploadError: string | null;
    profileDisplayName: string;
    setProfileDisplayName: (v: string) => void;
    profileVesselName: string;
    setProfileVesselName: (v: string) => void;
    profileSaving: boolean;
    profileSaved: boolean;
    vesselPlaceholder: string;
    isObserver?: boolean;
    fileInputRef: React.RefObject<HTMLInputElement>;
    onSaveProfile: () => void;
    onRemovePhoto: () => void;
}

export const ChatProfileView: React.FC<ChatProfileViewProps> = React.memo(
    ({
        myAvatarUrl,
        uploadProgress,
        uploadError,
        profileDisplayName,
        setProfileDisplayName,
        profileVesselName,
        setProfileVesselName,
        profileSaving,
        profileSaved,
        vesselPlaceholder,
        isObserver,
        fileInputRef,
        onSaveProfile,
        onRemovePhoto,
    }) => (
        <div
            className="flex-1 flex flex-col px-5 py-4 gap-4 overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 11rem)' }}
        >
            {/* Avatar section */}
            <div className="flex flex-col items-center gap-3">
                <div className="w-24 h-24 rounded-2xl overflow-hidden border-2 border-purple-400/20 shadow-lg shadow-purple-500/10">
                    {myAvatarUrl ? (
                        <img src={myAvatarUrl} loading="lazy" alt="" className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full bg-gradient-to-br from-purple-500/10 to-sky-500/10 flex items-center justify-center">
                            <span className="text-4xl opacity-40">🧑‍✈️</span>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!!uploadProgress}
                        className="text-sm text-purple-400 hover:text-purple-300 font-medium transition-colors"
                    >
                        {myAvatarUrl ? '🔄 Change Photo' : '📷 Upload Photo'}
                    </button>
                    {myAvatarUrl && (
                        <button
                            onClick={onRemovePhoto}
                            className="text-sm text-white/25 hover:text-red-400 transition-colors"
                        >
                            Remove
                        </button>
                    )}
                </div>
                <p className="text-xs text-white/60">JPEG/PNG • Max 2MB • AI-moderated 🍺</p>
            </div>

            {/* Upload progress */}
            {uploadProgress && (
                <div className="p-3.5 rounded-2xl bg-sky-500/[0.06] border border-sky-500/10">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm text-sky-400">{uploadProgress}</span>
                    </div>
                </div>
            )}

            {/* Upload error */}
            {uploadError && (
                <div className="p-3.5 rounded-2xl bg-red-500/[0.06] border border-red-500/10">
                    <p className="text-sm text-red-400">❌ {uploadError}</p>
                </div>
            )}

            {/* Display Name */}
            <div>
                <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                    Display Name
                </label>
                <input
                    value={profileDisplayName}
                    onChange={(e) => setProfileDisplayName(e.target.value)}
                    placeholder="Captain Jack"
                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 transition-colors"
                    maxLength={30}
                />
                <p className="text-xs text-white/60 mt-1.5 px-1">This is how you appear in chat</p>
            </div>

            {/* Vessel Name */}
            <div className={isObserver ? 'opacity-40' : ''}>
                <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                    ⛵ Vessel Name
                </label>
                <input
                    value={isObserver ? '' : profileVesselName}
                    onChange={(e) => setProfileVesselName(e.target.value)}
                    placeholder={isObserver ? 'Observer Mode — No Vessel' : (vesselPlaceholder || 'Black Pearl')}
                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 transition-colors disabled:cursor-not-allowed"
                    maxLength={40}
                    disabled={isObserver}
                />
            </div>

            {/* Save button */}
            <button
                onClick={onSaveProfile}
                disabled={profileSaving}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-purple-500/20 to-sky-500/20 hover:from-purple-500/30 hover:to-sky-500/30 text-base text-white/80 font-bold transition-all disabled:opacity-30 active:scale-[0.98]"
            >
                {profileSaved ? '✓ Saved!' : profileSaving ? 'Saving...' : '💾 Save Profile'}
            </button>
        </div>
    ),
);

ChatProfileView.displayName = 'ChatProfileView';
