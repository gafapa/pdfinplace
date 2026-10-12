import { readImageDimensions } from '../../utils/imageValidation';

const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_IMAGE_PIXELS = 16_000_000;

export type UploadedImage =
    | { ok: true; dataUrl: string; image: HTMLImageElement }
    | { ok: false; errorKey: 'modal.imageFileTooLarge' | 'modal.imagePixelsTooLarge' | 'modal.imageLoadFailed' };

const readAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
        if (typeof event.target?.result === 'string') resolve(event.target.result);
        else reject(new Error('The image could not be read.'));
    };
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
});

/**
 * Validates and loads a PNG/JPEG chosen by the user. The type is taken from
 * the file's own header, not its name, and size limits apply before decoding.
 */
export const readUploadedImage = async (file: File): Promise<UploadedImage> => {
    const isSupportedImage = ['image/png', 'image/jpeg'].includes(file.type) || /\.(png|jpe?g)$/.test(file.name.toLowerCase());
    if (!isSupportedImage || file.size > MAX_UPLOAD_IMAGE_BYTES) return { ok: false, errorKey: 'modal.imageFileTooLarge' };

    try {
        const buffer = await file.arrayBuffer();
        const dimensions = readImageDimensions(buffer);
        if (!dimensions || dimensions.width * dimensions.height > MAX_UPLOAD_IMAGE_PIXELS) {
            return { ok: false, errorKey: 'modal.imagePixelsTooLarge' };
        }
        const dataUrl = await readAsDataUrl(new Blob([buffer], { type: dimensions.kind === 'png' ? 'image/png' : 'image/jpeg' }));
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('The image could not be loaded.'));
            image.src = dataUrl;
        });
        if (image.width * image.height > MAX_UPLOAD_IMAGE_PIXELS) return { ok: false, errorKey: 'modal.imagePixelsTooLarge' };
        return { ok: true, dataUrl, image };
    } catch (error) {
        console.error('Failed to load the uploaded image:', error);
        return { ok: false, errorKey: 'modal.imageLoadFailed' };
    }
};
