import { useState, useCallback } from 'react';
import { PDFDocument, StandardFonts, rgb, degrees, type PDFPage } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { arrayMove } from '@dnd-kit/sortable';
import type {
    Annotation,
    TextAnnotationData,
    DrawingAnnotationData,
    ShapeAnnotationData,
    ImageAnnotationData
} from '../types/annotations';

export interface EditorPage {
    id: string; // Unique ID for dnd (e.g., "fileId-pageIndex")
    fileId: string;
    pageIndex: number; // 1-based index in the source file
    rotation: number; // 0, 90, 180, 270
    annotations: Annotation[]; // Page annotations
}

export interface EditorFile {
    id: string;
    file: File;
    pdfDoc?: pdfjsLib.PDFDocumentProxy; // Cached pdf.js document for rendering
    pageCount: number;
}

export type PageSize = 'Original' | 'A4' | 'A3' | 'Letter' | 'Legal';
interface ExportLabels {
    failed: string;
    downloadPrefix: string;
    originalName: string;
}

interface ProtectPdfLabels {
    failed: string;
    invalidPassword: string;
    downloadPrefix: string;
    originalName: string;
}

interface UnlockPdfLabels {
    failed: string;
    invalidPassword: string;
    invalidFile: string;
    downloadPrefix: string;
}

const PAGE_SIZES: Record<Exclude<PageSize, 'Original'>, [number, number]> = {
    A4: [595.28, 841.89],
    A3: [841.89, 1190.55],
    Letter: [612.00, 792.00],
    Legal: [612.00, 1008.00]
};

const toArrayBuffer = (bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
};

