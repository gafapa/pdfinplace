import type { PDFDict, PDFDocument, PDFEmbeddedPage, PDFObjectCopier, PDFPage, PDFRef } from 'pdf-lib';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions } from '../../hooks/editorTypes';
import type { Annotation, TextAnnotationData } from '../../types/annotations';
import { ContentEditExportError, getContentBox, getCropZoom, loadContentEditExporter, loadPdfLib, PAGE_SIZES } from '../../hooks/editorResources';
import { getLegacyEditorCanvasSize } from '../../utils/pageGeometry';
import { getContentEditErrorCode } from '../content-editor/errorMessages';
import { applyFormValuesToPdf } from '../forms/applyFormValues';
import { getFileFormValues } from '../forms/formWidgets';
import { compressPdfImages, type ImageCodec, type ImageCompressionResult, type ImageCompressionSettings } from './compressImages';
import { createAnnotationFonts, drawAnnotations, drawPrintOverlays, type FontBytesLoader, type Size } from './pageDecorations';
import { createPendingLinks, flattenPageAnnotations, multiplyMatrices, rotationMatrix, scaleMatrix, translationMatrix, type Box, type PendingLink } from './pageAnnotations';
import { pruneUnreachableObjects } from './pruneObjects';
import { sanitizeDocumentActions } from './sanitizeActions';
import { getRedactionRects, isRedaction, type PageRasterizer, type RedactionRect } from './redaction';

export interface BuildPdfOptions {
    sourcePages: EditorPage[];
    files: Record<string, EditorFile>;
    pageSize: PageSize;
    printOverlayOptions: PrintOverlayOptions;
    /** Cancellation/progress hook, called between pages. */
    checkpoint?: (completed?: number, total?: number) => Promise<void>;
    reportProgress?: boolean;
    loadFontBytes?: FontBytesLoader;
    /** Renders redacted pages to images; required when a page has redactions. */
    rasterizePage?: PageRasterizer;
    /** Recompresses raster images before saving. */
    imageCompression?: {
        settings: ImageCompressionSettings;
        codec: ImageCodec;
        onResult?: (result: ImageCompressionResult) => void;
    };
}

const normalizeRotation = (angle: number) => (((Math.round(angle / 90) * 90) % 360) + 360) % 360;

/** Font style used to pick a font for filled form text. */
const FORM_TEXT_STYLE: TextAnnotationData = { text: '', fontSize: 12, fontFamily: 'Arial', color: '#000000', bold: false, italic: false };

/** The region viewers display: the CropBox clipped to the MediaBox. */
const getVisibleBox = (page: PDFPage): Box => {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const left = Math.max(media.x, crop.x);
    const bottom = Math.max(media.y, crop.y);
    const right = Math.min(media.x + media.width, crop.x + crop.width);
    const top = Math.min(media.y + media.height, crop.y + crop.height);
    return right > left && top > bottom
        ? { x: left, y: bottom, width: right - left, height: top - bottom }
        : media;
};

/**
 * Maps the displayed (rotated) page area onto the page's unrotated user space,
 * so decorations drawn upright in that area appear upright after /Rotate.
 */
const displayToPageMatrix = (box: Box, rotation: number): [number, number, number, number, number, number] => {
    switch (rotation) {
        case 90: return [0, 1, -1, 0, box.x + box.width, box.y];
        case 180: return [-1, 0, 0, -1, box.x + box.width, box.y + box.height];
        case 270: return [0, -1, 1, 0, box.x, box.y + box.height];
        default: return [1, 0, 0, 1, box.x, box.y];
    }
};

interface PreparedPage {
    page: EditorPage;
    position: number;
    /** Document and page index holding the page to export (an isolated copy when content was edited). */
    document: PDFDocument;
    pageIndex: number;
    sourceDocument: PDFDocument;
    rotation: number;
    /** Editor annotations to draw (redactions are applied separately). */
    annotations: Annotation[];
    editorCanvas: Size;
    /** Non-empty when the page is exported as a redacted image. */
    redactions: RedactionRect[];
}

/**
 * Splits page references into batches where no page repeats, so every batch
 * can share one object copier (shared fonts and images are copied once).
 */
const batchByDocument = (prepared: PreparedPage[]) => {
    const byDocument = new Map<PDFDocument, { indices: Set<number>; items: PreparedPage[] }[]>();
    for (const item of prepared) {
        const batches = byDocument.get(item.document) ?? [];
        byDocument.set(item.document, batches);
        let batch = batches.find(candidate => !candidate.indices.has(item.pageIndex));
        if (!batch) {
            batch = { indices: new Set(), items: [] };
            batches.push(batch);
        }
        batch.indices.add(item.pageIndex);
        batch.items.push(item);
    }
    return [...byDocument.entries()].flatMap(([document, batches]) => batches.map(batch => ({ document, items: batch.items })));
};

