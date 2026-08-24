export const orderItemsByIds = <T>(
    items: T[],
    orderedIds: string[],
    getId: (item: T) => string,
): T[] => {
    const itemById = new Map(items.map((item) => [getId(item), item]));
    return orderedIds
        .map((itemId) => itemById.get(itemId))
        .filter((item): item is T => item !== undefined);
};
