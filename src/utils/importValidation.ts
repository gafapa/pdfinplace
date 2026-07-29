const MAX_IMPORT_FILES = 20;
export const MAX_IMPORT_FILE_SIZE_BYTES = 75 * 1024 * 1024;
const MAX_IMPORT_TOTAL_SIZE_BYTES = 250 * 1024 * 1024;
export const MAX_IMPORT_PAGES = 500;
export const MAX_IMAGE_PIXELS = 32_000_000;
export const MAX_RENDER_PIXELS = 32_000_000;
export const MAX_ARCHIVE_ENTRIES = 2_000;
export const MAX_ARCHIVE_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
export const MAX_OFFICE_XML_ELEMENTS = 200_000;

export type ImportFileKind = 'pdf' | 'jpeg' | 'png' | 'docx' | 'odt' | 'unsupported';

export const formatMegabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export const getImportFileKind = (file: Pick<File, 'name' | 'type'>): ImportFileKind => {
    const normalizedName = file.name.toLowerCase();

    if (file.type === 'application/pdf' || normalizedName.endsWith('.pdf')) return 'pdf';
    if (file.type === 'image/jpeg' || normalizedName.endsWith('.jpg') || normalizedName.endsWith('.jpeg')) return 'jpeg';
    if (file.type === 'image/png' || normalizedName.endsWith('.png')) return 'png';
    if (
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        normalizedName.endsWith('.docx')
    ) return 'docx';
    if (file.type === 'application/vnd.oasis.opendocument.text' || normalizedName.endsWith('.odt')) return 'odt';

    return 'unsupported';
};

const isSupportedImportFile = (file: Pick<File, 'name' | 'type'>) =>
    getImportFileKind(file) !== 'unsupported';

export interface AcceptedImportFiles {
    acceptedFiles: File[];
    skippedReasons: ImportSkipReason[];
}

interface ImportSkipReason {
    code: 'file-count' | 'unsupported' | 'file-size' | 'batch-size';
    fileName?: string;
}

export const getAcceptedImportFiles = (newFiles: File[]): AcceptedImportFiles => {
    const acceptedFiles: File[] = [];
    const skippedReasons: ImportSkipReason[] = [];
    let acceptedBytes = 0;

    for (const file of newFiles) {
        if (acceptedFiles.length >= MAX_IMPORT_FILES) {
            skippedReasons.push({ code: 'file-count', fileName: file.name });
            continue;
        }

        if (!isSupportedImportFile(file)) {
            skippedReasons.push({ code: 'unsupported', fileName: file.name });
            continue;
        }

        if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
            skippedReasons.push({ code: 'file-size', fileName: file.name });
            continue;
        }

        if (acceptedBytes + file.size > MAX_IMPORT_TOTAL_SIZE_BYTES) {
            skippedReasons.push({ code: 'batch-size' });
            break;
        }

        acceptedFiles.push(file);
        acceptedBytes += file.size;
    }

    return { acceptedFiles, skippedReasons };
};

export const isAcceptedUnlockPdf = (file: File) =>
    getImportFileKind(file) === 'pdf' && file.size <= MAX_IMPORT_FILE_SIZE_BYTES;