/** Registers the form fields owned by copied widget annotations in the output AcroForm. */
const rebuildAcroForm = async (output: PDFDocument, copiedPages: PDFPage[], sources: PDFDocument[]) => {
    const { PDFDict: Dict, PDFName, PDFObjectCopier, PDFRef: Ref } = await loadPdfLib();
    const roots: PDFRef[] = [];
    const rootSet = new Set<string>();
    for (const page of copiedPages) {
        const annots = page.node.Annots();
        if (!annots) continue;
        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            const annot = output.context.lookupMaybe(ref, Dict);
            if (!annot) continue;
            // Viewers locate an annotation's page through /P; point it at the exported page.
            if (annot.has(PDFName.of('P'))) annot.set(PDFName.of('P'), page.ref);
            if (annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Widget' || !(ref instanceof Ref)) continue;
            let rootRef: PDFRef = ref;
            let node: PDFDict | undefined = annot;
            for (let depth = 0; node && depth < 32; depth += 1) {
                const parent = node.get(PDFName.of('Parent'));
                if (!(parent instanceof Ref)) break;
                rootRef = parent;
                node = output.context.lookupMaybe(parent, Dict);
            }
            if (!rootSet.has(rootRef.toString())) {
                rootSet.add(rootRef.toString());
                roots.push(rootRef);
            }
        }
    }
    if (!roots.length) return;

    const acroForm = output.context.obj({ Fields: roots });
    const sourceForm = sources
        .map(source => ({ source, form: source.catalog.lookupMaybe(PDFName.of('AcroForm'), Dict) }))
        .find(candidate => candidate.form);
    if (sourceForm?.form) {
        const copier = PDFObjectCopier.for(sourceForm.source.context, output.context);
        for (const key of ['DA', 'DR', 'Q', 'NeedAppearances']) {
            const value = sourceForm.form.get(PDFName.of(key));
            if (value !== undefined) acroForm.set(PDFName.of(key), copier.copy(value));
        }
    }
    output.catalog.set(PDFName.of('AcroForm'), output.context.register(acroForm));
};

/**
 * Builds the exported PDF.
 *
 * At the original page size without margins or crop, pages are copied whole,
 * so links, form fields and other page annotations survive and rotation is
 * stored as /Rotate. Otherwise pages are embedded as scaled Form XObjects:
 * links are recreated and other annotations (including filled form fields)
 * are flattened into the page. Either way, pages from the same source share
 * one copy of its fonts/images. Pages with redactions become images.
 */
