import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFStream,
    type PDFPage,
} from 'pdf-lib';
import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import type { ContentEdit } from './types';
import { planImageRewrites } from './rewriteImageOperators';
import { getCompositeFontCodec, parseToUnicodeCodes, readToUnicode } from './rewriteCompositeFont';
import type { UnicodeFallbackFont } from './unicodeFallback';
import { BoundedPdfStreamError, decodeBoundedPdfStream } from './decodeBoundedPdfStream';

export class ContentRewriteError extends Error {
    readonly code: 'ambiguous-source' | 'unsupported-content' | 'source-not-found' | 'fallback-needed';

    constructor(code: ContentRewriteError['code'], message: string) {
        super(message);
        this.name = 'ContentRewriteError';
        this.code = code;
    }
}

export type PdfTokenKind = 'word' | 'number' | 'name' | 'string' | 'hex' | 'arrayStart' | 'arrayEnd';

export interface PdfToken {
    kind: PdfTokenKind;
    raw: string;
}

export interface StreamPatch {
    startToken: number;
    endToken: number;
    replacement: PdfToken[];
}

const MAX_CONTENT_STREAM_BYTES = 16 * 1024 * 1024;
const bytesToSourceString = (bytes: Uint8Array) => {
    if (bytes.length > MAX_CONTENT_STREAM_BYTES) throw new ContentRewriteError('unsupported-content', 'The content stream is too large to rewrite.');
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return parts.join('');
};
const whitespace = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const delimiters = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

const isWhitespace = (value: string) => whitespace.has(value);
const isDelimiter = (value: string) => delimiters.has(value);

const readLiteral = (source: string, start: number) => {
    let index = start + 1;
    let depth = 1;
    while (index < source.length && depth > 0) {
        if (source[index] === '\\') {
            index += 2;
            continue;
        }
        if (source[index] === '(') depth += 1;
        if (source[index] === ')') depth -= 1;
        index += 1;
    }
    if (depth !== 0) throw new ContentRewriteError('unsupported-content', 'The PDF contains an unterminated text string.');
    return index;
};

export const tokenizePdfContent = (source: string): PdfToken[] => {
    const tokens: PdfToken[] = [];
    let index = 0;
    while (index < source.length) {
        const current = source[index];
        if (isWhitespace(current)) {
            index += 1;
            continue;
        }
        if (current === '%') {
            while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
            continue;
        }
        if (source.startsWith('<<', index) || source.startsWith('>>', index)) {
            tokens.push({ kind: 'word', raw: source.slice(index, index + 2) });
            index += 2;
            continue;
        }
        if (current === '(') {
            const end = readLiteral(source, index);
            tokens.push({ kind: 'string', raw: source.slice(index, end) });
            index = end;
            continue;
        }
        if (current === '<' && source[index + 1] !== '<') {
            const end = source.indexOf('>', index + 1);
            if (end === -1) throw new ContentRewriteError('unsupported-content', 'The PDF contains an unterminated hexadecimal string.');
            tokens.push({ kind: 'hex', raw: source.slice(index, end + 1) });
            index = end + 1;
            continue;
        }
        if (current === '[' || current === ']') {
            tokens.push({ kind: current === '[' ? 'arrayStart' : 'arrayEnd', raw: current });
            index += 1;
            continue;
        }
        if (current === '/') {
            let nameEnd = index + 1;
            while (nameEnd < source.length && !isWhitespace(source[nameEnd]) && !isDelimiter(source[nameEnd])) nameEnd += 1;
            tokens.push({ kind: 'name', raw: source.slice(index, nameEnd) });
            index = nameEnd;
            continue;
        }
        let end = index + 1;
        while (end < source.length && !isWhitespace(source[end]) && !isDelimiter(source[end])) end += 1;
        const raw = source.slice(index, end);
        tokens.push({ kind: /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(raw) ? 'number' : 'word', raw });
        index = end;
    }
    return tokens;
};

export const serializePdfTokens = (tokens: PdfToken[]) => tokens.map((token) => token.raw).join(' ');

const decodeLiteralBytes = (raw: string) => {
    const bytes: number[] = [];
    for (let index = 1; index < raw.length - 1; index += 1) {
        const value = raw[index];
        if (value !== '\\') {
            bytes.push(value.charCodeAt(0));
            continue;
        }
        const escaped = raw[++index];
        if (escaped === undefined) break;
        const mapped: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (mapped[escaped] !== undefined) {
            bytes.push(mapped[escaped]);
            continue;
        }
        if (/[0-7]/.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/.test(raw[index + 1] ?? '')) octal += raw[++index];
            bytes.push(Number.parseInt(octal, 8));
            continue;
        }
        if (escaped === '\r' && raw[index + 1] === '\n') index += 1;
        else if (escaped !== '\r' && escaped !== '\n') bytes.push(escaped.charCodeAt(0));
    }
    return Uint8Array.from(bytes);
};

