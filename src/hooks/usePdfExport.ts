import type { EditorOperationController } from './useEditorOperation';
import type { OperationTask } from '../utils/editorOperation';
import { useCallback } from 'react';
import { loadPdfDocumentWithTask, type LoadedPdfDocument } from '../utils/pdfjs';
import { MAX_RENDER_PIXELS, isAcceptedUnlockPdf } from '../utils/importValidation';
import { orderItemsByIds } from '../utils/orderedSelection';
import { getImageExportFilename, getImageExportFormatDetails, getImageExportRenderScale, normalizeImageExportQuality } from '../utils/imageExport';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions, ExportLabels, SplitPdfLabels, ImageExportLabels, ImageExportOptions, ProtectPdfLabels, UnlockPdfLabels } from './editorTypes';
import { toArrayBuffer, cloneArrayBuffer, downloadPdfBytes, downloadBlob, canvasToImageBlob, MAX_IMAGE_EXPORT_TOTAL_PIXELS, ImageExportLimitError, exportFailureMessage, isLikelyInvalidPasswordError, releasePdfDocument } from './editorResources';
import { buildPdfDocument } from '../features/export/buildPdfDocument';
import { browserImageCodec, rasterizePageInBrowser } from '../features/export/browserImaging';
import { IMAGE_COMPRESSION_SETTINGS, type ImageCompressionLevel, type ImageCompressionResult } from '../features/export/compressImages';
import { buildDownloadName, toFileStem } from '../utils/fileNames';

/** Success message, reporting image savings when compression ran. */
const successMessage = (labels: ExportLabels | undefined, compression: ImageCompressionResult | undefined) =>
    compression && labels?.compressionResult ? labels.compressionResult(compression) : labels?.success;

