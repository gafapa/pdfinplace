import { useEffect, useRef, useState } from 'react';
import type {
    Annotation,
    DrawingAnnotationData,
    ShapeAnnotationData,
    TextAnnotationData,
    ImageAnnotationData
} from '../types/annotations';
import { useI18n } from '../i18n';
import { getPdfDocument } from '../utils/pdfjs';
import { drawContentEditsPreview } from '../features/content-editor/drawContentEditsPreview';
import type { ContentEdit } from '../features/content-editor/types';

type PdfDocumentProxy = import('pdfjs-dist').PDFDocumentProxy;
type PdfRenderTask = import('pdfjs-dist').RenderTask;
type PdfLoadingTask = import('pdfjs-dist').PDFDocumentLoadingTask;

const cloneArrayBuffer = (buffer: ArrayBuffer) => buffer.slice(0);
const EMPTY_CONTENT_EDITS: ContentEdit[] = [];

interface PdfPreviewProps {
    file?: File;
    pdfDocument?: PdfDocumentProxy;
    pageIndex?: number;
    width?: number; // Treat as maxWidth if height is also provided
    height?: number; // Optional maxHeight
    rotation?: number;
    className?: string;
    annotations?: Annotation[];
    contentEdits?: ContentEdit[];
    annotationCanvasWidth?: number;
    annotationCanvasHeight?: number;
}

