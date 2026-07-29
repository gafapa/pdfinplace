import { describe, expect, it } from 'vitest';
import {
    MAX_IMPORT_FILE_SIZE_BYTES,
    getAcceptedImportFiles,
    getImportFileKind,
    isAcceptedUnlockPdf,
} from './importValidation';

const createFile = (name: string, type: string, size = 4) =>
    new File([new Uint8Array(size)], name, { type });

describe('import validation', () => {
    it('classifies supported extensions without case sensitivity', () => {
        expect(getImportFileKind(createFile('SCAN.PNG', ''))).toBe('png');
        expect(getImportFileKind(createFile('REPORT.DOCX', ''))).toBe('docx');
        expect(getImportFileKind(createFile('document.PDF', ''))).toBe('pdf');
    });

    it('accepts a supported MIME type even without an extension', () => {
        const file = createFile('upload', 'application/pdf');
        expect(getAcceptedImportFiles([file]).acceptedFiles).toEqual([file]);
    });

    it('rejects oversized unlock files before reading them', () => {
        const oversizedFile = {
            name: 'locked.pdf',
            type: 'application/pdf',
            size: MAX_IMPORT_FILE_SIZE_BYTES + 1,
        } as File;
        expect(isAcceptedUnlockPdf(oversizedFile)).toBe(false);
    });
});
