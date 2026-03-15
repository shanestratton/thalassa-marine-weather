/**
 * useCrewFinderState — useReducer hook for LonelyHeartsPage
 *
 * Consolidates ~50 useState calls into a single reducer.
 * Performance win: batch state transitions (e.g. clearFilters, resetProfile)
 * that previously triggered 10-20 sequential re-renders now cause just 1.
 */

import { useReducer } from 'react';
import { CrewCard, SailorMatch, CrewProfile, CrewSearchFilters, ListingType } from '../services/LonelyHeartsService';

// ── State shape ──────────────────────────────────────────────────

export interface CrewFinderState {
    // Navigation
    view: 'board' | 'detail' | 'my_profile' | 'matches';
    loading: boolean;

    // Board
    listings: CrewCard[];
    filters: CrewSearchFilters;
    filterListingType: ListingType | '';
    filterGender: string;
    filterAgeRanges: string[];
    filterSkills: string[];
    filterExperience: string;
    filterRegion: string;
    filterLocationCountry: string;
    filterLocationState: string;
    filterLocationCity: string;
    showFilters: boolean;

    // Detail
    selectedCard: CrewCard | null;

    // Matches
    matches: SailorMatch[];
    hasSearched: boolean;

    // Block / Report
    blockedUserIds: Set<string>;
    showReportModal: string | null;
    reportReason: string;
    showActionMenu: string | null;

    // Super Like
    showSuperLikeModal: CrewCard | null;
    superLikeMessage: string;
    superLikeUsed: boolean;

    // My Profile form
    profile: Partial<CrewProfile>;
    editListingType: ListingType | '';
    editFirstName: string;
    editGender: string;
    editAge: string;
    editHasPartner: boolean;
    editPartnerDetails: string;
    editSkills: string[];
    editExperience: string;
    editRegion: string;
    editAvailFrom: string;
    editAvailTo: string;
    editBio: string;
    editVibe: string[];
    editLanguages: string[];
    editSmoking: string;
    editDrinking: string;
    editPets: string;
    editInterests: string[];
    editLocationCity: string;
    editLocationState: string;
    editLocationCountry: string;
    saving: boolean;
    saved: boolean;

    // Photos
    editPhotos: string[];
    uploadingPhotoIdx: number | null;
    photoError: string;
    pendingPhotoIdx: number;

    // Delete listing
    showDeleteConfirm: boolean;
    deleting: boolean;
    showPreview: boolean;

    // Keyboard
    kbHeight: number;

    // Card stack
    currentCardIndex: number;
    cardPhotoIndex: number;
    swipeX: number;
    swipeDirection: 'left' | 'right' | null;
    isAnimating: boolean;

    // Interactions
    likedUsers: Set<string>;
    messagedUsers: Set<string>;
}

// ── Actions ──────────────────────────────────────────────────────