export const PdfPreview = ({
    file,
    pdfDocument,
    pageIndex = 1,
    width = 200,
    height,
    rotation = 0,
    className = "",
    annotations = [],
    contentEdits = EMPTY_CONTENT_EDITS,
    annotationCanvasWidth,
    annotationCanvasHeight,
}: PdfPreviewProps) => {
    const { t } = useI18n();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let isMounted = true;
        let loadedPdf: PdfDocumentProxy | null = null;
        let renderTask: PdfRenderTask | null = null;
        let loadingTask: PdfLoadingTask | null = null;

        const renderPreview = async () => {
            try {
                setLoading(true);
                setError(false);

                if (pdfDocument) {
                    loadedPdf = pdfDocument;
                } else if (file) {
                    const arrayBuffer = await file.arrayBuffer();
                    loadingTask = await getPdfDocument({ data: cloneArrayBuffer(arrayBuffer) });
                    loadedPdf = await loadingTask.promise;
                } else {
                    return;
                }

                if (!isMounted || !loadedPdf) return;

                const page = await loadedPdf.getPage(pageIndex || 1);

                if (!isMounted) return;

                // Native rotation (page.rotate) + user rotation (rotation prop)
                const totalRotation = (page.rotate + rotation) % 360;
                const viewport = page.getViewport({ scale: 1, rotation: totalRotation });

                // Calculate scale to fit within width/height bounds
                let scale = width / viewport.width;
                if (height) {
                    const heightScale = height / viewport.height;
                    scale = Math.min(scale, heightScale);
                }

                const scaledViewport = page.getViewport({ scale, rotation: totalRotation });

                const canvas = canvasRef.current;
                if (canvas) {
                    const context = canvas.getContext('2d');
                    if (canvas && context) {
                        canvas.height = scaledViewport.height;
                        canvas.width = scaledViewport.width;

                        const renderContext = {
                            canvas,
                            canvasContext: context,
                            viewport: scaledViewport,
                        };
                        renderTask = page.render(renderContext);
                        await renderTask.promise;

                        if (contentEdits.length > 0) {
                            await drawContentEditsPreview(
                                context,
                                [...scaledViewport.transform],
                                contentEdits,
                            );
                        }

                        // Draw annotations on top if provided
                        if (annotations && annotations.length > 0) {
                            const editorBaseWidth = annotationCanvasWidth ?? (totalRotation % 180 === 0 ? 800 : 1000);
                            const editorBaseHeight = annotationCanvasHeight ?? (totalRotation % 180 === 0 ? 1000 : 800);
                            const annotationScaleX = canvas.width / editorBaseWidth;
                            const annotationScaleY = canvas.height / editorBaseHeight;

                            annotations.forEach(ann => {
                                context.save();
                                context.scale(annotationScaleX, annotationScaleY);
                                const centerX = ann.x + (ann.width / 2);
                                const centerY = ann.y + (ann.height / 2);
                                context.translate(centerX, centerY);
                                context.rotate((ann.rotation * Math.PI) / 180);
                                context.translate(-centerX, -centerY);
                                
                                if (ann.type === 'drawing') {
                                    const data = ann.data as DrawingAnnotationData;
                                    context.strokeStyle = data.strokeColor;
                                    context.lineWidth = data.strokeWidth;
                                    context.lineCap = 'round';
                                    context.lineJoin = 'round';
                                    context.beginPath();
                                    data.points.forEach((point, i: number) => {
                                        if (i === 0) context.moveTo(point.x, point.y);
                                        else context.lineTo(point.x, point.y);
                                    });
                                    context.stroke();
                                } else if (ann.type === 'shape') {
                                    const data = ann.data as ShapeAnnotationData;
                                    context.strokeStyle = data.strokeColor;
                                    context.lineWidth = data.strokeWidth;
                                    if (data.fillColor) {
                                        context.fillStyle = data.fillColor;
                                    }

                                    if (data.shapeType === 'rectangle') {
                                        context.strokeRect(ann.x, ann.y, ann.width, ann.height);
                                    } else if (data.shapeType === 'circle') {
                                        context.beginPath();
                                        context.ellipse(ann.x + ann.width / 2, ann.y + ann.height / 2, Math.abs(ann.width / 2), Math.abs(ann.height / 2), 0, 0, 2 * Math.PI);
                                        context.stroke();
                                    } else if (data.shapeType === 'line') {
                                        context.beginPath();
                                        const x1 = ann.x + (data.x1 ?? 0) * ann.width;
                                        const y1 = ann.y + (data.y1 ?? 0) * ann.height;
                                        const x2 = ann.x + (data.x2 ?? 1) * ann.width;
                                        const y2 = ann.y + (data.y2 ?? 1) * ann.height;
                                        context.moveTo(x1, y1);
                                        context.lineTo(x2, y2);
                                        context.stroke();
                                    }
                                } else if (ann.type === 'text') {
                                    const data = ann.data as TextAnnotationData;
                                    context.fillStyle = data.color;
                                    context.font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize}px ${data.fontFamily}`;
                                    context.textBaseline = 'top';
                                    const lines = data.text.split(/\r?\n/);
                                    const normalizedLines = lines.length > 0 ? lines : [''];
                                    const lineHeight = data.fontSize * 1.25;
                                    normalizedLines.forEach((line, index) => {
                                        context.fillText(line, ann.x, ann.y + (index * lineHeight));
                                    });
                                } else if (ann.type === 'image' || ann.type === 'signature') {
                                    const data = ann.data as ImageAnnotationData;
                                    let img = imageCacheRef.current.get(data.dataUrl);
                                    if (!img) {
                                        img = new Image();
                                        imageCacheRef.current.set(data.dataUrl, img);
                                    }
                                    if (img.complete) {
                                        context.drawImage(img, ann.x, ann.y, ann.width, ann.height);
                                    } else {
                                        img.onload = () => {
                                            if (!isMounted) return;
                                            context.save();
                                            context.scale(annotationScaleX, annotationScaleY);
                                            context.drawImage(img, ann.x, ann.y, ann.width, ann.height);
                                            context.restore();
                                        };
                                        img.src = data.dataUrl;
                                    }
                                }

                                context.restore();
                            });
                        }
                    }
                }
            } catch (err: unknown) {
                if (!(err instanceof Error) || err.name !== 'RenderingCancelledException') {
                    console.error("Error previewing PDF:", err);
                    if (isMounted) setError(true);
                }
            } finally {
                if (isMounted) setLoading(false);
            }
        };

        renderPreview();

        return () => {
            isMounted = false;
            if (renderTask) {
                renderTask.cancel();
            }
            if (loadingTask) {
                void loadingTask.destroy();
            }
        };
    }, [
        file,
        pdfDocument,
        pageIndex,
        width,
        height,
        rotation,
        annotations,
        contentEdits,
        annotationCanvasWidth,
        annotationCanvasHeight,
    ]);

    return (
        <div className={`relative bg-white shadow-sm overflow-hidden flex items-center justify-center ${className}`} style={{ width, height: height || 'auto' }}>
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
            )}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center text-red-500 text-xs text-center p-2 bg-gray-50">
                    {t('preview.error')}
                </div>
            )}
            <canvas
                ref={canvasRef}
                className={`block ${loading || error ? 'opacity-0' : 'opacity-100'} transition-opacity`}
                style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain'
                }}
            />
        </div>
    );
};
