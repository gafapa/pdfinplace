import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { applyContentEditsToPdfPage } from './applyContentEdits';
import {
    parseContentFontInfo,
    viewportDeltaToPdfDelta,
} from './parseContentPage';
import type { TextContentBlock } from './types';

describe('content editor geometry', () => {
    it('converts viewport movement back into PDF coordinates', () => {
        expect(viewportDeltaToPdfDelta([2, 0, 0, -2, 0, 100], 20, -10)).toEqual({
            dx: 10,
            dy: 5,
        });
    });

    it('keeps movement correct in a rotated viewport', () => {
        expect(viewportDeltaToPdfDelta([0, 2, 2, 0, 0, 0], 20, 10)).toEqual({
            dx: 5,
            dy: 10,
        });
    });

    it('maps common PDF font names to a compatible font family', () => {
        expect(parseContentFontInfo('ABCDEF+TimesNewRomanPS-BoldItalicMT')).toMatchObject({
            bold: true,
            italic: true,
            family: 'serif',
            rawName: 'TimesNewRomanPS-BoldItalicMT',
        });
    });
});

describe('content editor export', () => {
    it('applies a text replacement to an isolated PDF page', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        page.drawText('Original', {
            x: 40,
            y: 220,
            size: 16,
            font,
            color: rgb(0, 0, 0),
        });

        const edit: TextContentBlock = {
            id: '0-text-0',
            pageIndex: 0,
            type: 'text',
            x: 60,
            y: 80,
            origX: 40,
            origY: 80,
            width: 64,
            height: 16,
            pdfX: 60,
            pdfY: 220,
            origPdfX: 40,
            origPdfY: 220,
            origWidth: 56,
            pdfRotation: 0,
            screenRotation: 0,
            backgroundColor: [1, 1, 1],
            isDirty: true,
            text: 'Updated',
            originalText: 'Original',
            pdfFontSize: 16,
            pdfTextScaleX: 1,
            screenFontSize: 16,
            screenTextScaleX: 1,
            screenFontAscent: 13,
            fontInfo: {
                bold: false,
                italic: false,
                family: 'sans',
                cssFamily: 'sans-serif',
                rawName: 'Helvetica',
            },
            pdfColor: [0, 0, 0],
            textEffects: {
                renderingMode: 0,
                strokeColor: [0, 0, 0],
                strokeWidth: 1,
                screenStrokeWidth: 1,
            },
        };

        await applyContentEditsToPdfPage(pdfDocument, page, [edit]);
        const bytes = await pdfDocument.save();
        const reloaded = await PDFDocument.load(bytes);

        expect(reloaded.getPageCount()).toBe(1);
        expect(bytes.byteLength).toBeGreaterThan(500);
    });
});
