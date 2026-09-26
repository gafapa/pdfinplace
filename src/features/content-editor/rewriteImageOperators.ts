import type { ContentEdit } from './types';
import {
    ContentRewriteError,
    type PdfToken,
    type StreamPatch,
} from './rewriteContentStreams';

type Matrix = [number, number, number, number, number, number];

interface ImageCandidate {
    name: string;
    rawName: string;
    operatorIndex: number;
    matrix: Matrix;
}

export interface ImageRewriteOptions {
    /** Names of page XObjects whose subtype is Image, without the leading slash. */
    imageResourceNames?: ReadonlySet<string>;
    initialMatrix?: Matrix;
}

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
const POSITION_TOLERANCE = 1.25;
const MOVEMENT_EPSILON = 0.000001;

const approximatelyEqual = (left: number, right: number) => Math.abs(left - right) <= POSITION_TOLERANCE;

const matrixProduct = (left: Matrix, right: Matrix): Matrix => [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
];

const inverseMatrix = (matrix: Matrix): Matrix => {
    const [a, b, c, d, e, f] = matrix;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.000001) {
        throw new ContentRewriteError('unsupported-content', 'The image uses a non-invertible transformation.');
    }
    return [
        d / determinant,
        -b / determinant,
        -c / determinant,
        a / determinant,
        (c * f - d * e) / determinant,
        (b * e - a * f) / determinant,
    ];
};

const parseNumber = (token: PdfToken | undefined) => token?.kind === 'number' ? Number(token.raw) : Number.NaN;

const parseTransform = (tokens: PdfToken[], operatorIndex: number): Matrix | null => {
    const values = tokens.slice(operatorIndex - 6, operatorIndex).map(parseNumber);
    return values.length === 6 && values.every(Number.isFinite) ? values as Matrix : null;
};

const boundsFromMatrix = (matrix: Matrix) => {
    const [a, b, c, d, e, f] = matrix;
    const xs = [e, a + e, c + e, a + c + e];
    const ys = [f, b + f, d + f, b + d + f];
    return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
};

const matchesOriginalBounds = (
    matrix: Matrix,
    edit: Extract<ContentEdit, { type: 'image' }>,
) => {
    const bounds = boundsFromMatrix(matrix);
    return approximatelyEqual(bounds.x, edit.origPdfX)
        && approximatelyEqual(bounds.y, edit.origPdfY)
        && approximatelyEqual(bounds.width, edit.origWidth)
        && approximatelyEqual(bounds.height, edit.origHeight);
};

const isMoved = (edit: Extract<ContentEdit, { type: 'image' }>) => (
    Math.abs(edit.pdfX - edit.origPdfX) > MOVEMENT_EPSILON
    || Math.abs(edit.pdfY - edit.origPdfY) > MOVEMENT_EPSILON
    || Math.abs(edit.pdfWidth - edit.origWidth) > MOVEMENT_EPSILON
    || Math.abs(edit.pdfHeight - edit.origHeight) > MOVEMENT_EPSILON
);

const decodePdfName = (name: string) => name.replaceAll(/#([\da-fA-F]{2})/g, (_, hex: string) => (
    String.fromCharCode(Number.parseInt(hex, 16))
));

const targetMatrix = (source: Matrix, edit: Extract<ContentEdit, { type: 'image' }>): Matrix => {
    const width = Math.max(0.01, edit.pdfWidth);
    const height = Math.max(0.01, edit.pdfHeight);
    const horizontalLength = Math.hypot(source[0], source[1]);
    const verticalLength = Math.hypot(source[2], source[3]);
    if (horizontalLength < MOVEMENT_EPSILON || verticalLength < MOVEMENT_EPSILON) {
        throw new ContentRewriteError('unsupported-content', 'The image uses a degenerate transformation.');
    }
    const matrix: Matrix = [
        (source[0] / horizontalLength) * width,
        (source[1] / horizontalLength) * width,
        (source[2] / verticalLength) * height,
        (source[3] / verticalLength) * height,
        0,
        0,
    ];
    const bounds = boundsFromMatrix(matrix);
    matrix[4] = edit.pdfX - bounds.x;
    matrix[5] = edit.pdfY - bounds.y;
    return matrix;
};

const numberToken = (value: number): PdfToken => ({
    kind: 'number',
    raw: Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))),
});

const movedOccurrenceReplacement = (candidate: ImageCandidate, edit: Extract<ContentEdit, { type: 'image' }>): PdfToken[] => {
    const localTransform = matrixProduct(inverseMatrix(candidate.matrix), targetMatrix(candidate.matrix, edit));
    return [
        { kind: 'word', raw: 'q' },
        ...localTransform.map(numberToken),
        { kind: 'word', raw: 'cm' },
        { kind: 'name', raw: candidate.rawName },
        { kind: 'word', raw: 'Do' },
        { kind: 'word', raw: 'Q' },
    ];
};

