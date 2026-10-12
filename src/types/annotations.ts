type AnnotationType = 'text' | 'drawing' | 'shape' | 'signature' | 'image';

export interface TextAnnotationData {
    text: string;
    fontSize: number;
    fontFamily: string;
    color: string;
    bold: boolean;
    italic: boolean;
}
export interface DrawingAnnotationData {
    points: { x: number; y: number }[];
    strokeColor: string;
    strokeWidth: number;
}

export interface ShapeAnnotationData {
    /** 'redaction' boxes black out the area: the page is exported as an image. */
    shapeType: 'rectangle' | 'circle' | 'line' | 'arrow' | 'highlight' | 'redaction';
    strokeColor: string;
    fillColor: string;
    /** Fill opacity from 0 to 1; highlights default to a translucent fill. */
    fillOpacity?: number;
    strokeWidth: number;
    // For lines to prevent flipping
    x1?: number; // relative 0-1
    y1?: number;
    x2?: number;
    y2?: number;
}

interface SignatureAnnotationData {
    dataUrl: string; // Base64 image of signature
}

export interface ImageAnnotationData {
    dataUrl: string;
    originalWidth: number;
    originalHeight: number;
}

export interface Annotation {
    id: string;
    type: AnnotationType;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    data: TextAnnotationData | DrawingAnnotationData | ShapeAnnotationData | SignatureAnnotationData | ImageAnnotationData;
}
