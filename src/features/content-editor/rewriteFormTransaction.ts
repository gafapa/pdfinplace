import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, type PDFPage } from 'pdf-lib';
import { ContentRewriteError, rewriteContentSource, serializePdfTokens, tokenizePdfContent, type PdfToken } from './rewriteContentStreams';
import { planImageRewrites } from './rewriteImageOperators';
import type { ContentEdit } from './types';
import type { UnicodeFallbackFont } from './unicodeFallback';
import { BoundedPdfStreamError, decodeBoundedPdfStream } from './decodeBoundedPdfStream';

type Matrix = [number, number, number, number, number, number];
interface Occurrence {
    source: string;
    resources: PDFDict;
    matrix: Matrix;
    children: { nameIndex: number; occurrence: Occurrence }[];
    stream?: PDFStream;
    edits: ContentEdit[];
}
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const decodeBytes = (bytes: Uint8Array) => {
    if (bytes.length > 16 * 1024 * 1024) throw new ContentRewriteError('unsupported-content', 'Content exceeds the safe rewrite size.');
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return parts.join('');
};
const encodeBytes = (source: string) => Uint8Array.from(source, character => character.charCodeAt(0));
const readStream = (stream: PDFStream) => {
    try {
        return decodeBytes(decodeBoundedPdfStream(stream, 16 * 1024 * 1024));
    } catch (error) {
        if (error instanceof BoundedPdfStreamError) throw new ContentRewriteError('unsupported-content', error.message);
        throw error;
    }
};
const cloneDict = (dictionary: PDFDict | undefined, page: PDFPage) => {
    const copy = PDFDict.withContext(page.doc.context);
    dictionary?.entries().forEach(([key, value]) => copy.set(key, value));
    return copy;
};

