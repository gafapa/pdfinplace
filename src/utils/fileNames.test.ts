import { describe, expect, it } from 'vitest';
import { buildDownloadName, toFileStem } from './fileNames';

describe('download names', () => {
    it('strips the extension and characters that are invalid in file names', () => {
        expect(toFileStem('Factura 2025.pdf')).toBe('Factura 2025');
        expect(toFileStem('a/b\\c:d*e?"f<g>h|.docx')).toBe('a_b_c_d_e_f_g_h_');
        expect(toFileStem('  .hidden.  ')).toBe('hidden');
        expect(toFileStem('.pdf')).toBeNull();
    });

    it('uses the source name with a suffix, or the fallback prefix', () => {
        expect(buildDownloadName('invoice', 'edited', 'edited_document', undefined)).toBe('invoice_edited');
        expect(buildDownloadName('invoice', 'edited', 'edited_document', '2-5', 'A4')).toBe('invoice_edited_2-5_A4');
        expect(buildDownloadName(null, 'edited', 'edited_document', '2-5')).toBe('edited_document_2-5');
        expect(buildDownloadName('invoice', undefined, 'split', 'page-1')).toBe('invoice_page-1');
    });
});