const collectImageCandidates = (tokens: PdfToken[], options: ImageRewriteOptions) => {
    const candidates: ImageCandidate[] = [];
    const stack: Matrix[] = [];
    let matrix: Matrix = [...(options.initialMatrix ?? IDENTITY_MATRIX)];

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.kind !== 'word') continue;
        if (token.raw === 'BI') {
            throw new ContentRewriteError('unsupported-content', 'Inline images cannot be safely rewritten yet.');
        }
        if (token.raw === 'q') {
            stack.push([...matrix]);
            continue;
        }
        if (token.raw === 'Q') {
            const restored = stack.pop();
            if (!restored) throw new ContentRewriteError('unsupported-content', 'The page content has an unbalanced graphics-state restore.');
            matrix = restored;
            continue;
        }
        if (token.raw === 'cm') {
            const transform = parseTransform(tokens, index);
            if (!transform) throw new ContentRewriteError('unsupported-content', 'The image transformation has invalid operands.');
            matrix = matrixProduct(matrix, transform);
            continue;
        }
        if (token.raw !== 'Do') continue;

        const nameToken = tokens[index - 1];
        if (!nameToken || (nameToken.kind !== 'name' && !nameToken.raw.startsWith('/'))) continue;
        const rawName = nameToken.raw;
        const name = decodePdfName(rawName.slice(1));
        if (options.imageResourceNames && !options.imageResourceNames.has(name)) continue;
        candidates.push({ name, rawName, operatorIndex: index, matrix: [...matrix] });
    }

    if (stack.length > 0) {
        throw new ContentRewriteError('unsupported-content', 'The page content has an unbalanced graphics-state save.');
    }
    return candidates;
};

/**
 * Plans removal or relocation of direct image XObject occurrences. Each change
 * targets a single Do operator, so shared image resources and neighbouring page
 * operations remain intact.
 */
const boundsSignature = (round: (value: number) => number, x: number, y: number, width: number, height: number) =>
    `${round(x)},${round(y)},${round(width)},${round(height)}`;

export const planImageRewrites = (
    tokens: PdfToken[],
    imageEdits: Extract<ContentEdit, { type: 'image' }>[],
    options: ImageRewriteOptions = {},
): StreamPatch[] => {
    const candidates = collectImageCandidates(tokens, options);
    const patches: StreamPatch[] = [];
    const consumedOperators = new Set<number>();

    // Group edits and candidates that share the same rounded bounds signature:
    // when a duplicate stamp/overlay appears N times and N edits target that
    // exact position, pair them by encounter order instead of failing every
    // one of them as ambiguous.
    const round = (value: number) => Math.round(value / (POSITION_TOLERANCE * 2));
    const groupedEdits = new Map<string, Extract<ContentEdit, { type: 'image' }>[]>();
    for (const edit of imageEdits) {
        const key = boundsSignature(round, edit.origPdfX, edit.origPdfY, edit.origWidth, edit.origHeight);
        const group = groupedEdits.get(key);
        if (group) group.push(edit);
        else groupedEdits.set(key, [edit]);
    }
    const preAssigned = new Map<Extract<ContentEdit, { type: 'image' }>, ImageCandidate>();
    for (const [key, edits] of groupedEdits) {
        if (edits.length < 2) continue;
        const matchingCandidates = candidates.filter((candidate) => {
            const bounds = boundsFromMatrix(candidate.matrix);
            return boundsSignature(round, bounds.x, bounds.y, bounds.width, bounds.height) === key;
        });
        if (matchingCandidates.length !== edits.length) continue;
        const orderedCandidates = [...matchingCandidates].sort((a, b) => a.operatorIndex - b.operatorIndex);
        edits.forEach((edit, position) => preAssigned.set(edit, orderedCandidates[position]));
    }

    for (const edit of imageEdits) {
        const assigned = preAssigned.get(edit);
        const matches = assigned ? [assigned] : candidates.filter((candidate) => matchesOriginalBounds(candidate.matrix, edit));
        if (matches.length === 0) {
            throw new ContentRewriteError('source-not-found', 'The selected image could not be found in the page content stream.');
        }
        if (matches.length > 1) {
            throw new ContentRewriteError('ambiguous-source', 'The selected image appears more than once at this position.');
        }

        const candidate = matches[0];
        if (consumedOperators.has(candidate.operatorIndex)) {
            throw new ContentRewriteError('ambiguous-source', 'Several edits target the same image occurrence.');
        }
        consumedOperators.add(candidate.operatorIndex);

        patches.push({
            startToken: candidate.operatorIndex - 1,
            endToken: candidate.operatorIndex + 1,
            replacement: edit.deleted
                ? []
                : isMoved(edit)
                    ? movedOccurrenceReplacement(candidate, edit)
                    : [tokens[candidate.operatorIndex - 1], tokens[candidate.operatorIndex]],
        });
    }

    return patches;
};
