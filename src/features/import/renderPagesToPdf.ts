import { assertRenderableArea, canvasToPngBytes, loadPdfLib } from '../../hooks/editorResources';
import { MAX_RENDER_PIXELS } from '../../utils/importValidation';

/** A laid-out page element whose content may overflow onto further pages. */
export interface PageElement {
    element: HTMLElement;
    /** Page size and vertical margins in CSS pixels. */
    width: number;
    height: number;
    marginTop: number;
    marginBottom: number;
}

export interface RenderPagesOptions {
    /** Most pages this conversion may produce. */
    maxPages: number;
    /** Thrown when the document needs more than `maxPages` pages. */
    createPageLimitError: () => Error;
    checkpoint?: () => Promise<void>;
}

const PREFERRED_SCALE = 2;
// Browsers refuse canvases taller than ~32k device pixels; stay well below.
const MAX_CAPTURE_HEIGHT = 16_000;
// A page break is searched for in the lower part of the page, never higher.
const MIN_PAGE_FILL = 0.7;

/**
 * Finds the row in [fromRow, toRow] of `canvas` where a page can be cut
 * without slicing text or images: the lowest row that is (almost) a single
 * colour, or else the most uniform one. Working on the rendered pixels keeps
 * the cut exact even where html2canvas places glyphs differently from layout.
 */
const findCutRow = (canvas: HTMLCanvasElement, fromRow: number, toRow: number) => {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const top = Math.max(0, Math.floor(fromRow));
    const bottom = Math.min(canvas.height - 1, Math.floor(toRow));
    if (!context || bottom <= top) return bottom;
    const { data, width } = context.getImageData(0, top, canvas.width, bottom - top + 1);
    const samples = Math.ceil(width / 2);
    const tolerance = Math.max(1, Math.floor(samples * 0.002));
    const buckets = new Uint32Array(64);
    let bestRow = bottom;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let row = bottom - top; row >= 0; row -= 1) {
        buckets.fill(0);
        const offset = row * width * 4;
        for (let x = 0; x < width; x += 2) {
            const index = offset + x * 4;
            // Coarse luminance buckets tolerate antialiasing noise in backgrounds.
            buckets[((data[index] * 3 + data[index + 1] * 6 + data[index + 2]) / 10) >> 2]++;
        }
        let dominant = 0;
        for (const count of buckets) if (count > dominant) dominant = count;
        const score = samples - dominant;
        if (score <= tolerance) return top + row;
        if (score < bestScore) {
            bestScore = score;
            bestRow = top + row;
        }
    }
    return bestRow;
};

const capture = async (page: PageElement, scale: number, top: number, height: number) => {
    const html2canvas = (await import('html2canvas')).default;
    return html2canvas(page.element, {
        scale,
        y: top,
        height: Math.ceil(height),
        width: Math.ceil(page.width),
        windowWidth: Math.ceil(page.width),
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: false,
    });
};

const releaseCanvas = (canvas: HTMLCanvasElement) => {
    canvas.width = 1;
    canvas.height = 1;
};

/**
 * Rasterizes laid-out page elements (already attached to the document) into
 * a PDF with one image per page, at twice the CSS resolution when possible.
 * Content taller than a page continues on new pages that repeat the top margin.
 */
