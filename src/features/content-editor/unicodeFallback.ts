import { Encodings } from '@pdf-lib/standard-fonts';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import type { ContentEdit } from './types';
import { ContentRewriteError } from './rewriteContentStreams';
import { PDFJS_RESOURCE_VERSION } from '../../utils/pdfjsResourceVersion';

export type UnicodeFontId = 'western' | 'cjk';
export type UnicodeFontBytes = Partial<Record<UnicodeFontId, Uint8Array>>;

export interface UnicodeFallbackFont {
    name: string;
    font: PDFFont;
    encode: (text: string) => Uint8Array;
    width: (bytes: Uint8Array) => number;
    characterCount: (bytes: Uint8Array) => number;
    supports: (text: string) => boolean;
}

const fontPaths: Record<UnicodeFontId, string> = {
    western: `pdfjs/${PDFJS_RESOURCE_VERSION}/standard_fonts/LiberationSans-Regular.ttf`,
    cjk: 'fonts/NotoSansCJKsc-Regular.otf',
};

const fontBytesCache = new Map<UnicodeFontId, Promise<Uint8Array>>();

const fetchFontBytes = (id: UnicodeFontId) => {
    let pending = fontBytesCache.get(id);
    if (!pending) {
        pending = fetch(`${import.meta.env.BASE_URL}${fontPaths[id]}`).then(async response => {
            if (!response.ok) throw new Error(`Could not load the Unicode fallback font (${response.status}).`);
            return new Uint8Array(await response.arrayBuffer());
        });
        fontBytesCache.set(id, pending);
        void pending.catch(() => fontBytesCache.delete(id));
    }
    return pending;
};

const canEncodeWinAnsi = (text: string) => {
    try {
        for (const character of text) Encodings.WinAnsi.encodeUnicodeCodePoint(character.codePointAt(0) ?? 0);
        return true;
    } catch {
        return false;
    }
};

export const prepareUnicodeFallbackFonts = async (
    document: PDFDocument,
    edits: ContentEdit[],
    providedBytes: UnicodeFontBytes = {},
): Promise<UnicodeFallbackFont[]> => {
    const pendingText = edits.filter((edit): edit is Extract<ContentEdit, { type: 'text' }> =>
        edit.type === 'text' && edit.isDirty && !edit.deleted && !canEncodeWinAnsi(edit.text));
    if (!pendingText.length) return [];

    const { default: fontkit } = await import('@pdf-lib/fontkit');
    document.registerFontkit(fontkit);
    const fonts: UnicodeFallbackFont[] = [];
    const availableCharacterSets: Set<number>[] = [];

    for (const id of ['western', 'cjk'] as const) {
        if (pendingText.every(edit => fonts.some(font => font.supports(edit.text)))) break;
        const bytes = providedBytes[id] ?? await fetchFontBytes(id);
        const characterSet = new Set(fontkit.create(bytes).characterSet);
        availableCharacterSets.push(characterSet);
        const supports = (text: string) => [...text].every(character => characterSet.has(character.codePointAt(0) ?? 0));
        if (!pendingText.some(edit => supports(edit.text))) continue;
        const font = await document.embedFont(bytes, { subset: true });
        const widths = new Map<string, number>();
        const fallback: UnicodeFallbackFont = {
            name: `${id === 'western' ? 'PDFingUnicode' : 'PDFingCJK'}${font.ref.objectNumber}`,
            font,
            supports,
            encode: text => {
                const encoded = font.encodeText(text).asBytes();
                const key = Array.from(encoded, byte => byte.toString(16).padStart(2, '0')).join('');
                widths.set(key, font.widthOfTextAtSize(text, 1000));
                return encoded;
            },
            width: encoded => {
                const key = Array.from(encoded, byte => byte.toString(16).padStart(2, '0')).join('');
                const width = widths.get(key);
                if (width === undefined) throw new ContentRewriteError('unsupported-content', 'Unicode fallback glyph metrics are unavailable.');
                return width;
            },
            characterCount: encoded => {
                if (encoded.length % 2 !== 0) throw new ContentRewriteError('unsupported-content', 'The Unicode fallback contains an invalid CID.');
                return encoded.length / 2;
            },
        };
        for (const edit of pendingText) if (supports(edit.text)) fallback.encode(edit.text);
        fonts.push(fallback);
    }

    if (!fonts.length) {
        const missing = pendingText.flatMap(edit => [...edit.text]).find(character =>
            availableCharacterSets.every(characterSet => !characterSet.has(character.codePointAt(0) ?? 0)));
        throw new ContentRewriteError('unsupported-content', missing
            ? `No bundled Unicode font contains “${missing}”.`
            : 'No bundled Unicode font can encode this combination of characters.');
    }

    return fonts;
};