const tokenBytes = (token: PdfToken) => {
    if (token.kind === 'string') return decodeLiteralBytes(token.raw);
    if (token.kind === 'hex') {
        const digits = token.raw.slice(1, -1).replaceAll(/\s/g, '');
        if (!/^[\da-fA-F]*$/.test(digits)) throw new ContentRewriteError('unsupported-content', 'The PDF contains an invalid hexadecimal text string.');
        const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
        return Uint8Array.from(padded.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
    }
    throw new ContentRewriteError('unsupported-content', 'The PDF text operator has an invalid operand.');
};

const literalBytesToken = (bytes: Uint8Array): PdfToken => ({
    kind: 'string',
    raw: `(${[...bytes].map((byte) => {
        if (byte === 40 || byte === 41 || byte === 92) return `\\${String.fromCharCode(byte)}`;
        if (byte >= 32 && byte <= 126) return String.fromCharCode(byte);
        return `\\${byte.toString(8).padStart(3, '0')}`;
    }).join('')})`,
});

const getStreamSource = (stream: PDFStream) => {
    if (stream instanceof PDFRawStream) {
        try {
            return bytesToSourceString(decodeBoundedPdfStream(stream, MAX_CONTENT_STREAM_BYTES));
        } catch (error) {
            if (error instanceof BoundedPdfStreamError) throw new ContentRewriteError('unsupported-content', error.message);
            throw error;
        }
    }
    const contentStream = stream as PDFStream & { getUnencodedContents?: () => Uint8Array };
    if (!contentStream.getUnencodedContents) {
        throw new ContentRewriteError('unsupported-content', 'The PDF uses an unsupported content stream type.');
    }
    return bytesToSourceString(contentStream.getUnencodedContents());
};

const getPageStreams = (pdfPage: PDFPage) => {
    const contents = pdfPage.node.Contents();
    if (!contents) throw new ContentRewriteError('source-not-found', 'The page has no editable content stream.');
    if (contents instanceof PDFArray) {
        return contents.asArray().map((entry) => pdfPage.doc.context.lookup(entry, PDFStream));
    }
    return [contents];
};

const equalPosition = (left: number, right: number) => Math.abs(left - right) <= 1.25;
const samePosition = (left: number, right: number) => Math.abs(left - right) <= 0.000001;

type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = (left: Matrix, right: Matrix): Matrix => [
    left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
];
const translate = (matrix: Matrix, x: number, y = 0): Matrix =>
    multiply(matrix, [1, 0, 0, 1, x, y]);
const localDelta = (matrix: Matrix, x: number, y: number) => {
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (Math.abs(determinant) < 1e-12) throw new ContentRewriteError('unsupported-content', 'Singular text transformation.');
    return [(matrix[3] * x - matrix[2] * y) / determinant, (-matrix[1] * x + matrix[0] * y) / determinant];
};
const numeric = (value: number): PdfToken => {
    if (!Number.isFinite(value)) throw new ContentRewriteError('unsupported-content', 'Invalid text geometry.');
    return { kind: 'number', raw: String(Number(value.toFixed(8))) };
};
const operation = (raw: string): PdfToken => ({ kind: 'word', raw });
const matrixTokens = (matrix: Matrix): PdfToken[] => [...matrix.map(numeric), operation('Tm')];
const adjustmentTokens = (adjustment: number): PdfToken[] =>
    [{ kind: 'arrayStart', raw: '[' }, numeric(adjustment), { kind: 'arrayEnd', raw: ']' }, operation('TJ')];

interface TextState {
    fontName: string | null;
    fontSize: number;
    charSpacing: number;
    wordSpacing: number;
    horizontalScale: number;
    leading: number;
    rise: number;
    renderingMode: number;
    unsafeFontState: boolean;
    matrix: Matrix | null;
    lineMatrix: Matrix;
    ctm: Matrix;
}
const initialTextState = (): TextState => ({
    fontName: null, fontSize: 0, charSpacing: 0, wordSpacing: 0,
    horizontalScale: 1, leading: 0, rise: 0, renderingMode: 0, unsafeFontState: false,
    matrix: identity(), lineMatrix: identity(), ctm: identity(),
});
const parseNumber = (token: PdfToken | undefined) => token?.kind === 'number' ? Number(token.raw) : Number.NaN;
interface FontResolver {
    encode: (fontName: string | null, text: string) => Uint8Array;
    decode: (fontName: string | null, bytes: Uint8Array) => string;
    width: (fontName: string | null, bytes: Uint8Array) => number;
    characterCount: (fontName: string | null, bytes: Uint8Array) => number;
    fallbackFontName: string;
    encodeFallback: (text: string) => { bytes: Uint8Array; name: string };
    fallbackFontNames: Set<string>;
}
// pdf.js may normalize whitespace and Unicode compatibility characters while
// producing an editor block. Match that projection only after the source bytes
// have been decoded with the active PDF font; never search arbitrary stream text.
const normalizeExtractedText = (text: string) => text
    .normalize('NFKC')
    .replaceAll(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
const textAdvance = (bytes: Uint8Array, state: TextState, fonts: FontResolver) => {
    // Resolve widths first, which also initializes the composite font codec.
    const width = fonts.width(state.fontName, bytes);
    const characters = fonts.characterCount(state.fontName, bytes);
    // Tw applies only to a one-byte character code 32, never a two-byte CID.
    const spaces = characters === bytes.length ? [...bytes].filter((byte) => byte === 32).length : 0;
    return (width / 1000 * state.fontSize + characters * state.charSpacing + spaces * state.wordSpacing) * state.horizontalScale;
};
interface Candidate {
    start: number;
    end: number;
    replacement: PdfToken[];
}
interface PendingTextRun {
    start: number;
    end: number;
    decoded: string;
    advance: number;
    leadingAdjustment: number;
    before: Matrix;
    baseline: Matrix;
    state: TextState;
    prefix: PdfToken[];
}
const findTextCandidates = (
    tokens: PdfToken[],
    edit: Extract<ContentEdit, { type: 'text' }>,
    fonts: FontResolver,
    initialCtm: Matrix = identity(),
) => {
    const candidates: Candidate[] = [];
    let state = initialTextState();
    state.ctm = initialCtm;
    const stack: TextState[] = [];
    let pendingRun: PendingTextRun[] = [];
    let inText = false;
    // Why the operation at the edit's position could not be read; reported
    // instead of "not found" so an unsupported font never looks like a miss.
    let blockedReason: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.kind !== 'word') continue;
        const op = token.raw;
        // A grouped pdf.js item may be made from consecutive show operators.
        // Any other operator can change positioning or text state, so it forms a
        // hard boundary for the conservative contiguous-run fallback below.
        if (!['Tj', 'TJ', 'Tr', 'w'].includes(op)) pendingRun = [];
        if (op === 'q') { stack.push(structuredClone(state)); continue; }
        if (op === 'Q') {
            const restored = stack.pop();
            if (!restored) throw new ContentRewriteError('unsupported-content', 'Unbalanced graphics state.');
            state = restored;
            continue;
        }
        if (op === 'cm') {
            const values = tokens.slice(index - 6, index).map(parseNumber);
            if (values.length !== 6 || !values.every(Number.isFinite)) throw new ContentRewriteError('unsupported-content', 'Invalid graphics transform.');
            state.ctm = multiply(state.ctm, values as Matrix);
            continue;
        }
        // An ExtGState can change the active font. Until resolved, do not guess.
        if (op === 'gs') { state.unsafeFontState = true; continue; }
        if (op === 'BT') { inText = true; state.matrix = identity(); state.lineMatrix = identity(); continue; }
        if (op === 'ET') { inText = false; continue; }
        if (op === 'Tf') {
            state.fontSize = parseNumber(tokens[index - 1]);
            state.fontName = tokens[index - 2]?.kind === 'name'
                ? tokens[index - 2].raw.slice(1).replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
                : null;
            state.unsafeFontState = false;
            continue;
        }
        if (op === 'Tc') { state.charSpacing = parseNumber(tokens[index - 1]); continue; }
        if (op === 'Tw') { state.wordSpacing = parseNumber(tokens[index - 1]); continue; }
        if (op === 'Tz') { state.horizontalScale = parseNumber(tokens[index - 1]) / 100; continue; }
        if (op === 'TL') { state.leading = parseNumber(tokens[index - 1]); continue; }
        if (op === 'Ts') { state.rise = parseNumber(tokens[index - 1]); continue; }
        if (op === 'Tr') { state.renderingMode = parseNumber(tokens[index - 1]); continue; }
        if (!inText) continue;
        if (op === 'Tm') {
            const values = tokens.slice(index - 6, index).map(parseNumber);
            if (values.length !== 6 || !values.every(Number.isFinite)) throw new ContentRewriteError('unsupported-content', 'Invalid text matrix.');
            state.matrix = values as Matrix;
            state.lineMatrix = [...state.matrix];
            continue;
        }
        if (op === 'Td' || op === 'TD') {
            const tx = parseNumber(tokens[index - 2]);
            const ty = parseNumber(tokens[index - 1]);
            if (op === 'TD') state.leading = -ty;
            state.lineMatrix = translate(state.lineMatrix, tx, ty);
            state.matrix = [...state.lineMatrix];
            continue;
        }
        if (op === 'T*') {
            state.lineMatrix = translate(state.lineMatrix, 0, -state.leading);
            state.matrix = [...state.lineMatrix];
            continue;
        }
        if (!['Tj', 'TJ', "'", '"'].includes(op)) continue;
        let start = index - 1;
        const prefix: PdfToken[] = [];
        if (op === '"' || op === "'") {
            if (op === '"') {
                start = index - 3;
                state.wordSpacing = parseNumber(tokens[index - 3]);
                state.charSpacing = parseNumber(tokens[index - 2]);
                prefix.push(numeric(state.wordSpacing), operation('Tw'), numeric(state.charSpacing), operation('Tc'));
            }
            state.lineMatrix = translate(state.lineMatrix, 0, -state.leading);
            state.matrix = [...state.lineMatrix];
            prefix.push(operation('T*'));
        }
        let operands: PdfToken[];
        if (op === 'TJ') {
            start = index - 2;
            while (start >= 0 && tokens[start].kind !== 'arrayStart') start -= 1;
            if (start < 0 || tokens[index - 1].kind !== 'arrayEnd') throw new ContentRewriteError('unsupported-content', 'Invalid text array.');
            operands = tokens.slice(start + 1, index - 1);
        } else operands = [tokens[index - 1]];
        if (operands.some((operand) => !['string', 'hex', 'number'].includes(operand.kind))) throw new ContentRewriteError('unsupported-content', 'Invalid text operand.');
        const original = Uint8Array.from(operands.flatMap((operand) => operand.kind === 'number' ? [] : [...tokenBytes(operand)]));
        let leadingAdjustment = 0;
        for (const operand of operands) {
            if (operand.kind !== 'number') break;
            leadingAdjustment += Number(operand.raw);
        }
        const totalAdjustment = operands.reduce((total, operand) => total + (operand.kind === 'number' ? Number(operand.raw) : 0), 0);
        const unit = state.fontSize * state.horizontalScale / 1000;
        const before = state.matrix;
        const baseline = before ? translate(multiply(state.ctm, before), -leadingAdjustment * unit, state.rise) : null;
        if (!before && original.length > 0) {
            let lostText = '';
            try { lostText = fonts.decode(state.fontName, original); } catch { /* reported where it was positioned */ }
            if (lostText && normalizeExtractedText(lostText) === normalizeExtractedText(edit.originalText)) {
                blockedReason ??= 'Its position follows text whose font has no glyph metrics.';
            }
        }
        const atPosition = baseline && equalPosition(baseline[4], edit.origPdfX) && equalPosition(baseline[5], edit.origPdfY);
        let decoded = '';
        if (original.length > 0) {
            try { decoded = fonts.decode(state.fontName, original); }
            catch (error) {
                decoded = '';
                if (atPosition && error instanceof ContentRewriteError) blockedReason ??= error.message;
            }
        }
        const leadingWhitespace = decoded.match(/^\s*/u)?.[0] ?? '';
        let visiblePosition = false;
        let visiblePrefixAdjustment = 0;
        if (baseline && leadingWhitespace && normalizeExtractedText(decoded) === normalizeExtractedText(edit.originalText)) {
            // PDF viewers apply character spacing at the start of the next glyph
            // after a TJ string as well; include that boundary spacing when the
            // editor block starts after an invisible prefix.
            const prefixAdvance = textAdvance(fonts.encode(state.fontName, leadingWhitespace), state, fonts)
                + state.charSpacing * state.horizontalScale;
            const visibleBaseline = translate(baseline, prefixAdvance);
            visiblePosition = equalPosition(visibleBaseline[4], edit.origPdfX) && equalPosition(visibleBaseline[5], edit.origPdfY);
            // The replacement's first visible glyph receives Tc before drawing;
            // compensate that boundary spacing in the TJ offset.
            if (visiblePosition) visiblePrefixAdjustment = -(prefixAdvance - state.charSpacing * state.horizontalScale) / unit;
        }
        let matches = false;
        if ((atPosition || visiblePosition) && original.length > 0) {
            // Byte equality is ideal, but it is not available for grouped text or
            // a pdf.js-normalized source string. Decoding keeps the comparison
            // constrained to this exact show operation and its exact baseline.
            matches = decoded === edit.originalText
                || normalizeExtractedText(decoded) === normalizeExtractedText(edit.originalText);
        }
        let advance: number;
        try {
            advance = textAdvance(original, state, fonts) - totalAdjustment * unit;
        } catch (error) {
            if (matches || !(error instanceof ContentRewriteError)) throw error;
            if (atPosition) blockedReason ??= error.message;
            // A later explicit Tm/Td recovers position without guessing glyph widths.
            state.matrix = null;
            continue;
        }
        if (before) state.matrix = translate(before, advance);
        if (!matches && before && baseline && decoded && pendingRun.length >= 0) {
            const first = pendingRun[0];
            const sameTextState = !first || (
                first.state.fontName === state.fontName
                && first.state.fontSize === state.fontSize
                && first.state.charSpacing === state.charSpacing
                && first.state.wordSpacing === state.wordSpacing
                && first.state.horizontalScale === state.horizontalScale
                && first.state.rise === state.rise
            );
            const startsAtEdit = first
                ? equalPosition(first.baseline[4], edit.origPdfX) && equalPosition(first.baseline[5], edit.origPdfY)
                : atPosition;
            const nextRun: PendingTextRun[] = sameTextState && startsAtEdit
                ? [...pendingRun, { start, end: index + 1, decoded, advance, leadingAdjustment, before, baseline, state: structuredClone(state), prefix }]
                : (atPosition ? [{ start, end: index + 1, decoded, advance, leadingAdjustment, before, baseline, state: structuredClone(state), prefix }] : []);
            const joined = nextRun.map(part => part.decoded).join('');
            const expected = normalizeExtractedText(edit.originalText);
            if (nextRun.length > 1 && normalizeExtractedText(joined) === expected && first) {
                if (state.unsafeFontState || state.renderingMode >= 4 || !Number.isFinite(unit) || Math.abs(unit) < 1e-12) {
                    throw new ContentRewriteError('unsupported-content', 'This text uses unsupported font state or text clipping.');
                }
                if (nextRun.some(part => part.prefix.length > 0)) {
                    // A merged run spanning a `'`/`"` shorthand operator would silently
                    // drop that operator's implicit T*/Tw/Tc side effect if merged into
                    // a single TJ array. Refuse rather than misplace the text.
                    throw new ContentRewriteError('unsupported-content', 'Grouped text spans a line-break shorthand operator.');
                }
                const totalAdvance = nextRun.reduce((total, part) => total + part.advance, 0);
                const firstPart = nextRun[0];
                let bytes: Uint8Array = new Uint8Array();
                let replacementFont = firstPart.state.fontName;
                let groupedFallback = false;
                const keepOriginalRun = !edit.deleted && edit.text === edit.originalText;
                if (!edit.deleted && !keepOriginalRun) {
                    try {
                        bytes = fonts.encode(firstPart.state.fontName, edit.text);
                    } catch {
                        const fallback = fonts.encodeFallback(edit.text);
                        bytes = fallback.bytes;
                        replacementFont = fallback.name;
                        groupedFallback = true;
                    }
                }
                const changedAdvance = replacementFont === firstPart.state.fontName
                    ? textAdvance(bytes, firstPart.state, fonts)
                    : textAdvance(bytes, { ...firstPart.state, fontName: replacementFont }, fonts);
                const correction = changedAdvance / unit - totalAdvance / unit - firstPart.leadingAdjustment;
                let replacement: PdfToken[] = [{ kind: 'arrayStart', raw: '[' }];
                if (firstPart.leadingAdjustment) replacement.push(numeric(firstPart.leadingAdjustment));
                if (bytes.length) replacement.push(literalBytesToken(bytes));
                if (Math.abs(correction) > 1e-8) replacement.push(numeric(correction));
                replacement.push({ kind: 'arrayEnd', raw: ']' }, operation('TJ'));
                if (groupedFallback) replacement.splice(0, 0, operation('q'), { kind: 'name', raw: `/${replacementFont}` }, numeric(firstPart.state.fontSize), operation('Tf'));
                if (groupedFallback) replacement.push(operation('Q'));
                // Preserve the style-only state changes between adjacent show
                // operations. They are replayed after the unified replacement,
                // which leaves the final text state identical for later content.
                replacement.push(...nextRun.slice(1).flatMap((part, partIndex) => tokens.slice(nextRun[partIndex].end, part.start)));
                if (keepOriginalRun) replacement = tokens.slice(firstPart.start, index + 1);
                const moved = !samePosition(edit.pdfX, edit.origPdfX) || !samePosition(edit.pdfY, edit.origPdfY);
                if (moved && !edit.deleted) {
                    if (!state.matrix) throw new ContentRewriteError('unsupported-content', 'Grouped text has no active matrix.');
                    const [dx, dy] = localDelta(state.ctm, edit.pdfX - edit.origPdfX, edit.pdfY - edit.origPdfY);
                    const movedMatrix: Matrix = [...firstPart.before];
                    movedMatrix[4] += dx;
                    movedMatrix[5] += dy;
                    const [lineAdvance, lineVertical] = localDelta(state.lineMatrix,
                        state.matrix[4] - state.lineMatrix[4], state.matrix[5] - state.lineMatrix[5]);
                    if (Math.abs(lineVertical) > 1e-6) throw new ContentRewriteError('unsupported-content', 'Unsupported grouped text line displacement.');
                    replacement = [...matrixTokens(movedMatrix), ...replacement,
                        ...matrixTokens(state.lineMatrix), ...adjustmentTokens(-lineAdvance / unit)];
                }
                candidates.push({ start: firstPart.start, end: index + 1, replacement });
                pendingRun = [];
                continue;
            }
            pendingRun = expected.startsWith(normalizeExtractedText(joined)) ? nextRun : [];
        }
        if (!matches || !before || !state.matrix) continue;
        if (state.unsafeFontState || state.renderingMode >= 4 || !Number.isFinite(unit) || Math.abs(unit) < 1e-12) {
            throw new ContentRewriteError('unsupported-content', 'This text uses unsupported font state or text clipping.');
        }
        const moved = !samePosition(edit.pdfX, edit.origPdfX) || !samePosition(edit.pdfY, edit.origPdfY);
        let replacement: PdfToken[];
        let usedFallback = false;
        if (!edit.deleted && edit.text === edit.originalText) {
            // Moving text must retain all original glyph positioning, including TJ kerning.
            replacement = op === 'TJ' ? tokens.slice(start, index + 1) : [tokens[index - 1], operation('Tj')];
        } else {
            let bytes: Uint8Array = new Uint8Array();
            let replacementFont = state.fontName;
            if (!edit.deleted) {
                try {
                    bytes = fonts.encode(state.fontName, edit.text);
                } catch {
                    // Subset fonts regularly omit otherwise ordinary replacement
                    // glyphs. A Standard 14 Helvetica run is deterministic for
                    // WinAnsi text and is scoped to this show operation.
                    const fallback = fonts.encodeFallback(edit.text);
                    bytes = fallback.bytes;
                    replacementFont = fallback.name;
                    usedFallback = true;
                }
            }
            const changedAdvance = replacementFont === state.fontName
                ? textAdvance(bytes, state, fonts)
                : textAdvance(bytes, { ...state, fontName: replacementFont }, fonts);
            const replacementLeadingAdjustment = leadingAdjustment + visiblePrefixAdjustment;
            const correction = changedAdvance / unit - advance / unit - replacementLeadingAdjustment;
            replacement = [{ kind: 'arrayStart', raw: '[' }];
            if (replacementLeadingAdjustment) replacement.push(numeric(replacementLeadingAdjustment));
            if (bytes.length) replacement.push(literalBytesToken(bytes));
            if (Math.abs(correction) > 1e-8) replacement.push(numeric(correction));
            replacement.push({ kind: 'arrayEnd', raw: ']' }, operation('TJ'));
            if (usedFallback) replacement = [operation('q'), { kind: 'name', raw: `/${replacementFont}` }, numeric(state.fontSize), operation('Tf'), ...replacement, operation('Q')];
        }
        if (moved && !edit.deleted) {
            const [dx, dy] = localDelta(state.ctm, edit.pdfX - edit.origPdfX, edit.pdfY - edit.origPdfY);
            const movedMatrix: Matrix = [...before];
            movedMatrix[4] += dx;
            movedMatrix[5] += dy;
            const [lineAdvance, lineVertical] = localDelta(state.lineMatrix,
                state.matrix[4] - state.lineMatrix[4], state.matrix[5] - state.lineMatrix[5]);
            if (Math.abs(lineVertical) > 1e-6) throw new ContentRewriteError('unsupported-content', 'Unsupported text line displacement.');
            // Reset Tlm, then advance only Tm: following Td, T* and quotes retain their original line.
            replacement = [...matrixTokens(movedMatrix), ...replacement,
                ...matrixTokens(state.lineMatrix), ...adjustmentTokens(-lineAdvance / unit)];
        }
        candidates.push({ start, end: index + 1, replacement: [...prefix, ...replacement] });
    }
    if (!candidates.length && blockedReason) {
        throw new ContentRewriteError('unsupported-content', `The selected text uses a font that cannot be edited safely. ${blockedReason}`);
    }
    return candidates;
};

