/**
 * usePinDrop — Location sharing for channel chat.
 *
 * Current-location and place sharing deliberately use the same transport,
 * but they have different promises to the skipper: a current location is a
 * fresh GPS snapshot, while a place is deliberately chosen on the chart.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatService, ChatMessage, type ChatMessageSendResult } from '../../services/ChatService';
import { PinService, type SavedPin } from '../../services/PinService';
import { GpsService } from '../../services/GpsService';
import { createLogger } from '../../utils/createLogger';
import { PIN_PREFIX } from '../../components/chat/chatUtils';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { toast } from '../../components/Toast';

const log = createLogger('usePinDrop');

/** Source shown in the review sheet. `null` means the skipper has not selected a place yet. */
export type PinSelectionSource = 'current' | 'saved' | 'map' | 'search' | null;

const CURRENT_LOCATION_MAX_AGE_MS = 60_000;

export interface UsePinDropOptions {
    activeChannel: { id: string } | null;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    messageEndRef: React.RefObject<HTMLDivElement | null>;
}

/** A coordinate must be real before it is allowed into a public chat message. */
export function isValidPinCoordinate(latitude: number, longitude: number): boolean {
    return (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180
    );
}

function isFreshGpsPosition(
    position: {
        latitude: number;
        longitude: number;
        timestamp: number;
    } | null,
): boolean {
    if (!position || !isValidPinCoordinate(position.latitude, position.longitude)) return false;
    if (!Number.isFinite(position.timestamp)) return false;
    const age = Date.now() - position.timestamp;
    return age >= -5_000 && age <= CURRENT_LOCATION_MAX_AGE_MS;
}

function reconcileOptimisticMessage(
    messages: ChatMessage[],
    optimisticId: string,
    result: ChatMessageSendResult,
): ChatMessage[] {
    const optimisticIndex = messages.findIndex((message) => message.id === optimisticId);
    if (result === 'queued') {
        return optimisticIndex < 0
            ? messages
            : messages.map((message) =>
                  message.id === optimisticId ? { ...message, delivery_status: 'queued' } : message,
              );
    }
    if (!result) return optimisticIndex < 0 ? messages : messages.filter((message) => message.id !== optimisticId);
    if (optimisticIndex < 0) {
        return messages.some((message) => message.id === result.id) ? messages : [...messages, result];
    }
    const next = [...messages];
    next[optimisticIndex] = result;
    return next;
}

