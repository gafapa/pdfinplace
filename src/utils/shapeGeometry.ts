import type { Annotation, ShapeAnnotationData } from '../types/annotations';

export interface Point { x: number; y: number }

/** Opacity used for new highlights; the multiply blend keeps text beneath readable. */
export const HIGHLIGHT_OPACITY = 0.4;
export const DEFAULT_HIGHLIGHT_COLOR = '#ffd60a';
/** Redactions are always opaque black, as they appear in the exported image. */
export const REDACTION_COLOR = '#000000';

export const getLineEndpoints = (annotation: Pick<Annotation, 'x' | 'y' | 'width' | 'height'>, data: ShapeAnnotationData) => ({
    start: { x: annotation.x + (data.x1 ?? 0) * annotation.width, y: annotation.y + (data.y1 ?? 0) * annotation.height },
    end: { x: annotation.x + (data.x2 ?? 1) * annotation.width, y: annotation.y + (data.y2 ?? 1) * annotation.height },
});

/**
 * Arrow head as a triangle at `end`, and where the shaft should stop so a
 * thick stroke does not poke through the tip.
 */
export const getArrowHead = (start: Point, end: Point, strokeWidth: number) => {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const headLength = Math.min(Math.max(10, strokeWidth * 4), Math.max(1, length * 0.6));
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const spread = Math.PI / 7;
    const wing = (side: 1 | -1) => ({
        x: end.x - headLength * Math.cos(angle + side * spread),
        y: end.y - headLength * Math.sin(angle + side * spread),
    });
    const baseDistance = headLength * Math.cos(spread);
    return {
        tip: end,
        left: wing(1),
        right: wing(-1),
        shaftEnd: {
            x: end.x - baseDistance * Math.cos(angle),
            y: end.y - baseDistance * Math.sin(angle),
        },
    };
};

/** Draws a shape annotation on a 2D canvas in editor coordinates. */
export const drawShapeOnCanvas = (context: CanvasRenderingContext2D, annotation: Annotation, data: ShapeAnnotationData) => {
    if (data.shapeType === 'redaction') {
        context.fillStyle = REDACTION_COLOR;
        context.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
        return;
    }
    const stroke = data.strokeWidth > 0 && data.shapeType !== 'highlight';
    context.strokeStyle = data.strokeColor;
    if (stroke) context.lineWidth = data.strokeWidth;
    const fill = () => {
        if (!data.fillColor) return false;
        context.fillStyle = data.fillColor;
        context.globalAlpha = data.fillOpacity ?? (data.shapeType === 'highlight' ? HIGHLIGHT_OPACITY : 1);
        if (data.shapeType === 'highlight') context.globalCompositeOperation = 'multiply';
        return true;
    };
    const resetFill = () => {
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'source-over';
    };

    if (data.shapeType === 'rectangle' || data.shapeType === 'highlight') {
        if (fill()) {
            context.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
            resetFill();
        }
        if (stroke) context.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
    } else if (data.shapeType === 'circle') {
        context.beginPath();
        context.ellipse(
            annotation.x + annotation.width / 2,
            annotation.y + annotation.height / 2,
            Math.max(0.1, Math.abs(annotation.width / 2)),
            Math.max(0.1, Math.abs(annotation.height / 2)),
            0, 0, 2 * Math.PI,
        );
        if (fill()) {
            context.fill();
            resetFill();
        }
        if (stroke) context.stroke();
    } else if (data.shapeType === 'line' || data.shapeType === 'arrow') {
        const { start, end } = getLineEndpoints(annotation, data);
        const head = data.shapeType === 'arrow' ? getArrowHead(start, end, data.strokeWidth) : null;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(head ? head.shaftEnd.x : end.x, head ? head.shaftEnd.y : end.y);
        if (stroke) context.stroke();
        if (head) {
            context.fillStyle = data.strokeColor;
            context.beginPath();
            context.moveTo(head.tip.x, head.tip.y);
            context.lineTo(head.left.x, head.left.y);
            context.lineTo(head.right.x, head.right.y);
            context.closePath();
            context.fill();
        }
    }
};
