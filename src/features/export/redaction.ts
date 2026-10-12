import type { Annotation, ShapeAnnotationData } from '../../types/annotations';

/** Area to black out, as fractions of the displayed page (top-left origin). */
export interface RedactionRect { x: number; y: number; width: number; height: number }

export interface RasterizeRequest {
    /** A one-page PDF holding the page exactly as it would be exported. */
    pdfBytes: Uint8Array;
    /** Clockwise rotation added on top of the page's own /Rotate. */
    rotation: number;
    redactions: RedactionRect[];
}

export interface RasterizedPage {
    bytes: Uint8Array;
    format: 'jpeg' | 'png';
}

/**
 * Renders a page to an image with the redactions painted in, so nothing under
 * them (text, images, vector paths or form values) survives in the output.
 */
export type PageRasterizer = (request: RasterizeRequest) => Promise<RasterizedPage>;

export const isRedaction = (annotation: Annotation) =>
    annotation.type === 'shape' && (annotation.data as ShapeAnnotationData).shapeType === 'redaction';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Redaction areas of a page, normalized to the editor canvas the annotations were drawn on. */
export const getRedactionRects = (annotations: Annotation[], canvas: { width: number; height: number }): RedactionRect[] =>
    annotations.filter(isRedaction).flatMap(annotation => {
        // Cover the whole area of a rotated box.
        const radians = ((Number(annotation.rotation) || 0) * Math.PI) / 180;
        const cos = Math.abs(Math.cos(radians));
        const sin = Math.abs(Math.sin(radians));
        const width = (annotation.width * cos) + (annotation.height * sin);
        const height = (annotation.width * sin) + (annotation.height * cos);
        const centerX = annotation.x + (annotation.width / 2);
        const centerY = annotation.y + (annotation.height / 2);
        const left = clamp01((centerX - (width / 2)) / canvas.width);
        const top = clamp01((centerY - (height / 2)) / canvas.height);
        const right = clamp01((centerX + (width / 2)) / canvas.width);
        const bottom = clamp01((centerY + (height / 2)) / canvas.height);
        return right > left && bottom > top ? [{ x: left, y: top, width: right - left, height: bottom - top }] : [];
    });
