import { describe, expect, it } from 'vitest';
import { orderItemsByIds } from './orderedSelection';

describe('ordered selection', () => {
    it('returns items in the explicit selection order and skips missing IDs', () => {
        const items = [
            { id: 'first', value: 1 },
            { id: 'second', value: 2 },
            { id: 'third', value: 3 },
        ];

        expect(orderItemsByIds(items, ['third', 'missing', 'first'], (item) => item.id))
            .toEqual([items[2], items[0]]);
    });
});
