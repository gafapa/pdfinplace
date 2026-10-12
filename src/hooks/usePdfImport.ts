import type { EditorOperationController } from './useEditorOperation';
import { useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { createId } from '../utils/createId';
import { loadPdfDocumentWithTask } from '../utils/pdfjs';
import { MAX_IMPORT_FILES, MAX_IMPORT_PAGES, MAX_IMPORT_TOTAL_SIZE_BYTES, MAX_IMAGE_PIXELS, getAcceptedImportFiles, getImportFileKind } from '../utils/importValidation';
import { readImageDimensions } from '../utils/imageValidation';
import type { EditorFile, EditorPage, ImportLabels } from './editorTypes';
import { ImportLimitError, releasePdfDocument, loadPdfLib, cloneArrayBuffer, toArrayBuffer, isLikelyInvalidPasswordError } from './editorResources';

interface ImportContext {
    filesRef: RefObject<Record<string, EditorFile>>;
    pages: EditorPage[];
    isSessionReady: boolean;
    setFiles: Dispatch<SetStateAction<Record<string, EditorFile>>>;
    setPages: (update: EditorPage[] | ((previous: EditorPage[]) => EditorPage[])) => void;
    operationController: EditorOperationController;
    notifyError: (message: string) => void;
    notifySuccess: (message: string) => void;
}
export const usePdfImport = ({ filesRef, pages, isSessionReady, setFiles, setPages, operationController, notifyError, notifySuccess }: ImportContext) => {
    const isImportingRef = useRef(false);
    const { beginOperation, finishOperation } = operationController;
    const addFiles = useCallback(async (newFiles: File[], labels: ImportLabels) => {
        if (isImportingRef.current || !isSessionReady) return;

        const existingFiles = Object.values(filesRef.current);
        const existingBytes = existingFiles.reduce((total, fileData) => total + fileData.file.size, 0);
        const { acceptedFiles, skippedReasons } = getAcceptedImportFiles(
            newFiles,
            existingFiles.length,
            existingBytes,
        );

        if (skippedReasons.length > 0) {
            const formattedReasons = skippedReasons.map((reason) => {
                const label = reason.code === 'file-count'
                    ? labels.fileCount
                    : reason.code === 'unsupported'
                        ? labels.unsupported
                        : reason.code === 'file-size'
                            ? labels.fileSize
                            : labels.batchSize;
                return reason.fileName ? `${reason.fileName}: ${label}` : label;
            });
            notifyError(`${labels.skippedPrefix}\n${formattedReasons.join('\n')}`);
        }

        if (acceptedFiles.length === 0) {
            return;
        }

        const task = beginOperation('import');
        if (!task) return;
        isImportingRef.current = true;
        const newFilesMap: Record<string, EditorFile> = {};
        try {
            const newPages: EditorPage[] = [];
            const failedReasons: string[] = [];
            const passwordProtectedFiles: File[] = [];
            const pdfLib = await loadPdfLib();
            let importedPageCount = pages.length;
            let importedFileBytes = existingBytes;
            let importedOfficeDocument = false;

            const storeImportedFile = (fileId: string, fileData: EditorFile) => {
                if (existingFiles.length + Object.keys(newFilesMap).length >= MAX_IMPORT_FILES) {
                    releasePdfDocument(fileData.pdfDoc);
                    throw new ImportLimitError(labels.fileCount);
                }
                if (importedFileBytes + fileData.file.size > MAX_IMPORT_TOTAL_SIZE_BYTES) {
                    releasePdfDocument(fileData.pdfDoc);
                    throw new ImportLimitError(labels.batchSize);
                }

                newFilesMap[fileId] = fileData;
                importedFileBytes += fileData.file.size;
            };

            const appendFilePages = (fileId: string, pageCount: number) => {
                if (importedPageCount + pageCount > MAX_IMPORT_PAGES) {
                    throw new ImportLimitError(labels.pageLimit);
                }

                for (let i = 1; i <= pageCount; i++) {
                    newPages.push({
                        id: `${fileId}-${i}-${createId().slice(0, 8)}`,
                        fileId,
                        pageIndex: i,
                        rotation: 0,
                        annotations: [],
                        contentEdits: [],
                    });
                }
                importedPageCount += pageCount;
            };

            let filePosition = 0;
            for (const file of acceptedFiles) {
            await task.checkpoint(filePosition++, acceptedFiles.length);
            const fileId = createId();
            try {
                let arrayBuffer = await file.arrayBuffer();
                const fileKind = getImportFileKind(file);

                // If image, convert to PDF first
                if (fileKind === 'jpeg' || fileKind === 'png') {
                    const imageDimensions = readImageDimensions(arrayBuffer);
                    if (!imageDimensions || imageDimensions.kind !== fileKind) {
                        throw new Error('Image contents do not match a supported PNG or JPEG file.');
                    }
                    if (imageDimensions.width * imageDimensions.height > MAX_IMAGE_PIXELS) {
                        throw new ImportLimitError(labels.imageTooLarge);
                    }

                    const pdfDoc = await pdfLib.PDFDocument.create();
                    let image;
                    if (fileKind === 'jpeg') {
                        image = await pdfDoc.embedJpg(arrayBuffer);
                    } else {
                        image = await pdfDoc.embedPng(arrayBuffer);
                    }

                    const page = pdfDoc.addPage([image.width, image.height]);
                    page.drawImage(image, {
                        x: 0,
                        y: 0,
                        width: image.width,
                        height: image.height,
                    });

                    const pdfBytes = await pdfDoc.save();
                    arrayBuffer = toArrayBuffer(pdfBytes);

                    const newFileName = file.name.replace(/\.(jpg|jpeg|png)$/i, '.pdf');
                    const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });

                    storeImportedFile(fileId, {
                        id: fileId,
                        file: newFile,
                        ...await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) }),
                        pageCount: 1
                    });

                    appendFilePages(fileId, 1);
                    continue;
                }

                // DOCX/ODT: lay the document out in the page and rasterize each page.
                if (fileKind === 'docx' || fileKind === 'odt') {
                    const { convertDocxToPdf, convertOdtToPdf } = await import('../features/import/officeImport');
                    const convert = fileKind === 'docx' ? convertDocxToPdf : convertOdtToPdf;
                    const pdfBytes = await convert(arrayBuffer, {
                        maxPages: MAX_IMPORT_PAGES - importedPageCount,
                        createPageLimitError: () => new ImportLimitError(labels.pageLimit),
                        checkpoint: () => task.checkpoint(),
                    });
                    arrayBuffer = toArrayBuffer(pdfBytes);
                    const newFile = new File([arrayBuffer], file.name.replace(/.(docx|odt)$/i, '.pdf'), { type: 'application/pdf' });
                    const { pdfDoc: officePdf, loadingTask: officeTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });
                    storeImportedFile(fileId, {
                        id: fileId,
                        file: newFile,
                        pdfDoc: officePdf,
                        loadingTask: officeTask,
                        pageCount: officePdf.numPages,
                    });
                    appendFilePages(fileId, officePdf.numPages);
                    importedOfficeDocument = true;
                    continue;
                }

                const { pdfDoc, loadingTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });

                storeImportedFile(fileId, {
                    id: fileId,
                    file,
                    pdfDoc,
                    loadingTask,
                    pageCount: pdfDoc.numPages
                });

                appendFilePages(fileId, pdfDoc.numPages);
            } catch (error) {
                if (task.signal.aborted) throw error;
                const failedFileData = newFilesMap[fileId];
                if (failedFileData) {
                    importedFileBytes -= failedFileData.file.size;
                    releasePdfDocument(failedFileData.pdfDoc);
                }
                delete newFilesMap[fileId];
                const isPasswordProtectedPdf = getImportFileKind(file) === 'pdf' &&
                    isLikelyInvalidPasswordError(error);
                if (isPasswordProtectedPdf) {
                    passwordProtectedFiles.push(file);
                } else if (error instanceof ImportLimitError) {
                    failedReasons.push(`${file.name}: ${error.message}`);
                } else {
                    failedReasons.push(`${file.name}: ${labels.unreadable}`);
                }
                if (!isPasswordProtectedPdf) {
                    console.error(`Error loading file ${file.name}:`, error);
                }
            }
        }

            await task.checkpoint(acceptedFiles.length, acceptedFiles.length);
            if (passwordProtectedFiles.length > 0) {
                labels.onPasswordRequired?.(passwordProtectedFiles[0]);
            }
            if (failedReasons.length > 0) {
                notifyError(`${labels.failedPrefix}\n${failedReasons.join('\n')}`);
            }
            if (Object.keys(newFilesMap).length > 0) {
                setFiles(prev => ({ ...prev, ...newFilesMap }));
            }
            if (newPages.length > 0) {
                setPages(prev => [...prev, ...newPages]);
                if (!failedReasons.length && passwordProtectedFiles.length === 0 && labels.success) {
                    notifySuccess(importedOfficeDocument && labels.officeRasterized
                        ? `${labels.success}
${labels.officeRasterized}`
                        : labels.success);
                }
            }
        } catch {
            Object.values(newFilesMap).forEach(releasePdfDocument);
            if (!task.signal.aborted) notifyError(labels.failedPrefix);
        } finally {
            isImportingRef.current = false;
            finishOperation();
        }
    }, [pages.length, isSessionReady, filesRef, setFiles, setPages, notifyError, notifySuccess, beginOperation, finishOperation]);

    return { addFiles };
};
