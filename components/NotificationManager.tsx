
import React, { useEffect, useRef } from 'react';
import { useThalassa } from '../context/ThalassaContext';

interface NotificationManagerProps {
    onNotify: (message: string) => void;
}

export const NotificationManager: React.FC<NotificationManagerProps> = ({ onNotify }) => {
    const { weatherData, settings } = useThalassa();
    const lastAlertTime = useRef<number>(0);
    const alertedConditions = useRef<Set<string>>(new Set());

    useEffect(() => {
        // Only proceed if data available. 
        // Note: We do NOT block on Notification.permission here so in-app toasts still work.
        if (!weatherData || !weatherData.current) return;

        // Prevent spam: Check periodically or on significant change
        const now = Date.now();
        // Reset alerted set if data is stale (e.g., > 1 hour) or new data fetched
        if (now - lastAlertTime.current > 60 * 60 * 1000) {
            alertedConditions.current.clear();
        }

        const { current } = weatherData;
        const { notifications } = settings;

        const checkAndNotify = (id: string, title: string, body: string) => {
            if (!alertedConditions.current.has(id)) {
                // 1. In-App Notification (Toast)
                onNotify(title);

                // 2. System Notification (if granted)
                if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    new Notification(title, {
                        body,
                        icon: 'https://cdn-icons-png.flaticon.com/512/567/567055.png'
                    });
                }
                
                alertedConditions.current.add(id);
                lastAlertTime.current = Date.now();
            }
        };

        // 1. Wind Alert
        if (notifications.wind.enabled && notifications.wind.threshold) {
            if (current.windSpeed && current.windSpeed >= notifications.wind.threshold) {
                checkAndNotify(
                    'wind', 
                    `High Wind Alert: ${current.windSpeed}kts`, 
                    `Wind speed at ${weatherData.locationName} has exceeded your ${notifications.wind.threshold}kts threshold.`
                );
            }
        }

        // 2. Wave Alert
        if (notifications.waves.enabled && notifications.waves.threshold) {
            if (current.waveHeight && current.waveHeight >= notifications.waves.threshold) {
                checkAndNotify(
                    'waves',
                    `High Surf Advisory: ${current.waveHeight}ft`,
                    `Wave height at ${weatherData.locationName} is above your ${notifications.waves.threshold}ft limit.`
                );
            }
        }

        // 3. Precip Alert
        if (notifications.precipitation.enabled) {
            if (current.condition && (current.condition.toLowerCase().includes('rain') || current.condition.toLowerCase().includes('storm'))) {
                checkAndNotify(
                    'precip',
                    `Precipitation Detected`,
                    `Current conditions at ${weatherData.locationName}: ${current.condition}`
                );
            }
        }

    }, [weatherData, settings.notifications, onNotify]);

    return null; // Headless component
};
