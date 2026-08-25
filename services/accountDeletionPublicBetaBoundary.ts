/**
 * Public-beta boundary for destructive account deletion.
 *
 * The complete deletion implementation remains in source for review and later
 * activation. Production builds take this exact flag from the committed
 * public-beta feature profile, which keeps the UI and service fail-closed until
 * the durable server tombstone/write fences, survivor scrubs, deployment, and
 * authenticated live smoke have all passed.
 */
export const ACCOUNT_DELETION_PUBLIC_BETA_ENABLED = import.meta.env.VITE_ACCOUNT_DELETION_ENABLED === 'true';

export const ACCOUNT_DELETION_PRIVACY_EMAIL = 'privacy@thalassawx.com';

export const ACCOUNT_DELETION_PUBLIC_BETA_UNAVAILABLE_MESSAGE =
    'Account deletion is temporarily unavailable while its deletion safety controls are completed and verified. ' +
    `To request deletion during this beta, email ${ACCOUNT_DELETION_PRIVACY_EMAIL}.`;

export const ACCOUNT_DELETION_PRIVACY_MAILTO = `mailto:${ACCOUNT_DELETION_PRIVACY_EMAIL}?subject=${encodeURIComponent('Thalassa public beta account deletion request')}`;
