import { describe, expect, it } from 'vitest';
import {
    getImageExportFilename,
    getImageExportFormatDetails,
    getImageExportQualityValue,
    getImageExportRenderScale,
    normalizeImageExportQuality,
} from './imageExport';

describe('image export settings', () => {
    it('maps understandable presets to export values', () => {
        expect(getImageExportQualityValue('compact')).toBe(55);
        expect(getImageExportQualityValue('balanced')).toBe(80);
        expect(getImageExportQualityValue('maximum')).toBe(100);
    });

    it('clamps quality to the supported range', () => {
        expect(normalizeImageExportQuality(10)).toBe(30);
        expect(normalizeImageExportQuality(84.6)).toBe(85);
        expect(normalizeImageExportQuality(120)).toBe(100);
        expect(normalizeImageExportQuality(Number.NaN)).toBe(80);
    });

    it('increases render scale with quality', () => {
        expect(getImageExportRenderScale(30)).toBeCloseTo(0.995);
        expect(getImageExportRenderScale(100)).toBeCloseTo(2.5);
    });

    it('maps formats and creates sortable filenames', () => {
        expect(getImageExportFormatDetails('jpeg')).toEqual({
            extension: 'jpg',
            mimeType: 'image/jpeg',
        });
        expect(getImageExportFilename(7, 120, 'page', 'webp')).toBe('page-007.webp');
        expect(getImageExportFilename(4, 1_250, 'page', 'png')).toBe('page-0004.png');
    });
});
