import { describe, expect, it } from 'vitest';
import type { Annotation, DrawingAnnotationData } from '../types/annotations';
import { getEditorCanvasSize, scaleAnnotations, transformAnnotationBounds } from './pageGeometry';

describe('page geometry', () => {
    it('fits A4 pages without introducing editor letterboxing', () => {
        expect(getEditorCanvasSize(595.28, 841.89)).toEqual({
            width: 707,
            height: 1000,
        });
    });

    it('scales drawing points and stroke widths with the canvas', () => {
        const annotation: Annotation = {
            id: 'drawing',
            type: 'drawing',
            x: 10,
            y: 20,
            width: 40,
            height: 60,
            rotation: 0,
            data: {
                points: [{ x: 10, y: 20 }, { x: 50, y: 80 }],
                strokeColor: '#000000',
                strokeWidth: 2,
            } satisfies DrawingAnnotationData,
        };

        const [scaled] = scaleAnnotations(
            [annotation],
            { width: 100, height: 100 },
            { width: 200, height: 300 },
        );
        expect(scaled.x).toBe(20);
        expect(scaled.y).toBe(60);
        expect((scaled.data as DrawingAnnotationData).points[1]).toEqual({ x: 100, y: 240 });
        expect((scaled.data as DrawingAnnotationData).strokeWidth).toBe(4);
    });

    it('moves and resizes the actual points of a drawing annotation', () => {
        const annotation: Annotation = {
            id: 'drawing',
            type: 'drawing',
            x: 10,
            y: 20,
            width: 40,
            height: 60,
            rotation: 0,
            data: {
                points: [{ x: 10, y: 20 }, { x: 50, y: 80 }],
                strokeColor: '#000000',
                strokeWidth: 2,
            } satisfies DrawingAnnotationData,
        };

        const transformed = transformAnnotationBounds(annotation, {
            x: 30,
            y: 40,
            width: 80,
            height: 30,
        });

        expect((transformed.data as DrawingAnnotationData).points).toEqual([
            { x: 30, y: 40 },
            { x: 110, y: 70 },
        ]);
        expect((transformed.data as DrawingAnnotationData).strokeWidth).toBe(1);
    });
});