interface ExportContext {
    files: Record<string, EditorFile>;
    pages: EditorPage[];
    pageSize: PageSize;
    printOverlayOptions: PrintOverlayOptions;
    imageCompression: ImageCompressionLevel;
    operationController: EditorOperationController;
    notifyError: (message: string) => void;
    notifySuccess: (message: string) => void;
}
export const usePdfExport = ({ files, pages, pageSize, printOverlayOptions, imageCompression, operationController, notifyError, notifySuccess }: ExportContext) => {
    const { beginOperation, finishOperation } = operationController;
    const buildPdfBytes = useCallback(async (
        sourcePages: EditorPage[],
        task: OperationTask,
        reportProgress = true,
        onCompression?: (result: ImageCompressionResult) => void,
    ) => {
        const bytes = await buildPdfDocument({
            sourcePages,
            files,
            pageSize,
            printOverlayOptions,
            checkpoint: task.checkpoint,
            reportProgress,
            rasterizePage: rasterizePageInBrowser,
            imageCompression: imageCompression === 'none' ? undefined : {
                settings: IMAGE_COMPRESSION_SETTINGS[imageCompression],
                codec: browserImageCodec,
                onResult: onCompression,
            },
        });
        task.check();
        return bytes;
    }, [files, pageSize, printOverlayOptions, imageCompression]);

    /** Name of the source file when every page comes from one file, for download names. */
    const sourceFileStem = useCallback((sourcePages: EditorPage[]) => {
        const fileIds = new Set(sourcePages.map(page => page.fileId));
        if (fileIds.size !== 1) return null;
        const [fileId] = fileIds;
        const name = files[fileId]?.file.name;
        return name ? toFileStem(name) : null;
    }, [files]);
    const sizePart = pageSize === 'Original' ? undefined : pageSize;

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
            let compression: ImageCompressionResult | undefined;
            const pdfBytes = await buildPdfBytes(sourcePages, task, true, result => { compression = result; });
            const filename = `${buildDownloadName(sourceFileStem(sourcePages), labels?.editedSuffix, labels?.downloadPrefix ?? 'edited_document', sizePart)}.pdf`;
            await task.checkpoint();
            downloadPdfBytes(pdfBytes, filename);
            const success = successMessage(labels, compression);
            if (labels?.missingPagesWarning && sourcePages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (success) {
                notifySuccess(success);
            }
        } catch (error) {
            if (task.signal.aborted) return;
            console.error('Error exporting PDF:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to export PDF.', labels));
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, sourceFileStem, sizePart, notifyError, notifySuccess, beginOperation, finishOperation]);

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
                downloadBlob(archiveBlob, `${buildDownloadName(sourceFileStem(sourcePages), labels?.imagesSuffix, labels?.downloadPrefix ?? 'selected_pages_images')}.zip`);
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
                    : exportFailureMessage(error, labels?.failed ?? 'Failed to export the selected pages as images.', labels),
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
    }, [pages, files, buildPdfBytes, sourceFileStem, notifyError, notifySuccess, beginOperation, finishOperation]);

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
            let compression: ImageCompressionResult | undefined;
            const pdfBytes = await buildPdfBytes(sourcePages, task, true, result => { compression = result; });
            const filename = `${buildDownloadName(sourceFileStem(sourcePages), labels?.editedSuffix, labels?.downloadPrefix ?? 'edited_document', `${rangeStart}-${rangeEnd}`, sizePart)}.pdf`;
            await task.checkpoint();
            downloadPdfBytes(pdfBytes, filename);
            const success = successMessage(labels, compression);
            if (labels?.missingPagesWarning && sourcePages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (success) {
                notifySuccess(success);
            }
            return true;
        } catch (error) {
            if (task.signal.aborted) return false;
            console.error('Error exporting PDF range:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to export PDF.', labels));
            return false;
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, sourceFileStem, sizePart, notifyError, notifySuccess, beginOperation, finishOperation]);

    const splitPdf = useCallback(async (
        mode: 'single' | 'odd-even',
        labels?: SplitPdfLabels,
    ) => {
        if (pages.length === 0) {
            return false;
        }

        const stem = sourceFileStem(pages);
        const prefix = labels?.splitDownloadPrefix ?? 'split_document';
        const name = (part: string) => `${buildDownloadName(stem, undefined, prefix, part)}.pdf`;
        const groups = mode === 'single'
            ? pages.map((page, index) => ({
                pages: [page],
                filename: name(`${labels?.pageSuffix ?? 'page'}-${index + 1}`),
            }))
            : [
                { pages: pages.filter((_, index) => index % 2 === 0), filename: name(labels?.oddSuffix ?? 'odd') },
                { pages: pages.filter((_, index) => index % 2 === 1), filename: name(labels?.evenSuffix ?? 'even') },
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
            if (exports.length === 1) {
                downloadPdfBytes(exports[0].bytes, exports[0].filename);
            } else {
                // Browsers block or prompt for a burst of downloads, so several files go in one ZIP.
                const archive = new (await import('jszip')).default();
                for (const item of exports) archive.file(item.filename, item.bytes);
                const archiveBlob = await archive.generateAsync({ type: 'blob', compression: 'STORE' });
                await task.checkpoint();
                downloadBlob(archiveBlob, `${buildDownloadName(stem, labels?.splitSuffix, prefix)}.zip`);
            }
            if (labels?.missingPagesWarning && groups.some((group) => group.pages.some((page) => !files[page.fileId]))) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            if (task.signal.aborted) return false;
            console.error('Error splitting PDF:', error);
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to export PDF.', labels));
            return false;
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, sourceFileStem, notifyError, notifySuccess, beginOperation, finishOperation]);

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
            const filename = `${buildDownloadName(sourceFileStem(pages), labels?.protectedSuffix, labels?.downloadPrefix ?? 'protected_document', sizePart)}.pdf`;
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
            notifyError(exportFailureMessage(error, labels?.failed ?? 'Failed to protect PDF.', labels));
            return false;
        } finally {
            finishOperation();
        }
    }, [pages, files, buildPdfBytes, sourceFileStem, sizePart, notifyError, notifySuccess, beginOperation, finishOperation]);

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
