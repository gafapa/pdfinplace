export type ImageExportFormat = 'jpeg' | 'png' | 'webp';
export type ImageExportQualityPreset = 'compact' | 'balanced' | 'maximum';

export interface ImageExportFormatDetails {
    extension: 'jpg' | 'png' | 'webp';
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const IMAGE_EXPORT_FORMATS: Record<ImageExportFormat, ImageExportFormatDetails> = {
    jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
    png: { extension: 'png', mimeType: 'image/png' },
    webp: { extension: 'webp', mimeType: 'image/webp' },
};

const IMAGE_EXPORT_QUALITY_VALUES: Record<ImageExportQualityPreset, number> = {
    compact: 55,
    balanced: 80,
    maximum: 100,
};

export const getImageExportQualityValue = (preset: ImageExportQualityPreset) => (
    IMAGE_EXPORT_QUALITY_VALUES[preset]
);

export const normalizeImageExportQuality = (quality: number) => {
    if (!Number.isFinite(quality)) return 80;
    return Math.max(30, Math.min(100, Math.round(quality)));
};

export const getImageExportRenderScale = (quality: number) => {
    const normalizedQuality = normalizeImageExportQuality(quality);
    return 0.35 + (normalizedQuality * 0.0215);
};

export const getImageExportFormatDetails = (format: ImageExportFormat) => (
    IMAGE_EXPORT_FORMATS[format]
);

export const getImageExportFilename = (
    pageNumber: number,
    totalPages: number,
    pagePrefix: string,
    format: ImageExportFormat,
) => {
    const safePageNumber = Math.max(1, Math.trunc(pageNumber));
    const safeTotalPages = Math.max(safePageNumber, Math.trunc(totalPages));
    const digits = Math.max(3, String(safeTotalPages).length);
    return `${pagePrefix}-${String(safePageNumber).padStart(digits, '0')}.${IMAGE_EXPORT_FORMATS[format].extension}`;
};
