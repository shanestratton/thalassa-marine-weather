export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const LINK_OR_MARKUP = /[<>]|https?:\/\/|www\.|javascript:|data:/iu;
export interface GuestCommentInput {
    handle: string;
    entryId: string;
    submissionId: string;
    guestName: string;
    body: string;
    honeypot: boolean;
}
export function validCommentTarget(handle: unknown, entryId: unknown): boolean {
    return typeof handle === 'string' && handle.length <= 120 && HANDLE.test(handle) && typeof entryId === 'string' &&
        UUID.test(entryId);
}
export function validateGuestComment(value: Record<string, unknown>): GuestCommentInput | null {
    if (
        !validCommentTarget(value.handle, value.entry_id) || typeof value.submission_id !== 'string' ||
        !UUID.test(value.submission_id)
    ) return null;
    if (
        typeof value.guest_name !== 'string' || typeof value.body !== 'string' ||
        (value.website !== undefined && typeof value.website !== 'string')
    ) return null;
    const guestName = value.guest_name.trim();
    const body = value.body.replace(/\r\n?/gu, '\n').trim();
    if (
        [...guestName].length < 1 || [...guestName].length > 60 || [...body].length < 1 || [...body].length > 2000 ||
        CONTROL.test(guestName) || /[\r\n\t]/u.test(guestName) || CONTROL.test(body) ||
        LINK_OR_MARKUP.test(guestName) || LINK_OR_MARKUP.test(body)
    ) return null;
    return {
        handle: value.handle as string,
        entryId: value.entry_id as string,
        submissionId: value.submission_id,
        guestName,
        body,
        honeypot: typeof value.website === 'string' && value.website.trim().length > 0,
    };
}