/** Plans every occurrence against immutable input; only the final two page keys are committed. */
export const rewritePageTransaction = (page: PDFPage, edits: ContentEdit[], unicodeFonts: UnicodeFallbackFont[] = []) => {
    const dirtyEdits = edits.filter(edit => edit.isDirty);
    if (!dirtyEdits.length) return { usedFallbackFont: false };
    if (dirtyEdits.length > 5000) throw new ContentRewriteError('unsupported-content', 'Too many simultaneous content edits.');
    for (const edit of dirtyEdits) {
        if (![edit.origPdfX, edit.origPdfY, edit.pdfX, edit.pdfY].every(Number.isFinite)) {
            throw new ContentRewriteError('unsupported-content', 'Content coordinates must be finite.');
        }
        if (edit.type === 'image' && ![edit.origWidth, edit.origHeight, edit.pdfWidth, edit.pdfHeight].every(value => Number.isFinite(value) && value > 0)) {
            throw new ContentRewriteError('unsupported-content', 'Image dimensions must be positive and finite.');
        }
        if (edit.type === 'text' && (typeof edit.text !== 'string' || typeof edit.originalText !== 'string' || edit.text.length > 100000 || edit.originalText.length > 100000)) {
            throw new ContentRewriteError('unsupported-content', 'The text edit exceeds the safe rewrite limit.');
        }
    }
    const context = page.doc.context;
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => context.lookup(ref)) : contents ? [contents] : [];
    const rootSource = streams.map(stream => {
        if (!(stream instanceof PDFStream)) throw new ContentRewriteError('unsupported-content', 'Invalid page content stream.');
        return readStream(stream);
    }).join('\n');
    const all: Occurrence[] = [];
    let totalBytes = 0;
    const collect = (source: string, resources: PDFDict, initialMatrix: Matrix, ancestry: Set<PDFStream>, stream?: PDFStream): Occurrence => {
        totalBytes += source.length;
        if (ancestry.size > 12 || all.length >= 512 || totalBytes > 32 * 1024 * 1024) {
            throw new ContentRewriteError('unsupported-content', 'Nested content exceeds the safe rewrite limit.');
        }
        const occurrence: Occurrence = { source, resources, matrix: initialMatrix, children: [], stream, edits: [] };
        all.push(occurrence);
        const tokens = tokenizePdfContent(source);
        let matrix: Matrix = [...initialMatrix];
        const stack: Matrix[] = [];
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            if (token.kind !== 'word') continue;
            if (['BI', 'BDC', 'DP', '<<'].includes(token.raw)) throw new ContentRewriteError('unsupported-content', 'Inline images and marked-content dictionaries need a dedicated rewrite path.');
            if (token.raw === 'q') stack.push([...matrix]);
            else if (token.raw === 'Q') {
                const previous = stack.pop();
                if (!previous) throw new ContentRewriteError('unsupported-content', 'Unbalanced graphics-state restore.');
                matrix = previous;
            } else if (token.raw === 'cm') {
                const operands = tokens.slice(Math.max(0, index - 6), index);
                if (operands.length !== 6 || operands.some(value => value.kind !== 'number' || !Number.isFinite(Number(value.raw)))) {
                    throw new ContentRewriteError('unsupported-content', 'The transformation has invalid operands.');
                }
                matrix = multiply(matrix, operands.map(value => Number(value.raw)) as Matrix);
                if (!matrix.every(Number.isFinite)) throw new ContentRewriteError('unsupported-content', 'The accumulated transformation is not finite.');
            } else if (token.raw === 'Do' && tokens[index - 1]?.kind === 'name') {
                const objects = resources.lookupMaybe(PDFName.XObject, PDFDict);
                const child = objects?.lookup(PDFName.of(tokens[index - 1].raw.slice(1)));
                if (!(child instanceof PDFStream) || child.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Form') continue;
                if (ancestry.has(child)) throw new ContentRewriteError('unsupported-content', 'Cyclic Form resources cannot be rewritten.');
                const formMatrixArray = child.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
                let formMatrix = identity();
                if (formMatrixArray) {
                    if (formMatrixArray.size() !== 6) throw new ContentRewriteError('unsupported-content', 'Invalid Form matrix.');
                    const values = formMatrixArray.asArray().map(value => context.lookupMaybe(value, PDFNumber)?.asNumber());
                    if (values.some(value => value === undefined || !Number.isFinite(value))) throw new ContentRewriteError('unsupported-content', 'Invalid Form matrix.');
                    formMatrix = values as Matrix;
                }
                const nextAncestry = new Set(ancestry);
                nextAncestry.add(child);
                occurrence.children.push({ nameIndex: index - 1, occurrence: collect(readStream(child), child.dict.lookupMaybe(PDFName.Resources, PDFDict) ?? resources, multiply(matrix, formMatrix), nextAncestry, child) });
            }
        }
        if (stack.length) throw new ContentRewriteError('unsupported-content', 'Unbalanced graphics-state save.');
        return occurrence;
    };
    const root = collect(rootSource, page.node.Resources() ?? PDFDict.withContext(context), identity(), new Set());
    const rewrite = (occurrence: Occurrence, changes: ContentEdit[], input = occurrence.source) => {
        let source = input;
        const images = changes.filter((edit): edit is Extract<ContentEdit, { type: 'image' }> => edit.type === 'image');
        if (images.length) {
            const resources = occurrence.resources.lookupMaybe(PDFName.XObject, PDFDict);
            const names = new Set((resources?.entries() ?? []).flatMap(([name, ref]) => {
                const object = context.lookup(ref);
                return object instanceof PDFStream && object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Image' ? [name.decodeText()] : [];
            }));
            const tokens = tokenizePdfContent(source);
            const patches = planImageRewrites(tokens, images, { initialMatrix: occurrence.matrix, imageResourceNames: names });
            for (const patch of patches.sort((a, b) => b.startToken - a.startToken)) tokens.splice(patch.startToken, patch.endToken - patch.startToken, ...patch.replacement);
            source = serializePdfTokens(tokens);
        }
        const text = changes.filter((edit): edit is Extract<ContentEdit, { type: 'text' }> => edit.type === 'text');
        return text.length ? rewriteContentSource({ pdfPage: page, resources: occurrence.resources, initialCtm: occurrence.matrix, source, edits: text, unicodeFonts })
            : { source: encodeBytes(source), usesFallback: false, fallbackFontName: '', fallbackFontNames: [] as string[] };
    };
    for (const edit of dirtyEdits) {
        const matches: Occurrence[] = [];
        let unsupported: ContentRewriteError | undefined;
        for (const occurrence of all) {
            try { rewrite(occurrence, [edit]); matches.push(occurrence); }
            catch (error) {
                if (!(error instanceof ContentRewriteError)) throw error;
                if (error.code === 'ambiguous-source') throw error;
                if (error.code !== 'source-not-found') unsupported = error;
            }
        }
        if (matches.length > 1) throw new ContentRewriteError('ambiguous-source', 'Multiple content occurrences match this selection.');
        if (!matches.length) throw unsupported ?? new ContentRewriteError('source-not-found', 'The selected content could not be found.');
        matches[0].edits.push(edit);
    }
    // Validate combined edits before constructing or registering any replacement object.
    for (const occurrence of all) if (occurrence.edits.length) rewrite(occurrence, occurrence.edits);
    let usedFallbackFont = false;
    const build = (occurrence: Occurrence): { source: Uint8Array; resources: PDFDict } | null => {
        const tokens = tokenizePdfContent(occurrence.source);
        const resources = cloneDict(occurrence.resources, page);
        let changed = occurrence.edits.length > 0;
        let objects: PDFDict | undefined;
        for (const child of occurrence.children) {
            const rewritten = build(child.occurrence);
            if (!rewritten) continue;
            changed = true;
            objects ??= cloneDict(resources.lookupMaybe(PDFName.XObject, PDFDict), page);
            const dictionary = cloneDict(child.occurrence.stream!.dict, page);
            dictionary.delete(PDFName.of('Filter'));
            dictionary.delete(PDFName.of('DecodeParms'));
            dictionary.set(PDFName.Resources, rewritten.resources);
            dictionary.set(PDFName.Length, PDFNumber.of(rewritten.source.length));
            const ref = context.register(PDFRawStream.of(dictionary, rewritten.source));
            const name = objects.uniqueKey('PDFinPlaceForm');
            objects.set(name, ref);
            tokens[child.nameIndex] = { kind: 'name', raw: name.toString() } as PdfToken;
        }
        if (!changed) return null;
        if (objects) resources.set(PDFName.XObject, objects);
        const output = rewrite(occurrence, occurrence.edits, serializePdfTokens(tokens));
        if (output.fallbackFontNames.length) {
            const fonts = cloneDict(resources.lookupMaybe(PDFName.Font, PDFDict), page);
            for (const name of output.fallbackFontNames) {
                const unicodeFont = unicodeFonts.find(font => font.name === name);
                fonts.set(PDFName.of(name), unicodeFont?.font.ref ?? context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })));
            }
            resources.set(PDFName.Font, fonts);
            usedFallbackFont = true;
        }
        return { source: output.source, resources };
    };
    const result = build(root);
    if (result) {
        const ref = context.register(context.flateStream(result.source));
        const replacementContents = PDFArray.withContext(context);
        replacementContents.push(ref);
        page.node.set(PDFName.Resources, result.resources);
        page.node.set(PDFName.Contents, replacementContents);
    }
    return { usedFallbackFont };
};
