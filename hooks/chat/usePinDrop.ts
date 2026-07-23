/**
 * usePinDrop — Extracted from ChatPage.
 * Manages pin drop, POI picker, GPS position, and sending pin/POI messages.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatService, ChatMessage, type ChatMessageSendResult } from '../../services/ChatService';
import { BgGeoManager } from '../../services/BgGeoManager';
import { PinService, SavedPin } from '../../services/PinService';
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

export interface UsePinDropOptions {
    activeChannel: { id: string } | null;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setMessageText: (text: string) => void;
    messageEndRef: React.RefObject<HTMLDivElement | null>;
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
    const { activeChannel, setMessages, setMessageText, messageEndRef } = options;

    // --- State ---
    const [showAttachMenu, setShowAttachMenu] = useState(false);
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [showPoiSheet, setShowPoiSheet] = useState(false);
    const [pinLat, setPinLat] = useState(0);
    const [pinLng, setPinLng] = useState(0);
    const [pinCaption, setPinCaption] = useState('');
    const [pinLoading, setPinLoading] = useState(false);
    const [savedPins, setSavedPins] = useState<SavedPin[]>([]);
    const [searchingPoi, setSearchingPoi] = useState(false);

    // POI map refs
    const poiMapRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poiMapInstance = useRef<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poiMarkerRef = useRef<any>(null);
    const poiMapInitialized = useRef(false);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                setShowAttachMenu(false);
                setShowPinSheet(false);
                setShowPoiSheet(false);
                setPinLat(0);
                setPinLng(0);
                setPinCaption('');
                setPinLoading(false);
                setSavedPins([]);
                setSearchingPoi(false);
                poiMapInstance.current?.remove();
                poiMapInstance.current = null;
                poiMarkerRef.current = null;
                poiMapInitialized.current = false;
            }),
        [],
    );

    // Snap the marker back to the user's current GPS position.
    // Bound from the floating "📍" button on the POI sheet.
    const recenterPoiToMyLocation = useCallback(async () => {
        const identity = getAuthIdentityScope();
        try {
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 8 });
            if (!pos || !isAuthIdentityScopeCurrent(identity)) return;
            setPinLat(pos.latitude);
            setPinLng(pos.longitude);
            if (poiMarkerRef.current && poiMapInstance.current) {
                poiMarkerRef.current.setLngLat([pos.longitude, pos.latitude]);
                poiMapInstance.current.flyTo({ center: [pos.longitude, pos.latitude], zoom: 14 });
            }
        } catch (e) {
            log.warn('recenter to my location failed:', e);
        }
    }, []);

    // Forward-geocode a place name and pan the map there. Mapbox
    // Geocoding (the same one parseLocation uses) returns multiple
    // candidates; we take the first.
    const searchPoiLocation = useCallback(async (query: string) => {
        if (!query.trim()) return;
        const identity = getAuthIdentityScope();
        setSearchingPoi(true);
        try {
            const { parseLocation } = await import('../../services/weather/api/geocoding');
            if (!isAuthIdentityScopeCurrent(identity)) return;
            const result = await parseLocation(query.trim());
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (result.lat === 0 && result.lon === 0) {
                log.info(`no geocode result for "${query}"`);
                return;
            }
            setPinLat(result.lat);
            setPinLng(result.lon);
            if (poiMarkerRef.current && poiMapInstance.current) {
                poiMarkerRef.current.setLngLat([result.lon, result.lat]);
                poiMapInstance.current.flyTo({ center: [result.lon, result.lat], zoom: 14 });
            }
        } catch (e) {
            log.warn('search failed:', e);
        } finally {
            if (isAuthIdentityScopeCurrent(identity)) setSearchingPoi(false);
        }
    }, []);

    // --- Pin Drop ---
    const openPinDrop = useCallback(async () => {
        const identity = getAuthIdentityScope();
        setShowAttachMenu(false);
        setPinLoading(true);
        setPinCaption('');
        setShowPinSheet(true);

        PinService.getMyPins(15)
            .then((pins) => {
                if (isAuthIdentityScopeCurrent(identity)) setSavedPins(pins);
            })
            .catch((e) => {
                console.warn(`[usePinDrop]`, e);
            });

        try {
            const pos = BgGeoManager.getLastPosition();
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (pos) {
                setPinLat(pos.latitude);
                setPinLng(pos.longitude);
            } else {
                const freshPos = await BgGeoManager.getFreshPosition(60000, 10);
                if (!isAuthIdentityScopeCurrent(identity)) return;
                if (freshPos) {
                    setPinLat(freshPos.latitude);
                    setPinLng(freshPos.longitude);
                } else {
                    setPinLat(-33.8568);
                    setPinLng(151.2153);
                }
            }
        } catch (e) {
            log.warn('GPS fallback:', e);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setPinLat(-33.8568);
            setPinLng(151.2153);
        }
        if (isAuthIdentityScopeCurrent(identity)) setPinLoading(false);
    }, []);

    const sendPin = useCallback(async () => {
        if (!activeChannel) return;
        const identity = getAuthIdentityScope();
        const caption = pinCaption.trim();
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|[LOC] ${caption || 'My Location'}`;
        setShowPinSheet(false);
        setPinCaption('');
        setMessageText('');

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
        setMessages((prev) => [...prev, optimistic]);
        const result = await ChatService.sendMessage(activeChannel.id, text, false).catch(() => null);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        setMessages((prev) => reconcileOptimisticMessage(prev, optimistic.id, result));
        if (!result) {
            setShowPinSheet(true);
            setPinCaption(caption);
            toast.error("Pin wasn't sent. Its caption has been restored.");
            return;
        }
        if (result === 'queued') {
            toast.info('Pin queued — it will send when the connection returns.');
        }

        PinService.savePin({
            latitude: pinLat,
            longitude: pinLng,
            caption: caption || 'Dropped a pin',
        }).catch((e) => {
            console.warn(`[usePinDrop]`, e);
        });

        setTimeout(() => {
            if (isAuthIdentityScopeCurrent(identity)) {
                messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }
        }, 50);
    }, [activeChannel, pinLat, pinLng, pinCaption, setMessages, setMessageText, messageEndRef]);

    // --- POI Picker ---
    const openPoiPicker = useCallback(() => {
        const identity = getAuthIdentityScope();
        setShowAttachMenu(false);
        setShowPoiSheet(true);
        setPinCaption('');
        setPinLoading(true);
        GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 8 }).then((pos) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (pos) {
                setPinLat(pos.latitude);
                setPinLng(pos.longitude);
            } else {
                setPinLat(-27.4698);
                setPinLng(153.0251);
            }
            setPinLoading(false);
        });
    }, []);

    const sendPoi = useCallback(async () => {
        if (!activeChannel) return;
        const identity = getAuthIdentityScope();
        const caption = pinCaption.trim();
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|[POI] ${caption || 'Point of interest'}`;
        setShowPoiSheet(false);
        setPinCaption('');
        setMessageText('');

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
        setMessages((prev) => [...prev, optimistic]);
        const result = await ChatService.sendMessage(activeChannel.id, text, false).catch(() => null);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        setMessages((prev) => reconcileOptimisticMessage(prev, optimistic.id, result));
        if (!result) {
            setShowPoiSheet(true);
            setPinCaption(caption);
            toast.error("Point of interest wasn't sent. Its caption has been restored.");
            return;
        }
        if (result === 'queued') {
            toast.info('Point of interest queued — it will send when the connection returns.');
        }

        PinService.savePin({
            latitude: pinLat,
            longitude: pinLng,
            caption: caption || 'Point of interest',
        }).catch((e) => {
            console.warn(`[usePinDrop]`, e);
        });

        setTimeout(() => {
            if (isAuthIdentityScopeCurrent(identity)) {
                messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }
        }, 50);
    }, [activeChannel, pinLat, pinLng, pinCaption, setMessages, setMessageText, messageEndRef]);

    // --- POI Map Init/Cleanup ---
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

        import('mapbox-gl').then((mapboxgl) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (!poiMapRef.current || poiMapInstance.current) return;
            const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
            if (!token || token.length < 10) return;

            mapboxgl.default.accessToken = token;
            const map = new mapboxgl.default.Map({
                container: poiMapRef.current,
                style: 'mapbox://styles/mapbox/navigation-night-v1',
                center: [pinLng, pinLat],
                zoom: 12,
                attributionControl: false,
            });
            map.addControl(new mapboxgl.default.NavigationControl({ showCompass: false }), 'top-right');

            const marker = new mapboxgl.default.Marker({ color: '#38bdf8', draggable: true })
                .setLngLat([pinLng, pinLat])
                .addTo(map);
            poiMarkerRef.current = marker;

            marker.on('dragend', () => {
                if (!isAuthIdentityScopeCurrent(identity)) return;
                const lngLat = marker.getLngLat();
                setPinLat(lngLat.lat);
                setPinLng(lngLat.lng);
            });
            map.on('click', (e) => {
                if (!isAuthIdentityScopeCurrent(identity)) return;
                marker.setLngLat(e.lngLat);
                setPinLat(e.lngLat.lat);
                setPinLng(e.lngLat.lng);
            });
            poiMapInstance.current = map;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showPoiSheet, pinLoading]);

    useEffect(() => {
        if (!showPoiSheet && poiMapInstance.current) {
            poiMapInstance.current.remove();
            poiMapInstance.current = null;
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
        savedPins,
        poiMapRef,
        searchingPoi,

        // Actions
        openPinDrop,
        sendPin,
        openPoiPicker,
        sendPoi,
        recenterPoiToMyLocation,
        searchPoiLocation,
    };
}
