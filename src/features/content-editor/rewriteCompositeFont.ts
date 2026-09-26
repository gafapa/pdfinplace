import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFRef,
    PDFStream,
    type PDFContext,
    type PDFObject,
} from 'pdf-lib';
import { BoundedPdfStreamError, decodeBoundedPdfStream } from './decodeBoundedPdfStream';

export interface CompositeFontCodec {
    encode: (text: string) => Uint8Array;
    decode: (bytes: Uint8Array) => string;
    width: (bytes: Uint8Array) => number;
    characterCount: (bytes: Uint8Array) => number;
}

const textDecoder = new TextDecoder('latin1');
const MAX_CMAP_SOURCE_LENGTH = 1_000_000;
const MAX_CMAP_MAPPINGS = 20_000;
const MAX_CID = 0xffff;

const asNumber = (value: PDFObject | undefined, context: PDFContext) => {
    const resolved = value instanceof PDFNumber
        ? value
        : value instanceof PDFRef ? context.lookupMaybe(value, PDFNumber) : undefined;
    return resolved?.asNumber();
};

const asArray = (value: PDFObject | undefined, context: PDFContext) => (
    value instanceof PDFArray ? value : value instanceof PDFRef ? context.lookupMaybe(value, PDFArray) : undefined
);

const asDict = (value: PDFObject | undefined, context: PDFContext) => (
    value instanceof PDFDict ? value : value instanceof PDFRef ? context.lookupMaybe(value, PDFDict) : undefined
);

const asStream = (value: PDFObject | undefined, context: PDFContext) => {
    if (!value) return undefined;
    const resolved = value instanceof PDFStream ? value : value instanceof PDFRef ? context.lookup(value) : undefined;
    return resolved instanceof PDFStream ? resolved : undefined;
};