let glyphUnicode: Map<string, number> | undefined;
/** Resolves a PostScript glyph name from an /Encoding /Differences array to a code point. */
const glyphNameToCodePoint = (name: string) => {
    if (!glyphUnicode) {
        glyphUnicode = new Map();
        for (const encoding of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats]) {
            for (const codePoint of encoding.supportedCodePoints) {
                const glyph = encoding.encodeUnicodeCodePoint(codePoint);
                if (!glyphUnicode.has(glyph.name)) glyphUnicode.set(glyph.name, codePoint);
            }
        }
    }
    const known = glyphUnicode.get(name);
    if (known !== undefined) return known;
    const hex = /^uni([0-9A-F]{4})$/u.exec(name)?.[1] ?? /^u([0-9A-F]{4,6})$/u.exec(name)?.[1];
    const codePoint = hex ? Number.parseInt(hex, 16) : undefined;
    return codePoint !== undefined && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff) ? codePoint : undefined;
};

const getFontResolver = (pdfPage: PDFPage, resourceDictionary = pdfPage.node.Resources(), unicodeFonts: UnicodeFallbackFont[] = []): FontResolver => {
    const resources = resourceDictionary?.lookupMaybe(PDFName.Font, PDFDict);
    type Codec = { encode(text: string): Uint8Array; decode(bytes: Uint8Array): string; width(bytes: Uint8Array): number; characterCount(bytes: Uint8Array): number };
    const codecs = new Map<string, Codec>();
    let fallbackFontName = 'PDFingFallback';
    for (let suffix = 1; resources?.has(PDFName.of(fallbackFontName)); suffix += 1) {
        fallbackFontName = `PDFingFallback${suffix}`;
    }
    let fallbackCodec: Codec | undefined;
    const getFallbackCodec = () => {
        if (fallbackCodec) return fallbackCodec;
        const fallbackStandard = Font.load(FontNames.Helvetica);
        const fallbackCodes = new Map<number, number>();
        const fallbackGlyphs = new Map<number, string>();
        for (const codePoint of Encodings.WinAnsi.supportedCodePoints) {
            const glyph = Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint);
            fallbackCodes.set(codePoint, glyph.code);
            fallbackGlyphs.set(glyph.code, glyph.name);
        }
        fallbackCodec = {
            encode: text => Uint8Array.from([...text].map(character => {
                const code = fallbackCodes.get(character.codePointAt(0) ?? 0);
                if (code === undefined) throw new ContentRewriteError('unsupported-content', 'The replacement character is unavailable in the fallback font.');
                return code;
            })),
            decode: () => { throw new ContentRewriteError('unsupported-content', 'Fallback font decoding is not valid for source matching.'); },
            width: bytes => [...bytes].reduce((total, code) => {
                const glyph = fallbackGlyphs.get(code);
                const width = glyph ? fallbackStandard.getWidthOfGlyph(glyph) : undefined;
                if (width === undefined) throw new ContentRewriteError('unsupported-content', 'Missing fallback glyph metrics.');
                return total + width;
            }, 0),
            characterCount: bytes => bytes.length,
        };
        return fallbackCodec;
    };
    const resolve = (name: string | null): Codec => {
        if (!name) throw new ContentRewriteError('unsupported-content', 'No active font resource.');
        if (name === fallbackFontName) return getFallbackCodec();
        const unicodeFont = unicodeFonts.find(font => font.name === name);
        if (unicodeFont) return {
            encode: unicodeFont.encode,
            decode: () => { throw new ContentRewriteError('unsupported-content', 'Fallback font decoding is not valid for source matching.'); },
            width: unicodeFont.width,
            characterCount: unicodeFont.characterCount,
        };
        const cached = codecs.get(name);
        if (cached) return cached;
        const resource = resources?.get(PDFName.of(name));
        const font = resource ? pdfPage.doc.context.lookupMaybe(resource, PDFDict) : undefined;
        if (!font) throw new ContentRewriteError('unsupported-content', 'Font resource is unavailable.');
        if (font.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Type0') {
            const composite = getCompositeFontCodec(font, pdfPage.doc.context);
            if (!composite) throw new ContentRewriteError('unsupported-content', 'Unsupported composite font encoding.');
            codecs.set(name, composite);
            return composite;
        }
        const rawBaseFont = font.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText();
        // A subsetted font's BaseFont carries a 6-uppercase-letter tag prefix
        // (e.g. "ABCDEF+Helvetica"); strip it before matching a Standard-14 name.
        const baseFont = rawBaseFont?.replace(/^[A-Z]{6}\+/, '');
        const standard = baseFont && Object.values(FontNames).includes(baseFont as FontNames) ? Font.load(baseFont as FontNames) : undefined;
        const glyphNames = new Map<number, string>();
        // Unicode code point → character code according to /Encoding.
        const buildEncodingMap = () => {
            const declaredEncoding = font.lookup(PDFName.of('Encoding'));
            let encodingName = declaredEncoding instanceof PDFName ? declaredEncoding.decodeText() : undefined;
            let differences: PDFArray | undefined;
            if (declaredEncoding instanceof PDFDict) {
                // A simple encoding dictionary is a base encoding plus /Differences
                // naming the glyphs of individual codes (e.g. Word's /Euro at 128).
                encodingName = declaredEncoding.lookupMaybe(PDFName.of('BaseEncoding'), PDFName)?.decodeText();
                differences = declaredEncoding.lookupMaybe(PDFName.of('Differences'), PDFArray);
            } else if (declaredEncoding && !encodingName) throw new ContentRewriteError('unsupported-content', 'Custom font encodings require a dedicated character map.');
            if (encodingName && encodingName !== 'WinAnsiEncoding' && encodingName !== 'StandardEncoding') throw new ContentRewriteError('unsupported-content', 'Unsupported simple font encoding.');
            if (!standard && encodingName !== 'WinAnsiEncoding') throw new ContentRewriteError('unsupported-content', 'The font character encoding is not known.');
            const intrinsic = !encodingName && baseFont === FontNames.Symbol ? Encodings.Symbol
                : !encodingName && baseFont === FontNames.ZapfDingbats ? Encodings.ZapfDingbats : Encodings.WinAnsi;
            const standardEncoding = intrinsic === Encodings.WinAnsi && encodingName !== 'WinAnsiEncoding';
            const characterCodes = new Map<number, number>();
            for (const codePoint of intrinsic.supportedCodePoints) {
                if (standardEncoding && (codePoint < 32 || codePoint > 126 || codePoint === 39 || codePoint === 96)) continue;
                const glyph = intrinsic.encodeUnicodeCodePoint(codePoint);
                glyphNames.set(glyph.code, glyph.name);
                characterCodes.set(codePoint, glyph.code);
            }
            if (standardEncoding) {
                glyphNames.set(39, 'quoteright'); characterCodes.set(0x2019, 39);
                glyphNames.set(96, 'quoteleft'); characterCodes.set(0x2018, 96);
            }
            if (differences) {
                let code: number | undefined;
                for (const entry of differences.asArray()) {
                    const value = pdfPage.doc.context.lookup(entry);
                    if (value instanceof PDFNumber) { code = value.asNumber(); continue; }
                    if (!(value instanceof PDFName) || code === undefined || !Number.isInteger(code) || code < 0 || code > 255) {
                        throw new ContentRewriteError('unsupported-content', 'Invalid font encoding differences.');
                    }
                    const glyphName = value.decodeText();
                    for (const [codePoint, mapped] of characterCodes) if (mapped === code) characterCodes.delete(codePoint);
                    glyphNames.set(code, glyphName);
                    const codePoint = glyphNameToCodePoint(glyphName);
                    if (codePoint !== undefined && !characterCodes.has(codePoint)) characterCodes.set(codePoint, code);
                    code += 1;
                }
            }
            return characterCodes;
        };
        let encodingCodes: Map<number, number> | undefined;
        let encodingError: unknown;
        try { encodingCodes = buildEncodingMap(); }
        catch (error) {
            if (!(error instanceof ContentRewriteError)) throw error;
            encodingError = error;
        }
        // /ToUnicode is what viewers use to extract the text the editor shows, so it
        // is the authoritative decoder and covers encodings /Encoding cannot express
        // (built-in font encodings, MacRoman, private glyph names…).
        const toUnicodeSource = readToUnicode(font, pdfPage.doc.context);
        const toUnicode = toUnicodeSource ? parseToUnicodeCodes(toUnicodeSource, 1) : undefined;
        if (!encodingCodes && !toUnicode) throw encodingError;
        const decodeMap = new Map<number, string>();
        for (const [codePoint, code] of encodingCodes ?? []) if (!decodeMap.has(code)) decodeMap.set(code, String.fromCodePoint(codePoint));
        for (const [code, unicode] of toUnicode ?? []) decodeMap.set(code, unicode);
        const encodeMap = new Map<string, number>();
        for (const [code, unicode] of toUnicode ?? []) {
            if (!encodeMap.has(unicode) || encodingCodes?.get(unicode.codePointAt(0) ?? -1) === code) encodeMap.set(unicode, code);
        }
        // A subset only embeds the glyphs it used, which its ToUnicode lists; other
        // codes of the base encoding would render as missing glyphs.
        const subset = rawBaseFont !== baseFont;
        if (!(subset && toUnicode)) {
            for (const [codePoint, code] of encodingCodes ?? []) {
                const character = String.fromCodePoint(codePoint);
                if (!encodeMap.has(character) && decodeMap.get(code) === character) encodeMap.set(character, code);
            }
        }
        const encodeEntries = [...encodeMap.entries()].sort((left, right) => right[0].length - left[0].length);
        const widths = font.lookupMaybe(PDFName.of('Widths'), PDFArray);
        const firstChar = font.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber();
        const codec: Codec = {
            characterCount: bytes => bytes.length,
            encode: text => {
                const bytes: number[] = [];
                for (let index = 0; index < text.length;) {
                    const match = encodeEntries.find(([unicode]) => text.startsWith(unicode, index));
                    if (!match) throw new ContentRewriteError('unsupported-content', 'The original font cannot encode a replacement character.');
                    bytes.push(match[1]);
                    index += match[0].length;
                }
                return Uint8Array.from(bytes);
            },
            decode: bytes => [...bytes].map(code => {
                const character = decodeMap.get(code);
                if (character === undefined) throw new ContentRewriteError('unsupported-content', 'The original font has an undecodable character code.');
                return character;
            }).join(''),
            width: bytes => [...bytes].reduce((total, code) => {
                let width: number | undefined;
                if (widths && firstChar !== undefined) {
                    const offset = code - firstChar;
                    width = offset >= 0 && offset < widths.size() ? widths.lookupMaybe(offset, PDFNumber)?.asNumber() : undefined;
                } else if (standard) {
                    const glyphName = glyphNames.get(code);
                    width = glyphName ? standard.getWidthOfGlyph(glyphName) ?? undefined : undefined;
                }
                if (width === undefined || !Number.isFinite(width)) throw new ContentRewriteError('unsupported-content', 'Missing glyph metrics.');
                return total + width;
            }, 0),
        };
        codecs.set(name, codec);
        return codec;
    };
    const safely = <T,>(callback: () => T): T => {
        try { return callback(); }
        catch (error) {
            if (error instanceof ContentRewriteError) throw error;
            throw new ContentRewriteError('unsupported-content', error instanceof Error ? error.message : 'Unsupported font data.');
        }
    };
    return {
        encode: (name, text) => safely(() => resolve(name).encode(text)),
        decode: (name, bytes) => safely(() => resolve(name).decode(bytes)),
        width: (name, bytes) => safely(() => resolve(name).width(bytes)),
        characterCount: (name, bytes) => safely(() => resolve(name).characterCount(bytes)),
        fallbackFontName,
        fallbackFontNames: new Set([fallbackFontName, ...unicodeFonts.map(font => font.name)]),
        encodeFallback: text => {
            try { return { bytes: safely(() => getFallbackCodec().encode(text)), name: fallbackFontName }; }
            catch (error) {
                if (!(error instanceof ContentRewriteError)) throw error;
            }
            if (!unicodeFonts.length) throw new ContentRewriteError('fallback-needed', 'A Unicode fallback font is required for this replacement.');
            const font = unicodeFonts.find(candidate => candidate.supports(text));
            if (!font) {
                const missing = [...text].find(character => unicodeFonts.every(candidate => !candidate.supports(character)));
                throw new ContentRewriteError('unsupported-content', missing
                    ? `No bundled Unicode font contains “${missing}”.`
                    : 'No bundled Unicode font can encode this combination of characters.');
            }
            return { bytes: safely(() => font.encode(text)), name: font.name };
        },
    };
};

