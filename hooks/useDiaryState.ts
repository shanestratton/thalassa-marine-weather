/**
 * useDiaryState — Consolidated state management for DiaryPage.
 *
 * Replaces 29 individual useState calls with a single useReducer,
 * eliminating cascade re-renders when multiple state fields change
 * together (e.g. openCompose sets 11 fields → 1 dispatch).
 */

import { useReducer, useCallback } from 'react';
import { DiaryEntry, DiaryMood } from '../services/DiaryService';

// ── State Shape ────────────────────────────────────────────────

export interface DiaryState {
    // Page state
    entries: DiaryEntry[];
    loading: boolean;
    showCompose: boolean;
    selectedEntry: DiaryEntry | null;

    // Compose state
    editingId: string | null;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[];
    audioUrl: string | null;
    uploading: boolean;
    lat: number | null;
    lon: number | null;
    locationName: string;
    weatherSummary: string;
    saving: boolean;
    polishing: boolean;
    gpsLoading: boolean;

    // Timeline selection
    selectMode: boolean;
    selectedIds: Set<string>;
    menuOpen: boolean;
    exportProgress: string | null;

    // Audio recording
    isRecording: boolean;
    recordingTime: number;
    transcribing: boolean;

    // Playback
    isPlaying: boolean;

    // Keyboard
    keyboardHeight: number;

    // Soft-delete
    deletedItem: DiaryEntry | null;
}

const initialState: DiaryState = {
    entries: [],
    loading: true,
    showCompose: false,
    selectedEntry: null,

    editingId: null,
    title: '',
    body: '',
    mood: 'good',
    photos: [],
    audioUrl: null,
    uploading: false,
    lat: null,
    lon: null,
    locationName: '',
    weatherSummary: '',
    saving: false,
    polishing: false,
    gpsLoading: false,

    selectMode: false,
    selectedIds: new Set(),
    menuOpen: false,
    exportProgress: null,

    isRecording: false,
    recordingTime: 0,
    transcribing: false,

    isPlaying: false,

    keyboardHeight: 0,

    deletedItem: null,
};

// ── Actions ────────────────────────────────────────────────────

export type DiaryAction =
    // Page
    | { type: 'SET_ENTRIES'; entries: DiaryEntry[] }
    | { type: 'SET_LOADING'; loading: boolean }
    | { type: 'SET_SELECTED_ENTRY'; entry: DiaryEntry | null }
    | { type: 'PREPEND_ENTRY'; entry: DiaryEntry }
    | { type: 'UPDATE_ENTRY'; id: string; updates: Partial<DiaryEntry> }
    | { type: 'REMOVE_ENTRY'; id: string }
    | { type: 'RESTORE_ENTRY'; entry: DiaryEntry }

    // Compose — batch open/close
    | { type: 'OPEN_COMPOSE'; weatherSummary: string }
    | { type: 'OPEN_EDIT'; entry: DiaryEntry; locationDisplay: string }
    | { type: 'CLOSE_COMPOSE' }

    // Compose — individual field updates
    | { type: 'SET_TITLE'; title: string }
    | { type: 'SET_BODY'; body: string }
    | { type: 'SET_MOOD'; mood: DiaryMood }
    | { type: 'SET_PHOTOS'; photos: string[] }
    | { type: 'ADD_PHOTO'; url: string }
    | { type: 'REMOVE_PHOTO'; idx: number }
    | { type: 'SET_AUDIO_URL'; url: string | null }
    | { type: 'SET_UPLOADING'; uploading: boolean }
    | { type: 'SET_GPS'; lat: number | null; lon: number | null; locationName: string }
    | { type: 'SET_GPS_LOADING'; loading: boolean }
    | { type: 'SET_WEATHER_SUMMARY'; summary: string }
    | { type: 'SET_SAVING'; saving: boolean }
    | { type: 'SET_POLISHING'; polishing: boolean }

    // Timeline selection
    | { type: 'ENTER_SELECT_MODE' }
    | { type: 'EXIT_SELECT_MODE' }
    | { type: 'TOGGLE_ENTRY_SELECTION'; id: string }
    | { type: 'SET_MENU_OPEN'; open: boolean }
    | { type: 'SET_EXPORT_PROGRESS'; progress: string | null }

    // Audio recording
    | { type: 'START_RECORDING' }
    | { type: 'STOP_RECORDING' }
    | { type: 'TICK_RECORDING' }
    | { type: 'SET_TRANSCRIBING'; transcribing: boolean }
    | { type: 'SET_RECORDING_TIME'; time: number }

    // Playback
    | { type: 'SET_PLAYING'; playing: boolean }

    // Keyboard
    | { type: 'SET_KEYBOARD_HEIGHT'; height: number }

    // Soft-delete
    | { type: 'SET_DELETED_ITEM'; item: DiaryEntry | null }
    | { type: 'SOFT_DELETE'; id: string };

// ── Reducer ────────────────────────────────────────────────────

