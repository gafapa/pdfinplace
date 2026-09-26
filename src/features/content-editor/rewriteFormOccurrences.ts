import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFStream,
    type PDFPage,
} from 'pdf-lib';
import type { ContentEdit } from './types';
import { BoundedPdfStreamError, decodeBoundedPdfStream } from './decodeBoundedPdfStream';
import {
    ContentRewriteError,
    rewriteContentSource,
    tokenizePdfContent,
    type PdfToken,
} from './rewriteContentStreams';

type Matrix = [number, number, number, number, number, number];

const MAX_FORM_DEPTH = 8;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const POSITION_TOLERANCE = 1.25;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface FormOccurrence {
    /** The Form stream reached from its parent /XObject dictionary. */
    stream: PDFStream;
    /** Resource dictionary inherited by the Form when it has no /Resources. */
    resources: PDFDict;
    /** Complete page-to-form transform at the Form boundary. */
    ctm: Matrix;
    /** Names from the page root to this Form occurrence. */
    path: string[];
}

export interface FormImageMatch {
    editId: string;
    occurrence: FormOccurrence;
    imageName: string;
    operatorIndex: number;
    ctm: Matrix;
}

export interface RewrittenFormSource {
    source: Uint8Array;
    usesFallback: boolean;
    fallbackFontName: string;
}

const multiply = (left: Matrix, right: Matrix): Matrix => [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
];

const bytesToSource = (bytes: Uint8Array) => {
    if (bytes.length > MAX_STREAM_BYTES) {
        throw new ContentRewriteError('unsupported-content', 'A nested Form content stream is too large to rewrite safely.');
    }
    let output = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return output;
};

const sourceFromStream = (stream: PDFStream) => {
    if (stream instanceof PDFRawStream) {
        try {
            return bytesToSource(decodeBoundedPdfStream(stream, MAX_STREAM_BYTES));
        } catch (error) {
            if (error instanceof BoundedPdfStreamError) throw new ContentRewriteError('unsupported-content', error.message);
            throw error;
        }
    }
    const content = stream as PDFStream & { getUnencodedContents?: () => Uint8Array };
    if (!content.getUnencodedContents) throw new ContentRewriteError('unsupported-content', 'The Form has an unsupported content stream.');
    return bytesToSource(content.getUnencodedContents());
};

const number = (token: PdfToken | undefined) => token?.kind === 'number' ? Number(token.raw) : Number.NaN;

const matrixBefore = (tokens: PdfToken[], index: number): Matrix => {
    const values = tokens.slice(index - 6, index).map(number);
    if (values.length !== 6 || !values.every(Number.isFinite)) {
        throw new ContentRewriteError('unsupported-content', 'A Form transform has invalid operands.');
    }
    return values as Matrix;
};