const installFallbackFont = (pdfPage: PDFPage, name: string) => {
    const context = pdfPage.doc.context;
    const currentResources = pdfPage.node.Resources();
    const resources = PDFDict.withContext(context);
    currentResources?.entries().forEach(([key, value]) => resources.set(key, value));
    const currentFonts = currentResources?.lookupMaybe(PDFName.Font, PDFDict);
    const fonts = PDFDict.withContext(context);
    currentFonts?.entries().forEach(([key, value]) => fonts.set(key, value));
    if (!fonts.has(PDFName.of(name))) {
        const font = context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) as PDFDict);
        fonts.set(PDFName.of(name), font);
    }
    resources.set(PDFName.Font, fonts);
    pdfPage.node.set(PDFName.Resources, resources);
};

const getImageResourceNames = (pdfPage: PDFPage) => {
    const xObjects = pdfPage.node.Resources()?.lookupMaybe(PDFName.XObject, PDFDict);
    return new Set((xObjects?.entries() ?? []).flatMap(([name, resource]) => {
        const stream = pdfPage.doc.context.lookup(resource);
        const subtype = stream instanceof PDFStream ? stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() : undefined;
        return subtype === 'Image' ? [name.decodeText().replace(/^\//u, '')] : [];
    }));
};

const applyPatches = (tokens: PdfToken[], patches: StreamPatch[]) => {
    const ascending = [...patches].sort((left, right) => left.startToken - right.startToken);
    for (let index = 1; index < ascending.length; index += 1) {
        if (ascending[index].startToken < ascending[index - 1].endToken) {
            throw new ContentRewriteError('ambiguous-source', 'Several edits overlap the same PDF operation.');
        }
    }
    const ordered = [...patches].sort((left, right) => right.startToken - left.startToken);
    for (const patch of ordered) tokens.splice(patch.startToken, patch.endToken - patch.startToken, ...patch.replacement);
    return tokens;
};

export interface ContentSourceRewriteRequest {
    pdfPage: PDFPage;
    resources: PDFDict | undefined;
    source: string;
    initialCtm?: Matrix;
    edits: Extract<ContentEdit, { type: 'text' }>[];
    unicodeFonts?: UnicodeFallbackFont[];
}

/**
 * Rewrites text in one already-resolved content stream without mutating its
 * owner. Form traversal uses this to preserve its occurrence CTM and perform
 * clone-on-write only after every requested match has been validated.
 */
export const rewriteContentSource = ({ pdfPage, resources, source, initialCtm = identity(), edits, unicodeFonts = [] }: ContentSourceRewriteRequest) => {
    const tokens = tokenizePdfContent(source);
    const fontResolver = getFontResolver(pdfPage, resources, unicodeFonts);
    const patches: StreamPatch[] = [];
    for (const edit of edits) {
        const matches = findTextCandidates(tokens, edit, fontResolver, initialCtm);
        if (matches.length === 0) throw new ContentRewriteError('source-not-found', 'The selected text could not be found in this content stream.');
        if (matches.length > 1) throw new ContentRewriteError('ambiguous-source', 'The selected text appears more than once in this content stream.');
        patches.push({ startToken: matches[0].start, endToken: matches[0].end, replacement: matches[0].replacement });
    }
    const fallbackFontNames = [...fontResolver.fallbackFontNames].filter(name => patches.some(patch => patch.replacement.some(token => token.kind === 'name' && token.raw === `/${name}`)));
    const rewritten = serializePdfTokens(applyPatches(tokens, patches));
    return { source: Uint8Array.from([...rewritten].map(character => character.charCodeAt(0))), usesFallback: fallbackFontNames.length > 0, fallbackFontName: fontResolver.fallbackFontName, fallbackFontNames };
};

/**
 * Rewrites direct page content streams. It intentionally accepts only source
 * operations that can be identified once and transformed without rasterising.
 */
export const rewriteContentStreams = (pdfPage: PDFPage, edits: ContentEdit[]) => {
    const textEdits = edits.filter((edit): edit is Extract<ContentEdit, { type: 'text' }> => edit.type === 'text' && edit.isDirty);
    const imageEdits = edits.filter((edit): edit is Extract<ContentEdit, { type: 'image' }> => edit.type === 'image' && edit.isDirty);
    if (textEdits.length === 0 && imageEdits.length === 0) return { usedFallbackFont: false };

    const source = getPageStreams(pdfPage).map(getStreamSource).join('\n');
    if (source.includes('<<') || /(?:^|[\s])BI(?:[\s])/u.test(source) || /(?:^|[\s])(?:BDC|DP)(?:[\s])/u.test(source)) {
        throw new ContentRewriteError('unsupported-content', 'The page contains inline image, dictionary, or marked content that cannot be safely rewritten.');
    }
    const tokens = tokenizePdfContent(source);
    const fontResolver = getFontResolver(pdfPage);
    const patches: StreamPatch[] = planImageRewrites(tokens, imageEdits, {
        imageResourceNames: getImageResourceNames(pdfPage),
    });
    for (const edit of textEdits) {
        const matches = findTextCandidates(tokens, edit, fontResolver);
        if (matches.length === 0) throw new ContentRewriteError('source-not-found', 'The selected text could not be found in the page content stream.');
        if (matches.length > 1) throw new ContentRewriteError('ambiguous-source', 'The selected text appears more than once at this position.');
        const match = matches[0];
        patches.push({ startToken: match.start, endToken: match.end, replacement: match.replacement });
    }
    const usesFallback = patches.some(patch => patch.replacement.some(token => token.kind === 'name' && token.raw === `/${fontResolver.fallbackFontName}`));
    const rewritten = serializePdfTokens(applyPatches(tokens, patches));
    if (usesFallback) installFallbackFont(pdfPage, fontResolver.fallbackFontName);
    const replacement = pdfPage.doc.context.flateStream(Uint8Array.from([...rewritten].map((character) => character.charCodeAt(0))));
    const replacementRef = pdfPage.doc.context.register(replacement);
    const contents = PDFArray.withContext(pdfPage.doc.context);
    contents.push(replacementRef);
    pdfPage.node.set(PDFName.Contents, contents);
    return { usedFallbackFont: usesFallback };
};
