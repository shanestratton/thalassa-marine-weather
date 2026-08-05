import React from 'react';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../components/chat/ChatComposer';
import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';
import { ShareSheet } from '../pages/log/ShareSheet';
import { COMMUNITY_TRACK_SHARING_BETA_HOLD_MESSAGE, TrackSharingService } from '../services/TrackSharingService';
import { supabase } from '../services/supabase';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

const migrationPath = resolve(process.cwd(), 'supabase/migrations/20260805103000_hold_precise_track_sharing.sql');

describe('public-beta precise track privacy hold', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps the feature flag off and blocks every non-owner distribution API before Supabase is called', async () => {
        expect(FEATURE_VISIBILITY.communityTrackSharing).toBe(false);

        await expect(
            TrackSharingService.shareTrack([], {
                title: 'Private voyage',
                description: '',
                tags: [],
                category: 'coastal',
                region: '',
            }),
        ).rejects.toThrow(COMMUNITY_TRACK_SHARING_BETA_HOLD_MESSAGE);
        await expect(TrackSharingService.downloadTrack('legacy-track', true)).rejects.toThrow(
            COMMUNITY_TRACK_SHARING_BETA_HOLD_MESSAGE,
        );
        await expect(TrackSharingService.browseSharedTracks()).resolves.toEqual({ tracks: [], total: 0 });
        await expect(TrackSharingService.getTrackById('legacy-track')).resolves.toBeNull();
        await expect(TrackSharingService.getDistinctRegions()).resolves.toEqual([]);

        expect(supabase!.from).not.toHaveBeenCalled();
        expect(supabase!.rpc).not.toHaveBeenCalled();
    });

    it('keeps local image sharing but hides logbook community publish and browse actions', () => {
        render(
            <ShareSheet
                onClose={vi.fn()}
                onShowShareForm={vi.fn()}
                onShowCommunityBrowser={vi.fn()}
                onShareImage={vi.fn()}
                hasNonDeviceEntries={false}
                selectedVoyageId="voyage-1"
            />,
        );

        expect(screen.getByRole('button', { name: 'Share voyage image' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Share voyage' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Browse community tracks' })).not.toBeInTheDocument();
        expect(screen.getByText(/without publishing|visual summary/i)).toBeInTheDocument();
    });

    it('keeps location and pin attachments while hiding crew voyage-track publishing', () => {
        render(
            <ChatComposer
                messageText=""
                setMessageText={vi.fn()}
                isQuestion={false}
                setIsQuestion={vi.fn()}
                filterWarning={null}
                setFilterWarning={vi.fn()}
                isMuted={false}
                mutedUntil={null}
                showAttachMenu
                setShowAttachMenu={vi.fn()}
                keyboardOffset={0}
                inputRef={{ current: null }}
                onSend={vi.fn()}
                onOpenPinDrop={vi.fn()}
                onOpenPoiPicker={vi.fn()}
                onOpenTrackPicker={vi.fn()}
            />,
        );

        expect(screen.getByRole('menuitem', { name: 'Share my current location' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Drop a pin on the chart' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Share a voyage track' })).not.toBeInTheDocument();
    });

    it('refuses to mount the legacy community browser when the beta hold is active', () => {
        render(<CommunityTrackBrowser isOpen onClose={vi.fn()} onImportComplete={vi.fn()} />);

        expect(screen.queryByRole('dialog', { name: 'Community track browser' })).not.toBeInTheDocument();
        expect(supabase!.from).not.toHaveBeenCalled();
    });

    it('gates logbook and legacy-chat entry points in source', () => {
        const logPage = readFileSync(resolve(process.cwd(), 'pages/LogPage.tsx'), 'utf8');
        const messageList = readFileSync(resolve(process.cwd(), 'components/chat/ChatMessageList.tsx'), 'utf8');
        const account = readFileSync(resolve(process.cwd(), 'components/settings/AccountTab.tsx'), 'utf8');

        expect(logPage).toContain("FEATURE_VISIBILITY.communityTrackSharing && actionSheet === 'import'");
        expect(logPage).toContain("FEATURE_VISIBILITY.communityTrackSharing && actionSheet === 'share_form'");
        expect(messageList).toContain('!FEATURE_VISIBILITY.communityTrackSharing');
        expect(messageList).toContain('Legacy voyage track unavailable');
        expect(account).not.toContain('share community tracks');
    });

    it('replaces both public-read policies with authenticated owner-only RLS and retires the bypass RPC', () => {
        const migration = readFileSync(migrationPath, 'utf8');

        expect(migration).toContain('DROP POLICY IF EXISTS "Anyone can view shared tracks"');
        expect(migration).toContain('DROP POLICY IF EXISTS "Anyone can read community tracks"');
        expect(migration).toContain('ALTER TABLE public.shared_tracks FORCE ROW LEVEL SECURITY');
        expect(migration).toContain('ALTER TABLE public.community_tracks FORCE ROW LEVEL SECURITY');
        expect(migration).not.toMatch(/USING\s*\(\s*true\s*\)/i);
        expect(migration.match(/USING \(auth\.uid\(\) = user_id\)/g)).toHaveLength(6);
        expect(migration.match(/WITH CHECK \(auth\.uid\(\) = user_id\)/g)).toHaveLength(4);
        expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.shared_tracks FROM PUBLIC, anon');
        expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.community_tracks FROM PUBLIC, anon');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.increment_download_count(UUID) FROM PUBLIC, anon, authenticated',
        );
        expect(migration).not.toMatch(/GRANT EXECUTE[^;]*increment_download_count/i);
    });
});
