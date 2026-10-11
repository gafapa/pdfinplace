import type { EditorOperationController } from './useEditorOperation';
import type { OperationTask } from '../utils/editorOperation';
import { useCallback } from 'react';
import type { PDFPage, PDFDocument } from 'pdf-lib';
import type { Annotation, TextAnnotationData, DrawingAnnotationData, ShapeAnnotationData } from '../types/annotations';
import { loadPdfDocumentWithTask, type LoadedPdfDocument } from '../utils/pdfjs';
import { MAX_RENDER_PIXELS, MAX_IMAGE_PIXELS, isAcceptedUnlockPdf } from '../utils/importValidation';
import { getDataUrlImageKind, readImageDimensions } from '../utils/imageValidation';
import { getLegacyEditorCanvasSize } from '../utils/pageGeometry';
import { orderItemsByIds } from '../utils/orderedSelection';
import { getImageExportFilename, getImageExportFormatDetails, getImageExportRenderScale, normalizeImageExportQuality } from '../utils/imageExport';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions, ExportLabels, SplitPdfLabels, ImageExportLabels, ImageExportOptions, ProtectPdfLabels, UnlockPdfLabels } from './editorTypes';
import { loadPdfLib, loadContentEditExporter, getOverlayFont, toArrayBuffer, cloneArrayBuffer, PAGE_SIZES, getContentBox, getCropZoom, hexToRgb, isImageLikeAnnotation, downloadPdfBytes, downloadBlob, canvasToPngBytes, canvasToImageBlob, MAX_IMAGE_EXPORT_TOTAL_PIXELS, ImageExportLimitError, ContentEditExportError, exportFailureMessage, isLikelyInvalidPasswordError, releasePdfDocument } from './editorResources';

