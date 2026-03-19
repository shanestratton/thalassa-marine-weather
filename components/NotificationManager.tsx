import React, { useEffect, useRef } from 'react';
import { useThalassa } from '../context/ThalassaContext';
import { supabase } from '../services/supabase';
import { createLogger } from '../utils/logger';

const log = createLogger('NotifMgr');

interface NotificationManagerProps {
    onNotify: (message: string) => void;
}

export const NotificationManager: React.FC<NotificationManagerProps> = ({ onNotify }) => {
    const { weatherData, settings, user } = useThalassa();
    const lastAlertTime = useRef<number>(0);
    const alertedConditions = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!weatherData || !weatherData.current) return;

        const now = Date.now();
        // Reset alerted set after 1 hour to allow re-alerting
        if (now - lastAlertTime.current > 60 * 60 * 1000) {
            alertedConditions.current.clear();
        }

        const { current } = weatherData;
        const { notifications } = settings;

        /**
         * Check threshold and fire both in-app + push notification.
         * In-app toast always fires; push is queued to push_notification_queue
         * so the send-push Edge Function delivers it via APNs even when backgrounded.
         */
        const checkAndNotify = (id: string, title: string, body: string) => {
            if (alertedConditions.current.has(id)) return;

            // 1. In-App Toast (always)
            onNotify(title);

            // 2. Browser Notification (web fallback)
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(title, {
                    body,
                    icon: 'https://cdn-icons-png.flaticon.com/512/567/567055.png',
                });
            }

            // 3. Queue for APNs push delivery (so it arrives when app is backgrounded)
            if (supabase && user?.id) {
                supabase
                    .from('push_notification_queue')
                    .insert({
                        recipient_user_id: user.id,
                        notification_type: 'weather_alert',
                        title,
                        body,
                        data: {
                            alert_type: id,
                            location: weatherData.locationName || 'Unknown',
                        },
                    })
                    .then(({ error }) => {
                        if (error) log.warn('Push queue insert failed:', error.message);
                        else log.info('Weather alert queued for push:', id);
                    });
            }

            alertedConditions.current.add(id);
            lastAlertTime.current = Date.now();
        };

        // — Wind Alert
        if (notifications.wind.enabled && notifications.wind.threshold) {
            if (current.windSpeed && current.windSpeed >= notifications.wind.threshold) {
                checkAndNotify(
                    'wind',
                    `🌬 High Wind Alert: ${current.windSpeed}kts`,
                    `Wind speed at ${weatherData.locationName} has exceeded your ${notifications.wind.threshold}kts threshold.`,
                );
            }
        }

        // — Gust Alert
        if (notifications.gusts.enabled && notifications.gusts.threshold) {
            if (current.windGust && current.windGust >= notifications.gusts.threshold) {
                checkAndNotify(
                    'gusts',
                    `💨 Gust Alert: ${Math.round(current.windGust)}kts`,
                    `Wind gusts at ${weatherData.locationName} have exceeded your ${notifications.gusts.threshold}kts threshold.`,
                );
            }
        }

        // — Wave Alert
        if (notifications.waves.enabled && notifications.waves.threshold) {
            if (current.waveHeight && current.waveHeight >= notifications.waves.threshold) {
                checkAndNotify(
                    'waves',
                    `🌊 High Surf Advisory: ${current.waveHeight}ft`,
                    `Wave height at ${weatherData.locationName} is above your ${notifications.waves.threshold}ft limit.`,
                );
            }
        }

        // — Swell Period Alert
        if (notifications.swellPeriod.enabled && notifications.swellPeriod.threshold) {
            if (current.swellPeriod && current.swellPeriod >= notifications.swellPeriod.threshold) {
                checkAndNotify(
                    'swellPeriod',
                    `🌊 Long Period Swell: ${current.swellPeriod}s`,
                    `Swell period at ${weatherData.locationName} has exceeded your ${notifications.swellPeriod.threshold}s threshold.`,
                );
            }
        }

        // — Low Visibility Alert
        if (notifications.visibility.enabled && notifications.visibility.threshold) {
            if (current.visibility != null && current.visibility <= notifications.visibility.threshold) {
                checkAndNotify(
                    'visibility',
                    `🌫️ Low Visibility: ${current.visibility}NM`,
                    `Visibility at ${weatherData.locationName} has dropped below your ${notifications.visibility.threshold}NM threshold.`,
                );
            }
        }

        // — UV Index Alert
        if (notifications.uv.enabled && notifications.uv.threshold) {
            if (current.uvIndex != null && current.uvIndex >= notifications.uv.threshold) {
                checkAndNotify(
                    'uv',
                    `☀️ High UV: Index ${current.uvIndex}`,
                    `UV index at ${weatherData.locationName} has reached ${current.uvIndex}, above your ${notifications.uv.threshold} threshold.`,
                );
            }
        }

        // — Temperature High Alert
        if (notifications.tempHigh.enabled && notifications.tempHigh.threshold) {
            if (current.airTemperature != null && current.airTemperature >= notifications.tempHigh.threshold) {
                checkAndNotify(
                    'tempHigh',
                    `🌡️ Heat Alert: ${Math.round(current.airTemperature)}°`,
                    `Temperature at ${weatherData.locationName} has exceeded your ${notifications.tempHigh.threshold}° threshold.`,
                );
            }
        }

        // — Temperature Low Alert
        if (notifications.tempLow.enabled && notifications.tempLow.threshold) {
            if (current.airTemperature != null && current.airTemperature <= notifications.tempLow.threshold) {
                checkAndNotify(
                    'tempLow',
                    `🥶 Freeze Alert: ${Math.round(current.airTemperature)}°`,
                    `Temperature at ${weatherData.locationName} has dropped below your ${notifications.tempLow.threshold}° threshold.`,
                );
            }
        }

        // — Precipitation Alert
        if (notifications.precipitation.enabled) {
            if (
                current.condition &&
                (current.condition.toLowerCase().includes('rain') || current.condition.toLowerCase().includes('storm'))
            ) {
                checkAndNotify(
                    'precip',
                    `🌧 Precipitation Detected`,
                    `Current conditions at ${weatherData.locationName}: ${current.condition}`,
                );
            }
        }
    }, [weatherData, settings.notifications, onNotify, user?.id]);

    return null; // Headless component
};
