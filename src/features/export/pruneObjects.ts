import type { PDFDocument, PDFObject, PDFRef as PDFRefType } from 'pdf-lib';
import { loadPdfLib } from '../../hooks/editorResources';

/**
 * Removes every object a reader cannot reach from the document catalog, and
 * every reference to a page that is not in the page tree.
 *
 * Copying a page also copies whatever its links and form fields point to, so
 * a link to a page that was not exported (or that was exported as a redacted
 * image) drags a full copy of that page into the file. Nothing displays it,
 * but its text and images would still be in the bytes.
 *
 * Call after `flush()` so lazily embedded fonts, images and pages exist.
 */
export const pruneUnreachableObjects = async (document: PDFDocument) => {
    const { PDFArray, PDFDict, PDFName, PDFNull, PDFPageLeaf, PDFRef, PDFStream } = await loadPdfLib();
    const { context } = document;
    const pageRefs = new Set(document.getPages().map(page => page.ref.toString()));
    const isDetachedPage = (object: PDFObject | undefined) => {
        if (!object) return false;
        const dict = object instanceof PDFDict ? object : undefined;
        return Boolean(dict && (dict instanceof PDFPageLeaf || dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() === 'Page'));
    };

    const reachable = new Set<string>();
    const pending: PDFObject[] = [];
    const queueRef = (ref: PDFRefType) => {
        const key = ref.toString();
        if (reachable.has(key)) return;
        reachable.add(key);
        const object = context.lookup(ref);
        if (object) pending.push(object);
    };
    /** Queues a referenced object, or reports a reference to a detached page. */
    const follow = (value: PDFObject): 'keep' | 'drop' => {
        if (value instanceof PDFRef) {
            if (!pageRefs.has(value.toString()) && isDetachedPage(context.lookup(value))) return 'drop';
            queueRef(value);
        } else {
            pending.push(value);
        }
        return 'keep';
    };

    const { Root, Info } = context.trailerInfo;
    for (const entry of [Root, Info]) if (entry instanceof PDFRef) queueRef(entry);

    while (pending.length > 0) {
        const object = pending.pop()!;
        const dict = object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : undefined;
        if (dict) {
            for (const [key, value] of dict.entries()) {
                if (follow(value) === 'drop') dict.delete(key);
            }
        } else if (object instanceof PDFArray) {
            for (let index = 0; index < object.size(); index += 1) {
                if (follow(object.get(index)) === 'drop') object.set(index, PDFNull);
            }
        }
    }

    for (const [ref] of context.enumerateIndirectObjects()) {
        if (!reachable.has(ref.toString())) context.delete(ref);
    }
};
