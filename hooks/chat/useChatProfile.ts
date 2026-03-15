/**
 * useChatProfile — Extracted from ChatPage.
 * Manages profile photos, display name, vessel name, avatar resolution.
 */
import { useState, useRef, useCallback } from 'react';
import { ChatService } from '../../services/ChatService';
import {
    uploadProfilePhoto,
    getCachedAvatar,
    removeProfilePhoto,
    getProfile,
    updateProfile,
} from '../../services/ProfilePhotoService';

export interface UseChatProfileOptions {
    avatarMap: Map<string, string>;
    setView: (view: string) => void;
}

export function useChatProfile(options: UseChatProfileOptions) {
    const { avatarMap, setView } = options;

    // --- State ---
    const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
    const [showPhotoUpload, setShowPhotoUpload] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<string | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [profileDisplayName, setProfileDisplayName] = useState('');
    const [profileVesselName, setProfileVesselName] = useState('');
    const [profileLoaded, setProfileLoaded] = useState(false);
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileSaved, setProfileSaved] = useState(false);
    const [profileLookingForLove, setProfileLookingForLove] = useState(false);

    // --- Actions ---

    /** Load profile data from Supabase (called during init) */
    const loadProfile = useCallback(async () => {
        const user = await ChatService.getCurrentUser();
        if (!user) {
            setProfileLoaded(true);
            return;
        }
        const profile = await getProfile(user.id);
        if (profile) {
            setProfileDisplayName(profile.display_name || '');
            setProfileVesselName(profile.vessel_name || '');
            setProfileLookingForLove(profile.looking_for_love || false);
            if (profile.avatar_url) setMyAvatarUrl(profile.avatar_url);
        }
        setProfileLoaded(true);
    }, []);

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploadError(null);
        setUploadProgress('Starting...');

        const result = await uploadProfilePhoto(file, (step) => setUploadProgress(step));

        if (result.success && result.url) {
            setMyAvatarUrl(result.url);
            setUploadProgress(null);
            setShowPhotoUpload(false);
        } else {
            setUploadError(result.error || 'Upload failed');
            setUploadProgress(null);
        }

        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    const handleRemovePhoto = useCallback(async () => {
        await removeProfilePhoto();
        setMyAvatarUrl(null);
        setShowPhotoUpload(false);
    }, []);

    const handleSaveProfile = useCallback(async () => {
        setProfileSaving(true);
        await updateProfile({
            display_name: profileDisplayName.trim() || undefined,
            vessel_name: profileVesselName.trim() || undefined,
            looking_for_love: profileLookingForLove,
        });
        ChatService.clearDisplayNameCache();
        setProfileSaving(false);
        setProfileSaved(true);
        setTimeout(() => {
            setProfileSaved(false);
            setView('channels');
        }, 1200);
    }, [profileDisplayName, profileVesselName, profileLookingForLove, setView]);

    /** Resolve avatar URL for a user — uses myAvatarUrl for 'self', then map, then cache */
    const getAvatar = useCallback(
        (userId: string): string | null => {
            if (userId === 'self') return myAvatarUrl;
            return avatarMap.get(userId) || getCachedAvatar(userId) || null;
        },
        [myAvatarUrl, avatarMap],
    );

    return {
        // State
        myAvatarUrl,
        setMyAvatarUrl,
        showPhotoUpload,
        setShowPhotoUpload,
        uploadProgress,
        uploadError,
        fileInputRef,
        profileDisplayName,
        setProfileDisplayName,
        profileVesselName,
        setProfileVesselName,
        profileLoaded,
        setProfileLoaded,
        profileSaving,
        profileSaved,
        profileLookingForLove,
        setProfileLookingForLove,

        // Actions
        loadProfile,
        handleFileSelect,
        handleRemovePhoto,
        handleSaveProfile,
        getAvatar,
    };
}
