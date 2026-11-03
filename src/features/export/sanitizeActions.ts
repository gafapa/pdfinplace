import type { PDFDocument, PDFObject } from 'pdf-lib';
import { loadPdfLib } from '../../hooks/editorResources';

export const isSafeLinkUri = (uri: string) => {
    try { return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(uri).protocol); }
    catch { return false; }
};

/** Keeps navigation/local reset actions while removing scripts, uploads and launches. */
export const sanitizeDocumentActions = async (document: PDFDocument) => {
    const { PDFDict, PDFArray, PDFName, PDFStream, PDFRef, PDFString, PDFHexString } = await loadPdfLib();
    document.catalog.delete(PDFName.of('OpenAction'));
    document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.delete(PDFName.of('XFA'));
    const pending: PDFObject[] = [document.catalog];
    const visited = new Set<PDFObject>();
    while (pending.length) {
        let value: PDFObject | undefined = pending.pop();
        if (value instanceof PDFRef) value = document.context.lookup(value);
        if (!value || visited.has(value)) continue;
        visited.add(value);
        if (value instanceof PDFStream) pending.push(value.dict);
        else if (value instanceof PDFArray) pending.push(...value.asArray());
        else if (value instanceof PDFDict) {
            value.delete(PDFName.of('AA'));
            const action = value.lookupMaybe(PDFName.of('A'), PDFDict);
            const kind = action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText();
            if (action && kind) {
                // An allowed first action must not chain into an unsafe second one.
                action.delete(PDFName.of('Next'));
                const uri = kind === 'URI' ? action.lookupMaybe(PDFName.of('URI'), PDFString, PDFHexString)?.decodeText() : undefined;
                const named = kind === 'Named' ? action.lookupMaybe(PDFName.of('N'), PDFName)?.decodeText() : undefined;
                const allowed = kind === 'GoTo' || kind === 'ResetForm' ||
                    (kind === 'URI' && uri !== undefined && isSafeLinkUri(uri)) ||
                    (kind === 'Named' && ['FirstPage', 'LastPage', 'NextPage', 'PrevPage'].includes(named ?? ''));
                if (!allowed) value.delete(PDFName.of('A'));
            }
            pending.push(...value.values());
        }
    }
};