export type CrewFinderAction =
    | { type: 'SET_VIEW'; payload: CrewFinderState['view'] }
    | { type: 'SET_LOADING'; payload: boolean }
    | { type: 'SET_LISTINGS'; payload: CrewCard[] }
    | { type: 'SET_FILTERS'; payload: CrewSearchFilters }
    | { type: 'SET_FILTER_LISTING_TYPE'; payload: ListingType | '' }
    | { type: 'SET_FILTER_GENDER'; payload: string }
    | { type: 'SET_FILTER_AGE_RANGES'; payload: string[] }
    | { type: 'SET_FILTER_SKILLS'; payload: string[] }
    | { type: 'SET_FILTER_EXPERIENCE'; payload: string }
    | { type: 'SET_FILTER_REGION'; payload: string }
    | { type: 'SET_FILTER_LOCATION_COUNTRY'; payload: string }
    | { type: 'SET_FILTER_LOCATION_STATE'; payload: string }
    | { type: 'SET_FILTER_LOCATION_CITY'; payload: string }
    | { type: 'SET_SHOW_FILTERS'; payload: boolean }
    | { type: 'SET_SELECTED_CARD'; payload: CrewCard | null }
    | { type: 'SET_MATCHES'; payload: SailorMatch[] }
    | { type: 'SET_HAS_SEARCHED'; payload: boolean }
    | { type: 'SET_BLOCKED_USER_IDS'; payload: Set<string> }
    | { type: 'SET_SHOW_REPORT_MODAL'; payload: string | null }
    | { type: 'SET_REPORT_REASON'; payload: string }
    | { type: 'SET_SHOW_ACTION_MENU'; payload: string | null }
    | { type: 'SET_SHOW_SUPER_LIKE_MODAL'; payload: CrewCard | null }
    | { type: 'SET_SUPER_LIKE_MESSAGE'; payload: string }
    | { type: 'SET_SUPER_LIKE_USED'; payload: boolean }
    | { type: 'SET_PROFILE'; payload: Partial<CrewProfile> }
    | { type: 'SET_EDIT_LISTING_TYPE'; payload: ListingType | '' }
    | { type: 'SET_EDIT_FIRST_NAME'; payload: string }
    | { type: 'SET_EDIT_GENDER'; payload: string }
    | { type: 'SET_EDIT_AGE'; payload: string }
    | { type: 'SET_EDIT_HAS_PARTNER'; payload: boolean }
    | { type: 'SET_EDIT_PARTNER_DETAILS'; payload: string }
    | { type: 'SET_EDIT_SKILLS'; payload: string[] }
    | { type: 'SET_EDIT_EXPERIENCE'; payload: string }
    | { type: 'SET_EDIT_REGION'; payload: string }
    | { type: 'SET_EDIT_AVAIL_FROM'; payload: string }
    | { type: 'SET_EDIT_AVAIL_TO'; payload: string }
    | { type: 'SET_EDIT_BIO'; payload: string }
    | { type: 'SET_EDIT_VIBE'; payload: string[] }
    | { type: 'SET_EDIT_LANGUAGES'; payload: string[] }
    | { type: 'SET_EDIT_SMOKING'; payload: string }
    | { type: 'SET_EDIT_DRINKING'; payload: string }
    | { type: 'SET_EDIT_PETS'; payload: string }
    | { type: 'SET_EDIT_INTERESTS'; payload: string[] }
    | { type: 'SET_EDIT_LOCATION_CITY'; payload: string }
    | { type: 'SET_EDIT_LOCATION_STATE'; payload: string }
    | { type: 'SET_EDIT_LOCATION_COUNTRY'; payload: string }
    | { type: 'SET_SAVING'; payload: boolean }
    | { type: 'SET_SAVED'; payload: boolean }
    | { type: 'SET_EDIT_PHOTOS'; payload: string[] }
    | { type: 'SET_UPLOADING_PHOTO_IDX'; payload: number | null }
    | { type: 'SET_PHOTO_ERROR'; payload: string }
    | { type: 'SET_PENDING_PHOTO_IDX'; payload: number }
    | { type: 'SET_SHOW_DELETE_CONFIRM'; payload: boolean }
    | { type: 'SET_DELETING'; payload: boolean }
    | { type: 'SET_SHOW_PREVIEW'; payload: boolean }
    | { type: 'SET_KB_HEIGHT'; payload: number }
    | { type: 'SET_CURRENT_CARD_INDEX'; payload: number }
    | { type: 'SET_CARD_PHOTO_INDEX'; payload: number }
    | { type: 'SET_SWIPE_X'; payload: number }
    | { type: 'SET_SWIPE_DIRECTION'; payload: 'left' | 'right' | null }
    | { type: 'SET_IS_ANIMATING'; payload: boolean }
    | { type: 'SET_LIKED_USERS'; payload: Set<string> }
    | { type: 'SET_MESSAGED_USERS'; payload: Set<string> }
    // ── Batch actions (perf wins) ──
    | { type: 'CLEAR_FILTERS' }
    | { type: 'RESET_PROFILE' }
    | { type: 'LOAD_PROFILE'; payload: CrewProfile }
    | { type: 'SWIPE_ANIMATE'; payload: { direction: 'left' | 'right' } }
    | { type: 'SWIPE_COMPLETE'; payload: { newIndex: number } }
    | { type: 'GO_TO_START' }
    | { type: 'REMOVE_LISTING'; payload: string }; // userId

