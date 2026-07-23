import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

export const PASSAGE_ENHANCEMENT_START_EVENT = 'thalassa:passage-enhancement-start';
export const PASSAGE_ENHANCEMENT_END_EVENT = 'thalassa:passage-enhancement-end';

/**
 * Identity- and operation-owned token carried by every enhancement event.
 *
 * The operation id prevents a late `end` from an older calculation on the
 * same account from dismissing the chip for a newer calculation. The exact
 * auth generation also rejects events from a previous login of that account.
 */
export interface PassageEnhancementToken {
    readonly scopeKey: string;
    readonly generation: number;
    readonly operationId: string;
}

export function createPassageEnhancementToken(scope: AuthIdentityScope, operationId: string): PassageEnhancementToken {
    return Object.freeze({
        scopeKey: scope.key,
        generation: scope.generation,
        operationId,
    });
}

export function isPassageEnhancementTokenCurrent(
    token: PassageEnhancementToken,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): boolean {
    return token.scopeKey === scope.key && token.generation === scope.generation && isAuthIdentityScopeCurrent(scope);
}

export function readPassageEnhancementToken(event: Event): PassageEnhancementToken | null {
    if (!(event instanceof CustomEvent)) return null;
    const detail = event.detail as Partial<PassageEnhancementToken> | null;
    if (
        !detail ||
        typeof detail.scopeKey !== 'string' ||
        typeof detail.generation !== 'number' ||
        !Number.isSafeInteger(detail.generation) ||
        typeof detail.operationId !== 'string' ||
        detail.operationId.length === 0
    ) {
        return null;
    }
    return {
        scopeKey: detail.scopeKey,
        generation: detail.generation,
        operationId: detail.operationId,
    };
}

export function dispatchPassageEnhancementEvent(
    type: typeof PASSAGE_ENHANCEMENT_START_EVENT | typeof PASSAGE_ENHANCEMENT_END_EVENT,
    token: PassageEnhancementToken,
): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(type, { detail: token }));
}