const decodeHex = (value: string) => {
    const compact = value.replaceAll(/\s/g, '');
    if (compact.length === 0 || compact.length % 2 !== 0 || !/^[\da-fA-F]+$/.test(compact)) return undefined;
    return Uint8Array.from(compact.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
};

const decodeUtf16Be = (hex: string) => {
    const bytes = decodeHex(hex);
    if (!bytes || bytes.length % 2 !== 0) return undefined;
    let value = '';
    for (let index = 0; index < bytes.length; index += 2) {
        value += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
};

const parseCid = (hex: string) => {
    const bytes = decodeHex(hex);
    return bytes?.length === 2 ? (bytes[0] << 8) | bytes[1] : undefined;
};

const addMapping = (mapping: Map<string, number>, cid: number, unicode: string) => {
    if (!unicode || mapping.size >= MAX_CMAP_MAPPINGS) return false;
    const existing = mapping.get(unicode);
    if (existing !== undefined && existing !== cid) return false;
    mapping.set(unicode, cid);
    return true;
};

const parseToUnicode = (source: string) => {
    if (source.length > MAX_CMAP_SOURCE_LENGTH) return undefined;
    const content = source.replaceAll(/%[^\r\n]*/g, '');
    if (/\busecmap\b/i.test(content)) return undefined;
    const mappings = new Map<string, number>();
    const cidToUnicode = new Map<number, string>();
    let valid = true;
    const add = (cidHex: string, unicodeHex: string) => {
        const cid = parseCid(cidHex);
        const unicode = decodeUtf16Be(unicodeHex);
        if (cid === undefined || unicode === undefined || cidToUnicode.get(cid) && cidToUnicode.get(cid) !== unicode) {
            valid = false;
            return;
        }
        cidToUnicode.set(cid, unicode);
        if (!addMapping(mappings, cid, unicode)) valid = false;
    };

    for (const block of content.matchAll(/beginbfchar\s*([\s\S]*?)\s*endbfchar/gi)) {
        for (const entry of block[1].matchAll(/<([^>]+)>\s*<([^>]+)>/g)) add(entry[1], entry[2]);
    }

    for (const block of content.matchAll(/beginbfrange\s*([\s\S]*?)\s*endbfrange/gi)) {
        const entryPattern = /<([^>]+)>\s*<([^>]+)>\s*(\[[\s\S]*?\]|<[^>]+>)/g;
        for (const entry of block[1].matchAll(entryPattern)) {
            const start = parseCid(entry[1]);
            const end = parseCid(entry[2]);
            if (start === undefined || end === undefined || end < start) {
                valid = false;
                continue;
            }
            if (end - start + 1 > MAX_CMAP_MAPPINGS) {
                valid = false;
                continue;
            }
            const target = entry[3].trim();
            if (target.startsWith('[')) {
                const targets = [...target.matchAll(/<([^>]+)>/g)].map((item) => item[1]);
                if (targets.length !== end - start + 1) {
                    valid = false;
                    continue;
                }
                targets.forEach((unicodeHex, offset) => add(`${((start + offset) >> 8).toString(16).padStart(2, '0')}${((start + offset) & 0xff).toString(16).padStart(2, '0')}`, unicodeHex));
                continue;
            }
            const unicode = decodeUtf16Be(target.slice(1, -1));
            if (!unicode || [...unicode].length !== 1) {
                valid = false;
                continue;
            }
            const codePoint = unicode.codePointAt(0);
            if (codePoint === undefined) {
                valid = false;
                continue;
            }
            const lastCodePoint = codePoint + end - start;
            const crossesSurrogateRange = codePoint > 0xffff
                || lastCodePoint > 0xffff
                || (codePoint <= 0xdfff && lastCodePoint >= 0xd800);
            if (crossesSurrogateRange) {
                valid = false;
                continue;
            }
            for (let cid = start; cid <= end; cid += 1) {
                const next = String.fromCodePoint(codePoint + cid - start);
                add(`${(cid >> 8).toString(16).padStart(2, '0')}${(cid & 0xff).toString(16).padStart(2, '0')}`, Array.from(next).map((character) => character.codePointAt(0)?.toString(16).padStart(4, '0')).join(''));
            }
        }
    }

    return valid && mappings.size > 0 ? mappings : undefined;
};

const readToUnicode = (font: PDFDict, context: PDFContext) => {
    const stream = asStream(font.get(PDFName.of('ToUnicode')), context);
    if (!(stream instanceof PDFRawStream)) return undefined;
    try {
        return textDecoder.decode(decodeBoundedPdfStream(stream, MAX_CMAP_SOURCE_LENGTH));
    } catch (error) {
        if (error instanceof BoundedPdfStreamError) return undefined;
        throw error;
    }
};

const getWidths = (cidFont: PDFDict, context: PDFContext) => {
    const defaultWidth = asNumber(cidFont.get(PDFName.of('DW')), context) ?? 1000;
    if (!Number.isFinite(defaultWidth) || defaultWidth < 0) return undefined;
    const widths = new Map<number, number>();
    const definition = asArray(cidFont.get(PDFName.of('W')), context);
    if (!definition) return { defaultWidth, widths };
    const entries = definition.asArray();
    let index = 0;
    while (index < entries.length) {
        const startCid = asNumber(entries[index], context);
        const next = entries[index + 1];
        if (startCid === undefined || !Number.isInteger(startCid) || startCid < 0 || startCid > MAX_CID || !next) return undefined;
        const sequential = asArray(next, context);
        if (sequential) {
            if (startCid + sequential.size() - 1 > MAX_CID) return undefined;
            let valid = true;
            sequential.asArray().forEach((entry, offset) => {
                const width = asNumber(entry, context);
                if (width === undefined || !Number.isFinite(width) || width < 0) valid = false;
                else widths.set(startCid + offset, width);
            });
            if (!valid) return undefined;
            index += 2;
            continue;
        }
        const endCid = asNumber(next, context);
        const width = asNumber(entries[index + 2], context);
        if (endCid === undefined || !Number.isInteger(endCid) || endCid < startCid || endCid > MAX_CID || width === undefined || !Number.isFinite(width) || width < 0) return undefined;
        for (let cid = startCid; cid <= endCid; cid += 1) widths.set(cid, width);
        index += 3;
    }
    return widths.size <= MAX_CID + 1 ? { defaultWidth, widths } : undefined;
};

/** Supports the conservative Identity-H subset used by common Office-generated PDFs. */
export const getCompositeFontCodec = (font: PDFDict, context: PDFContext): CompositeFontCodec | undefined => {
    if (font.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Type0') return undefined;
    if (font.lookupMaybe(PDFName.of('Encoding'), PDFName)?.decodeText() !== 'Identity-H') return undefined;

    const descendants = asArray(font.get(PDFName.of('DescendantFonts')), context);
    const cidFont = descendants ? asDict(descendants.get(0), context) : undefined;
    const source = readToUnicode(font, context);
    if (!cidFont || !source) return undefined;

    const unicodeToCid = parseToUnicode(source);
    const widthData = getWidths(cidFont, context);
    if (!unicodeToCid || !widthData) return undefined;

    const encodingEntries = [...unicodeToCid.entries()].sort((left, right) => right[0].length - left[0].length);
    const cidToUnicode = new Map([...unicodeToCid.entries()].map(([unicode, cid]) => [cid, unicode]));
    return {
        encode: (text) => {
            const bytes: number[] = [];
            for (let index = 0; index < text.length;) {
                const match = encodingEntries.find(([unicode]) => text.startsWith(unicode, index));
                if (!match) {
                    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
                    throw new Error(`The PDF font has no glyph for “${character}”.`);
                }
                const [unicode, cid] = match;
                bytes.push(cid >> 8, cid & 0xff);
                index += unicode.length;
            }
            return Uint8Array.from(bytes);
        },
        decode: (bytes) => {
            if (bytes.length % 2 !== 0) throw new Error('The composite font text must contain complete two-byte CIDs.');
            let text = '';
            for (let index = 0; index < bytes.length; index += 2) {
                const unicode = cidToUnicode.get((bytes[index] << 8) | bytes[index + 1]);
                if (unicode === undefined) throw new Error('The composite font contains a CID without a ToUnicode mapping.');
                text += unicode;
            }
            return text;
        },
        width: (bytes) => {
            if (bytes.length % 2 !== 0) throw new Error('The composite font text must contain complete two-byte CIDs.');
            let total = 0;
            for (let index = 0; index < bytes.length; index += 2) {
                const cid = (bytes[index] << 8) | bytes[index + 1];
                total += widthData.widths.get(cid) ?? widthData.defaultWidth;
            }
            return total;
        },
        characterCount: (bytes) => {
            if (bytes.length % 2 !== 0) throw new Error('The composite font text must contain complete two-byte CIDs.');
            return bytes.length / 2;
        },
    };
};