// ── Initial state ────────────────────────────────────────────────

const initialState: CrewFinderState = {
    view: 'my_profile',
    loading: true,
    listings: [],
    filters: {},
    filterListingType: '',
    filterGender: '',
    filterAgeRanges: [],
    filterSkills: [],
    filterExperience: '',
    filterRegion: '',
    filterLocationCountry: '',
    filterLocationState: '',
    filterLocationCity: '',
    showFilters: false,
    selectedCard: null,
    matches: [],
    hasSearched: false,
    blockedUserIds: new Set(),
    showReportModal: null,
    reportReason: '',
    showActionMenu: null,
    showSuperLikeModal: null,
    superLikeMessage: '',
    superLikeUsed: false,
    profile: {},
    editListingType: '',
    editFirstName: '',
    editGender: '',
    editAge: '',
    editHasPartner: false,
    editPartnerDetails: '',
    editSkills: [],
    editExperience: '',
    editRegion: '',
    editAvailFrom: '',
    editAvailTo: '',
    editBio: '',
    editVibe: [],
    editLanguages: [],
    editSmoking: '',
    editDrinking: '',
    editPets: '',
    editInterests: [],
    editLocationCity: '',
    editLocationState: '',
    editLocationCountry: '',
    saving: false,
    saved: false,
    editPhotos: [],
    uploadingPhotoIdx: null,
    photoError: '',
    pendingPhotoIdx: 0,
    showDeleteConfirm: false,
    deleting: false,
    showPreview: false,
    kbHeight: 0,
    currentCardIndex: 0,
    cardPhotoIndex: 0,
    swipeX: 0,
    swipeDirection: null,
    isAnimating: false,
    likedUsers: new Set(),
    messagedUsers: new Set(),
};

// ── Reducer ──────────────────────────────────────────────────────

