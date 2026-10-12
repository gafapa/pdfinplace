import type { PDFDict, PDFDocument, PDFObjectCopier, PDFOperator, PDFPage, PDFRef, PDFStream } from 'pdf-lib';
import { loadPdfLib } from '../../hooks/editorResources';

/** PDF matrix [a b c d e f]: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];
export interface Box { x: number; y: number; width: number; height: number }

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/** The matrix that applies `first`, then `second`. */
export const multiplyMatrices = (first: Matrix, second: Matrix): Matrix => [
    first[0] * second[0] + first[1] * second[2],
    first[0] * second[1] + first[1] * second[3],
    first[2] * second[0] + first[3] * second[2],
    first[2] * second[1] + first[3] * second[3],
    first[4] * second[0] + first[5] * second[2] + second[4],
    first[4] * second[1] + first[5] * second[3] + second[5],
];

export const translationMatrix = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scaleMatrix = (sx: number, sy: number): Matrix => [sx, 0, 0, sy, 0, 0];
export const rotationMatrix = (radians: number): Matrix => {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [cos, sin, -sin, cos, 0, 0];
};

/** Bounding box [x1, y1, x2, y2] of a rectangle after a transform. */
export const transformRect = (matrix: Matrix, [x1, y1, x2, y2]: number[]): [number, number, number, number] => {
    const points = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => [
        matrix[0] * x + matrix[2] * y + matrix[4],
        matrix[1] * x + matrix[3] * y + matrix[5],
    ]);
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const intersectRect = ([x1, y1, x2, y2]: number[], box: Box): [number, number, number, number] | null => {
    const left = Math.max(Math.min(x1, x2), box.x);
    const bottom = Math.max(Math.min(y1, y2), box.y);
    const right = Math.min(Math.max(x1, x2), box.x + box.width);
    const top = Math.min(Math.max(y1, y2), box.y + box.height);
    return right > left && top > bottom ? [left, bottom, right, top] : null;
};

// Annotation flags: Hidden (bit 2) and NoView (bit 6).
const HIDDEN_FLAGS = 2 | 32;

/** A link found on a source page, created once every exported page exists. */
export interface PendingLink {
    target: PDFPage;
    /** Rectangle on the target page. */
    rect: [number, number, number, number];
    sourceDocument: PDFDocument;
    annotation: PDFDict;
}

const readNumbers = async (dict: PDFDict, key: string, length: number) => {
    const { PDFArray, PDFName, PDFNumber } = await loadPdfLib();
    const array = dict.lookupMaybe(PDFName.of(key), PDFArray);
    if (!array || array.size() !== length) return null;
    const values: number[] = [];
    for (let index = 0; index < length; index += 1) {
        const value = array.lookupMaybe(index, PDFNumber)?.asNumber();
        if (value === undefined || !Number.isFinite(value)) return null;
        values.push(value);
    }
    return values;
};

/** The normal appearance stream an annotation currently shows, if any. */
const resolveAppearance = async (annotation: PDFDict, document: PDFDocument): Promise<{ ref: PDFRef; stream: PDFStream } | null> => {
    const { PDFDict: Dict, PDFName, PDFRef: Ref, PDFStream: Stream } = await loadPdfLib();
    const appearances = annotation.lookupMaybe(PDFName.of('AP'), Dict);
    let normal = appearances?.get(PDFName.of('N'));
    if (!normal) return null;
    let resolved = document.context.lookup(normal);
    if (resolved instanceof Dict && !(resolved instanceof Stream)) {
        // Check boxes and radio buttons keep one appearance per state.
        const state = annotation.lookupMaybe(PDFName.of('AS'), PDFName);
        normal = state ? resolved.get(state) : undefined;
        if (!normal) return null;
        resolved = document.context.lookup(normal);
    }
    if (!(resolved instanceof Stream) || !(normal instanceof Ref)) return null;
    return { ref: normal, stream: resolved };
};

/**
 * Draws the annotations of `source` onto `target`, which shows the source page
 * through `transform` (source user space → target user space). Widgets and
 * other annotations with an appearance are flattened into the page content,
 * clipped to the visible box like the page itself; links are returned so the
 * caller can recreate them once every exported page exists.
 */
