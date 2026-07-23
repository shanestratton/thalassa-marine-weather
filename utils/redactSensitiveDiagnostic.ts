/**
 * Remove bearer credentials from diagnostic text before it reaches a durable
 * store or a console. This is deliberately conservative: diagnostics do not
 * need the value of an OAuth token, API key, DRM session, or password.
 */
export function redactSensitiveDiagnostic(value: string): string {
    return value
        .replace(
            /([?&;](?:access_token|refresh_token|id_token|token|ticket|api[-_]?key|apikey|key|code|code_verifier|client_secret|password|session(?:id)?|sid)=)[^&#\s"'<>)]*/gi,
            '$1[REDACTED]',
        )
        .replace(/(\/tokens\/)[^/?#\s"'<>)]*/gi, '$1[REDACTED]')
        .replace(
            /(["'](?:access_token|refresh_token|id_token|token|ticket|api[-_]?key|apikey|key|code|code_verifier|client_secret|password|session(?:id)?|sid)["']\s*:\s*["'])[^"']*(["'])/gi,
            '$1[REDACTED]$2',
        )
        .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
        .replace(/\b((?:session(?:id)?|sid)\s*=\s*)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}
