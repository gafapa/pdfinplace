type PdfJsModule = typeof import('pdfjs-dist');
type PdfDocumentInitParameters = import('pdfjs-dist/types/src/display/api').DocumentInitParameters;
type PdfDocumentProxy = import('pdfjs-dist').PDFDocumentProxy;
type PdfLoadingTask = import('pdfjs-dist').PDFDocumentLoadingTask;

let pdfJsPromise: Promise<PdfJsModule> | null = null;
let workerPort: Worker | null = null;

const appendTrailingSlash = (url: string) => url.endsWith('/') ? url : `${url}/`;

const resolvePdfJsAssetBaseUrl = () => {
    const configuredBaseUrl = `${appendTrailingSlash(import.meta.env.BASE_URL)}pdfjs/`;
    const documentBaseUrl = typeof document === 'undefined' ? globalThis.location?.href : document.baseURI;
    return new URL(configuredBaseUrl, documentBaseUrl).href;
};

const pdfJsAssetBaseUrl = resolvePdfJsAssetBaseUrl();

const pdfDocumentOptions: Pick<
    PdfDocumentInitParameters,
    'cMapPacked' | 'cMapUrl' | 'iccUrl' | 'standardFontDataUrl' | 'useWasm' | 'wasmUrl'
> = {
    cMapPacked: true,
    cMapUrl: `${pdfJsAssetBaseUrl}cmaps/`,
    iccUrl: `${pdfJsAssetBaseUrl}iccs/`,
    standardFontDataUrl: `${pdfJsAssetBaseUrl}standard_fonts/`,
    useWasm: true,
    wasmUrl: `${pdfJsAssetBaseUrl}wasm/`,
};

const loadPdfJsWorker = async (): Promise<Worker> => {
    if (workerPort) {
        return workerPort;
    }

    const WorkerConstructor = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')).default;
    workerPort = new WorkerConstructor();
    return workerPort;
};

export const loadPdfJs = async (): Promise<PdfJsModule> => {
    if (!pdfJsPromise) {
        pdfJsPromise = (import('pdfjs-dist/build/pdf.min.mjs') as Promise<PdfJsModule>).then(async (module) => {
            if (!module.GlobalWorkerOptions.workerPort) {
                module.GlobalWorkerOptions.workerPort = await loadPdfJsWorker();
            }

            return module;
        });
    }

    return pdfJsPromise;
};

export const getPdfDocument = async (source: PdfDocumentInitParameters): Promise<PdfLoadingTask> => {
    const pdfJs = await loadPdfJs();
    return pdfJs.getDocument({
        ...pdfDocumentOptions,
        ...source,
    });
};

export const loadPdfDocument = async (source: PdfDocumentInitParameters): Promise<PdfDocumentProxy> => {
    const loadingTask = await getPdfDocument(source);
    return loadingTask.promise;
};
