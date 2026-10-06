/**
 * BreakableEmail — an email address that wraps where a reader expects it to.
 *
 * At 320 px a crew card titled by its email broke mid-domain
 * ("sam.hollis@example.co" with a lone "m" below), which reads like a typo in
 * the address. The address now breaks after its "@", the way mail apps wrap
 * one, and the domain moves to the next line whole ("sam.hollis@" /
 * "example.com"): a domain has no break point of its own. Only a domain too
 * long to fit a phone card's line also gets one before its last "."; the
 * title's CSS (overflow-wrap: break-word) splits a part only when that part
 * alone is still too wide.
 *
 * Every piece stays a plain text node of the caller's element (no wrapping
 * element), so a screen reader, a copy and getByText all read the address
 * unchanged and in one piece.
 */
import React from 'react';

/** Longer than this, a domain will not fit a 320 px card's title line. */
const LONG_DOMAIN = 18;

export const BreakableEmail: React.FC<{ email: string }> = ({ email }) => {
    const at = email.indexOf('@');
    if (at <= 0) return <>{email}</>;
    const local = email.slice(0, at + 1);
    const domain = email.slice(at + 1);
    const dot = domain.length > LONG_DOMAIN ? domain.lastIndexOf('.') : -1;
    return (
        <>
            {local}
            <wbr />
            {dot > 0 ? (
                <>
                    {domain.slice(0, dot)}
                    <wbr />
                    {domain.slice(dot)}
                </>
            ) : (
                domain
            )}
        </>
    );
};