interface ExportContext {
    files: Record<string, EditorFile>;
    pages: EditorPage[];
    pageSize: PageSize;
    printOverlayOptions: PrintOverlayOptions;
    operationController: EditorOperationController;
    notifyError: (message: string) => void;
    notifySuccess: (message: string) => void;
}
export const usePdfExport = ({ files, pages, pageSize, printOverlayOptions, operationController, notifyError, notifySuccess }: ExportContext) => {
    const { beginOperation, finishOperation } = operationController;
    const applyAnnotationsToPage = useCallback(async (
        pdfPage: PDFPage,
        annotations: Annotation[],
        pageHeight: number,
        pageWidth: number,
        editorCanvasWidth: number,
        editorCanvasHeight: number,
    ) => {
        const pdfLib = await loadPdfLib();
        const marginPercent = Math.max(0, Math.min(printOverlayOptions.marginPercent, 20));
        const cropPercent = Math.max(0, Math.min(printOverlayOptions.cropPercent, 20));
        const cropZoom = getCropZoom(cropPercent);
        const contentBox = getContentBox(pageWidth, pageHeight, marginPercent);
        const safeEditorWidth = Math.max(1, editorCanvasWidth);
        const safeEditorHeight = Math.max(1, editorCanvasHeight);
        const scaleX = (contentBox.width / safeEditorWidth) * cropZoom;
        const scaleY = (contentBox.height / safeEditorHeight) * cropZoom;
        const cropInsetX = (safeEditorWidth * cropPercent) / 100;
        const cropInsetY = (safeEditorHeight * cropPercent) / 100;

        const transformCoords = (x: number, y: number) => {
            return {
                x: contentBox.x + ((x - cropInsetX) * scaleX),
                y: contentBox.y + contentBox.height - ((y - cropInsetY) * scaleY)
            };
        };

        const getStandardFontName = (data: TextAnnotationData) => {
            const isSerif = data.fontFamily === 'Times New Roman' || data.fontFamily === 'Georgia';
            const isMonospace = data.fontFamily === 'Courier New';

            if (isSerif) {
                if (data.bold && data.italic) return pdfLib.StandardFonts.TimesRomanBoldItalic;
                if (data.bold) return pdfLib.StandardFonts.TimesRomanBold;
                if (data.italic) return pdfLib.StandardFonts.TimesRomanItalic;
                return pdfLib.StandardFonts.TimesRoman;
            }
            if (isMonospace) {
                if (data.bold && data.italic) return pdfLib.StandardFonts.CourierBoldOblique;
                if (data.bold) return pdfLib.StandardFonts.CourierBold;
                if (data.italic) return pdfLib.StandardFonts.CourierOblique;
                return pdfLib.StandardFonts.Courier;
            }
            if (data.bold && data.italic) return pdfLib.StandardFonts.HelveticaBoldOblique;
            if (data.bold) return pdfLib.StandardFonts.HelveticaBold;
            if (data.italic) return pdfLib.StandardFonts.HelveticaOblique;
            return pdfLib.StandardFonts.Helvetica;
        };

        const fontCache = new Map<string, Awaited<ReturnType<typeof pdfPage.doc.embedFont>>>();
        const getFont = async (data: TextAnnotationData) => {
            const fontName = getStandardFontName(data);
            const cached = fontCache.get(fontName);
            if (cached) return cached;
            const font = await pdfPage.doc.embedFont(fontName);
            fontCache.set(fontName, font);
            return font;
        };

        const drawRasterizedTextLine = async (
            line: string,
            data: TextAnnotationData,
            x: number,
            topY: number,
            lineHeight: number,
            rotation: number,
        ) => {
            const renderScale = 2;
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Text fallback canvas is unavailable.');

            context.font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize * renderScale}px ${data.fontFamily}`;
            const measuredWidth = Math.max(1, Math.ceil(context.measureText(line || ' ').width));
            canvas.width = measuredWidth + 4;
            canvas.height = Math.max(1, Math.ceil(lineHeight * renderScale));
            context.scale(renderScale, renderScale);
            context.font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize}px ${data.fontFamily}`;
            context.fillStyle = data.color || '#000000';
            context.textBaseline = 'top';
            context.fillText(line || ' ', 1, 0);

            const image = await pdfPage.doc.embedPng(await canvasToPngBytes(canvas));
            const imageWidth = (canvas.width / renderScale) * scaleX;
            const imageHeight = lineHeight * scaleY;
            pdfPage.drawImage(image, {
                x,
                y: topY - imageHeight,
                width: imageWidth,
                height: imageHeight,
                rotate: pdfLib.degrees(-rotation),
            });
        };

        for (const ann of annotations) {
            const { x, y } = transformCoords(ann.x, ann.y);
            const width = ann.width * scaleX;
            const height = ann.height * scaleY;

            if (ann.type === 'text') {
                const data = ann.data as TextAnnotationData;
                const font = await getFont(data);

                const renderedLines = data.text.split(/\r?\n/);
                const lines = renderedLines.length > 0 ? renderedLines : [''];
                const scaledFontSize = data.fontSize * scaleY;
                const lineHeight = scaledFontSize * 1.25;
                const editorLineHeight = data.fontSize * 1.25;

                for (const [index, line] of lines.entries()) {
                    const lineTopY = y - (index * lineHeight);
                    try {
                        font.encodeText(line.length > 0 ? line : ' ');
                    } catch {
                        await drawRasterizedTextLine(
                            line,
                            data,
                            x,
                            lineTopY,
                            editorLineHeight,
                            ann.rotation,
                        );
                        continue;
                    }

                    pdfPage.drawText(line.length > 0 ? line : ' ', {
                        x,
                        y: lineTopY - scaledFontSize,
                        size: scaledFontSize,
                        font,
                        color: hexToRgb(data.color || '#000000', pdfLib.rgb),
                        rotate: pdfLib.degrees(-ann.rotation),
                    });
                }
            } else if (ann.type === 'drawing') {
                const data = ann.data as DrawingAnnotationData;
                const points = data.points;
                if (points.length < 2) continue;

                for (let i = 0; i < points.length - 1; i++) {
                    const p1 = transformCoords(points[i].x, points[i].y);
                    const p2 = transformCoords(points[i + 1].x, points[i + 1].y);
                    pdfPage.drawLine({
                        start: p1,
                        end: p2,
                        thickness: data.strokeWidth * Math.min(scaleX, scaleY),
                        color: hexToRgb(data.strokeColor, pdfLib.rgb),
                    });
                }
            } else if (ann.type === 'shape') {
                const data = ann.data as ShapeAnnotationData;
                const color = hexToRgb(data.strokeColor, pdfLib.rgb);
                const fill = data.fillColor ? hexToRgb(data.fillColor, pdfLib.rgb) : undefined;
                const thickness = data.strokeWidth * Math.min(scaleX, scaleY);

                if (data.shapeType === 'rectangle') {
                        const p1 = transformCoords(ann.x, ann.y);
                        const p2 = transformCoords(ann.x + ann.width, ann.y);
                        const p3 = transformCoords(ann.x + ann.width, ann.y + ann.height);
                        const p4 = transformCoords(ann.x, ann.y + ann.height);

                        if (fill) {
                            // transformCoords only scales and flips Y, so p4 is the bottom-left corner.
                            pdfPage.drawRectangle({ x: p4.x, y: p4.y, width: ann.width * scaleX, height: ann.height * scaleY, color: fill });
                        }

                        const drawLine = (start: { x: number; y: number }, end: { x: number; y: number }) =>
                            pdfPage.drawLine({ start, end, thickness, color });
                        drawLine(p1, p2);
                        drawLine(p2, p3);
                        drawLine(p3, p4);
                        drawLine(p4, p1);

                } else if (data.shapeType === 'circle') {
                        const cx = ann.x + ann.width / 2;
                        const cy = ann.y + ann.height / 2;
                        const center = transformCoords(cx, cy);
                    const rx = (ann.width / 2) * scaleX;
                    const ry = (ann.height / 2) * scaleY;

                        pdfPage.drawEllipse({
                            x: center.x,
                            y: center.y,
                            xScale: rx,
                            yScale: ry,
                            color: fill, borderColor: color, borderWidth: thickness,
                        });
                } else if (data.shapeType === 'line') {
                        const x1 = ann.x + (data.x1 ?? 0) * ann.width;
                        const y1 = ann.y + (data.y1 ?? 0) * ann.height;
                        const x2 = ann.x + (data.x2 ?? 1) * ann.width;
                        const y2 = ann.y + (data.y2 ?? 1) * ann.height;

                        pdfPage.drawLine({
                            start: transformCoords(x1, y1),
                            end: transformCoords(x2, y2),
                            thickness, color,
                        });
                }
            } else if (isImageLikeAnnotation(ann)) {
                const dataUrl = ann.data.dataUrl;
                const imageKind = getDataUrlImageKind(dataUrl);
                if (!imageKind) {
                    throw new Error('An annotation contains an unsupported image format.');
                }
                const response = await fetch(dataUrl);
                if (!response.ok) {
                    throw new Error('An annotation image could not be read.');
                }
                const imageBytes = await response.arrayBuffer();
                const dimensions = readImageDimensions(imageBytes);
                if (!dimensions || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
                    throw new Error('An annotation image is invalid or too large.');
                }
                const image = imageKind === 'png'
                    ? await pdfPage.doc.embedPng(imageBytes)
                    : await pdfPage.doc.embedJpg(imageBytes);

                pdfPage.drawImage(image, {
                    x,
                    y: y - height,
                    width,
                    height,
                    rotate: pdfLib.degrees(-ann.rotation),
                });
            }
        }
    }, [printOverlayOptions]);

    const applyPrintOverlays = useCallback(async (
        pdfPage: PDFPage,
        pageNumber: number,
        totalPages: number,
    ) => {
        const pdfLib = await loadPdfLib();
        const { width, height } = pdfPage.getSize();
        const normalizedWatermark = printOverlayOptions.watermarkText.trim();
        const normalizedHeader = printOverlayOptions.headerText.trim();
        const normalizedFooter = printOverlayOptions.footerText.trim();
        const overlayFont = await getOverlayFont(
            pdfPage.doc,
            [normalizedWatermark, normalizedHeader, normalizedFooter],
            pdfLib,
        );

        if (normalizedWatermark) {
            const watermarkSize = Math.max(36, Math.min(width, height) * 0.08);
            const watermarkWidth = overlayFont.widthOfTextAtSize(normalizedWatermark, watermarkSize);

            pdfPage.drawText(normalizedWatermark, {
                x: (width - watermarkWidth) / 2,
                y: height / 2,
                size: watermarkSize,
                font: overlayFont,
                color: pdfLib.rgb(0.72, 0.72, 0.72),
                opacity: 0.22,
                rotate: pdfLib.degrees(35),
            });
        }

        if (printOverlayOptions.includePageNumbers) {
            const label = `${pageNumber} / ${totalPages}`;
            const labelSize = Math.max(9, Math.min(width, height) * 0.018);
            const labelWidth = overlayFont.widthOfTextAtSize(label, labelSize);

            pdfPage.drawText(label, {
                x: width - labelWidth - 24,
                y: 18,
                size: labelSize,
                font: overlayFont,
                color: pdfLib.rgb(0.35, 0.35, 0.35),
            });
        }

        if (normalizedHeader) {
            const headerSize = Math.max(10, Math.min(width, height) * 0.018);
            pdfPage.drawText(normalizedHeader, {
                x: 24,
                y: height - headerSize - 18,
                size: headerSize,
                font: overlayFont,
                color: pdfLib.rgb(0.35, 0.35, 0.35),
            });
        }

        if (normalizedFooter) {
            const footerSize = Math.max(10, Math.min(width, height) * 0.018);
            pdfPage.drawText(normalizedFooter, {
                x: 24,
                y: 18,
                size: footerSize,
                font: overlayFont,
                color: pdfLib.rgb(0.35, 0.35, 0.35),
            });
        }
    }, [printOverlayOptions]);

    const buildPdfBytes = useCallback(async (sourcePages: EditorPage[], task: OperationTask, reportProgress = true) => {
        const pdfLib = await loadPdfLib();
        const newPdf = await pdfLib.PDFDocument.create();
        const marginPercent = Math.max(0, Math.min(printOverlayOptions.marginPercent, 20));
        const cropZoom = getCropZoom(Math.max(0, Math.min(printOverlayOptions.cropPercent, 20)));
        const sourcePdfCache = new Map<string, Promise<PDFDocument>>();

        const loadSourcePdf = (fileData: EditorFile) => {
            const cachedPdf = sourcePdfCache.get(fileData.id);
            if (cachedPdf) {
                return cachedPdf;
            }

            const pdfPromise = fileData.file.arrayBuffer().then((fileBuffer) => pdfLib.PDFDocument.load(fileBuffer));
            sourcePdfCache.set(fileData.id, pdfPromise);
            return pdfPromise;
        };

        for (const [pagePosition, page] of sourcePages.entries()) {
            await task.checkpoint(reportProgress ? pagePosition : undefined, reportProgress ? sourcePages.length : undefined);
            const fileData = files[page.fileId];
            if (!fileData) {
                continue;
            }

            const srcPdf = await loadSourcePdf(fileData);
            const srcPage = srcPdf.getPage(page.pageIndex - 1);
            const srcRotation = srcPage.getRotation().angle;
            const totalRotation = (srcRotation + page.rotation) % 360;
            let pageToEmbed = srcPage;

            if (page.contentEdits.length > 0) {
                try {
                    const isolatedPdf = await pdfLib.PDFDocument.create();
                    const [isolatedPage] = await isolatedPdf.copyPages(srcPdf, [page.pageIndex - 1]);
                    isolatedPdf.addPage(isolatedPage);
                    const { applyContentEditsToPdfPage } = await loadContentEditExporter();
                    await applyContentEditsToPdfPage(isolatedPdf, isolatedPage, page.contentEdits);
                    pageToEmbed = isolatedPage;
                } catch (error) {
                    console.error(`Error applying content edits to page ${pagePosition + 1}:`, error);
                    const reason = error instanceof Error ? error.message : 'Unknown content rewrite error.';
                    throw new ContentEditExportError(pagePosition + 1, reason);
                }
            }

            // pdf-lib cannot embed an otherwise valid blank page without /Contents.
            if (!pageToEmbed.node.Contents()) pageToEmbed.pushOperators();
            const embeddedPage = await newPdf.embedPage(pageToEmbed);

            const { width: srcWidth, height: srcHeight } = embeddedPage;
            const isRotatedSides = totalRotation === 90 || totalRotation === 270;
            const effectiveWidth = isRotatedSides ? srcHeight : srcWidth;
            const effectiveHeight = isRotatedSides ? srcWidth : srcHeight;

            let targetWidth = effectiveWidth;
            let targetHeight = effectiveHeight;

            if (pageSize !== 'Original') {
                const targetDims = PAGE_SIZES[pageSize];
                if (!targetDims) {
                    throw new Error('Invalid page size');
                }

                [targetWidth, targetHeight] = targetDims;
                if (effectiveWidth > effectiveHeight) {
                    [targetWidth, targetHeight] = [targetHeight, targetWidth];
                }
            }

            const newPage = newPdf.addPage([targetWidth, targetHeight]);
            const contentBox = getContentBox(targetWidth, targetHeight, marginPercent);
            const scale = Math.min(contentBox.width / effectiveWidth, contentBox.height / effectiveHeight);
            const destWidth = effectiveWidth * scale * cropZoom;
            const destHeight = effectiveHeight * scale * cropZoom;
            const x = contentBox.x + ((contentBox.width - destWidth) / 2);
            const y = contentBox.y + ((contentBox.height - destHeight) / 2);

            const dims = { w: srcWidth * scale, h: srcHeight * scale };
            let drawX = x;
            let drawY = y;

            dims.w *= cropZoom;
            dims.h *= cropZoom;

            if (totalRotation === 90) {
                drawX += dims.h;
            } else if (totalRotation === 180) {
                drawX += dims.w;
                drawY += dims.h;
            } else if (totalRotation === 270) {
                drawY += dims.w;
            }

            newPage.drawPage(embeddedPage, {
                x: drawX,
                y: drawY,
                width: dims.w,
                height: dims.h,
                rotate: pdfLib.degrees(totalRotation),
            });

            if (page.annotations.length > 0) {
                const legacyCanvasSize = getLegacyEditorCanvasSize(totalRotation);
                await applyAnnotationsToPage(
                    newPage,
                    page.annotations,
                    targetHeight,
                    targetWidth,
                    page.annotationCanvasWidth ?? legacyCanvasSize.width,
                    page.annotationCanvasHeight ?? legacyCanvasSize.height,
                );
            }
            await applyPrintOverlays(newPage, pagePosition + 1, sourcePages.length);
        }

        await task.checkpoint(reportProgress ? sourcePages.length : undefined, reportProgress ? sourcePages.length : undefined);
        const bytes = await newPdf.save();
        task.check();
        return bytes;
    }, [files, pageSize, printOverlayOptions, applyAnnotationsToPage, applyPrintOverlays]);

    const exportPdf = useCallback(async (labels?: ExportLabels, pageIds?: string[]) => {
        const sourcePages = pageIds?.length
            ? orderItemsByIds(pages, pageIds, (page) => page.id)
            : pages;

        if (sourcePages.length === 0) {
            return;
        }

        const task = beginOperation('export');
        if (!task) return;
        try {
            const pdfBytes = await buildPdfBytes(sourcePages, task);
            const prefix = labels?.downloadPrefix ?? 'edited_document';
            const originalName = labels?.originalName ?? 'original';
            const filename = `${prefix}_${pageSize === 'Original' ? originalName : pageSize}.pdf`;
            await task.checkpoint();
            downloadPdfBytes(pdfBytes, filename);
            if (labels?.missingPagesWarning && sourcePages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
        } catch (error) {
            if (task.signal.aborted) return;
            console.error('Error exporting PDF:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to export PDF.'));
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, pageSize, notifyError, notifySuccess, beginOperation, finishOperation]);

    const exportPagesAsImages = useCallback(async (
        options: ImageExportOptions,
        labels?: ImageExportLabels,
        pageIds?: string[],
    ) => {
        const orderedPages = pageIds?.length
            ? orderItemsByIds(pages, pageIds, (page) => page.id)
            : pages;
        const sourcePages = orderedPages.filter((page) => files[page.fileId]);

        if (sourcePages.length === 0) {
            return false;
        }

        const task = beginOperation('images');
        if (!task) return false;
        let renderedDocument: LoadedPdfDocument | null = null;
        try {
            const pdfBytes = await buildPdfBytes(sourcePages, task);
            renderedDocument = await loadPdfDocumentWithTask({ data: toArrayBuffer(pdfBytes) });

            const normalizedQuality = normalizeImageExportQuality(options.quality);
            const renderScale = getImageExportRenderScale(normalizedQuality);
            const formatDetails = getImageExportFormatDetails(options.format);
            const pageNumbers = sourcePages.map((page) => pages.findIndex((candidate) => candidate.id === page.id) + 1);
            const renderPlans: Array<{
                page: Awaited<ReturnType<LoadedPdfDocument['pdfDoc']['getPage']>>;
                pageNumber: number;
                viewport: ReturnType<Awaited<ReturnType<LoadedPdfDocument['pdfDoc']['getPage']>>['getViewport']>;
            }> = [];
            let totalPixels = 0;

            for (let index = 0; index < renderedDocument.pdfDoc.numPages; index += 1) {
                const pdfPage = await renderedDocument.pdfDoc.getPage(index + 1);
                const viewport = pdfPage.getViewport({ scale: renderScale });
                const pagePixels = Math.ceil(viewport.width) * Math.ceil(viewport.height);
                totalPixels += pagePixels;
                if (pagePixels > MAX_RENDER_PIXELS || totalPixels > MAX_IMAGE_EXPORT_TOTAL_PIXELS) {
                    throw new ImageExportLimitError('Image export exceeds the safe rendering limit.');
                }
                renderPlans.push({
                    page: pdfPage,
                    pageNumber: pageNumbers[index] ?? index + 1,
                    viewport,
                });
            }

            const isArchive = renderPlans.length > 1;
            const archive = isArchive ? new (await import('jszip')).default() : null;
            const pagePrefix = labels?.pagePrefix ?? 'page';

            for (const [index, plan] of renderPlans.entries()) {
                await task.checkpoint(index, renderPlans.length);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.ceil(plan.viewport.width));
                canvas.height = Math.max(1, Math.ceil(plan.viewport.height));
                const context = canvas.getContext('2d');
                if (!context) {
                    throw new Error('Canvas is unavailable for image export.');
                }

                try {
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    await plan.page.render({
                        canvas,
                        canvasContext: context,
                        viewport: plan.viewport,
                        background: '#ffffff',
                    }).promise;
                    const imageBlob = await canvasToImageBlob(
                        canvas,
                        formatDetails.mimeType,
                        normalizedQuality / 100,
                    );
                    const filename = getImageExportFilename(
                        plan.pageNumber,
                        pages.length,
                        pagePrefix,
                        options.format,
                    );

                    if (archive) {
                        archive.file(filename, imageBlob);
                    } else {
                        await task.checkpoint();
                        downloadBlob(imageBlob, filename);
                    }
                } finally {
                    canvas.width = 1;
                    canvas.height = 1;
                }
            }

            if (archive) {
                const archiveBlob = await archive.generateAsync({
                    type: 'blob',
                    compression: 'STORE',
                });
                await task.checkpoint();
                downloadBlob(archiveBlob, `${labels?.downloadPrefix ?? 'selected_pages_images'}.zip`);
            }

            if (labels?.missingPagesWarning && sourcePages.length < orderedPages.length) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            if (task.signal.aborted) return false;
            console.error('Error exporting pages as images:', error);
            notifyError(
                error instanceof ImageExportLimitError
                    ? labels?.limitExceeded ?? 'Reduce the quality or select fewer pages.'
                    : labels?.failed ?? 'Failed to export the selected pages as images.',
            );
            return false;
        } finally {
            if (renderedDocument) {
                try {
                    await renderedDocument.loadingTask.destroy();
                } catch {
                    // The temporary rendering task may already be released.
                }
            }
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, notifyError, notifySuccess, beginOperation, finishOperation]);

    const exportPageRange = useCallback(async (
        startPage: number,
        endPage: number,
        labels?: ExportLabels,
    ) => {
        const rangeStart = Math.max(1, Math.min(startPage, endPage));
        const rangeEnd = Math.min(pages.length, Math.max(startPage, endPage));
        const sourcePages = pages.slice(rangeStart - 1, rangeEnd);

        if (sourcePages.length === 0) {
            return false;
        }

        const task = beginOperation('export');
        if (!task) return false;
        try {
            const pdfBytes = await buildPdfBytes(sourcePages, task);
            const prefix = labels?.downloadPrefix ?? 'edited_document';
            const originalName = labels?.originalName ?? 'original';
            const sizeLabel = pageSize === 'Original' ? originalName : pageSize;
            const filename = `${prefix}_${rangeStart}-${rangeEnd}_${sizeLabel}.pdf`;
            await task.checkpoint();
            downloadPdfBytes(pdfBytes, filename);
            if (labels?.missingPagesWarning && sourcePages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            if (task.signal.aborted) return false;
            console.error('Error exporting PDF range:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to export PDF.'));
            return false;
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, pageSize, notifyError, notifySuccess, beginOperation, finishOperation]);

    const splitPdf = useCallback(async (
        mode: 'single' | 'odd-even',
        labels?: SplitPdfLabels,
    ) => {
        if (pages.length === 0) {
            return false;
        }

        const groups = mode === 'single'
            ? pages.map((page, index) => ({
                pages: [page],
                filename: `${labels?.splitDownloadPrefix ?? 'split_document'}_${labels?.pageSuffix ?? 'page'}-${index + 1}.pdf`
            }))
            : [
                {
                    pages: pages.filter((_, index) => index % 2 === 0),
                    filename: `${labels?.splitDownloadPrefix ?? 'split_document'}_${labels?.oddSuffix ?? 'odd'}.pdf`
                },
                {
                    pages: pages.filter((_, index) => index % 2 === 1),
                    filename: `${labels?.splitDownloadPrefix ?? 'split_document'}_${labels?.evenSuffix ?? 'even'}.pdf`
                }
            ].filter(group => group.pages.length > 0);

        const task = beginOperation('split');
        if (!task) return false;
        try {
            const exports = [];
            for (const [index, group] of groups.entries()) {
                await task.checkpoint(index, groups.length);
                exports.push({ filename: group.filename, bytes: await buildPdfBytes(group.pages, task, false) });
            }
            await task.checkpoint(groups.length, groups.length);
            for (const item of exports) downloadPdfBytes(item.bytes, item.filename);
            if (labels?.missingPagesWarning && groups.some((group) => group.pages.some((page) => !files[page.fileId]))) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            if (task.signal.aborted) return false;
            console.error('Error splitting PDF:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to export PDF.'));
            return false;
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, notifyError, notifySuccess, beginOperation, finishOperation]);

    const exportProtectedPdf = useCallback(async (
        password: string,
        labels?: ProtectPdfLabels,
    ): Promise<boolean> => {
        if (pages.length === 0) {
            return false;
        }

        if (password.length === 0) {
            notifyError(labels?.invalidPassword ?? 'Please provide a valid password.');
            return false;
        }

        const task = beginOperation('protect');
        if (!task) return false;
        try {
            const rawBytes = await buildPdfBytes(pages, task);
            const { PDF: SecurePDF } = await import('@libpdf/core');
            const securePdf = await SecurePDF.load(rawBytes);
            securePdf.setProtection({
                userPassword: password,
                ownerPassword: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
                algorithm: 'AES-256',
            });

            const protectedBytes = await securePdf.save();
            const prefix = labels?.downloadPrefix ?? 'protected_document';
            const originalName = labels?.originalName ?? 'original';
            const sizeLabel = pageSize === 'Original' ? originalName : pageSize;
            const filename = `${prefix}_${sizeLabel}.pdf`;
            await task.checkpoint();
            downloadPdfBytes(protectedBytes, filename);
            if (labels?.missingPagesWarning && pages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            if (task.signal.aborted) return false;
            console.error('Error protecting PDF:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to protect PDF.'));
            return false;
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, pageSize, notifyError, notifySuccess, beginOperation, finishOperation]);

    const unlockPdfFile = useCallback(async (
        file: File | null,
        password: string,
        labels?: UnlockPdfLabels
    ): Promise<File | null> => {
        if (!file) {
            notifyError(labels?.invalidFile ?? 'Please select a PDF file.');
            return null;
        }

        const isPdfFile = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdfFile) {
            notifyError(labels?.invalidFile ?? 'Please select a PDF file.');
            return null;
        }
        if (!isAcceptedUnlockPdf(file)) {
            notifyError(labels?.invalidFile ?? 'The selected PDF is invalid or too large.');
            return null;
        }

        const task = beginOperation('unlock');
        if (!task) return null;
        try {
            await task.checkpoint(0, 1);
            const sourceBuffer = await file.arrayBuffer();
            const passwordCheck = await loadPdfDocumentWithTask({
                data: cloneArrayBuffer(sourceBuffer),
                password,
            });
            releasePdfDocument(passwordCheck);

            const bytes = new Uint8Array(sourceBuffer);
            const { PDF: SecurePDF } = await import('@libpdf/core');
            const securePdf = await SecurePDF.load(bytes, { credentials: password });

            if (securePdf.isEncrypted) {
                securePdf.removeProtection();
            }

            const unlockedBytes = await securePdf.save();
            const unlockedBuffer = toArrayBuffer(unlockedBytes);
            const unlockedDocument = await loadPdfDocumentWithTask({
                data: cloneArrayBuffer(unlockedBuffer),
            });
            releasePdfDocument(unlockedDocument);

            await task.checkpoint(1, 1);
            return new File([unlockedBuffer], file.name, {
                type: 'application/pdf',
            });
        } catch (error) {
            if (task.signal.aborted) return null;
            if (isLikelyInvalidPasswordError(error)) {
                notifyError(labels?.invalidPassword ?? 'Invalid password.');
            } else {
                console.error('Error unlocking PDF:', error);
                notifyError(labels?.failed ?? 'Failed to unlock PDF.');
            }
            return null;
        } finally {
            finishOperation();
        }
    }, [notifyError, beginOperation, finishOperation]);

    return { exportPdf, exportPagesAsImages, exportPageRange, splitPdf, exportProtectedPdf, unlockPdfFile };
};
