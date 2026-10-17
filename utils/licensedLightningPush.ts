/** Only original licensed pulses with a short queue expiry may be presented as recent. */
export function isCurrentLightningNotice(value: unknown, now = Date.now()): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    return (
        data.provider === 'xweather' &&
        (data.type === 'lightning_nearby' || data.notification_type === 'lightning_nearby') &&
        (data.type === undefined || data.type === 'lightning_nearby') &&
        (data.notification_type === undefined || data.notification_type === 'lightning_nearby') &&
        typeof data.pulse_id === 'string' &&
        /^[A-Za-z0-9_-]{1,80}$/.test(data.pulse_id) &&
        typeof data.source_at === 'number' &&
        Number.isSafeInteger(data.source_at) &&
        data.source_at > 0 &&
        typeof data.expires_at === 'number' &&
        Number.isSafeInteger(data.expires_at) &&
        data.source_at <= now &&
        now - data.source_at <= 300000 &&
        data.expires_at > now &&
        data.expires_at <= data.source_at + 300000
    );
}
