import type { Annotation, DrawingAnnotationData } from '../types/annotations';

export interface EditorCanvasSize {
    width: number;
    height: number;
}

const PORTRAIT_MAX_SIZE: EditorCanvasSize = { width: 800, height: 1000 };
const LANDSCAPE_MAX_SIZE: EditorCanvasSize = { width: 1000, height: 800 };

export const getEditorCanvasSize = (pageWidth: number, pageHeight: number): EditorCanvasSize => {
    const safeWidth = Math.max(1, pageWidth);
    const safeHeight = Math.max(1, pageHeight);
    const bounds = safeWidth >= safeHeight ? LANDSCAPE_MAX_SIZE : PORTRAIT_MAX_SIZE;
    const scale = Math.min(bounds.width / safeWidth, bounds.height / safeHeight);

    return {
        width: Math.max(1, Math.round(safeWidth * scale)),
        height: Math.max(1, Math.round(safeHeight * scale)),
    };
};

export const getLegacyEditorCanvasSize = (rotation: number): EditorCanvasSize =>
    rotation % 180 === 0 ? PORTRAIT_MAX_SIZE : LANDSCAPE_MAX_SIZE;

export const scaleAnnotations = (
    annotations: Annotation[],
    source: EditorCanvasSize,
    target: EditorCanvasSize,
): Annotation[] => {
    if (source.width === target.width && source.height === target.height) {
        return annotations.map((annotation) => structuredClone(annotation));
    }

    const scaleX = target.width / Math.max(1, source.width);
    const scaleY = target.height / Math.max(1, source.height);

    return annotations.map((annotation) => {
        if (annotation.type === 'drawing') {
            const data = annotation.data as DrawingAnnotationData;
            return {
                ...structuredClone(annotation),
                x: annotation.x * scaleX,
                y: annotation.y * scaleY,
                width: annotation.width * scaleX,
                height: annotation.height * scaleY,
                data: {
                    ...data,
                    strokeWidth: data.strokeWidth * Math.min(scaleX, scaleY),
                    points: data.points.map((point) => ({
                        x: point.x * scaleX,
                        y: point.y * scaleY,
                    })),
                },
            };
        }

        return {
            ...structuredClone(annotation),
            x: annotation.x * scaleX,
            y: annotation.y * scaleY,
            width: annotation.width * scaleX,
            height: annotation.height * scaleY,
        };
    });
};