export const buildPdfDocument = async ({
    sourcePages,
    files,
    pageSize,
    printOverlayOptions,
    checkpoint = async () => {},
    reportProgress = true,
    loadFontBytes,
    rasterizePage,
    imageCompression,
}: BuildPdfOptions) => {
    const pdfLib = await loadPdfLib();
    const output = await pdfLib.PDFDocument.create();
    const marginPercent = Math.max(0, Math.min(printOverlayOptions.marginPercent, 20));
    const cropPercent = Math.max(0, Math.min(printOverlayOptions.cropPercent, 20));
    const cropZoom = getCropZoom(cropPercent);
    const preserveStructure = pageSize === 'Original' && marginPercent === 0 && cropPercent === 0;
    const fonts = createAnnotationFonts(output, loadFontBytes);
    // Two passes over the pages (prepare, then assemble) share one progress range.
    const progressTotal = sourcePages.length * 2;
    const progress = (completed: number) => checkpoint(reportProgress ? completed : undefined, reportProgress ? progressTotal : undefined);

    const sourceCache = new Map<string, Promise<PDFDocument>>();
    const loadSource = (fileData: EditorFile) => {
        let pending = sourceCache.get(fileData.id);
        if (!pending) {
            pending = fileData.file.arrayBuffer()
                .then(buffer => pdfLib.PDFDocument.load(buffer))
                .then(async document => {
                    const formValues = getFileFormValues(sourcePages, fileData.id);
                    if (formValues && Object.keys(formValues).length > 0) {
                        const formFonts = createAnnotationFonts(document, loadFontBytes);
                        await applyFormValuesToPdf(document, formValues, text => formFonts.forLine(text, FORM_TEXT_STYLE));
                    }
                    return document;
                });
            sourceCache.set(fileData.id, pending);
        }
        return pending;
    };

    // 1. Resolve every exported page, applying content edits on isolated copies.
    const prepared: PreparedPage[] = [];
    for (const [position, page] of sourcePages.entries()) {
        await progress(position);
        const fileData = files[page.fileId];
        if (!fileData) continue;

        const sourceDocument = await loadSource(fileData);
        const sourceIndex = page.pageIndex - 1;
        const sourceRotation = sourceDocument.getPage(sourceIndex).getRotation().angle;
        let document = sourceDocument;
        let pageIndex = sourceIndex;

        if (page.contentEdits.length > 0) {
            try {
                const isolated = await pdfLib.PDFDocument.create();
                const [isolatedPage] = await isolated.copyPages(sourceDocument, [sourceIndex]);
                isolated.addPage(isolatedPage);
                const { applyContentEditsToPdfPage } = await loadContentEditExporter();
                await applyContentEditsToPdfPage(isolated, isolatedPage, page.contentEdits);
                document = isolated;
                pageIndex = 0;
            } catch (error) {
                console.error(`Error applying content edits to page ${position + 1}:`, error);
                const reason = error instanceof Error ? error.message : 'Unknown content rewrite error.';
                throw new ContentEditExportError(position + 1, reason, getContentEditErrorCode(error));
            }
        }

        const rotation = normalizeRotation(sourceRotation + page.rotation);
        const legacyCanvasSize = getLegacyEditorCanvasSize(rotation);
        const editorCanvas = {
            width: page.annotationCanvasWidth ?? legacyCanvasSize.width,
            height: page.annotationCanvasHeight ?? legacyCanvasSize.height,
        };
        prepared.push({
            page,
            position,
            document,
            pageIndex,
            sourceDocument,
            rotation,
            annotations: page.annotations.filter(annotation => !isRedaction(annotation)),
            editorCanvas,
            redactions: getRedactionRects(page.annotations, editorCanvas),
        });
    }

    // 2. Copy or embed pages, one batch per source document. Redacted pages are
    // rendered to images later and never copied.
    const copied = new Map<PreparedPage, PDFPage>();
    const embedded = new Map<PreparedPage, PDFEmbeddedPage>();
    for (const batch of batchByDocument(prepared.filter(item => item.redactions.length === 0))) {
        await checkpoint();
        if (preserveStructure) {
            const pages = await output.copyPages(batch.document, batch.items.map(item => item.pageIndex));
            batch.items.forEach((item, index) => copied.set(item, pages[index]));
        } else {
            const pages = batch.items.map(item => {
                const page = item.document.getPage(item.pageIndex);
                // pdf-lib cannot embed an otherwise valid blank page without /Contents.
                if (!page.node.Contents()) page.pushOperators();
                return page;
            });
            const boxes = pages.map(page => {
                const box = getVisibleBox(page);
                return { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height };
            });
            const embeddedPages = await output.embedPages(pages, boxes);
            batch.items.forEach((item, index) => embedded.set(item, embeddedPages[index]));
        }
    }

    // 3. Assemble pages in order and draw annotations and print overlays.
    const decorate = async (page: PDFPage, item: PreparedPage, area: Size) => {
        if (item.annotations.length > 0) {
            await drawAnnotations(page, item.annotations, area, item.editorCanvas, printOverlayOptions, fonts);
        }
        await drawPrintOverlays(page, area, item.position + 1, sourcePages.length, printOverlayOptions);
    };

    /** Where content of the displayed size lands on a new output page. */
    const layoutPage = (displayWidth: number, displayHeight: number) => {
        let targetWidth = displayWidth;
        let targetHeight = displayHeight;
        if (pageSize !== 'Original') {
            const targetDims = PAGE_SIZES[pageSize];
            if (!targetDims) throw new Error('Invalid page size');
            [targetWidth, targetHeight] = targetDims;
            if (displayWidth > displayHeight) [targetWidth, targetHeight] = [targetHeight, targetWidth];
        }
        const contentBox = getContentBox(targetWidth, targetHeight, marginPercent);
        const scale = Math.min(contentBox.width / displayWidth, contentBox.height / displayHeight) * cropZoom;
        const width = displayWidth * scale;
        const height = displayHeight * scale;
        return {
            targetWidth,
            targetHeight,
            scale,
            x: contentBox.x + ((contentBox.width - width) / 2),
            y: contentBox.y + ((contentBox.height - height) / 2),
            width,
            height,
        };
    };

    const copiers = new Map<PDFDocument, PDFObjectCopier>();
    const copierFor = (document: PDFDocument) => {
        let copier = copiers.get(document);
        if (!copier) {
            copier = pdfLib.PDFObjectCopier.for(document.context, output.context);
            copiers.set(document, copier);
        }
        return copier;
    };
    const pendingLinks: PendingLink[] = [];
    // First exported copy of each source page, for internal links.
    const exportedPages = new Map<PDFDocument, Map<string, PDFRef>>();
    const registerExportedPage = (item: PreparedPage, outputPage: PDFPage) => {
        const pages = exportedPages.get(item.document) ?? new Map<string, PDFRef>();
        exportedPages.set(item.document, pages);
        const key = item.document.getPage(item.pageIndex).ref.toString();
        if (!pages.has(key)) pages.set(key, outputPage.ref);
    };

    for (const [index, item] of prepared.entries()) {
        await progress(sourcePages.length + index);
        const copiedPage = copied.get(item);
        if (copiedPage) {
            output.addPage(copiedPage);
            registerExportedPage(item, copiedPage);
            copiedPage.setRotation(pdfLib.degrees(item.rotation));
            const box = getVisibleBox(copiedPage);
            const area = item.rotation % 180 === 0
                ? { width: box.width, height: box.height }
                : { width: box.height, height: box.width };
            const hasDecorations = item.annotations.length > 0
                || printOverlayOptions.includePageNumbers
                || [printOverlayOptions.watermarkText, printOverlayOptions.headerText, printOverlayOptions.footerText].some(text => text.trim());
            if (hasDecorations) {
                copiedPage.pushOperators(
                    pdfLib.pushGraphicsState(),
                    pdfLib.concatTransformationMatrix(...displayToPageMatrix(box, item.rotation)),
                );
                await decorate(copiedPage, item, area);
                copiedPage.pushOperators(pdfLib.popGraphicsState());
            }
            continue;
        }

        const sourcePage = item.document.getPage(item.pageIndex);
        const visibleBox = getVisibleBox(sourcePage);
        const isRotatedSides = item.rotation % 180 !== 0;
        const layout = layoutPage(
            isRotatedSides ? visibleBox.height : visibleBox.width,
            isRotatedSides ? visibleBox.width : visibleBox.height,
        );
        const newPage = output.addPage([layout.targetWidth, layout.targetHeight]);
        registerExportedPage(item, newPage);

        if (item.redactions.length > 0) {
            if (!rasterizePage) throw new Error('Redacted pages need a rasterizer.');
            // Render exactly the page that would be exported: content edits and
            // filled form values included, the document's other pages excluded.
            const single = await pdfLib.PDFDocument.create();
            const [singlePage] = await single.copyPages(item.document, [item.pageIndex]);
            single.addPage(singlePage);
            const raster = await rasterizePage({
                pdfBytes: await single.save(),
                rotation: item.page.rotation,
                redactions: item.redactions,
            });
            const image = raster.format === 'png' ? await output.embedPng(raster.bytes) : await output.embedJpg(raster.bytes);
            newPage.drawImage(image, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
        } else {
            const embeddedPage = embedded.get(item);
            if (!embeddedPage) continue;
            const drawnWidth = embeddedPage.width * layout.scale;
            const drawnHeight = embeddedPage.height * layout.scale;
            // /Rotate turns pages clockwise; drawPage rotates counterclockwise, so
            // rotate by the negative angle and shift the result back into place.
            const offset = item.rotation === 90 ? { x: 0, y: drawnWidth }
                : item.rotation === 180 ? { x: drawnWidth, y: drawnHeight }
                    : item.rotation === 270 ? { x: drawnHeight, y: 0 }
                        : { x: 0, y: 0 };
            const origin = { x: layout.x + offset.x, y: layout.y + offset.y };
            newPage.drawPage(embeddedPage, {
                ...origin,
                width: drawnWidth,
                height: drawnHeight,
                rotate: pdfLib.degrees(-item.rotation),
            });
            // The same transform drawPage applies: embedded form matrix, scale, rotation, position.
            const transform = [
                translationMatrix(-visibleBox.x, -visibleBox.y),
                scaleMatrix(layout.scale, layout.scale),
                rotationMatrix((-item.rotation * Math.PI) / 180),
                translationMatrix(origin.x, origin.y),
            ].reduce(multiplyMatrices);
            pendingLinks.push(...await flattenPageAnnotations(newPage, sourcePage, item.document, transform, visibleBox, copierFor(item.document)));
        }
        await decorate(newPage, item, { width: layout.targetWidth, height: layout.targetHeight });
    }

    await createPendingLinks(output, pendingLinks, (document, pageRef) => exportedPages.get(document)?.get(pageRef.toString()));

    if (preserveStructure) {
        await rebuildAcroForm(output, [...copied.values()], [...new Set(prepared.map(item => item.sourceDocument))]);
    }

    // Keep the title of a single-source export, which viewers show in tabs.
    const sources = new Set(prepared.map(item => item.sourceDocument));
    if (sources.size === 1) {
        const [source] = sources;
        const title = source.getTitle();
        if (title) output.setTitle(title);
        const author = source.getAuthor();
        if (author) output.setAuthor(author);
    }

    await output.flush();
    await sanitizeDocumentActions(output);
    await pruneUnreachableObjects(output);
    if (imageCompression) {
        const result = await compressPdfImages(output, imageCompression.settings, imageCompression.codec, () => checkpoint());
        imageCompression.onResult?.(result);
    }

    await progress(progressTotal);
    return output.save();
};