export const renderPagesToPdf = async (pages: PageElement[], options: RenderPagesOptions) => {
    const pdfLib = await loadPdfLib();
    const pdf = await pdfLib.PDFDocument.create();

    // Reject documents that certainly exceed the page budget before rendering
    // anything: no page can hold more than its content height.
    const minimumPages = pages.reduce((total, page) => {
        const contentHeight = Math.max(page.height * 0.5, page.height - page.marginTop - page.marginBottom);
        const totalHeight = Math.max(page.element.scrollHeight, page.element.offsetHeight);
        return total + Math.max(1, Math.ceil((totalHeight - page.marginTop - page.marginBottom) / contentHeight));
    }, 0);
    if (minimumPages > options.maxPages) throw options.createPageLimitError();

    let pageCount = 0;
    const addPage = async (page: PageElement, scale: number, source: HTMLCanvasElement, sourceTop: number, sourceHeight: number, offset: number) => {
        pageCount += 1;
        if (pageCount > options.maxPages) throw options.createPageLimitError();
        const canvasWidth = Math.ceil(page.width * scale);
        const canvasHeight = Math.ceil(page.height * scale);
        assertRenderableArea(canvasWidth, canvasHeight);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvasWidth;
        pageCanvas.height = canvasHeight;
        const context = pageCanvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable for document conversion.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvasWidth, canvasHeight);
        const height = Math.max(0, Math.min(sourceHeight, canvasHeight - offset, source.height - sourceTop));
        if (height > 0) context.drawImage(source, 0, sourceTop, source.width, height, 0, offset, source.width, height);

        const image = await pdf.embedPng(await canvasToPngBytes(pageCanvas));
        releaseCanvas(pageCanvas);
        // CSS pixels are 1/96 in; PDF points are 1/72 in.
        const widthPt = page.width * 0.75;
        const heightPt = page.height * 0.75;
        pdf.addPage([widthPt, heightPt]).drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
    };

    for (const page of pages) {
        await options.checkpoint?.();
        const scale = Math.min(PREFERRED_SCALE, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, page.width * page.height)));
        const totalHeight = Math.max(page.element.scrollHeight, page.element.offsetHeight);
        const pageRows = page.height * scale;
        const contentRows = Math.max(page.height * 0.5, page.height - page.marginTop - page.marginBottom) * scale;
        const marginTopRows = Math.round(page.marginTop * scale);
        const marginBottomRows = page.marginBottom * scale;

        if (totalHeight <= page.height + 1) {
            const canvas = await capture(page, scale, 0, page.height);
            await addPage(page, scale, canvas, 0, canvas.height, 0);
            releaseCanvas(canvas);
            continue;
        }

        // Short documents are captured once and sliced; long ones a page window at a time.
        const whole = totalHeight * scale <= MAX_CAPTURE_HEIGHT ? await capture(page, scale, 0, totalHeight) : null;
        const totalRows = whole ? whole.height : Math.ceil(totalHeight * scale);
        let start = 0;
        let offset = 0;
        let limit = pageRows - marginBottomRows;
        while (start < totalRows - 1) {
            await options.checkpoint?.();
            const isLast = totalRows - marginBottomRows <= limit;
            const windowRows = isLast ? totalRows - start : limit - start;
            const source = whole ?? await capture(page, scale, start / scale, windowRows / scale);
            const sourceStart = whole ? start : 0;
            const cut = isLast
                ? sourceStart + windowRows
                : findCutRow(source, sourceStart + windowRows * MIN_PAGE_FILL, sourceStart + windowRows - 1);
            const sliceRows = Math.max(1, cut - sourceStart);
            await addPage(page, scale, source, sourceStart, sliceRows, offset);
            if (!whole) releaseCanvas(source);
            if (isLast) break;
            start += sliceRows;
            offset = marginTopRows;
            limit = start + contentRows;
        }
        if (whole) releaseCanvas(whole);
    }
    return pdf.save();
};

/** Mounts a hidden, laid-out host for document rendering and removes it afterwards. */
export const withRenderHost = async <T,>(render: (host: HTMLDivElement) => Promise<T>) => {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        zIndex: '-9999',
        pointerEvents: 'none',
        backgroundColor: '#ffffff',
        color: '#000000',
    });
    document.body.appendChild(host);
    try {
        return await render(host);
    } finally {
        host.remove();
    }
};

/** Waits for web fonts and two frames so measurements reflect the final layout. */
export const settleLayout = async () => {
    try {
        await document.fonts?.ready;
    } catch {
        // Font loading failures leave fallback fonts in place.
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
