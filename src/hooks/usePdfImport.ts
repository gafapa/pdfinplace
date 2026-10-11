import type { EditorOperationController } from './useEditorOperation';
import { useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { createId } from '../utils/createId';
import { loadPdfDocumentWithTask } from '../utils/pdfjs';
import { MAX_IMPORT_FILES, MAX_IMPORT_PAGES, MAX_IMPORT_TOTAL_SIZE_BYTES, MAX_IMAGE_PIXELS, getAcceptedImportFiles, getImportFileKind } from '../utils/importValidation';
import { readImageDimensions } from '../utils/imageValidation';
import type { EditorFile, EditorPage, ImportLabels } from './editorTypes';
import { type ArchiveEntryMetadata, ImportLimitError, releasePdfDocument, loadPdfLib, cloneArrayBuffer, toArrayBuffer, validateArchiveLimits, validateOfficeXmlComplexity, assertRenderableArea, canvasToPngBytes, isLikelyInvalidPasswordError } from './editorResources';

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
                    throw new Error(`Import would exceed the ${MAX_IMPORT_PAGES} page limit.`);
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
                        throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel limit.`);
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

                // DOCX Handling
                if (fileKind === 'docx') {
                    const JSZip = (await import('jszip')).default;
                    const docxPreview = await import('docx-preview');
                    const html2canvas = (await import('html2canvas')).default;
                    const archive = await JSZip.loadAsync(arrayBuffer);
                    validateArchiveLimits(archive.files as Record<string, ArchiveEntryMetadata>);
                    const documentXml = await archive.file('word/document.xml')?.async('string');
                    if (!documentXml) {
                        throw new Error('DOCX document.xml is missing.');
                    }
                    validateOfficeXmlComplexity(documentXml);

                    // A4 dimensions at 96 DPI
                    const pageWidthPx = 794;
                    const pageHeightPx = 1123;

                    const container = document.createElement('div');
                    container.style.width = `${pageWidthPx}px`;
                    container.style.backgroundColor = 'white';
                    container.style.position = 'fixed';
                    container.style.left = '0';
                    container.style.top = '0';
                    container.style.zIndex = '-9999';
                    container.style.overflow = 'visible';
                    let canvas: HTMLCanvasElement;
                    try {
                        document.body.appendChild(container);

                        await docxPreview.renderAsync(arrayBuffer, container, undefined, {
                            className: 'docx-preview',
                            inWrapper: false,
                            ignoreWidth: false,
                            ignoreHeight: false,
                            ignoreFonts: false,
                            breakPages: true,
                            ignoreLastRenderedPageBreak: false,
                            experimental: true,
                            trimXmlDeclaration: true,
                            useBase64URL: true
                        });

                        await new Promise(r => setTimeout(r, 500));

                        const renderHeight = Math.max(container.scrollHeight, container.offsetHeight);
                        assertRenderableArea(pageWidthPx, renderHeight);
                        const estimatedPages = Math.max(1, Math.ceil(renderHeight / (pageHeightPx - 120)));
                        if (importedPageCount + estimatedPages > MAX_IMPORT_PAGES) {
                            throw new Error(`Import would exceed the ${MAX_IMPORT_PAGES} page limit.`);
                        }

                        canvas = await html2canvas(container, {
                            scale: 1,
                            useCORS: true,
                            logging: false,
                            width: pageWidthPx,
                            windowWidth: pageWidthPx,
                            scrollY: -window.scrollY
                        });
                    } finally {
                        container.remove();
                    }

                    assertRenderableArea(canvas.width, canvas.height);

                    // Create PDF with pdf-lib
                    const pdfDoc = await pdfLib.PDFDocument.create();

                    // A4 size in points (72 DPI)
                    const pageWidthPt = 595.28;
                    const pageHeightPt = 841.89;

                    // Margins in pixels (for content area)
                    const marginTopPx = 60;
                    const marginBottomPx = 60;
                    const contentHeightPx = pageHeightPx - marginTopPx - marginBottomPx;

                    // Helper function to find the "whitest" row near a target Y position
                    const findOptimalBreakPoint = (targetY: number, searchRange: number = 80): number => {
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = pageWidthPx;
                        tempCanvas.height = searchRange * 2;
                        const tempCtx = tempCanvas.getContext('2d');

                        if (!tempCtx) return targetY;

                        const startY = Math.max(0, targetY - searchRange);
                        const endY = Math.min(canvas.height, targetY + searchRange);
                        const actualHeight = endY - startY;

                        tempCtx.drawImage(canvas, 0, startY, pageWidthPx, actualHeight, 0, 0, pageWidthPx, actualHeight);
                        const imageData = tempCtx.getImageData(0, 0, pageWidthPx, actualHeight);
                        const data = imageData.data;

                        let bestY = targetY;
                        let bestWhiteness = -1;

                        // Scan each row to find the whitest one
                        for (let y = 0; y < actualHeight; y++) {
                            let rowWhiteness = 0;
                            for (let x = 0; x < pageWidthPx; x++) {
                                const i = (y * pageWidthPx + x) * 4;
                                // Calculate how "white" this pixel is (R+G+B close to 255 each)
                                const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                                rowWhiteness += brightness;
                            }
                            rowWhiteness /= pageWidthPx;

                            // Prefer rows closer to the target, but prioritize whiteness
                            const distancePenalty = Math.abs(y - searchRange) * 0.1;
                            const score = rowWhiteness - distancePenalty;

                            if (score > bestWhiteness) {
                                bestWhiteness = score;
                                bestY = startY + y;
                            }
                        }

                        return bestY;
                    };

                    // Calculate break points with smart detection
                    const breakPoints: number[] = [0];
                    let currentY = 0;

                    while (currentY + contentHeightPx < canvas.height) {
                        const idealBreak = currentY + contentHeightPx;
                        const optimalBreak = findOptimalBreakPoint(idealBreak);
                        breakPoints.push(optimalBreak);
                        currentY = optimalBreak;
                    }
                    breakPoints.push(canvas.height);

                    const numPages = breakPoints.length - 1;

                    for (let p = 0; p < numPages; p++) {
                        const sliceCanvas = document.createElement('canvas');
                        sliceCanvas.width = pageWidthPx;
                        sliceCanvas.height = pageHeightPx;
                        const ctx = sliceCanvas.getContext('2d');

                        if (ctx) {
                            ctx.fillStyle = 'white';
                            ctx.fillRect(0, 0, pageWidthPx, pageHeightPx);

                            const sourceY = breakPoints[p];
                            const sourceHeight = Math.min(contentHeightPx, breakPoints[p + 1] - sourceY);

                            // Draw with top margin offset
                            ctx.drawImage(
                                canvas,
                                0, sourceY, pageWidthPx, sourceHeight,
                                0, marginTopPx, pageWidthPx, sourceHeight
                            );
                        }

                        const sliceBytes = await canvasToPngBytes(sliceCanvas);
                        const sliceImage = await pdfDoc.embedPng(sliceBytes);

                        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
                        page.drawImage(sliceImage, {
                            x: 0,
                            y: 0,
                            width: pageWidthPt,
                            height: pageHeightPt,
                        });
                    }

                    const pdfBytes = await pdfDoc.save();
                    arrayBuffer = toArrayBuffer(pdfBytes);

                    const newFileName = file.name.replace(/\.docx$/i, '.pdf');
                    const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });

                    const { pdfDoc: docxPdf, loadingTask: docxTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });

                    storeImportedFile(fileId, {
                        id: fileId,
                        file: newFile,
                        pdfDoc: docxPdf,
                        loadingTask: docxTask,
                        pageCount: docxPdf.numPages
                    });

                    appendFilePages(fileId, docxPdf.numPages);
                    continue;
                }

                // ODT Handling
                if (fileKind === 'odt') {
                    const JSZip = (await import('jszip')).default;
                    const html2canvas = (await import('html2canvas')).default;

                    const zip = await JSZip.loadAsync(arrayBuffer);
                    validateArchiveLimits(zip.files as Record<string, ArchiveEntryMetadata>);
                    const contentXml = await zip.file("content.xml")?.async("string");

                    if (contentXml) {
                        validateOfficeXmlComplexity(contentXml);
                        const parser = new DOMParser();
                        const xmlDoc = parser.parseFromString(contentXml, "text/xml");

                        const appendExtractedText = (target: HTMLElement, node: Node) => {
                            const stack = Array.from(node.childNodes).reverse();
                            while (stack.length > 0) {
                                const child = stack.pop();
                                if (!child) continue;
                                if (child.nodeType === Node.TEXT_NODE) {
                                    target.appendChild(document.createTextNode(child.textContent ?? ''));
                                } else if (child.nodeName.endsWith(':s')) {
                                    target.appendChild(document.createTextNode(' '));
                                } else if (child.nodeName.endsWith(':tab')) {
                                    target.appendChild(document.createTextNode('\t'));
                                } else if (child.nodeName.endsWith(':line-break')) {
                                    target.appendChild(document.createElement('br'));
                                } else {
                                    stack.push(...Array.from(child.childNodes).reverse());
                                }
                            }
                        };

                        const processNode = (parent: HTMLElement, root: Element): boolean => {
                            const stack: Element[] = [root];
                            let appended = false;
                            while (stack.length > 0) {
                                const node = stack.pop();
                                if (!node) continue;
                                const name = node.nodeName;
                                if (name.endsWith(':h')) {
                                    const level = node.getAttributeNS("*", "outline-level") || '1';
                                    const hLevel = parseInt(level) || 1;
                                    const heading = document.createElement(`h${Math.min(6, Math.max(1, hLevel))}`);
                                    appendExtractedText(heading, node);
                                    parent.appendChild(heading);
                                    appended = true;
                                    continue;
                                }
                                if (name.endsWith(':p')) {
                                    const paragraph = document.createElement('p');
                                    appendExtractedText(paragraph, node);
                                    parent.appendChild(paragraph);
                                    appended = true;
                                    continue;
                                }
                                stack.push(...Array.from(node.children).reverse());
                            }
                            return appended;
                        };

                        // A4 dimensions at 96 DPI
                        const pageWidthPx = 794;
                        const pageHeightPx = 1123;
                        const marginPx = 40;
                        const contentWidthPx = pageWidthPx - (marginPx * 2);

                        // Create a visible container sized to A4 width
                        const container = document.createElement('div');
                        container.style.width = `${contentWidthPx}px`;
                        container.style.backgroundColor = 'white';
                        container.style.position = 'fixed';
                        container.style.left = '0';
                        container.style.top = '0';
                        container.style.zIndex = '-9999';
                        container.style.padding = `${marginPx}px`;
                        container.style.fontFamily = 'Arial, sans-serif';
                        container.style.fontSize = '12pt';
                        container.style.lineHeight = '1.5';
                        container.style.color = '#000';
                        let hasTextContent = false;
                        const officeText = xmlDoc.getElementsByTagNameNS("*", "text")[0];
                        if (officeText) {
                            for (let i = 0; i < officeText.children.length; i++) {
                                hasTextContent = processNode(container, officeText.children[i]) || hasTextContent;
                            }
                        }
                        if (!hasTextContent) {
                            const emptyParagraph = document.createElement('p');
                            emptyParagraph.textContent = 'No text content found.';
                            container.appendChild(emptyParagraph);
                        }
                        let canvas: HTMLCanvasElement;
                        try {
                            document.body.appendChild(container);

                            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                            const renderHeight = Math.max(container.scrollHeight, container.offsetHeight);
                            assertRenderableArea(pageWidthPx, renderHeight);
                            const estimatedPages = Math.max(1, Math.ceil(renderHeight / (pageHeightPx - 120)));
                            if (importedPageCount + estimatedPages > MAX_IMPORT_PAGES) {
                                throw new Error(`Import would exceed the ${MAX_IMPORT_PAGES} page limit.`);
                            }

                            canvas = await html2canvas(container, {
                                scale: 1,
                                useCORS: true,
                                logging: false,
                                width: pageWidthPx,
                                windowWidth: pageWidthPx
                            });
                        } finally {
                            container.remove();
                        }

                        assertRenderableArea(canvas.width, canvas.height);

                        // Create PDF with pdf-lib
                        const pdfDoc = await pdfLib.PDFDocument.create();

                        // A4 size in points (72 DPI)
                        const pageWidthPt = 595.28;
                        const pageHeightPt = 841.89;

                        // Margins in pixels (for content area)
                        const marginTopPx = 60;
                        const marginBottomPx = 60;
                        const contentHeightPx = pageHeightPx - marginTopPx - marginBottomPx;

                        // Helper function to find the "whitest" row near a target Y position
                        const findOptimalBreakPoint = (targetY: number, searchRange: number = 80): number => {
                            const tempCanvas = document.createElement('canvas');
                            tempCanvas.width = pageWidthPx;
                            tempCanvas.height = searchRange * 2;
                            const tempCtx = tempCanvas.getContext('2d');

                            if (!tempCtx) return targetY;

                            const startY = Math.max(0, targetY - searchRange);
                            const endY = Math.min(canvas.height, targetY + searchRange);
                            const actualHeight = endY - startY;

                            tempCtx.drawImage(canvas, 0, startY, pageWidthPx, actualHeight, 0, 0, pageWidthPx, actualHeight);
                            const imageData = tempCtx.getImageData(0, 0, pageWidthPx, actualHeight);
                            const data = imageData.data;

                            let bestY = targetY;
                            let bestWhiteness = -1;

                            for (let y = 0; y < actualHeight; y++) {
                                let rowWhiteness = 0;
                                for (let x = 0; x < pageWidthPx; x++) {
                                    const i = (y * pageWidthPx + x) * 4;
                                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                                    rowWhiteness += brightness;
                                }
                                rowWhiteness /= pageWidthPx;

                                const distancePenalty = Math.abs(y - searchRange) * 0.1;
                                const score = rowWhiteness - distancePenalty;

                                if (score > bestWhiteness) {
                                    bestWhiteness = score;
                                    bestY = startY + y;
                                }
                            }

                            return bestY;
                        };

                        // Calculate break points with smart detection
                        const breakPoints: number[] = [0];
                        let currentY = 0;

                        while (currentY + contentHeightPx < canvas.height) {
                            const idealBreak = currentY + contentHeightPx;
                            const optimalBreak = findOptimalBreakPoint(idealBreak);
                            breakPoints.push(optimalBreak);
                            currentY = optimalBreak;
                        }
                        breakPoints.push(canvas.height);

                        const numPages = breakPoints.length - 1;

                        for (let p = 0; p < numPages; p++) {
                            const sliceCanvas = document.createElement('canvas');
                            sliceCanvas.width = pageWidthPx;
                            sliceCanvas.height = pageHeightPx;
                            const ctx = sliceCanvas.getContext('2d');

                            if (ctx) {
                                ctx.fillStyle = 'white';
                                ctx.fillRect(0, 0, pageWidthPx, pageHeightPx);

                                const sourceY = breakPoints[p];
                                const sourceHeight = Math.min(contentHeightPx, breakPoints[p + 1] - sourceY);

                                // Draw with top margin offset
                                ctx.drawImage(
                                    canvas,
                                    0, sourceY, pageWidthPx, sourceHeight,
                                    0, marginTopPx, pageWidthPx, sourceHeight
                                );
                            }

                            const sliceBytes = await canvasToPngBytes(sliceCanvas);
                            const sliceImage = await pdfDoc.embedPng(sliceBytes);

                            const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
                            page.drawImage(sliceImage, {
                                x: 0,
                                y: 0,
                                width: pageWidthPt,
                                height: pageHeightPt,
                            });
                        }

                        const pdfBytes = await pdfDoc.save();
                        arrayBuffer = toArrayBuffer(pdfBytes);

                        const newFileName = file.name.replace(/\.odt$/i, '.pdf');
                        const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });

                        const { pdfDoc: odtPdf, loadingTask: odtTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });

                        storeImportedFile(fileId, {
                            id: fileId,
                            file: newFile,
                            pdfDoc: odtPdf,
                            loadingTask: odtTask,
                            pageCount: odtPdf.numPages
                        });

                        appendFilePages(fileId, odtPdf.numPages);
                        continue;
                    }
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
                    failedReasons.push(file.name);
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
                    notifySuccess(labels.success);
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
