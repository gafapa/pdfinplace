type PdfJsModule = typeof import('pdfjs-dist');

let pdfJsPromise: Promise<PdfJsModule> | null = null;
let workerPort: Worker | null = null;

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
