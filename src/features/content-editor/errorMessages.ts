/** Reads the machine-readable code of a content rewrite error, if any. */
export const getContentEditErrorCode = (error: unknown): string | undefined =>
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

const messageKeys: Record<string, string> = {
    'unsupported-font': 'modal.contentErrorFont',
    'unsupported-character': 'modal.contentErrorCharacter',
    'source-not-found': 'modal.contentErrorNotFound',
    'ambiguous-source': 'modal.contentErrorAmbiguous',
    'unsupported-content': 'modal.contentErrorUnsupported',
};

/** Translation key explaining a content rewrite failure to the user. */
export const contentEditErrorMessageKey = (code: string | undefined) =>
    (code && messageKeys[code]) || 'modal.contentRewriteFailed';
