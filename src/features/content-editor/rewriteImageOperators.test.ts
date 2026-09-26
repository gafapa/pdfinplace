import { describe, expect, it } from 'vitest';
import { tokenizePdfContent } from './rewriteContentStreams';
import { planImageRewrites } from './rewriteImageOperators';
import type { ContentEdit } from './types';

const imageEdit = (overrides: Partial<Extract<ContentEdit, { type: 'image' }>> = {}): Extract<ContentEdit, { type: 'image' }> => ({
    id: '0-image-0',
    pageIndex: 0,
    type: 'image',
    x: 20,
    y: 30,
    origX: 20,
    origY: 30,
    width: 100,
    height: 50,
    pdfX: 20,
    pdfY: 30,
    origPdfX: 20,
    origPdfY: 30,
    origWidth: 100,
    origHeight: 50,
    pdfWidth: 100,
    pdfHeight: 50,
    pdfRotation: 0,
    screenRotation: 0,
    backgroundColor: [1, 1, 1],
    imageDataUrl: 'data:image/png;base64,',
    isDirty: true,
    ...overrides,
});

describe('image content stream rewrites', () => {
    it('removes only the matched image Do occurrence', () => {
        const tokens = tokenizePdfContent('q 100 0 0 50 20 30 cm /Im1 Do Q');
        const patches = planImageRewrites(tokens, [imageEdit({ deleted: true })], {
            imageResourceNames: new Set(['Im1']),
        });

        expect(patches).toEqual([{
            startToken: 8,
            endToken: 10,
            replacement: [],
        }]);
    });

    it('wraps a moved occurrence in a local graphics state and preserves the resource name', () => {
        const tokens = tokenizePdfContent('q 100 0 0 50 20 30 cm /Im1 Do Q');
        const patches = planImageRewrites(tokens, [imageEdit({ pdfX: 50, pdfY: 60 })], {
            imageResourceNames: new Set(['Im1']),
        });

        expect(patches).toHaveLength(1);
        expect(patches[0].replacement.map((token) => token.raw)).toEqual([
            'q', '1', '0', '0', '1', '0.3', '0.6', 'cm', '/Im1', 'Do', 'Q',
        ]);
    });

    it('plans a one-point movement instead of treating it as unchanged', () => {
        const tokens = tokenizePdfContent('q 100 0 0 50 20 30 cm /Im1 Do Q');
        const patches = planImageRewrites(tokens, [imageEdit({ pdfX: 21 })], {
            imageResourceNames: new Set(['Im1']),
        });

        expect(patches[0].replacement.map((token) => token.raw)).toContain('0.01');
    });

    it('matches decoded PDF resource names while preserving the original name token', () => {
        const tokens = tokenizePdfContent('q 100 0 0 50 20 30 cm /Im#31 Do Q');
        const patches = planImageRewrites(tokens, [imageEdit({ pdfX: 21 })], {
            imageResourceNames: new Set(['Im1']),
        });

        expect(patches[0].replacement.map((token) => token.raw)).toContain('/Im#31');
    });

    it('moves a rotated image occurrence while preserving its orientation', () => {
        const tokens = tokenizePdfContent('q 0 100 -50 0 70 20 cm /Im1 Do Q');
        const patches = planImageRewrites(tokens, [imageEdit({
            origPdfX: 20,
            origPdfY: 20,
            origWidth: 50,
            origHeight: 100,
            pdfX: 30,
            pdfY: 40,
            pdfWidth: 50,
            pdfHeight: 100,
            pdfRotation: 90,
        })], { imageResourceNames: new Set(['Im1']) });

        expect(patches).toHaveLength(1);
        expect(patches[0].replacement.map((token) => token.raw)).toContain('/Im1');
        expect(patches[0].replacement.map((token) => token.raw)).toContain('0.2');
    });

    it('does not rewrite a form XObject that is not an image resource', () => {
        const tokens = tokenizePdfContent('q 100 0 0 50 20 30 cm /Fm1 Do Q');

        expect(() => planImageRewrites(tokens, [imageEdit()], {
            imageResourceNames: new Set(['Im1']),
        })).toThrow('could not be found');
    });
});
