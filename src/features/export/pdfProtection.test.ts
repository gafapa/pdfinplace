import { describe, expect, it } from 'vitest';
import { PDF } from '@libpdf/core';
import { PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { getDocument } from '../../test/pdfjs';

describe('PDF password protection dependency contract', () => {
    it('writes AES-256, rejects a wrong password and saves a readable unlocked copy', async () => {
        const source = await PDFDocument.create();
        source.addPage([300, 300]).drawText('Synthetic protection regression', { font: await source.embedFont(StandardFonts.Helvetica) });
        const document = await PDF.load(await source.save());
        document.setProtection({ userPassword: 'synthetic-passphrase', ownerPassword: 'synthetic-owner-password', algorithm: 'AES-256' });
        const encrypted = await document.save();
        const unauthenticated = await PDF.load(encrypted, { credentials: 'incorrect-password' });
        expect(unauthenticated.isAuthenticated).toBe(false);
        const rejectedTask = getDocument({ data: encrypted.slice(), password: 'incorrect-password' });
        try { await expect(rejectedTask.promise).rejects.toThrow(); }
        finally { await rejectedTask.destroy(); }
        await expect(PDFDocument.load(encrypted)).rejects.toThrow();
        const encryptedStructure = await PDFDocument.load(encrypted, { ignoreEncryption: true });
        const encryption = encryptedStructure.context.lookup(encryptedStructure.context.trailerInfo.Encrypt!, PDFDict);
        expect(encryption.lookup(PDFName.of('Length'), PDFNumber).asNumber()).toBe(256);
        const reopened = await PDF.load(encrypted, { credentials: 'synthetic-passphrase' });
        expect(reopened.isEncrypted).toBe(true);
        expect(reopened.isAuthenticated).toBe(true);
        reopened.removeProtection();
        const unlocked = await PDFDocument.load(await reopened.save());
        expect(unlocked.getPageCount()).toBe(1);
        expect(unlocked.context.trailerInfo.Encrypt).toBeUndefined();
    });
});
