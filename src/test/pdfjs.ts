import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument as openDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

// Load native canvas/PDF.js during suite setup, outside an individual assertion's
// timeout, and resolve fonts locally instead of depending on system fonts/network.
export const getDocument = (options: DocumentInitParameters) => openDocument({
    standardFontDataUrl: `${join(packageRoot, 'standard_fonts')}/`,
    cMapUrl: `${join(packageRoot, 'cmaps')}/`,
    cMapPacked: true,
    useWorkerFetch: false,
    verbosity: 0,
    ...options,
});
