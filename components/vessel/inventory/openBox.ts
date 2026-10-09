/**
 * openBox(id): open a box's page on the Ship's Stores page (126-11a). One
 * function, so 126-11b's tag link and anything after it open a box the same
 * way. It works while the Stores page is mounted (the page registers itself)
 * and returns false otherwise: the caller keeps its own pending request,
 * owned by the account it was made for, until the page is open.
 */
let opener: ((id: string) => void) | null = null;

export function openBox(id: string): boolean {
    opener?.(id);
    return !!opener;
}

/** The Stores page's registration; returns its release. */
export function registerBoxOpener(open: (id: string) => void): () => void {
    opener = open;
    return () => {
        if (opener === open) opener = null;
    };
}
