export const createId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `id-${Math.random().toString(36).slice(2, 11)}`;
};
