import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Share } from '@capacitor/share';
import { SwipeableDiaryCard } from '../components/diary/SwipeableDiaryCard';
import type { DiaryEntry } from '../services/DiaryService';

const swipe = vi.hoisted(() => ({ offset: 0, reset: vi.fn() }));
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({
        swipeOffset: swipe.offset,
        isSwiping: false,
        resetSwipe: swipe.reset,
        ref: { current: null },
    }),
}));
vi.mock('../services/DiaryService', () => ({
    DiaryService: { resolvePhotoUrl: vi.fn() },
    MOOD_CONFIG: { neutral: { emoji: '⚓', label: 'At sea' } },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

const entry: DiaryEntry = {
    id: 'entry-one',
    user_id: 'skipper',
    title: 'An excellent day in Mackay',
    body: 'A lovely sail.',
    mood: 'neutral',
    photos: [],
    audio_url: null,
    latitude: -21.1,
    longitude: 149.2,
    location_name: 'Mackay',
    weather_summary: '',
    voyage_id: null,
    tags: [],
    is_public: true,
    created_at: '2026-09-21T01:00:00Z',
    updated_at: '2026-09-21T01:00:00Z',
};

function props() {
    return {
        entry,
        onTap: vi.fn(),
        onDelete: vi.fn(),
        onEdit: vi.fn(),
        selected: false,
        onToggleSelect: vi.fn(),
    };
}

beforeEach(() => {
    swipe.offset = 0;
    swipe.reset.mockClear();
    vi.mocked(Share.share).mockClear();
});
afterEach(cleanup);

describe('diary comment review highlight', () => {
    it('keeps ordinary entries unchanged when no pending count is supplied', () => {
        const { container } = render(<SwipeableDiaryCard {...props()} />);
        expect(screen.queryByText(/comments? to review/)).toBeNull();
        expect(container.firstElementChild?.className).not.toContain('shadow-');
        expect(container.firstElementChild?.children[1]).toHaveClass('border-white/5', 'bg-white/3');
    });

    it('uses a warm static halo and a readable count instead of relying on colour alone', () => {
        const { container } = render(<SwipeableDiaryCard {...props()} pendingCommentCount={2} />);
        expect(screen.getByText('2 comments to review')).toBeVisible();
        expect(container.firstElementChild?.className).toContain('shadow-');
        expect(container.firstElementChild?.children[1]).toHaveClass('border-amber-400/45');
        expect(container.innerHTML).not.toContain('animate-');
        expect(screen.getByText('2 comments to review')).toHaveClass('min-w-0', 'break-words');
        expect(screen.getByText('2 comments to review').parentElement).not.toHaveClass('whitespace-nowrap');
    });

    it('updates the singular count and removes the halo after the final comment is reviewed', () => {
        const handlers = props();
        const { container, rerender } = render(<SwipeableDiaryCard {...handlers} pendingCommentCount={2} />);
        rerender(<SwipeableDiaryCard {...handlers} pendingCommentCount={1} />);
        expect(screen.getByText('1 comment to review')).toBeVisible();
        rerender(<SwipeableDiaryCard {...handlers} pendingCommentCount={0} />);
        expect(screen.queryByText(/comments? to review/)).toBeNull();
        expect(container.firstElementChild?.className).not.toContain('shadow-');
        expect(container.firstElementChild?.children[1]).toHaveClass('border-white/5');
    });

    it('preserves the blue selection border and checkbox while a review is pending', () => {
        const { container } = render(<SwipeableDiaryCard {...props()} selected pendingCommentCount={1} />);
        expect(container.firstElementChild?.children[1]).toHaveClass('border-sky-500/50');
        expect(container.firstElementChild?.className).toContain('shadow-');
        expect(screen.getByRole('button', { name: 'Deselect' }).firstElementChild).toHaveClass('bg-sky-500');
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('does not highlight invalid count %s', (count) => {
        const { container } = render(<SwipeableDiaryCard {...props()} pendingCommentCount={count} />);
        expect(screen.queryByText(/comments? to review/)).toBeNull();
        expect(container.firstElementChild?.className).not.toContain('shadow-');
    });

    it('opens the entry when its review label is tapped', () => {
        const handlers = props();
        render(<SwipeableDiaryCard {...handlers} pendingCommentCount={1} />);
        fireEvent.click(screen.getByText('1 comment to review'));
        expect(handlers.onTap).toHaveBeenCalledOnce();
    });

    it('preserves selection, edit and share controls without opening the entry', async () => {
        const handlers = props();
        render(<SwipeableDiaryCard {...handlers} pendingCommentCount={2} />);
        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        fireEvent.click(screen.getByRole('button', { name: 'Edit entry' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share entry' }));
        expect(handlers.onToggleSelect).toHaveBeenCalledOnce();
        expect(handlers.onEdit).toHaveBeenCalledOnce();
        await waitFor(() => expect(Share.share).toHaveBeenCalledOnce());
        expect(handlers.onTap).not.toHaveBeenCalled();
    });

    it('keeps swipe-to-delete working and does not open the entry mid-swipe', () => {
        swipe.offset = 80;
        const handlers = props();
        const { container } = render(<SwipeableDiaryCard {...handlers} pendingCommentCount={1} />);
        expect(container.firstElementChild?.children[1]).toHaveStyle({ transform: 'translateX(-80px)' });
        fireEvent.click(screen.getByText('1 comment to review'));
        expect(handlers.onTap).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }));
        expect(swipe.reset).toHaveBeenCalledOnce();
        expect(handlers.onDelete).toHaveBeenCalledOnce();
    });
});
