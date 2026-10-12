import type { Annotation, DrawingAnnotationData, ImageAnnotationData, ShapeAnnotationData, TextAnnotationData } from '../../types/annotations';
import { drawShapeOnCanvas } from '../../utils/shapeGeometry';

export interface TextLayout {
    lines: string[];
    lineHeight: number;
    width: number;
    height: number;
}

export const textFont = (data: TextAnnotationData) =>
    `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize}px ${data.fontFamily}`;

/** Lines and box size of a text annotation, measured with the canvas when available. */
export const measureTextLayout = (data: TextAnnotationData, context: CanvasRenderingContext2D | null | undefined): TextLayout => {
    const lines = data.text.split(/\r?\n/);
    const normalizedLines = lines.length > 0 ? lines : [''];
    const lineHeight = data.fontSize * 1.25;
    let measuredWidth: number;
    if (context) {
        context.save();
        context.font = textFont(data);
        measuredWidth = normalizedLines.reduce((max, line) => Math.max(max, context.measureText(line.length > 0 ? line : ' ').width), 0);
        context.restore();
    } else {
        measuredWidth = normalizedLines.reduce((max, line) => Math.max(max, line.length * data.fontSize * 0.55), 0);
    }
    return {
        lines: normalizedLines,
        lineHeight,
        width: Math.max(150, measuredWidth + 20),
        height: Math.max(60, normalizedLines.length * lineHeight + 20),
    };
};

interface EditorCanvasState {
    annotations: Annotation[];
    selectedAnnotationId: string | null;
    /** The text box being typed into is drawn by its textarea instead. */
    editingTextId: string | null;
    /** Drawing or shape currently being dragged out. */
    draft?: { kind: 'path'; points: { x: number; y: number }[]; color: string; strokeWidth: number } | { kind: 'shape'; annotation: Annotation };
    getImage: (dataUrl: string) => HTMLImageElement;
}

const HANDLE_SIZE = 6;

/** Paints the editor's annotation layer, selection handles and the current draft. */
export const drawEditorCanvas = (context: CanvasRenderingContext2D, { annotations, selectedAnnotationId, editingTextId, draft, getImage }: EditorCanvasState) => {
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);

    for (const annotation of annotations) {
        if (editingTextId === annotation.id) continue;
        context.save();
        const centerX = annotation.x + (annotation.width || 0) / 2;
        const centerY = annotation.y + (annotation.height || 0) / 2;
        context.translate(centerX, centerY);
        context.rotate(((Number(annotation.rotation) || 0) * Math.PI) / 180);
        context.translate(-centerX, -centerY);

        if (annotation.type === 'drawing') {
            const data = annotation.data as DrawingAnnotationData;
            context.strokeStyle = data.strokeColor;
            context.lineWidth = data.strokeWidth;
            context.lineCap = 'round';
            context.lineJoin = 'round';
            context.beginPath();
            data.points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
            context.stroke();
        } else if (annotation.type === 'shape') {
            drawShapeOnCanvas(context, annotation, annotation.data as ShapeAnnotationData);
        } else if (annotation.type === 'text') {
            const data = annotation.data as TextAnnotationData;
            context.fillStyle = data.color;
            context.font = textFont(data);
            context.textBaseline = 'top';
            const { lines, lineHeight } = measureTextLayout(data, context);
            lines.forEach((line, index) => context.fillText(line, annotation.x, annotation.y + (index * lineHeight)));
        } else if (annotation.type === 'image' || annotation.type === 'signature') {
            const image = getImage((annotation.data as ImageAnnotationData).dataUrl);
            if (image.complete) context.drawImage(image, annotation.x, annotation.y, annotation.width, annotation.height);
        }

        if (selectedAnnotationId === annotation.id) {
            context.strokeStyle = '#3B82F6';
            context.lineWidth = 1;
            context.setLineDash([5, 5]);
            context.strokeRect(annotation.x - 2, annotation.y - 2, annotation.width + 4, annotation.height + 4);
            context.setLineDash([]);
            context.fillStyle = '#3B82F6';
            for (const [x, y] of [
                [annotation.x, annotation.y],
                [annotation.x + annotation.width, annotation.y],
                [annotation.x, annotation.y + annotation.height],
                [annotation.x + annotation.width, annotation.y + annotation.height],
            ]) {
                context.fillRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
            }
        }
        context.restore();
    }

    if (draft?.kind === 'path' && draft.points.length > 0) {
        context.save();
        context.strokeStyle = draft.color;
        context.lineWidth = draft.strokeWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.beginPath();
        draft.points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
        context.stroke();
        context.restore();
    } else if (draft?.kind === 'shape') {
        context.save();
        drawShapeOnCanvas(context, draft.annotation, draft.annotation.data as ShapeAnnotationData);
        context.restore();
    }
};