export function usePinDrop(options: UsePinDropOptions) {
    const { activeChannel, setMessages, messageEndRef } = options;

    // --- Sheet / selection state ---
    const [showAttachMenu, setShowAttachMenu] = useState(false);
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [showPoiSheet, setShowPoiSheet] = useState(false);
    const [pinLat, setPinLat] = useState(0);
    const [pinLng, setPinLng] = useState(0);
    const [pinCaption, setPinCaption] = useState('');
    const [pinLoading, setPinLoading] = useState(false);
    const [pinSource, setPinSource] = useState<PinSelectionSource>(null);
    const [pinAccuracy, setPinAccuracy] = useState<number | null>(null);
    const [pinTimestamp, setPinTimestamp] = useState<number | null>(null);
    const [locationError, setLocationError] = useState<string | null>(null);
    const [saveToMyPlaces, setSaveToMyPlaces] = useState(false);
    const [savedPins, setSavedPins] = useState<SavedPin[]>([]);
    const [searchingPoi, setSearchingPoi] = useState(false);
    const [sendingKind, setSendingKind] = useState<'current' | 'place' | null>(null);
    const shareInFlightRef = useRef(false);
    const placeSearchEpochRef = useRef(0);

    // POI map refs
    const poiMapRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poiMapInstance = useRef<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poiMapbox = useRef<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poiMarkerRef = useRef<any>(null);
    const poiMapInitialized = useRef(false);

    const clearSelection = useCallback(() => {
        setPinLat(0);
        setPinLng(0);
        setPinSource(null);
        setPinAccuracy(null);
        setPinTimestamp(null);
    }, []);

    const syncPoiMarker = useCallback((latitude: number, longitude: number, recenter = false) => {
        const map = poiMapInstance.current;
        const mapboxgl = poiMapbox.current;
        if (!map || !mapboxgl || !isValidPinCoordinate(latitude, longitude)) return;

        if (!poiMarkerRef.current) {
            poiMarkerRef.current = new mapboxgl.Marker({ color: '#38bdf8', draggable: true })
                .setLngLat([longitude, latitude])
                .addTo(map);
        } else {
            poiMarkerRef.current.setLngLat([longitude, latitude]);
        }
        if (recenter) map.flyTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 12) });
    }, []);

    const selectPoiPosition = useCallback(
        (
            latitude: number,
            longitude: number,
            source: Exclude<PinSelectionSource, null>,
            details: { accuracy?: number | null; timestamp?: number | null; recenter?: boolean } = {},
        ) => {
            if (!isValidPinCoordinate(latitude, longitude)) return false;
            setPinLat(latitude);
            setPinLng(longitude);
            setPinSource(source);
            setPinAccuracy(details.accuracy ?? null);
            setPinTimestamp(details.timestamp ?? null);
            setLocationError(null);
            syncPoiMarker(latitude, longitude, details.recenter === true);
            return true;
        },
        [syncPoiMarker],
    );

    const loadSavedPins = useCallback((identity = getAuthIdentityScope()) => {
        void PinService.getMyPins(15)
            .then((pins) => {
                if (isAuthIdentityScopeCurrent(identity)) setSavedPins(pins);
            })
            .catch((error) => {
                log.warn('could not load saved places:', error);
            });
    }, []);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                setShowAttachMenu(false);
                setShowPinSheet(false);
                setShowPoiSheet(false);
                clearSelection();
                setPinCaption('');
                setPinLoading(false);
                setPinAccuracy(null);
                setPinTimestamp(null);
                setLocationError(null);
                setSaveToMyPlaces(false);
                setSavedPins([]);
                setSearchingPoi(false);
                setSendingKind(null);
                shareInFlightRef.current = false;
                placeSearchEpochRef.current += 1;
                poiMapInstance.current?.remove();
                poiMapInstance.current = null;
                poiMapbox.current = null;
                poiMarkerRef.current = null;
                poiMapInitialized.current = false;
            }),
        [clearSelection],
    );

    const requestCurrentLocation = useCallback(
        async (identity = getAuthIdentityScope(), { preserveSelectionOnFailure = false } = {}) => {
            try {
                const position = await GpsService.requestCurrentForegroundPosition({
                    staleLimitMs: CURRENT_LOCATION_MAX_AGE_MS,
                    timeoutSec: 10,
                });
                if (!isAuthIdentityScopeCurrent(identity)) return false;
                if (!position || !isFreshGpsPosition(position)) {
                    if (!preserveSelectionOnFailure) clearSelection();
                    setLocationError(
                        "We couldn't get a fresh GPS fix. Check location permission, then try again or drop a place on the chart.",
                    );
                    return false;
                }

                return selectPoiPosition(position.latitude, position.longitude, 'current', {
                    accuracy: position.accuracy,
                    timestamp: position.timestamp,
                    recenter: true,
                });
            } catch (error) {
                log.warn('current location unavailable:', error);
                if (isAuthIdentityScopeCurrent(identity)) {
                    if (!preserveSelectionOnFailure) clearSelection();
                    setLocationError(
                        "We couldn't get a fresh GPS fix. Check location permission, then try again or drop a place on the chart.",
                    );
                }
                return false;
            }
        },
        [clearSelection, selectPoiPosition],
    );

    // --- Share my current location ---
    const openPinDrop = useCallback(async () => {
        const identity = getAuthIdentityScope();
        setShowAttachMenu(false);
        setShowPoiSheet(false);
        setShowPinSheet(true);
        setPinCaption('');
        setSaveToMyPlaces(false);
        setLocationError(null);
        clearSelection();
        setPinLoading(true);

        await requestCurrentLocation(identity);
        if (isAuthIdentityScopeCurrent(identity)) setPinLoading(false);
    }, [clearSelection, requestCurrentLocation]);

    const retryCurrentLocation = useCallback(async () => {
        const identity = getAuthIdentityScope();
        setPinLoading(true);
        setLocationError(null);
        clearSelection();
        await requestCurrentLocation(identity);
        if (isAuthIdentityScopeCurrent(identity)) setPinLoading(false);
    }, [clearSelection, requestCurrentLocation]);

    // --- Share a place ---
    const openPoiPicker = useCallback(async () => {
        const identity = getAuthIdentityScope();
        setShowAttachMenu(false);
        setShowPinSheet(false);
        setShowPoiSheet(true);
        setPinCaption('');
        setSaveToMyPlaces(false);
        setLocationError(null);
        clearSelection();
        setPinLoading(true);
        loadSavedPins(identity);

        await requestCurrentLocation(identity);
        if (isAuthIdentityScopeCurrent(identity)) setPinLoading(false);
    }, [clearSelection, loadSavedPins, requestCurrentLocation]);

    const selectSavedPin = useCallback(
        (savedPin: SavedPin) => {
            if (!selectPoiPosition(savedPin.latitude, savedPin.longitude, 'saved', { recenter: true })) return;
            setPinCaption(savedPin.caption);
            setSaveToMyPlaces(false);
        },
        [selectPoiPosition],
    );

    // Snap the place marker back to the user's current GPS position.
    const recenterPoiToMyLocation = useCallback(async () => {
        const identity = getAuthIdentityScope();
        setLocationError(null);
        const didFindLocation = await requestCurrentLocation(identity, { preserveSelectionOnFailure: true });
        if (!didFindLocation && isAuthIdentityScopeCurrent(identity)) {
            toast.error("We couldn't get your current location. You can still choose a spot on the chart.");
        }
    }, [requestCurrentLocation]);

    // Forward-geocode a place name and centre the map on the selected result.
    // The epoch means a slow, earlier search can never overwrite a newer one.
    const searchPoiLocation = useCallback(
        async (query: string) => {
            if (!query.trim()) return;
            const identity = getAuthIdentityScope();
            const searchEpoch = ++placeSearchEpochRef.current;
            setSearchingPoi(true);
            setLocationError(null);
            try {
                const { parseLocation } = await import('../../services/weather/api/geocoding');
                const result = await parseLocation(query.trim());
                if (!isAuthIdentityScopeCurrent(identity) || searchEpoch !== placeSearchEpochRef.current) return;
                if (!isValidPinCoordinate(result.lat, result.lon)) {
                    setLocationError('No matching place found. Try a more specific name or tap the chart.');
                    return;
                }
                selectPoiPosition(result.lat, result.lon, 'search', { recenter: true });
                setPinCaption((current) => current.trim() || result.name);
            } catch (error) {
                log.warn('place search failed:', error);
                if (isAuthIdentityScopeCurrent(identity) && searchEpoch === placeSearchEpochRef.current) {
                    setLocationError("We couldn't search for that place. Check your connection and try again.");
                }
            } finally {
                if (isAuthIdentityScopeCurrent(identity) && searchEpoch === placeSearchEpochRef.current) {
                    setSearchingPoi(false);
                }
            }
        },
        [selectPoiPosition],
    );

    const sendSharedPin = useCallback(
        async (kind: 'current' | 'place') => {
            if (!activeChannel) {
                toast.error('Choose a channel before sharing a location.');
                return;
            }
            if (!isValidPinCoordinate(pinLat, pinLng)) {
                toast.error(
                    kind === 'current'
                        ? 'A fresh GPS fix is needed before sharing.'
                        : 'Choose a place on the chart first.',
                );
                return;
            }
            if (shareInFlightRef.current) return;

            const identity = getAuthIdentityScope();
            const latitude = pinLat;
            const longitude = pinLng;
            const caption = pinCaption.trim();
            const defaultCaption = kind === 'current' ? 'Current location' : 'Dropped pin';
            const text = `${PIN_PREFIX}${latitude.toFixed(6)},${longitude.toFixed(6)}|${kind === 'current' ? '[LOC]' : '[POI]'} ${caption || defaultCaption}`;
            shareInFlightRef.current = true;
            setSendingKind(kind);

            const optimistic: ChatMessage = {
                id: `opt-${crypto.randomUUID()}`,
                channel_id: activeChannel.id,
                user_id: 'self',
                display_name: 'You',
                message: text,
                is_question: false,
                helpful_count: 0,
                is_pinned: false,
                deleted_at: null,
                created_at: new Date().toISOString(),
                delivery_status: 'sending',
            };

            try {
                setMessages((previous) => [...previous, optimistic]);
                const result = await ChatService.sendMessage(activeChannel.id, text, false).catch(() => null);
                if (!isAuthIdentityScopeCurrent(identity)) return;
                setMessages((previous) => reconcileOptimisticMessage(previous, optimistic.id, result));
                if (!result) {
                    kind === 'current' ? setShowPinSheet(true) : setShowPoiSheet(true);
                    toast.error(
                        kind === 'current'
                            ? "Location wasn't sent. Your note is still here."
                            : "Pin wasn't sent. Your note is still here.",
                    );
                    return;
                }

                if (result === 'queued') {
                    toast.info(
                        kind === 'current'
                            ? 'Location queued — it will send when the connection returns.'
                            : 'Pin queued — it will send when the connection returns.',
                    );
                }

                if (saveToMyPlaces) {
                    PinService.savePin({
                        latitude,
                        longitude,
                        caption: caption || defaultCaption,
                    }).catch((error) => {
                        log.warn('could not save shared place:', error);
                    });
                }

                setPinCaption('');
                setSaveToMyPlaces(false);
                kind === 'current' ? setShowPinSheet(false) : setShowPoiSheet(false);
                setTimeout(() => {
                    if (isAuthIdentityScopeCurrent(identity)) {
                        messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                    }
                }, 50);
            } finally {
                shareInFlightRef.current = false;
                if (isAuthIdentityScopeCurrent(identity)) setSendingKind(null);
            }
        },
        [activeChannel, messageEndRef, pinCaption, pinLat, pinLng, saveToMyPlaces, setMessages],
    );

    const sendPin = useCallback(() => sendSharedPin('current'), [sendSharedPin]);
    const sendPoi = useCallback(() => sendSharedPin('place'), [sendSharedPin]);

    // --- POI map init / cleanup ---
    useEffect(() => {
        if (!showPoiSheet || pinLoading || !poiMapRef.current) return;
        if (poiMapInitialized.current) return;
        const identity = getAuthIdentityScope();
        poiMapInitialized.current = true;

        if (!document.querySelector('link[href*="mapbox-gl"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.9.4/mapbox-gl.css';
            document.head.appendChild(link);
        }

        void import('mapbox-gl')
            .then((mapboxgl) => {
                if (!isAuthIdentityScopeCurrent(identity) || !poiMapRef.current || poiMapInstance.current) return;
                const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
                if (!token || token.length < 10) {
                    setLocationError('The chart picker is unavailable until its map key is configured.');
                    poiMapInitialized.current = false;
                    return;
                }

                mapboxgl.default.accessToken = token;
                poiMapbox.current = mapboxgl.default;
                const hasSelection = pinSource !== null && isValidPinCoordinate(pinLat, pinLng);
                const map = new mapboxgl.default.Map({
                    container: poiMapRef.current,
                    style: 'mapbox://styles/mapbox/navigation-night-v1',
                    center: hasSelection ? [pinLng, pinLat] : [0, 20],
                    zoom: hasSelection ? 12 : 1.75,
                    attributionControl: true,
                });
                map.addControl(new mapboxgl.default.NavigationControl({ showCompass: false }), 'top-right');

                const bindMarkerDrag = (marker: {
                    on: (event: string, listener: () => void) => void;
                    getLngLat: () => { lat: number; lng: number };
                    __thalassaPinDragBound?: boolean;
                }) => {
                    if (marker.__thalassaPinDragBound) return;
                    marker.__thalassaPinDragBound = true;
                    marker.on('dragend', () => {
                        if (!isAuthIdentityScopeCurrent(identity)) return;
                        const location = marker.getLngLat();
                        selectPoiPosition(location.lat, location.lng, 'map');
                    });
                };

                poiMapInstance.current = map;
                if (hasSelection) {
                    syncPoiMarker(pinLat, pinLng);
                    if (poiMarkerRef.current) bindMarkerDrag(poiMarkerRef.current);
                }

                map.on('click', (event) => {
                    if (!isAuthIdentityScopeCurrent(identity)) return;
                    selectPoiPosition(event.lngLat.lat, event.lngLat.lng, 'map');
                    if (poiMarkerRef.current) bindMarkerDrag(poiMarkerRef.current);
                });
            })
            .catch((error) => {
                log.warn('chart picker could not start:', error);
                if (isAuthIdentityScopeCurrent(identity)) {
                    setLocationError("We couldn't open the chart picker. You can still search for a place.");
                    poiMapInitialized.current = false;
                }
            });
        // The initial selection is intentionally read when the map opens. Later
        // selections use `selectPoiPosition`, which updates the live map marker.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showPoiSheet, pinLoading]);

    useEffect(() => {
        if (!showPoiSheet && poiMapInstance.current) {
            poiMapInstance.current.remove();
            poiMapInstance.current = null;
            poiMapbox.current = null;
            poiMarkerRef.current = null;
            poiMapInitialized.current = false;
        }
    }, [showPoiSheet]);

    return {
        // State
        showAttachMenu,
        setShowAttachMenu,
        showPinSheet,
        setShowPinSheet,
        showPoiSheet,
        setShowPoiSheet,
        pinLat,
        setPinLat,
        pinLng,
        setPinLng,
        pinCaption,
        setPinCaption,
        pinLoading,
        pinSource,
        pinAccuracy,
        pinTimestamp,
        locationError,
        saveToMyPlaces,
        setSaveToMyPlaces,
        savedPins,
        poiMapRef,
        searchingPoi,
        sendingKind,

        // Actions
        openPinDrop,
        retryCurrentLocation,
        sendPin,
        openPoiPicker,
        sendPoi,
        selectSavedPin,
        recenterPoiToMyLocation,
        searchPoiLocation,
    };
}