export const flattenPageAnnotations = async (
    target: PDFPage,
    source: PDFPage,
    sourceDocument: PDFDocument,
    transform: Matrix,
    visibleBox: Box,
    copier: PDFObjectCopier,
): Promise<PendingLink[]> => {
    const pdfLib = await loadPdfLib();
    const { PDFDict: Dict, PDFName, PDFNumber } = pdfLib;
    const annots = source.node.Annots();
    if (!annots) return [];

    const links: PendingLink[] = [];
    const operators: PDFOperator[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
        const annotation = sourceDocument.context.lookupMaybe(annots.get(index), Dict);
        if (!annotation) continue;
        const flags = annotation.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0;
        const subtype = annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
        if (flags & HIDDEN_FLAGS || subtype === 'Popup') continue;
        const rect = await readNumbers(annotation, 'Rect', 4);
        if (!rect) continue;

        if (subtype === 'Link') {
            const visible = intersectRect(rect, visibleBox);
            if (visible) links.push({ target, rect: transformRect(transform, visible), sourceDocument, annotation });
            continue;
        }

        const appearance = await resolveAppearance(annotation, sourceDocument);
        if (!appearance) continue;
        const bbox = await readNumbers(appearance.stream.dict, 'BBox', 4);
        if (!bbox) continue;
        const formMatrix = (await readNumbers(appearance.stream.dict, 'Matrix', 6)) as Matrix | null ?? IDENTITY_MATRIX;
        // PDF 32000-1 §12.5.5: map the transformed BBox onto the annotation rectangle.
        const [bx1, by1, bx2, by2] = transformRect(formMatrix, bbox);
        const [rx1, ry1, rx2, ry2] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
        if (bx2 - bx1 <= 0 || by2 - by1 <= 0 || rx2 - rx1 <= 0 || ry2 - ry1 <= 0) continue;
        const sx = (rx2 - rx1) / (bx2 - bx1);
        const sy = (ry2 - ry1) / (by2 - by1);
        const placement: Matrix = [sx, 0, 0, sy, rx1 - (sx * bx1), ry1 - (sy * by1)];

        const name = target.node.newXObject('FlatAnnot', copier.copy(appearance.ref));
        const opacity = annotation.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber();
        operators.push(pdfLib.pushGraphicsState(), pdfLib.concatTransformationMatrix(...placement));
        if (opacity !== undefined && opacity >= 0 && opacity < 1) {
            const state = target.node.newExtGState('FlatAnnotGS', target.doc.context.obj({ CA: opacity, ca: opacity }));
            operators.push(pdfLib.setGraphicsState(state));
        }
        operators.push(pdfLib.drawObject(name), pdfLib.popGraphicsState());
    }

    if (operators.length > 0) {
        target.pushOperators(
            pdfLib.pushGraphicsState(),
            pdfLib.concatTransformationMatrix(...transform),
            pdfLib.rectangle(visibleBox.x, visibleBox.y, visibleBox.width, visibleBox.height),
            pdfLib.clip(),
            pdfLib.endPath(),
            ...operators,
            pdfLib.popGraphicsState(),
        );
    }
    return links;
};

/**
 * Recreates links on exported pages: web links keep their URI, and links to a
 * page that is also exported point at its new copy. Other actions (scripts,
 * launches, named or remote destinations) are dropped.
 */
export const createPendingLinks = async (
    output: PDFDocument,
    links: PendingLink[],
    resolvePage: (document: PDFDocument, pageRef: PDFRef) => PDFRef | undefined,
) => {
    const { PDFArray, PDFDict: Dict, PDFName, PDFRef: Ref, PDFString, PDFHexString } = await loadPdfLib();
    for (const link of links) {
        const { annotation, sourceDocument } = link;
        let action: PDFDict | undefined;
        const sourceAction = annotation.lookupMaybe(PDFName.of('A'), Dict);
        const kind = sourceAction?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText();
        const toPageDestination = (destination: unknown) => {
            const array = destination instanceof PDFArray ? destination : undefined;
            const pageRef = array?.get(0);
            const resolved = pageRef instanceof Ref ? resolvePage(sourceDocument, pageRef) : undefined;
            return resolved ? output.context.obj([resolved, PDFName.of('Fit')]) : undefined;
        };
        if (sourceAction && kind === 'URI') {
            const uri = sourceAction.lookupMaybe(PDFName.of('URI'), PDFString, PDFHexString);
            // Keep the string object as written; it is already escaped.
            if (uri) action = output.context.obj({ S: 'URI', URI: uri.clone() });
        } else if (sourceAction && kind === 'GoTo') {
            const destination = toPageDestination(sourceDocument.context.lookup(sourceAction.get(PDFName.of('D'))));
            if (destination) action = output.context.obj({ S: 'GoTo', D: destination });
        } else if (!sourceAction) {
            const destination = toPageDestination(sourceDocument.context.lookup(annotation.get(PDFName.of('Dest'))));
            if (destination) action = output.context.obj({ S: 'GoTo', D: destination });
        }
        if (!action) continue;
        const ref = output.context.register(output.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: link.rect,
            Border: [0, 0, 0],
            A: action,
        }));
        link.target.node.addAnnot(ref);
    }
};