const downloadPdfBytes = (pdfBytes: Uint8Array<ArrayBufferLike>, filename: string) => {
    const pdfBytesBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBytesBuffer).set(pdfBytes);
    const blob = new Blob([pdfBytesBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

const isLikelyInvalidPasswordError = (error: unknown): boolean => {
    const content = error instanceof Error
        ? `${error.name} ${error.message}`.toLowerCase()
        : String(error).toLowerCase();

    return content.includes('password') ||
        content.includes('credential') ||
        content.includes('auth') ||
        content.includes('decrypt');
};

// Custom hook for history management
const useHistory = <T>(initialState: T) => {
    const [historyState, setHistoryState] = useState<{ history: T[]; currentIndex: number }>({
        history: [initialState],
        currentIndex: 0
    });

    const state = historyState.history[historyState.currentIndex];

    const setState = useCallback((newState: T | ((prev: T) => T)) => {
        setHistoryState(prev => {
            const current = prev.history[prev.currentIndex];
            const updated = typeof newState === 'function'
                ? (newState as (prev: T) => T)(current)
                : newState;

            // If we're not at the end of history, truncate it before adding new state
            const truncatedHistory = prev.history.slice(0, prev.currentIndex + 1);
            return {
                history: [...truncatedHistory, updated],
                currentIndex: truncatedHistory.length
            };
        });
    }, []);

    const undo = useCallback(() => {
        setHistoryState(prev => ({
            ...prev,
            currentIndex: Math.max(0, prev.currentIndex - 1)
        }));
    }, []);

    const redo = useCallback(() => {
        setHistoryState(prev => ({
            ...prev,
            currentIndex: Math.min(prev.history.length - 1, prev.currentIndex + 1)
        }));
    }, []);

    const setHistory = useCallback((nextHistory: T[]) => {
        setHistoryState(prev => ({ ...prev, history: nextHistory }));
    }, []);

    const setCurrentIndex = useCallback((nextIndex: number) => {
        setHistoryState(prev => ({ ...prev, currentIndex: nextIndex }));
    }, []);

    const canUndo = historyState.currentIndex > 0;
    const canRedo = historyState.currentIndex < historyState.history.length - 1;

    return {
        state,
        setState,
        undo,
        redo,
        canUndo,
        canRedo,
        history: historyState.history,
        setHistory,
        setCurrentIndex
    };
};

const hexToRgb = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return rgb(r, g, b);
};

const escapeHtml = (text: string): string =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

export const usePdfEditor = () => {
    const [files, setFiles] = useState<Record<string, EditorFile>>({});
    // Use history for pages
    const {
        state: pages,
        setState: setPages,
        undo,
        redo,
        canUndo,
        canRedo,
        setHistory: setPagesHistory,
        setCurrentIndex: setPagesCurrentIndex
    } = useHistory<EditorPage[]>([]);

    const [isProcessing, setIsProcessing] = useState(false);
    const [pageSize, setPageSize] = useState<PageSize>('Original');

    const addFiles = useCallback(async (newFiles: File[]) => {
        const newFilesMap: Record<string, EditorFile> = {};
        const newPages: EditorPage[] = [];

        for (const file of newFiles) {
            const fileId = Math.random().toString(36).substr(2, 9);
            try {
                let arrayBuffer = await file.arrayBuffer();

                // If image, convert to PDF first
                if (file.type === 'image/jpeg' || file.type === 'image/png' || file.name.endsWith('.jpg') || file.name.endsWith('.jpeg') || file.name.endsWith('.png')) {
                    const pdfDoc = await PDFDocument.create();
                    let image;
                    if (file.type === 'image/jpeg' || file.name.endsWith('.jpg') || file.name.endsWith('.jpeg')) {
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

                    // IMPORTANT: Replace the original image file with this new PDF file
                    // so that exportPdf reads this PDF buffer instead of the original image bytes.
                    const newFileName = file.name.replace(/\.(jpg|jpeg|png)$/i, '.pdf');
                    // Create a new File object
                    const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });
                    // Using distinct variable to avoid TS const re-assignment if we didn't use 'let' loop var, 
                    // but here 'file' is const in for-loop. We need to use this newFile in newFilesMap.

                    // We need to update the usage below to use newFile instead of file
                    // Let's store it in a map to override
                    newFilesMap[fileId] = {
                        id: fileId,
                        file: newFile,
                        pdfDoc: await pdfjsLib.getDocument({ data: arrayBuffer }).promise,
                        pageCount: 1 // We know it's 1 page
                    };

                    // Skip the default loading below for this file
                    const pdfDocJS = newFilesMap[fileId].pdfDoc!;
                    for (let i = 1; i <= pdfDocJS.numPages; i++) {
                        newPages.push({
                            id: `${fileId}-${i}-${Math.random().toString(36).substr(2, 5)}`,
                            fileId,
                            pageIndex: i,
                            rotation: 0,
                            annotations: []
                        });
                    }
                    continue; // Skip the rest of the loop for this file
                }

                // DOCX Handling
                if (file.name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                    const docxPreview = await import('docx-preview');
                    const html2canvas = (await import('html2canvas')).default;

                    // A4 dimensions at 96 DPI
                    const pageWidthPx = 794;
                    const pageHeightPx = 1123;

                    // Create container for docx-preview rendering
                    const container = document.createElement('div');
                    container.style.width = `${pageWidthPx}px`;
                    container.style.backgroundColor = 'white';
                    container.style.position = 'fixed';
                    container.style.left = '0';
                    container.style.top = '0';
                    container.style.zIndex = '-9999';
                    container.style.overflow = 'visible';
                    document.body.appendChild(container);

                    // Render DOCX using docx-preview
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

                    // Wait for rendering to complete
                    await new Promise(r => setTimeout(r, 500));

                    // Capture the rendered content
                    const canvas = await html2canvas(container, {
                        scale: 1,
                        useCORS: true,
                        logging: false,
                        width: pageWidthPx,
                        windowWidth: pageWidthPx,
                        scrollY: -window.scrollY
                    });

                    document.body.removeChild(container);

                    // Create PDF with pdf-lib
                    const pdfDoc = await PDFDocument.create();

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

                        const sliceData = sliceCanvas.toDataURL('image/png');
                        const sliceBytes = await fetch(sliceData).then(r => r.arrayBuffer());
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

                    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
                    const loadedPdf = await loadingTask.promise;

                    newFilesMap[fileId] = {
                        id: fileId,
                        file: newFile,
                        pdfDoc: loadedPdf,
                        pageCount: loadedPdf.numPages
                    };

                    for (let i = 1; i <= loadedPdf.numPages; i++) {
                        newPages.push({
                            id: `${fileId}-${i}-${Math.random().toString(36).substr(2, 5)}`,
                            fileId,
                            pageIndex: i,
                            rotation: 0,
                            annotations: []
                        });
                    }
                    continue;
                }

                // ODT Handling
                if (file.name.endsWith('.odt') || file.type === 'application/vnd.oasis.opendocument.text') {
                    const JSZip = (await import('jszip')).default;
                    const html2canvas = (await import('html2canvas')).default;

                    const zip = await JSZip.loadAsync(arrayBuffer);
                    const contentXml = await zip.file("content.xml")?.async("string");

                    if (contentXml) {
                        const parser = new DOMParser();
                        const xmlDoc = parser.parseFromString(contentXml, "text/xml");

                        // Create a simple HTML structure
                        let htmlContent = '';

                        const extractText = (node: Node): string => {
                            let text = '';
                            node.childNodes.forEach(child => {
                                if (child.nodeType === 3) text += escapeHtml(child.textContent ?? ''); // Text node
                                else if (child.nodeName.endsWith(':s')) text += ' '; // Space
                                else if (child.nodeName.endsWith(':tab')) text += '\t'; // Tab
                                else if (child.nodeName.endsWith(':line-break')) text += '<br/>';
                                else text += extractText(child);
                            });
                            return text;
                        };

                        const processNode = (node: Element) => {
                            const name = node.nodeName;
                            if (name.endsWith(':h')) {
                                const level = node.getAttributeNS("*", "outline-level") || '1';
                                const hLevel = parseInt(level) || 1;
                                htmlContent += `<h${Math.min(6, hLevel)}>${extractText(node)}</h${Math.min(6, hLevel)}>`;
                            } else if (name.endsWith(':p')) {
                                htmlContent += `<p>${extractText(node)}</p>`;
                            } else {
                                for (let i = 0; i < node.children.length; i++) {
                                    processNode(node.children[i]);
                                }
                            }
                        }

                        // Start from office:body -> office:text
                        const officeText = xmlDoc.getElementsByTagNameNS("*", "text")[0];
                        if (officeText) {
                            for (let i = 0; i < officeText.children.length; i++) {
                                processNode(officeText.children[i]);
                            }
                        }

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
                        container.innerHTML = htmlContent || '<p>No text content found.</p>';
                        document.body.appendChild(container);

                        // Wait for rendering
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                        const canvas = await html2canvas(container, {
                            scale: 1,
                            useCORS: true,
                            logging: false,
                            width: pageWidthPx,
                            windowWidth: pageWidthPx
                        });

                        document.body.removeChild(container);

                        // Create PDF with pdf-lib
                        const pdfDoc = await PDFDocument.create();

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

                            const sliceData = sliceCanvas.toDataURL('image/png');
                            const sliceBytes = await fetch(sliceData).then(r => r.arrayBuffer());
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

                        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
                        const loadedPdf = await loadingTask.promise;

                        newFilesMap[fileId] = {
                            id: fileId,
                            file: newFile,
                            pdfDoc: loadedPdf,
                            pageCount: loadedPdf.numPages
                        };

                        for (let i = 1; i <= loadedPdf.numPages; i++) {
                            newPages.push({
                                id: `${fileId}-${i}-${Math.random().toString(36).substr(2, 5)}`,
                                fileId,
                                pageIndex: i,
                                rotation: 0,
                                annotations: []
                            });
                        }
                        continue;
                    }
                }

                const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
                const pdfDoc = await loadingTask.promise;

                newFilesMap[fileId] = {
                    id: fileId,
                    file,
                    pdfDoc,
                    pageCount: pdfDoc.numPages
                };

                for (let i = 1; i <= pdfDoc.numPages; i++) {
                    newPages.push({
                        id: `${fileId}-${i}-${Math.random().toString(36).substr(2, 5)}`,
                        fileId,
                        pageIndex: i,
                        rotation: 0,
                        annotations: []
                    });
                }
            } catch (error) {
                console.error(`Error loading file ${file.name}:`, error);
                // Handle error (maybe skip file or show notification)
            }
        }

        setFiles(prev => ({ ...prev, ...newFilesMap }));
        // Ensure strictly new array for history
        setPages(prev => [...prev, ...newPages]);
    }, [setPages]);

    const movePage = useCallback((activeId: string, overId: string) => {
        setPages((items) => {
            const oldIndex = items.findIndex((item) => item.id === activeId);
            const newIndex = items.findIndex((item) => item.id === overId);
            return arrayMove(items, oldIndex, newIndex);
        });
    }, [setPages]);

    const rotatePage = useCallback((pageId: string) => {
        setPages(prev => prev.map(page => {
            if (page.id === pageId) {
                return { ...page, rotation: (page.rotation + 90) % 360 };
            }
            return page;
        }));
    }, [setPages]);

    const rotatePages = useCallback((pageIds: string[]) => {
        if (pageIds.length === 0) {
            return;
        }
        const idSet = new Set(pageIds);
        setPages(prev => prev.map(page => (
            idSet.has(page.id)
                ? { ...page, rotation: (page.rotation + 90) % 360 }
                : page
        )));
    }, [setPages]);

    const deletePage = useCallback((pageId: string) => {
        setPages(prev => prev.filter(page => page.id !== pageId));
    }, [setPages]);

    const deletePages = useCallback((pageIds: string[]) => {
        if (pageIds.length === 0) {
            return;
        }
        const idSet = new Set(pageIds);
        setPages(prev => prev.filter(page => !idSet.has(page.id)));
    }, [setPages]);

    const duplicatePages = useCallback((pageIds: string[]) => {
        if (pageIds.length === 0) {
            return;
        }

        const idSet = new Set(pageIds);
        setPages(prev => {
            const next: EditorPage[] = [];
            for (const page of prev) {
                next.push(page);
                if (idSet.has(page.id)) {
                    next.push({
                        ...page,
                        id: `${page.fileId}-${page.pageIndex}-${Math.random().toString(36).slice(2, 9)}`,
                        annotations: JSON.parse(JSON.stringify(page.annotations)) as Annotation[]
                    });
                }
            }
            return next;
        });
    }, [setPages]);

    const clearAll = useCallback(() => {
        setFiles({});
        // Reset history completely
        setPagesHistory([[]]);
        setPagesCurrentIndex(0);
    }, [setPagesHistory, setPagesCurrentIndex]);

    const exportPdf = useCallback(async (labels?: ExportLabels) => {
        if (pages.length === 0) return;
        setIsProcessing(true);

        try {
            const newPdf = await PDFDocument.create();

            for (const page of pages) {
                const fileData = files[page.fileId];
                if (!fileData) continue;

                const fileBuffer = await fileData.file.arrayBuffer();
                const srcPdf = await PDFDocument.load(fileBuffer);

                if (pageSize === 'Original') {
                    const [copiedPage] = await newPdf.copyPages(srcPdf, [page.pageIndex - 1]);
                    const existingRotation = copiedPage.getRotation()?.angle ?? 0;
                    const newRotation = (existingRotation + page.rotation) % 360;
                    copiedPage.setRotation(degrees(newRotation));
                    newPdf.addPage(copiedPage);

                    if (page.annotations.length > 0) {
                        const { width, height } = copiedPage.getSize();
                        await applyAnnotationsToPage(copiedPage, page.annotations, height, width, newRotation);
                    }
                } else {
                    const targetDims = PAGE_SIZES[pageSize];
                    if (!targetDims) throw new Error("Invalid page size");

                    const embeddedPage = await newPdf.embedPage(srcPdf.getPages()[page.pageIndex - 1]);
                    const srcPage = srcPdf.getPage(page.pageIndex - 1);
                    const srcRotation = srcPage.getRotation().angle;
                    const totalRotation = (srcRotation + page.rotation) % 360;

                    const { width: srcWidth, height: srcHeight } = embeddedPage;
                    const isRotatedSides = totalRotation === 90 || totalRotation === 270;
                    const effectiveWidth = isRotatedSides ? srcHeight : srcWidth;
                    const effectiveHeight = isRotatedSides ? srcWidth : srcHeight;

                    let [targetWidth, targetHeight] = targetDims;
                    if (effectiveWidth > effectiveHeight) {
                        [targetWidth, targetHeight] = [targetHeight, targetWidth];
                    }

                    const newPage = newPdf.addPage([targetWidth, targetHeight]);
                    const scale = Math.min(targetWidth / effectiveWidth, targetHeight / effectiveHeight);
                    const destWidth = effectiveWidth * scale;
                    const destHeight = effectiveHeight * scale;
                    const x = (targetWidth - destWidth) / 2;
                    const y = (targetHeight - destHeight) / 2;

                    const dims = { w: srcWidth * scale, h: srcHeight * scale };
                    let drawX = x;
                    let drawY = y;

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
                        rotate: degrees(totalRotation)
                    });

                    if (page.annotations.length > 0) {
                        await applyAnnotationsToPage(newPage, page.annotations, targetHeight, targetWidth, totalRotation);
                    }
                }
            }

            const pdfBytes = await newPdf.save();
            const prefix = labels?.downloadPrefix ?? 'edited_document';
            const originalName = labels?.originalName ?? 'original';
            downloadPdfBytes(pdfBytes, `${prefix}_${pageSize === 'Original' ? originalName : pageSize}.pdf`);
        } catch (error) {
            console.error("Error exporting PDF:", error);
            alert(labels?.failed ?? "Failed to export PDF.");
        } finally {
            setIsProcessing(false);
        }
    }, [pages, files, pageSize]);

    const applyAnnotationsToPage = async (
        pdfPage: PDFPage,
        annotations: Annotation[],
        pageHeight: number,
        pageWidth: number,
        rotation: number
    ) => {
        const fontHelvetica = await pdfPage.doc.embedFont(StandardFonts.Helvetica);
        const fontHelveticaBold = await pdfPage.doc.embedFont(StandardFonts.HelveticaBold);
        const fontHelveticaOblique = await pdfPage.doc.embedFont(StandardFonts.HelveticaOblique);
        const fontHelveticaBoldOblique = await pdfPage.doc.embedFont(StandardFonts.HelveticaBoldOblique);

        // Visual Dimensions (Editor Canvas)
        const VISUAL_WIDTH_PORTRAIT = 800;
        const VISUAL_HEIGHT_PORTRAIT = 1000;
        const VISUAL_WIDTH_LANDSCAPE = 1000;
        const VISUAL_HEIGHT_LANDSCAPE = 800;

        const isLandscape = rotation % 180 !== 0;

        // Scale factors: Visual -> PDF Page
        let scaleX = 1;
        let scaleY = 1;

        if (isLandscape) {
            scaleX = pageHeight / VISUAL_WIDTH_LANDSCAPE;
            scaleY = pageWidth / VISUAL_HEIGHT_LANDSCAPE;
        } else {
            scaleX = pageWidth / VISUAL_WIDTH_PORTRAIT;
            scaleY = pageHeight / VISUAL_HEIGHT_PORTRAIT;
        }

        const transformCoords = (x: number, y: number) => {
            if (rotation === 0) {
                return { x: x * scaleX, y: pageHeight - (y * scaleY) };
            }
            if (rotation === 90) {
                // Visual x (0..1000) -> PDF y (0..H)
                // Visual y (0..800) -> PDF x (0..W)
                return { x: y * scaleY, y: x * scaleX };
            }
            if (rotation === 180) {
                return { x: pageWidth - (x * scaleX), y: y * scaleY };
            }
            if (rotation === 270) {
                return { x: pageWidth - (y * scaleY), y: pageHeight - (x * scaleX) };
            }
            return { x: x * scaleX, y: pageHeight - (y * scaleY) };
        };

        const getRotationAdjustment = () => {
            if (rotation === 90) return -90;
            if (rotation === 180) return -180;
            if (rotation === 270) return -270;
            return 0;
        };

        for (const ann of annotations) {
            try {
                const { x, y } = transformCoords(ann.x, ann.y);
                const width = isLandscape ? ann.height * scaleX : ann.width * scaleX;
                const height = isLandscape ? ann.width * scaleY : ann.height * scaleY;
                const rotAdj = getRotationAdjustment();

                if (ann.type === 'text') {
                    const data = ann.data as TextAnnotationData;
                    let font = fontHelvetica;
                    if (data.bold && data.italic) font = fontHelveticaBoldOblique;
                    else if (data.bold) font = fontHelveticaBold;
                    else if (data.italic) font = fontHelveticaOblique;

                    const renderedLines = data.text.split(/\r?\n/);
                    const lines = renderedLines.length > 0 ? renderedLines : [''];
                    const scaledFontSize = data.fontSize * (isLandscape ? scaleX : scaleY);
                    const lineHeight = scaledFontSize * 1.25;
                    const startY = y - (rotation === 0 ? scaledFontSize : 0);

                    lines.forEach((line, index) => {
                        pdfPage.drawText(line.length > 0 ? line : ' ', {
                            x,
                            y: startY - (index * lineHeight),
                            size: scaledFontSize,
                            font,
                            color: hexToRgb(data.color || '#000000'),
                            rotate: degrees(rotAdj - ann.rotation),
                        });
                    });
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
                            thickness: data.strokeWidth * (isLandscape ? scaleX : scaleY),
                            color: hexToRgb(data.strokeColor),
                        });
                    }
                } else if (ann.type === 'shape') {
                    const data = ann.data as ShapeAnnotationData;
                    const color = hexToRgb(data.strokeColor);
                    const thickness = data.strokeWidth * (isLandscape ? scaleX : scaleY);

                    if (data.shapeType === 'rectangle') {
                        const p1 = transformCoords(ann.x, ann.y);
                        const p2 = transformCoords(ann.x + ann.width, ann.y);
                        const p3 = transformCoords(ann.x + ann.width, ann.y + ann.height);
                        const p4 = transformCoords(ann.x, ann.y + ann.height);

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
                        const rx = (ann.width / 2) * (isLandscape ? scaleY : scaleX);
                        const ry = (ann.height / 2) * (isLandscape ? scaleX : scaleY);

                        pdfPage.drawEllipse({
                            x: center.x,
                            y: center.y,
                            xScale: rx,
                            yScale: ry,
                            borderColor: color, borderWidth: thickness,
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
                } else if (ann.type === 'image') {
                    const data = ann.data as ImageAnnotationData;
                    let image;
                    try {
                        const imageBytes = await fetch(data.dataUrl).then(res => res.arrayBuffer());
                        if (data.dataUrl.includes('image/png')) {
                            image = await pdfPage.doc.embedPng(imageBytes);
                        } else {
                            image = await pdfPage.doc.embedJpg(imageBytes);
                        }

                        pdfPage.drawImage(image, {
                            x: x,
                            y: y - height,
                            width,
                            height,
                            rotate: degrees(-ann.rotation + rotAdj),
                        });
                    } catch (e) {
                        console.error("Failed to embed image", e);
                    }
                }
            } catch (err) {
                console.error("Error drawing annotation:", err);
            }
        }
    };

    const buildCurrentPdfBytes = useCallback(async () => {
        const newPdf = await PDFDocument.create();

        for (const page of pages) {
            const fileData = files[page.fileId];
            if (!fileData) {
                continue;
            }

            const fileBuffer = await fileData.file.arrayBuffer();
            const srcPdf = await PDFDocument.load(fileBuffer);

            if (pageSize === 'Original') {
                const [copiedPage] = await newPdf.copyPages(srcPdf, [page.pageIndex - 1]);
                const existingRotation = copiedPage.getRotation()?.angle ?? 0;
                const newRotation = (existingRotation + page.rotation) % 360;
                copiedPage.setRotation(degrees(newRotation));
                newPdf.addPage(copiedPage);

                if (page.annotations.length > 0) {
                    const { width, height } = copiedPage.getSize();
                    await applyAnnotationsToPage(copiedPage, page.annotations, height, width, newRotation);
                }
                continue;
            }

            const targetDims = PAGE_SIZES[pageSize];
            if (!targetDims) {
                throw new Error('Invalid page size');
            }

            const embeddedPage = await newPdf.embedPage(srcPdf.getPages()[page.pageIndex - 1]);
            const srcPage = srcPdf.getPage(page.pageIndex - 1);
            const srcRotation = srcPage.getRotation().angle;
            const totalRotation = (srcRotation + page.rotation) % 360;

            const { width: srcWidth, height: srcHeight } = embeddedPage;
            const isRotatedSides = totalRotation === 90 || totalRotation === 270;
            const effectiveWidth = isRotatedSides ? srcHeight : srcWidth;
            const effectiveHeight = isRotatedSides ? srcWidth : srcHeight;

            let [targetWidth, targetHeight] = targetDims;
            if (effectiveWidth > effectiveHeight) {
                [targetWidth, targetHeight] = [targetHeight, targetWidth];
            }

            const newPage = newPdf.addPage([targetWidth, targetHeight]);
            const scale = Math.min(targetWidth / effectiveWidth, targetHeight / effectiveHeight);
            const destWidth = effectiveWidth * scale;
            const destHeight = effectiveHeight * scale;
            const x = (targetWidth - destWidth) / 2;
            const y = (targetHeight - destHeight) / 2;

            const dims = { w: srcWidth * scale, h: srcHeight * scale };
            let drawX = x;
            let drawY = y;

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
                rotate: degrees(totalRotation),
            });

            if (page.annotations.length > 0) {
                await applyAnnotationsToPage(newPage, page.annotations, targetHeight, targetWidth, totalRotation);
            }
        }

        return newPdf.save();
    }, [pages, files, pageSize]);

    const exportProtectedPdf = useCallback(async (
        password: string,
        labels?: ProtectPdfLabels,
    ): Promise<boolean> => {
        if (pages.length === 0) {
            return false;
        }

        const normalizedPassword = password.trim();
        if (!normalizedPassword) {
            alert(labels?.invalidPassword ?? 'Please provide a valid password.');
            return false;
        }

        setIsProcessing(true);
        try {
            const rawBytes = await buildCurrentPdfBytes();
            const { PDF: SecurePDF } = await import('@libpdf/core');
            const securePdf = await SecurePDF.load(rawBytes);
            securePdf.setProtection({
                userPassword: normalizedPassword,
                ownerPassword: normalizedPassword,
                algorithm: 'AES-256',
            });

            const protectedBytes = await securePdf.save();
            const prefix = labels?.downloadPrefix ?? 'protected_document';
            const originalName = labels?.originalName ?? 'original';
            const sizeLabel = pageSize === 'Original' ? originalName : pageSize;
            downloadPdfBytes(protectedBytes, `${prefix}_${sizeLabel}.pdf`);
            return true;
        } catch (error) {
            console.error('Error protecting PDF:', error);
            alert(labels?.failed ?? 'Failed to protect PDF.');
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, [pages.length, buildCurrentPdfBytes, pageSize]);

    const unlockPdfFile = useCallback(async (
        file: File | null,
        password: string,
        labels?: UnlockPdfLabels
    ): Promise<boolean> => {
        if (!file) {
            alert(labels?.invalidFile ?? 'Please select a PDF file.');
            return false;
        }

        const isPdfFile = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdfFile) {
            alert(labels?.invalidFile ?? 'Please select a PDF file.');
            return false;
        }

        setIsProcessing(true);
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const { PDF: SecurePDF } = await import('@libpdf/core');
            const securePdf = await SecurePDF.load(bytes, { credentials: password });

            if (securePdf.isEncrypted) {
                securePdf.removeProtection();
            }

            const unlockedBytes = await securePdf.save();
            const prefix = labels?.downloadPrefix ?? 'unlocked_document';
            const baseName = file.name.replace(/\.pdf$/i, '');
            downloadPdfBytes(unlockedBytes, `${prefix}_${baseName}.pdf`);
            return true;
        } catch (error) {
            console.error('Error unlocking PDF:', error);
            if (isLikelyInvalidPasswordError(error)) {
                alert(labels?.invalidPassword ?? 'Invalid password.');
            } else {
                alert(labels?.failed ?? 'Failed to unlock PDF.');
            }
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, []);

    const updatePageAnnotations = useCallback((pageId: string, annotations: Annotation[]) => {
        setPages(prev => prev.map(page => {
            if (page.id === pageId) {
                return { ...page, annotations };
            }
            return page;
        }));
    }, [setPages]);

    return {
        files,
        pages,
        isProcessing,
        pageSize,
        setPageSize,
        addFiles,
        movePage,
        rotatePage,
        rotatePages,
        deletePage,
        deletePages,
        duplicatePages,
        clearAll,
        exportPdf,
        exportProtectedPdf,
        unlockPdfFile,
        undo,
        redo,
        canUndo,
        canRedo,
        updatePageAnnotations
    };
};