function diaryReducer(state: DiaryState, action: DiaryAction): DiaryState {
    switch (action.type) {
        // ── Page ──
        case 'SET_ENTRIES':
            return { ...state, entries: action.entries };
        case 'SET_LOADING':
            return { ...state, loading: action.loading };
        case 'SET_SELECTED_ENTRY':
            return { ...state, selectedEntry: action.entry };
        case 'PREPEND_ENTRY':
            return { ...state, entries: [action.entry, ...state.entries], showCompose: false };
        case 'UPDATE_ENTRY':
            return {
                ...state,
                entries: state.entries.map(e =>
                    e.id === action.id ? { ...e, ...action.updates } : e
                ),
                showCompose: false,
                editingId: null,
            };
        case 'REMOVE_ENTRY':
            return {
                ...state,
                entries: state.entries.filter(e => e.id !== action.id),
                selectedEntry: state.selectedEntry?.id === action.id ? null : state.selectedEntry,
            };
        case 'RESTORE_ENTRY':
            return { ...state, entries: [...state.entries, action.entry] };

        // ── Compose batch ──
        case 'OPEN_COMPOSE':
            return {
                ...state,
                showCompose: true,
                editingId: null,
                title: '',
                body: '',
                mood: 'good',
                photos: [],
                audioUrl: null,
                lat: null,
                lon: null,
                locationName: '',
                weatherSummary: action.weatherSummary,
                recordingTime: 0,
            };
        case 'OPEN_EDIT':
            return {
                ...state,
                showCompose: true,
                editingId: action.entry.id,
                title: action.entry.title,
                body: action.entry.body,
                mood: action.entry.mood,
                photos: action.entry.photos || [],
                audioUrl: action.entry.audio_url || null,
                lat: action.entry.latitude,
                lon: action.entry.longitude,
                locationName: action.locationDisplay,
                selectedEntry: null,
            };
        case 'CLOSE_COMPOSE':
            return { ...state, showCompose: false };

        // ── Compose fields ──
        case 'SET_TITLE':
            return { ...state, title: action.title };
        case 'SET_BODY':
            return { ...state, body: action.body };
        case 'SET_MOOD':
            return { ...state, mood: action.mood };
        case 'SET_PHOTOS':
            return { ...state, photos: action.photos };
        case 'ADD_PHOTO':
            return { ...state, photos: [...state.photos, action.url] };
        case 'REMOVE_PHOTO':
            return { ...state, photos: state.photos.filter((_, i) => i !== action.idx) };
        case 'SET_AUDIO_URL':
            return { ...state, audioUrl: action.url };
        case 'SET_UPLOADING':
            return { ...state, uploading: action.uploading };
        case 'SET_GPS':
            return { ...state, lat: action.lat, lon: action.lon, locationName: action.locationName };
        case 'SET_GPS_LOADING':
            return { ...state, gpsLoading: action.loading };
        case 'SET_WEATHER_SUMMARY':
            return { ...state, weatherSummary: action.summary };
        case 'SET_SAVING':
            return { ...state, saving: action.saving };
        case 'SET_POLISHING':
            return { ...state, polishing: action.polishing };

        // ── Timeline selection ──
        case 'ENTER_SELECT_MODE':
            return { ...state, selectMode: true };
        case 'EXIT_SELECT_MODE':
            return { ...state, selectMode: false, selectedIds: new Set() };
        case 'TOGGLE_ENTRY_SELECTION': {
            const next = new Set(state.selectedIds);
            if (next.has(action.id)) next.delete(action.id);
            else next.add(action.id);
            return { ...state, selectedIds: next };
        }
        case 'SET_MENU_OPEN':
            return { ...state, menuOpen: action.open };
        case 'SET_EXPORT_PROGRESS':
            return { ...state, exportProgress: action.progress };

        // ── Audio recording ──
        case 'START_RECORDING':
            return { ...state, isRecording: true, recordingTime: 0 };
        case 'STOP_RECORDING':
            return { ...state, isRecording: false };
        case 'TICK_RECORDING':
            return { ...state, recordingTime: state.recordingTime + 1 };
        case 'SET_TRANSCRIBING':
            return { ...state, transcribing: action.transcribing };
        case 'SET_RECORDING_TIME':
            return { ...state, recordingTime: action.time };

        // ── Playback ──
        case 'SET_PLAYING':
            return { ...state, isPlaying: action.playing };

        // ── Keyboard ──
        case 'SET_KEYBOARD_HEIGHT':
            return { ...state, keyboardHeight: action.height };

        // ── Soft-delete ──
        case 'SET_DELETED_ITEM':
            return { ...state, deletedItem: action.item };
        case 'SOFT_DELETE': {
            const item = state.entries.find(e => e.id === action.id);
            return {
                ...state,
                entries: state.entries.filter(e => e.id !== action.id),
                selectedEntry: state.selectedEntry?.id === action.id ? null : state.selectedEntry,
                deletedItem: item || null,
            };
        }

        default:
            return state;
    }
}

// ── Hook ───────────────────────────────────────────────────────

export function useDiaryState() {
    const [state, dispatch] = useReducer(diaryReducer, initialState);
    return { state, dispatch };
}
