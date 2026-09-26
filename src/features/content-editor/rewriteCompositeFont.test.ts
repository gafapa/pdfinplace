import { describe, expect, it } from 'vitest';
import { PDFArray, PDFContext, PDFDict, PDFName } from 'pdf-lib';
import { getCompositeFontCodec } from './rewriteCompositeFont';

const createFont = (cmap: string) => {
    const context = PDFContext.create();
    const unicodeRef = context.register(context.flateStream(cmap));
    const descendant = context.obj({
        DW: 500,
        W: [1, [600, 610], 3, 4, 700],
    }) as PDFDict;
    const descendantRef = context.register(descendant);
    const font = context.obj({
        Subtype: 'Type0',
        Encoding: 'Identity-H',
        DescendantFonts: [descendantRef],
        ToUnicode: unicodeRef,
    }) as PDFDict;
    return { context, font };
};

describe('Identity-H composite font codec', () => {
    it('encodes two-byte CIDs and uses W and DW metrics', () => {
        const { context, font } = createFont(`
            2 beginbfchar
            <0001> <0041>
            <0002> <D83DDE00>
            endbfchar
            1 beginbfrange
            <0003> <0004> <0042>
            endbfrange
        `);
        const codec = getCompositeFontCodec(font, context);

        expect(codec).toBeDefined();
        const bytes = codec?.encode('A😀BC') ?? new Uint8Array();
        expect([...bytes]).toEqual([0, 1, 0, 2, 0, 3, 0, 4]);
        expect(codec?.width(bytes)).toBe(2610);
        expect(codec?.characterCount(bytes)).toBe(4);
    });

    it('rejects vertical and ambiguous CMaps', () => {
        const vertical = createFont('1 beginbfchar <0001> <0041> endbfchar');
        vertical.font.set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
        expect(getCompositeFontCodec(vertical.font, vertical.context)).toBeUndefined();

        const ambiguous = createFont(`
            2 beginbfchar
            <0001> <0041>
            <0002> <0041>
            endbfchar
        `);
        expect(getCompositeFontCodec(ambiguous.font, ambiguous.context)).toBeUndefined();

        const conflictingCid = createFont(`
            2 beginbfchar
            <0001> <0041>
            <0001> <0042>
            endbfchar
        `);
        expect(getCompositeFontCodec(conflictingCid.font, conflictingCid.context)).toBeUndefined();

        const crossBlockAmbiguity = createFont(`
            1 beginbfchar <0001> <0041> endbfchar
            1 beginbfrange <0002> <0002> <0041> endbfrange
        `);
        expect(getCompositeFontCodec(crossBlockAmbiguity.font, crossBlockAmbiguity.context)).toBeUndefined();
    });

    it('fails when replacement text contains no source glyph', () => {
        const { context, font } = createFont('1 beginbfchar <0001> <0041> endbfchar');
        const codec = getCompositeFontCodec(font, context);

        expect(() => codec?.encode('Z')).toThrow('no glyph');
    });

    it('keeps a multi-codepoint ToUnicode mapping as one CID glyph', () => {
        const { context, font } = createFont('1 beginbfchar <0001> <00660069> endbfchar');
        const codec = getCompositeFontCodec(font, context);

        const bytes = codec?.encode('fi') ?? new Uint8Array();
        expect([...bytes]).toEqual([0, 1]);
        expect(codec?.characterCount(bytes)).toBe(1);
    });

    it('rejects malformed CID widths and inherited CMaps', () => {
        const malformed = createFont('1 beginbfchar <0001> <0041> endbfchar');
        const descendants = malformed.font.lookup(PDFName.of('DescendantFonts'), PDFArray);
        const descendant = malformed.context.lookup(descendants.get(0), PDFDict);
        descendant.set(PDFName.of('W'), malformed.context.obj([1, 2, -1]) as PDFArray);
        expect(getCompositeFontCodec(malformed.font, malformed.context)).toBeUndefined();

        malformed.font.set(PDFName.of('ToUnicode'), malformed.context.register(malformed.context.flateStream('/Other usecmap')));
        expect(getCompositeFontCodec(malformed.font, malformed.context)).toBeUndefined();
    });
});
