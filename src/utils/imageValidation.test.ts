import { describe, expect, it } from 'vitest';
import { getDataUrlImageKind, readImageDimensions } from './imageValidation';

describe('image validation', () => {
    it('reads PNG dimensions from the header', () => {
        const bytes = new Uint8Array(24);
        bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(bytes.buffer);
        view.setUint32(16, 1920);
        view.setUint32(20, 1080);

        expect(readImageDimensions(bytes.buffer)).toEqual({
            width: 1920,
            height: 1080,
            kind: 'png',
        });
    });

    it('rejects unsupported data URL formats', () => {
        expect(getDataUrlImageKind('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
        expect(getDataUrlImageKind('data:image/jpeg;base64,/9j/')).toBe('jpeg');
    });
});
