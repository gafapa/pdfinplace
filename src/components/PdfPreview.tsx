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
import { getLegacyEditorCanvasSize } from '../utils/pageGeometry';
import { drawContentEditsPreview } from '../features/content-editor/drawContentEditsPreview';
import type { ContentEdit } from '../features/content-editor/types';

type PdfDocumentProxy = import('pdfjs-dist').PDFDocumentProxy;
type PdfRenderTask = import('pdfjs-dist').RenderTask;
type PdfLoadingTask = import('pdfjs-dist').PDFDocumentLoadingTask;

const cloneArrayBuffer = (buffer: ArrayBuffer) => buffer.slice(0);
const EMPTY_ANNOTATIONS: Annotation[] = [];
const EMPTY_CONTENT_EDITS: ContentEdit[] = [];

export interface PdfPreviewFinishOptions {
    watermarkText: string;
    headerText: string;
    footerText: string;
    includePageNumbers: boolean;
    cropPercent: number;
    marginPercent: number;
    pageNumber: number;
    totalPages: number;
}

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
    showPageBorder?: boolean;
    finishOptions?: PdfPreviewFinishOptions;
}

export const PdfPreview = ({
    file,
    pdfDocument,
    pageIndex = 1,
    width = 200,
    height,
    rotation = 0,
    className = "",
    annotations = EMPTY_ANNOTATIONS,
    contentEdits = EMPTY_CONTENT_EDITS,
    annotationCanvasWidth,
    annotationCanvasHeight,
    showPageBorder = false,
    finishOptions,
}: PdfPreviewProps) => {
    const { t } = useI18n();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [renderedPageSize, setRenderedPageSize] = useState({ width: 0, height: 0 });
    const renderGenerationRef = useRef(0);
    const renderQueueRef = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        let isMounted = true;
        let loadedPdf: PdfDocumentProxy | null = null;
        let renderTask: PdfRenderTask | null = null;
        let loadingTask: PdfLoadingTask | null = null;
        const generation = renderGenerationRef.current + 1;
        renderGenerationRef.current = generation;

        const isCurrentRender = () => isMounted && renderGenerationRef.current === generation;

        const renderPreview = async () => {
            try {
                if (isMounted) {
                    setLoading(true);
                    setError(false);
                }

                if (pdfDocument) {
                    loadedPdf = pdfDocument;
                } else if (file) {
                    const arrayBuffer = await file.arrayBuffer();
                    loadingTask = await getPdfDocument({ data: cloneArrayBuffer(arrayBuffer) });
                    loadedPdf = await loadingTask.promise;
                } else {
                    return;
                }

                if (!isCurrentRender() || !loadedPdf) {
                    if (loadingTask) void loadingTask.destroy();
                    return;
                }

                const page = await loadedPdf.getPage(pageIndex || 1);

                if (!isCurrentRender()) {
                    if (loadingTask) void loadingTask.destroy();
                    return;
                }

                // Native rotation (page.rotate) + user rotation (rotation prop)
                const totalRotation = (page.rotate + rotation) % 360;
                const viewport = page.getViewport({ scale: 1, rotation: totalRotation });

                // Leave a quiet gutter around thumbnail pages so their physical edge remains visible.
                const pageGutter = showPageBorder ? Math.max(6, Math.min(width, height ?? width) * 0.045) : 0;
                const availableWidth = Math.max(1, width - (pageGutter * 2));
                const availableHeight = height ? Math.max(1, height - (pageGutter * 2)) : undefined;
                let scale = availableWidth / viewport.width;
                if (height) {
                    const heightScale = (availableHeight ?? height) / viewport.height;
                    scale = Math.min(scale, heightScale);
                }

                const scaledViewport = page.getViewport({ scale, rotation: totalRotation });

                const canvas = canvasRef.current;
                if (canvas) {
                    const context = canvas.getContext('2d');
                    if (canvas && context) {
                        canvas.height = scaledViewport.height;
                        canvas.width = scaledViewport.width;
                        if (isCurrentRender()) {
                            setRenderedPageSize({
                                width: scaledViewport.width,
                                height: scaledViewport.height,
                            });
                        }

                        const renderContext = {
                            canvas,
                            canvasContext: context,
                            viewport: scaledViewport,
                        };
                        renderTask = page.render(renderContext);
                        await renderTask.promise;

                        if (!isCurrentRender()) return;

                        if (contentEdits.length > 0) {
                            await drawContentEditsPreview(
                                context,
                                [...scaledViewport.transform],
                                contentEdits,
                            );
                        }

                        // Draw annotations on top if provided
                        if (annotations && annotations.length > 0) {
                            const editorBaseWidth = annotationCanvasWidth ?? getLegacyEditorCanvasSize(totalRotation).width;
                            const editorBaseHeight = annotationCanvasHeight ?? getLegacyEditorCanvasSize(totalRotation).height;
                            const annotationScaleX = canvas.width / editorBaseWidth;
                            const annotationScaleY = canvas.height / editorBaseHeight;

                            annotations.forEach(ann => {
                                if (ann.type === 'image' || ann.type === 'signature') {
                                    const data = ann.data as ImageAnnotationData;
                                    let image = imageCacheRef.current.get(data.dataUrl);
                                    if (!image) {
                                        image = new Image();
                                        imageCacheRef.current.set(data.dataUrl, image);
                                    }

                                    const drawLoadedImage = () => {
                                        if (!isCurrentRender()) return;
                                        context.save();
                                        context.scale(annotationScaleX, annotationScaleY);
                                        const centerX = ann.x + (ann.width / 2);
                                        const centerY = ann.y + (ann.height / 2);
                                        context.translate(centerX, centerY);
                                        context.rotate((ann.rotation * Math.PI) / 180);
                                        context.translate(-centerX, -centerY);
                                        context.drawImage(image, ann.x, ann.y, ann.width, ann.height);
                                        context.restore();
                                    };

                                    if (image.complete && image.naturalWidth > 0) {
                                        drawLoadedImage();
                                    } else {
                                        image.onload = drawLoadedImage;
                                        image.onerror = () => {
                                            if (isMounted) setError(true);
                                        };
                                        if (!image.src) image.src = data.dataUrl;
                                    }
                                    return;
                                }

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

        renderQueueRef.current = renderQueueRef.current.then(renderPreview, renderPreview);

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
        showPageBorder,
    ]);

    const normalizedMargin = Math.max(0, Math.min(finishOptions?.marginPercent ?? 0, 20));
    const normalizedCrop = Math.max(0, Math.min(finishOptions?.cropPercent ?? 0, 20));
    const cropZoom = 1 / Math.max(0.2, 1 - ((normalizedCrop * 2) / 100));
    const outputContentScale = (1 - ((normalizedMargin * 2) / 100)) * cropZoom;
    const pageNumberFontSize = Math.max(7, Math.min(10, Math.min(renderedPageSize.width, renderedPageSize.height) * 0.05));
    const watermarkFontSize = Math.max(9, Math.min(18, Math.min(renderedPageSize.width, renderedPageSize.height) * 0.08));
    const normalizedWatermark = finishOptions?.watermarkText.trim() ?? '';
    const normalizedHeader = finishOptions?.headerText.trim() ?? '';
    const normalizedFooter = finishOptions?.footerText.trim() ?? '';

    const canvas = (
        <canvas
            ref={canvasRef}
            className={`${showPageBorder ? 'pdf-preview-output-content absolute' : 'block'} ${loading || error ? 'opacity-0' : 'opacity-100'} transition-opacity motion-reduce:transition-none`}
            style={showPageBorder ? {
                left: '50%',
                top: '50%',
                width: `${outputContentScale * 100}%`,
                height: `${outputContentScale * 100}%`,
                maxWidth: 'none',
                maxHeight: 'none',
                transform: 'translate(-50%, -50%)',
            } : {
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
            }}
        />
    );

    return (
        <div
            className={`relative flex items-center justify-center overflow-hidden ${showPageBorder ? 'pdf-preview-workbench' : 'bg-white shadow-sm'} ${className}`}
            style={{ width, height: height || 'auto' }}
        >
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent motion-reduce:animate-none"></div>
                </div>
            )}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center text-red-500 text-xs text-center p-2 bg-gray-50">
                    {t('preview.error')}
                </div>
            )}
            {showPageBorder ? (
                <div
                    className={`pdf-preview-paper relative overflow-hidden bg-white ${loading || error ? 'invisible' : 'visible'}`}
                    style={{ width: renderedPageSize.width, height: renderedPageSize.height }}
                >
                    {canvas}
                    {normalizedHeader ? (
                        <span
                            aria-hidden="true"
                            className="pdf-preview-header absolute z-[1] truncate"
                            style={{ fontSize: pageNumberFontSize }}
                        >
                            {normalizedHeader}
                        </span>
                    ) : null}
                    {normalizedWatermark ? (
                        <span
                            aria-hidden="true"
                            className="pdf-preview-watermark absolute z-[1] max-w-[84%] truncate"
                            style={{ fontSize: watermarkFontSize }}
                        >
                            {normalizedWatermark}
                        </span>
                    ) : null}
                    {normalizedFooter ? (
                        <span
                            aria-hidden="true"
                            className="pdf-preview-footer absolute z-[1] truncate"
                            style={{ fontSize: pageNumberFontSize }}
                        >
                            {normalizedFooter}
                        </span>
                    ) : null}
                    {finishOptions?.includePageNumbers ? (
                        <span
                            aria-hidden="true"
                            className="pdf-preview-page-number absolute z-[1] tabular-nums"
                            style={{ fontSize: pageNumberFontSize }}
                        >
                            {finishOptions.pageNumber} / {finishOptions.totalPages}
                        </span>
                    ) : null}
                </div>
            ) : canvas}
        </div>
    );
};