const bounds = (matrix: Matrix) => {
    const [, , , , e, f] = matrix;
    const xs = [e, matrix[0] + e, matrix[2] + e, matrix[0] + matrix[2] + e];
    const ys = [f, matrix[1] + f, matrix[3] + f, matrix[1] + matrix[3] + f];
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

const sameBounds = (matrix: Matrix, edit: Extract<ContentEdit, { type: 'image' }>) => {
    const candidate = bounds(matrix);
    return Math.abs(candidate.x - edit.origPdfX) <= POSITION_TOLERANCE
        && Math.abs(candidate.y - edit.origPdfY) <= POSITION_TOLERANCE
        && Math.abs(candidate.width - edit.origWidth) <= POSITION_TOLERANCE
        && Math.abs(candidate.height - edit.origHeight) <= POSITION_TOLERANCE;
};

const getResources = (stream: PDFStream, inherited: PDFDict) => stream.dict.lookupMaybe(PDFName.Resources, PDFDict) ?? inherited;
const getXObjects = (resources: PDFDict) => resources.lookupMaybe(PDFName.XObject, PDFDict);
const subtype = (stream: PDFStream) => stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText().replace(/^\//u, '');

const formMatrix = (stream: PDFStream): Matrix => {
    const values = stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray)?.asArray().map((entry) => (
        entry instanceof PDFNumber ? entry.asNumber() : Number.NaN
    ));
    if (!values) return [...IDENTITY];
    if (values.length !== 6 || !values.every(Number.isFinite)) throw new ContentRewriteError('unsupported-content', 'The Form has an invalid Matrix.');
    return values as Matrix;
};

/**
 * Finds image XObject occurrences inside Form XObjects without mutating the
 * document. Callers must clone the selected Form path before writing it.
 */
export const findFormImageMatches = (pdfPage: PDFPage, edits: Extract<ContentEdit, { type: 'image' }>[]) => {
    const matches: FormImageMatch[] = [];
    const rootResources = pdfPage.node.Resources();
    if (!rootResources) throw new ContentRewriteError('source-not-found', 'The page has no resources for Form traversal.');
    const context = pdfPage.doc.context;
    const visit = (stream: PDFStream, inherited: PDFDict, baseCtm: Matrix, path: string[], ancestors: Set<PDFStream>, depth: number) => {
        if (depth > MAX_FORM_DEPTH) throw new ContentRewriteError('unsupported-content', 'Nested Form depth exceeds the safe rewrite limit.');
        if (ancestors.has(stream)) throw new ContentRewriteError('unsupported-content', 'The PDF contains a cyclic Form XObject.');
        const nextAncestors = new Set(ancestors).add(stream);
        const resources = getResources(stream, inherited);
        const xObjects = getXObjects(resources);
        if (!xObjects) return;
        const tokens = tokenizePdfContent(sourceFromStream(stream));
        const stack: Matrix[] = [];
        let ctm: Matrix = [...baseCtm];
        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index];
            if (token.kind !== 'word') continue;
            if (token.raw === 'q') { stack.push([...ctm]); continue; }
            if (token.raw === 'Q') {
                const restored = stack.pop();
                if (!restored) throw new ContentRewriteError('unsupported-content', 'The Form has an unbalanced graphics-state restore.');
                ctm = restored;
                continue;
            }
            if (token.raw === 'cm') { ctm = multiply(ctm, matrixBefore(tokens, index)); continue; }
            if (token.raw !== 'Do') continue;
            const nameToken = tokens[index - 1];
            if (!nameToken || nameToken.kind !== 'name') continue;
            const name = nameToken.raw.slice(1);
            const object = xObjects.get(PDFName.of(name));
            const nested = object ? context.lookup(object) : undefined;
            if (!(nested instanceof PDFStream)) continue;
            if (subtype(nested) === 'Image') {
                for (const edit of edits) {
                    if (sameBounds(ctm, edit)) matches.push({
                        editId: edit.id,
                        occurrence: { stream, resources, ctm: [...baseCtm], path },
                        imageName: name,
                        operatorIndex: index,
                        ctm: [...ctm],
                    });
                }
                continue;
            }
            if (subtype(nested) !== 'Form') continue;
            visit(nested, resources, multiply(ctm, formMatrix(nested)), [...path, name], nextAncestors, depth + 1);
        }
        if (stack.length > 0) throw new ContentRewriteError('unsupported-content', 'The Form has an unbalanced graphics-state save.');
    };
    const root = pdfPage.node.Contents();
    if (!root) throw new ContentRewriteError('source-not-found', 'The page has no content stream.');
    const streams = root instanceof PDFArray ? root.asArray().map((entry) => context.lookup(entry, PDFStream)) : [root];
    for (const stream of streams) visit(stream, rootResources, [...IDENTITY], [], new Set(), 0);
    for (const edit of edits) {
        const count = matches.filter((match) => match.editId === edit.id).length;
        if (count === 0) throw new ContentRewriteError('source-not-found', 'The selected image could not be found inside a Form XObject.');
        if (count > 1) throw new ContentRewriteError('ambiguous-source', 'The selected image occurs more than once inside Form XObjects.');
    }
    return matches;
};

/**
 * Rewrites a Form stream in memory. The caller owns cloning the stream and its
 * ancestor resource dictionaries, then installing this source atomically.
 */
export const rewriteFormTextSource = (
    pdfPage: PDFPage,
    occurrence: FormOccurrence,
    edits: Extract<ContentEdit, { type: 'text' }>[],
): RewrittenFormSource => rewriteContentSource({
    pdfPage,
    resources: occurrence.resources,
    source: sourceFromStream(occurrence.stream),
    initialCtm: occurrence.ctm,
    edits,
});
