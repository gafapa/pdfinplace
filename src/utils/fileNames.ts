/** A file name without its extension, made safe for downloads on every OS. */
export const toFileStem = (fileName: string) => {
    const stem = fileName
        .replace(/\.[^./\\]+$/, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Control characters are invalid in file names.
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 120)
        .trim();
    return stem || null;
};

/**
 * `<stem>_<suffix>_<parts…>` when the source name is known (e.g.
 * "invoice_edited_2-5"), otherwise `<fallback>_<parts…>`.
 */
export const buildDownloadName = (
    stem: string | null,
    suffix: string | undefined,
    fallback: string,
    ...parts: (string | undefined)[]
) => [stem ? [stem, suffix].filter(Boolean).join('_') : fallback, ...parts.filter(Boolean)].join('_');