function crewFinderReducer(state: CrewFinderState, action: CrewFinderAction): CrewFinderState {
    switch (action.type) {
        // ── Simple setters (1:1 with old useState) ──
        case 'SET_VIEW':
            return { ...state, view: action.payload };
        case 'SET_LOADING':
            return { ...state, loading: action.payload };
        case 'SET_LISTINGS':
            return { ...state, listings: action.payload };
        case 'SET_FILTERS':
            return { ...state, filters: action.payload };
        case 'SET_FILTER_LISTING_TYPE':
            return { ...state, filterListingType: action.payload };
        case 'SET_FILTER_GENDER':
            return { ...state, filterGender: action.payload };
        case 'SET_FILTER_AGE_RANGES':
            return { ...state, filterAgeRanges: action.payload };
        case 'SET_FILTER_SKILLS':
            return { ...state, filterSkills: action.payload };
        case 'SET_FILTER_EXPERIENCE':
            return { ...state, filterExperience: action.payload };
        case 'SET_FILTER_REGION':
            return { ...state, filterRegion: action.payload };
        case 'SET_FILTER_LOCATION_COUNTRY':
            return { ...state, filterLocationCountry: action.payload };
        case 'SET_FILTER_LOCATION_STATE':
            return { ...state, filterLocationState: action.payload };
        case 'SET_FILTER_LOCATION_CITY':
            return { ...state, filterLocationCity: action.payload };
        case 'SET_SHOW_FILTERS':
            return { ...state, showFilters: action.payload };
        case 'SET_SELECTED_CARD':
            return { ...state, selectedCard: action.payload };
        case 'SET_MATCHES':
            return { ...state, matches: action.payload };
        case 'SET_HAS_SEARCHED':
            return { ...state, hasSearched: action.payload };
        case 'SET_BLOCKED_USER_IDS':
            return { ...state, blockedUserIds: action.payload };
        case 'SET_SHOW_REPORT_MODAL':
            return { ...state, showReportModal: action.payload };
        case 'SET_REPORT_REASON':
            return { ...state, reportReason: action.payload };
        case 'SET_SHOW_ACTION_MENU':
            return { ...state, showActionMenu: action.payload };
        case 'SET_SHOW_SUPER_LIKE_MODAL':
            return { ...state, showSuperLikeModal: action.payload };
        case 'SET_SUPER_LIKE_MESSAGE':
            return { ...state, superLikeMessage: action.payload };
        case 'SET_SUPER_LIKE_USED':
            return { ...state, superLikeUsed: action.payload };
        case 'SET_PROFILE':
            return { ...state, profile: action.payload };
        case 'SET_EDIT_LISTING_TYPE':
            return { ...state, editListingType: action.payload };
        case 'SET_EDIT_FIRST_NAME':
            return { ...state, editFirstName: action.payload };
        case 'SET_EDIT_GENDER':
            return { ...state, editGender: action.payload };
        case 'SET_EDIT_AGE':
            return { ...state, editAge: action.payload };
        case 'SET_EDIT_HAS_PARTNER':
            return { ...state, editHasPartner: action.payload };
        case 'SET_EDIT_PARTNER_DETAILS':
            return { ...state, editPartnerDetails: action.payload };
        case 'SET_EDIT_SKILLS':
            return { ...state, editSkills: action.payload };
        case 'SET_EDIT_EXPERIENCE':
            return { ...state, editExperience: action.payload };
        case 'SET_EDIT_REGION':
            return { ...state, editRegion: action.payload };
        case 'SET_EDIT_AVAIL_FROM':
            return { ...state, editAvailFrom: action.payload };
        case 'SET_EDIT_AVAIL_TO':
            return { ...state, editAvailTo: action.payload };
        case 'SET_EDIT_BIO':
            return { ...state, editBio: action.payload };
        case 'SET_EDIT_VIBE':
            return { ...state, editVibe: action.payload };
        case 'SET_EDIT_LANGUAGES':
            return { ...state, editLanguages: action.payload };
        case 'SET_EDIT_SMOKING':
            return { ...state, editSmoking: action.payload };
        case 'SET_EDIT_DRINKING':
            return { ...state, editDrinking: action.payload };
        case 'SET_EDIT_PETS':
            return { ...state, editPets: action.payload };
        case 'SET_EDIT_INTERESTS':
            return { ...state, editInterests: action.payload };
        case 'SET_EDIT_LOCATION_CITY':
            return { ...state, editLocationCity: action.payload };
        case 'SET_EDIT_LOCATION_STATE':
            return { ...state, editLocationState: action.payload };
        case 'SET_EDIT_LOCATION_COUNTRY':
            return { ...state, editLocationCountry: action.payload };
        case 'SET_SAVING':
            return { ...state, saving: action.payload };
        case 'SET_SAVED':
            return { ...state, saved: action.payload };
        case 'SET_EDIT_PHOTOS':
            return { ...state, editPhotos: action.payload };
        case 'SET_UPLOADING_PHOTO_IDX':
            return { ...state, uploadingPhotoIdx: action.payload };
        case 'SET_PHOTO_ERROR':
            return { ...state, photoError: action.payload };
        case 'SET_PENDING_PHOTO_IDX':
            return { ...state, pendingPhotoIdx: action.payload };
        case 'SET_SHOW_DELETE_CONFIRM':
            return { ...state, showDeleteConfirm: action.payload };
        case 'SET_DELETING':
            return { ...state, deleting: action.payload };
        case 'SET_SHOW_PREVIEW':
            return { ...state, showPreview: action.payload };
        case 'SET_KB_HEIGHT':
            return { ...state, kbHeight: action.payload };
        case 'SET_CURRENT_CARD_INDEX':
            return { ...state, currentCardIndex: action.payload };
        case 'SET_CARD_PHOTO_INDEX':
            return { ...state, cardPhotoIndex: action.payload };
        case 'SET_SWIPE_X':
            return { ...state, swipeX: action.payload };
        case 'SET_SWIPE_DIRECTION':
            return { ...state, swipeDirection: action.payload };
        case 'SET_IS_ANIMATING':
            return { ...state, isAnimating: action.payload };
        case 'SET_LIKED_USERS':
            return { ...state, likedUsers: action.payload };
        case 'SET_MESSAGED_USERS':
            return { ...state, messagedUsers: action.payload };

        // ── Batch actions (perf: N re-renders → 1) ──

        case 'CLEAR_FILTERS':
            // Was 10 setState calls → 1 dispatch
            return {
                ...state,
                filterListingType: '',
                filterGender: '',
                filterAgeRanges: [],
                filterSkills: [],
                filterExperience: '',
                filterRegion: '',
                filterLocationCountry: '',
                filterLocationState: '',
                filterLocationCity: '',
                filters: {},
                showFilters: false,
            };

        case 'RESET_PROFILE':
            // handleDeleteProfile was 23 setState calls → 1 dispatch
            return {
                ...state,
                profile: {},
                editListingType: '',
                editFirstName: '',
                editGender: '',
                editAge: '',
                editVibe: [],
                editLanguages: [],
                editSmoking: '',
                editDrinking: '',
                editPets: '',
                editInterests: [],
                editHasPartner: false,
                editPartnerDetails: '',
                editSkills: [],
                editExperience: '',
                editRegion: '',
                editAvailFrom: '',
                editAvailTo: '',
                editBio: '',
                editLocationCity: '',
                editLocationState: '',
                editLocationCountry: '',
                editPhotos: [],
                deleting: false,
                showDeleteConfirm: false,
                view: 'board',
            };

        case 'LOAD_PROFILE':
            // loadProfile was 22 setState calls → 1 dispatch
            return {
                ...state,
                profile: action.payload,
                editListingType: action.payload.listing_type || '',
                editFirstName: action.payload.first_name || '',
                editGender: action.payload.gender || '',
                editAge: action.payload.age_range || '',
                editHasPartner: action.payload.has_partner || false,
                editPartnerDetails: action.payload.partner_details || '',
                editSkills: action.payload.skills || [],
                editExperience: action.payload.sailing_experience || '',
                editRegion: action.payload.sailing_region || '',
                editAvailFrom: action.payload.available_from || '',
                editAvailTo: action.payload.available_to || '',
                editBio: action.payload.bio || '',
                editVibe: action.payload.vibe || [],
                editLanguages: action.payload.languages || [],
                editSmoking: action.payload.smoking || '',
                editDrinking: action.payload.drinking || '',
                editPets: action.payload.pets || '',
                editInterests: action.payload.interests || [],
                editLocationCity: action.payload.location_city || '',
                editLocationState: action.payload.location_state || '',
                editLocationCountry: action.payload.location_country || '',
                editPhotos: action.payload.photos?.length
                    ? action.payload.photos
                    : action.payload.photo_url
                      ? [action.payload.photo_url]
                      : [],
            };

        case 'SWIPE_ANIMATE':
            return { ...state, isAnimating: true, swipeDirection: action.payload.direction };

        case 'SWIPE_COMPLETE':
            return {
                ...state,
                currentCardIndex: action.payload.newIndex,
                cardPhotoIndex: 0,
                swipeDirection: null,
                swipeX: 0,
                isAnimating: false,
            };

        case 'GO_TO_START':
            return { ...state, currentCardIndex: 0, cardPhotoIndex: 0, swipeDirection: null, swipeX: 0 };

        case 'REMOVE_LISTING':
            return { ...state, listings: state.listings.filter((l) => l.user_id !== action.payload) };

        default:
            return state;
    }
}

// ── Hook ─────────────────────────────────────────────────────────

export function useCrewFinderState() {
    // Initialise likedUsers and messagedUsers from localStorage
    const [state, dispatch] = useReducer(crewFinderReducer, initialState, (init) => {
        let likedUsers = new Set<string>();
        let messagedUsers = new Set<string>();
        try {
            const saved = localStorage.getItem('crew_liked_users');
            if (saved) likedUsers = new Set(JSON.parse(saved));
        } catch {
            /* empty */
        }
        try {
            const saved = localStorage.getItem('crew_messaged_users');
            if (saved) messagedUsers = new Set(JSON.parse(saved));
        } catch {
            /* empty */
        }
        return { ...init, likedUsers, messagedUsers };
    });

    return { state, dispatch };
}
