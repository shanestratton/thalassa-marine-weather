/**
 * usePinDrop — Extracted from ChatPage.
 * Manages pin drop, POI picker, GPS position, and sending pin/POI messages.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatService, ChatMessage } from '../../services/ChatService';
import { BgGeoManager } from '../../services/BgGeoManager';
import { PinService, SavedPin } from '../../services/PinService';
import { GpsService } from '../../services/GpsService';
import { createLogger } from '../../utils/createLogger';
import { PIN_PREFIX } from '../../components/chat/chatUtils';

const log = createLogger('usePinDrop');

export interface UsePinDropOptions {
    activeChannel: { id: string } | null;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setMessageText: (text: string) => void;
    messageEndRef: React.RefObject<HTMLDivElement | null>;
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

    // POI map refs
    const poiMapRef = useRef<HTMLDivElement>(null);
    const poiMapInstance = useRef<any>(null);
    const poiMarkerRef = useRef<any>(null);
    const poiMapInitialized = useRef(false);

    // --- Pin Drop ---
    const openPinDrop = useCallback(async () => {
        setShowAttachMenu(false);
        setPinLoading(true);
        setPinCaption('');
        setShowPinSheet(true);

        PinService.getMyPins(15).then(pins => setSavedPins(pins)).catch(() => { });

        try {
            const pos = BgGeoManager.getLastPosition();
            if (pos) {
                setPinLat(pos.latitude);
                setPinLng(pos.longitude);
            } else {
                const freshPos = await BgGeoManager.getFreshPosition(60000, 10);
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
            setPinLat(-33.8568);
            setPinLng(151.2153);
        }
        setPinLoading(false);
    }, []);

    const sendPin = useCallback(async () => {
        if (!activeChannel) return;
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|[LOC] ${pinCaption.trim() || 'My Location'}`;
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
        };
        setMessages(prev => [...prev, optimistic]);
        await ChatService.sendMessage(activeChannel.id, text, false);

        PinService.savePin({
            latitude: pinLat,
            longitude: pinLng,
            caption: pinCaption.trim() || 'Dropped a pin',
        }).catch(() => { });

        setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }, [activeChannel, pinLat, pinLng, pinCaption, setMessages, setMessageText, messageEndRef]);

    // --- POI Picker ---
    const openPoiPicker = useCallback(() => {
        setShowAttachMenu(false);
        setShowPoiSheet(true);
        setPinCaption('');
        setPinLoading(true);
        GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 8 }).then((pos) => {
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
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|[POI] ${pinCaption.trim() || 'Point of interest'}`;
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
        };
        setMessages(prev => [...prev, optimistic]);
        await ChatService.sendMessage(activeChannel.id, text, false);

        PinService.savePin({
            latitude: pinLat,
            longitude: pinLng,
            caption: pinCaption.trim() || 'Point of interest',
        }).catch(() => { });

        setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }, [activeChannel, pinLat, pinLng, pinCaption, setMessages, setMessageText, messageEndRef]);

    // --- POI Map Init/Cleanup ---
    useEffect(() => {
        if (!showPoiSheet || pinLoading || !poiMapRef.current) return;
        if (poiMapInitialized.current) return;
        poiMapInitialized.current = true;

        if (!document.querySelector('link[href*="mapbox-gl"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.9.4/mapbox-gl.css';
            document.head.appendChild(link);
        }

        import('mapbox-gl').then((mapboxgl) => {
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
                const lngLat = marker.getLngLat();
                setPinLat(lngLat.lat);
                setPinLng(lngLat.lng);
            });
            map.on('click', (e) => {
                marker.setLngLat(e.lngLat);
                setPinLat(e.lngLat.lat);
                setPinLng(e.lngLat.lng);
            });
            poiMapInstance.current = map;
        });
    }, [showPoiSheet, pinLoading]); // eslint-disable-line react-hooks/exhaustive-deps

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
        showAttachMenu, setShowAttachMenu,
        showPinSheet, setShowPinSheet,
        showPoiSheet, setShowPoiSheet,
        pinLat, setPinLat,
        pinLng, setPinLng,
        pinCaption, setPinCaption,
        pinLoading,
        savedPins,
        poiMapRef,

        // Actions
        openPinDrop,
        sendPin,
        openPoiPicker,
        sendPoi,
    };
}
