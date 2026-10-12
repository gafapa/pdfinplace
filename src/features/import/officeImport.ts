import { type ArchiveEntryMetadata, validateArchiveLimits, validateOfficeXmlComplexity } from '../../hooks/editorResources';
import { renderPagesToPdf, settleLayout, withRenderHost, type PageElement, type RenderPagesOptions } from './renderPagesToPdf';

const loadArchive = async (bytes: ArrayBuffer) => {
    const JSZip = (await import('jszip')).default;
    const archive = await JSZip.loadAsync(bytes);
    validateArchiveLimits(archive.files as Record<string, ArchiveEntryMetadata>);
    return archive;
};

const pixels = (value: string) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Removes anything interactive or remote from rendered document markup. */
const neutralizeMarkup = (root: HTMLElement) => {
    for (const element of root.querySelectorAll('script, iframe, object, embed, link, meta, form, input, button, textarea')) element.remove();
    for (const element of root.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            if (name.startsWith('on') || name === 'href' || name === 'xlink:href' || (name === 'src' && !value.startsWith('data:image/'))) {
                element.removeAttribute(attribute.name);
            }
        }
    }
};

/**
 * Renders a DOCX with docx-preview, which lays out one <section> per page
 * break with the document's own page size and margins, and rasterizes it.
 */
export const convertDocxToPdf = async (bytes: ArrayBuffer, options: RenderPagesOptions) => {
    const archive = await loadArchive(bytes);
    const documentXml = await archive.file('word/document.xml')?.async('string');
    if (!documentXml) throw new Error('DOCX document.xml is missing.');
    validateOfficeXmlComplexity(documentXml);
    const docxPreview = await import('docx-preview');

    return withRenderHost(async (host) => {
        await docxPreview.renderAsync(bytes, host, undefined, {
            className: 'docx-preview',
            inWrapper: false,
            ignoreWidth: false,
            ignoreHeight: false,
            ignoreFonts: false,
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            experimental: true,
            trimXmlDeclaration: true,
            useBase64URL: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            renderEndnotes: true,
        });
        neutralizeMarkup(host);
        await settleLayout();

        const sections = [...host.querySelectorAll<HTMLElement>(':scope > section.docx-preview')];
        if (!sections.length) throw new Error('The DOCX produced no pages.');
        const pages: PageElement[] = sections.map(element => {
            const style = getComputedStyle(element);
            const width = element.offsetWidth || 794;
            return {
                element,
                width,
                // Pages grow past their nominal height when content overflows.
                height: pixels(style.minHeight) || Math.round(width * Math.SQRT2),
                marginTop: pixels(style.paddingTop),
                marginBottom: pixels(style.paddingBottom),
            };
        });
        return renderPagesToPdf(pages, options);
    });
};

// ---------------------------------------------------------------------------
// ODT

const NS = {
    office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    xlink: 'http://www.w3.org/1999/xlink',
} as const;

const is = (node: Node, ns: string, localName: string): node is Element =>
    node.nodeType === Node.ELEMENT_NODE && (node as Element).namespaceURI === ns && (node as Element).localName === localName;
const children = (node: Element) => [...node.children];
const attr = (element: Element, ns: string, name: string) => element.getAttributeNS(ns, name) ?? '';

const LENGTH = /^-?\d+(\.\d+)?(cm|mm|in|pt|pc|px)$/;
const toPixels = (value: string) => {
    const match = /^(-?\d+(?:\.\d+)?)(cm|mm|in|pt|pc|px)$/.exec(value.trim());
    if (!match) return undefined;
    const amount = Number(match[1]);
    const factor = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 }[match[2] as 'cm'];
    return amount * factor;
};

interface OdfStyle { family: string; parent?: string; properties: Map<string, string> }

/** Collects paragraph/text styles, keyed by family and name, with their parents. */
const collectStyles = (documents: Document[]) => {
    const styles = new Map<string, OdfStyle>();
    const defaults = new Map<string, Map<string, string>>();
    const readProperties = (element: Element) => {
        const properties = new Map<string, string>();
        for (const child of children(element)) {
            if (child.namespaceURI !== NS.style || !['text-properties', 'paragraph-properties', 'table-cell-properties'].includes(child.localName)) continue;
            for (const attribute of child.attributes) properties.set(attribute.localName, attribute.value);
        }
        return properties;
    };
    for (const document of documents) {
        for (const element of document.getElementsByTagNameNS(NS.style, 'style')) {
            const name = attr(element, NS.style, 'name');
            const family = attr(element, NS.style, 'family');
            if (!name) continue;
            styles.set(`${family}:${name}`, {
                family,
                parent: attr(element, NS.style, 'parent-style-name') || undefined,
                properties: readProperties(element),
            });
        }
        for (const element of document.getElementsByTagNameNS(NS.style, 'default-style')) {
            defaults.set(attr(element, NS.style, 'family'), readProperties(element));
        }
    }
    const resolve = (family: string, name: string) => {
        const chain: Map<string, string>[] = [];
        let current = name ? styles.get(`${family}:${name}`) : undefined;
        for (let depth = 0; current && depth < 16; depth += 1) {
            chain.unshift(current.properties);
            current = current.parent ? styles.get(`${family}:${current.parent}`) : undefined;
        }
        const merged = new Map<string, string>();
        for (const properties of chain) for (const [key, value] of properties) merged.set(key, value);
        return merged;
    };
    return { resolve, defaults };
};

const collectFontFamilies = (documents: Document[]) => {
    const families = new Map<string, string>();
    for (const document of documents) {
        for (const face of document.getElementsByTagNameNS(NS.style, 'font-face')) {
            const family = attr(face, NS.svg, 'font-family').replace(/['"]/g, '').trim();
            if (/^[\w\s.-]{1,80}$/.test(family)) families.set(attr(face, NS.style, 'name'), family);
        }
    }
    return families;
};

/** Applies the supported subset of ODF text/paragraph properties as validated inline CSS. */
const applyProperties = (element: HTMLElement, properties: Map<string, string>, fonts: Map<string, string>) => {
    const value = (key: string) => properties.get(key)?.trim() ?? '';
    const weight = value('font-weight');
    if (/^(bold|normal|[1-9]00)$/.test(weight)) element.style.fontWeight = weight;
    const fontStyle = value('font-style');
    if (/^(italic|normal|oblique)$/.test(fontStyle)) element.style.fontStyle = fontStyle;
    const size = value('font-size');
    if (LENGTH.test(size) || /^\d+(\.\d+)?%$/.test(size)) element.style.fontSize = size;
    const color = value('color');
    if (/^#[0-9a-f]{6}$/i.test(color)) element.style.color = color;
    const background = value('background-color');
    if (/^#[0-9a-f]{6}$/i.test(background)) element.style.backgroundColor = background;
    const decorations = [
        value('text-underline-style') && value('text-underline-style') !== 'none' ? 'underline' : '',
        value('text-line-through-style') && value('text-line-through-style') !== 'none' ? 'line-through' : '',
    ].filter(Boolean);
    if (decorations.length) element.style.textDecoration = decorations.join(' ');
    const align = { start: 'left', end: 'right', left: 'left', right: 'right', center: 'center', justify: 'justify' }[value('text-align')];
    if (align) element.style.textAlign = align;
    for (const [key, css] of [['margin-top', 'marginTop'], ['margin-bottom', 'marginBottom'], ['margin-left', 'marginLeft'], ['margin-right', 'marginRight'], ['text-indent', 'textIndent']] as const) {
        if (LENGTH.test(value(key))) element.style[css] = value(key);
    }
    const position = value('text-position');
    if (position.startsWith('super')) element.style.verticalAlign = 'super';
    else if (position.startsWith('sub')) element.style.verticalAlign = 'sub';
    const fontFamily = fonts.get(value('font-name'));
    if (fontFamily) element.style.fontFamily = `"${fontFamily}", sans-serif`;
};

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_DEPTH = 48;

/**
 * Converts ODT content into HTML (paragraphs, headings, inline styles, lists,
 * tables and embedded images) laid out on a page with the document's page
 * size and margins, then rasterizes it.
 */
export const convertOdtToPdf = async (bytes: ArrayBuffer, options: RenderPagesOptions) => {
    const archive = await loadArchive(bytes);
    const contentXml = await archive.file('content.xml')?.async('string');
    if (!contentXml) throw new Error('ODT content.xml is missing.');
    validateOfficeXmlComplexity(contentXml);
    const stylesXml = await archive.file('styles.xml')?.async('string');
    if (stylesXml) validateOfficeXmlComplexity(stylesXml);

    const parser = new DOMParser();
    const content = parser.parseFromString(contentXml, 'application/xml');
    if (content.getElementsByTagName('parsererror').length) throw new Error('ODT content.xml is not valid XML.');
    const stylesDocument = stylesXml ? parser.parseFromString(stylesXml, 'application/xml') : undefined;
    const documents = stylesDocument && !stylesDocument.getElementsByTagName('parsererror').length ? [stylesDocument, content] : [content];
    const { resolve, defaults } = collectStyles(documents);
    const fonts = collectFontFamilies(documents);

    // Page geometry from the first master page's layout; A4 with 2 cm margins otherwise.
    const layout = { width: toPixels('21cm')!, height: toPixels('29.7cm')!, top: toPixels('2cm')!, bottom: toPixels('2cm')!, left: toPixels('2cm')!, right: toPixels('2cm')! };
    if (stylesDocument) {
        const master = stylesDocument.getElementsByTagNameNS(NS.style, 'master-page')[0];
        const layoutName = master ? attr(master, NS.style, 'page-layout-name') : '';
        const pageLayout = [...stylesDocument.getElementsByTagNameNS(NS.style, 'page-layout')].find(element => attr(element, NS.style, 'name') === layoutName);
        const properties = pageLayout?.getElementsByTagNameNS(NS.style, 'page-layout-properties')[0];
        if (properties) {
            const read = (name: string, min: number, max: number) => {
                const parsed = toPixels(attr(properties, NS.fo, name));
                return parsed !== undefined && parsed >= min && parsed <= max ? parsed : undefined;
            };
            layout.width = read('page-width', 100, 5000) ?? layout.width;
            layout.height = read('page-height', 100, 5000) ?? layout.height;
            layout.top = read('margin-top', 0, layout.height / 3) ?? layout.top;
            layout.bottom = read('margin-bottom', 0, layout.height / 3) ?? layout.bottom;
            layout.left = read('margin-left', 0, layout.width / 3) ?? layout.left;
            layout.right = read('margin-right', 0, layout.width / 3) ?? layout.right;
        }
    }

    const images: Promise<void>[] = [];
    const loadImage = (target: HTMLImageElement, href: string) => {
        const path = href.replace(/^\.\//, '');
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        const type = IMAGE_TYPES[extension];
        const entry = !path.includes(':') && !path.startsWith('/') && !path.includes('..') ? archive.file(path) : null;
        if (!type || !entry) return false;
        images.push(entry.async('base64').then(data => new Promise<void>(resolveImage => {
            target.onload = () => resolveImage();
            target.onerror = () => { target.remove(); resolveImage(); };
            target.src = `data:${type};base64,${data}`;
        })));
        return true;
    };

    const convert = (source: Element, target: HTMLElement, depth: number) => {
        for (const node of source.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                target.append(node.textContent ?? '');
                continue;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const element = node as Element;
            if (depth >= MAX_DEPTH) {
                target.append(element.textContent ?? '');
                continue;
            }
            const styled = (tag: string, family: string) => {
                const created = document.createElement(tag);
                applyProperties(created, resolve(family, attr(element, NS.text, 'style-name') || attr(element, NS.table, 'style-name')), fonts);
                target.append(created);
                convert(element, created, depth + 1);
                return created;
            };
            if (is(element, NS.text, 'h')) {
                const level = Math.min(6, Math.max(1, Number.parseInt(attr(element, NS.text, 'outline-level'), 10) || 1));
                styled(`h${level}`, 'paragraph');
            } else if (is(element, NS.text, 'p')) {
                const paragraph = styled('p', 'paragraph');
                // An empty paragraph still occupies a line.
                if (!paragraph.textContent && !paragraph.querySelector('img')) paragraph.append(' ');
            } else if (is(element, NS.text, 'span')) {
                styled('span', 'text');
            } else if (is(element, NS.text, 's')) {
                // ODF collapses ordinary whitespace; text:s marks spaces that must be kept.
                const count = Math.min(100, Math.max(1, Number.parseInt(attr(element, NS.text, 'c'), 10) || 1));
                target.append(' '.repeat(count));
            } else if (is(element, NS.text, 'tab')) {
                target.append(' '.repeat(4));
            } else if (is(element, NS.text, 'line-break')) {
                target.append(document.createElement('br'));
            } else if (is(element, NS.text, 'list')) {
                const list = document.createElement('ul');
                list.style.margin = '0 0 0 1.5em';
                list.style.padding = '0';
                target.append(list);
                convert(element, list, depth + 1);
            } else if (is(element, NS.text, 'list-item') || is(element, NS.text, 'list-header')) {
                const item = document.createElement('li');
                if (is(element, NS.text, 'list-header')) item.style.listStyle = 'none';
                target.append(item);
                convert(element, item, depth + 1);
            } else if (is(element, NS.table, 'table')) {
                const table = document.createElement('table');
                Object.assign(table.style, { borderCollapse: 'collapse', width: '100%', margin: '0.5em 0' });
                const body = document.createElement('tbody');
                table.append(body);
                target.append(table);
                convert(element, body, depth + 1);
            } else if (is(element, NS.table, 'table-row')) {
                const row = document.createElement('tr');
                target.append(row);
                convert(element, row, depth + 1);
            } else if (is(element, NS.table, 'table-cell')) {
                const cell = document.createElement('td');
                Object.assign(cell.style, { border: '1px solid #808080', padding: '2px 4px', verticalAlign: 'top' });
                applyProperties(cell, resolve('table-cell', attr(element, NS.table, 'style-name')), fonts);
                const span = (name: string) => Math.min(100, Math.max(1, Number.parseInt(attr(element, NS.table, name), 10) || 1));
                cell.colSpan = span('number-columns-spanned');
                cell.rowSpan = span('number-rows-spanned');
                target.append(cell);
                convert(element, cell, depth + 1);
            } else if (is(element, NS.table, 'covered-table-cell') || is(element, NS.table, 'table-column') || is(element, NS.table, 'table-columns')) {
                // Covered cells are part of a spanning cell; columns carry only widths.
            } else if (is(element, NS.draw, 'frame')) {
                const width = toPixels(attr(element, NS.svg, 'width'));
                const height = toPixels(attr(element, NS.svg, 'height'));
                const image = children(element).find(child => is(child, NS.draw, 'image'));
                const textBox = children(element).find(child => is(child, NS.draw, 'text-box'));
                if (image) {
                    const img = document.createElement('img');
                    img.alt = '';
                    img.style.maxWidth = '100%';
                    if (width) img.style.width = `${width}px`;
                    if (height && width) img.style.height = `${height}px`;
                    if (loadImage(img, attr(image, NS.xlink, 'href'))) target.append(img);
                } else if (textBox) {
                    const box = document.createElement('div');
                    box.style.display = 'inline-block';
                    if (width) box.style.width = `${width}px`;
                    target.append(box);
                    convert(textBox, box, depth + 1);
                }
            } else if (is(element, NS.text, 'note')) {
                const citation = children(element).find(child => is(child, NS.text, 'note-citation'));
                if (citation) {
                    const mark = document.createElement('sup');
                    mark.textContent = citation.textContent ?? '';
                    target.append(mark);
                }
            } else if (
                is(element, NS.office, 'annotation') || is(element, NS.office, 'annotation-end')
                || is(element, NS.text, 'soft-page-break') || is(element, NS.text, 'tracked-changes')
                || is(element, NS.text, 'sequence-decls') || is(element, NS.text, 'variable-decls')
            ) {
                // Comments, tracked changes and declarations are not printed.
            } else if (is(element, NS.text, 'section')) {
                const section = document.createElement('div');
                target.append(section);
                convert(element, section, depth + 1);
            } else {
                // Fields (dates, page numbers, links, indexes) render their current text.
                convert(element, target, depth + 1);
            }
        }
    };

    return withRenderHost(async (host) => {
        const page = document.createElement('section');
        Object.assign(page.style, {
            boxSizing: 'border-box',
            width: `${layout.width}px`,
            minHeight: `${layout.height}px`,
            padding: `${layout.top}px ${layout.right}px ${layout.bottom}px ${layout.left}px`,
            backgroundColor: '#ffffff',
            color: '#000000',
            fontFamily: '"Liberation Serif", "Times New Roman", serif',
            fontSize: '12pt',
            lineHeight: '1.15',
            overflowWrap: 'break-word',
        });
        applyProperties(page, defaults.get('paragraph') ?? new Map(), fonts);
        // Paragraph spacing comes from the document's styles, not browser defaults.
        const reset = document.createElement('style');
        reset.textContent = '.odt-page p, .odt-page h1, .odt-page h2, .odt-page h3, .odt-page h4, .odt-page h5, .odt-page h6 { margin: 0; } .odt-page h1, .odt-page h2, .odt-page h3 { margin: 0.4em 0 0.2em; }';
        page.className = 'odt-page';
        host.append(reset, page);

        const body = content.getElementsByTagNameNS(NS.office, 'text')[0];
        if (body) convert(body, page, 0);
        await Promise.all(images);
        await settleLayout();
        return renderPagesToPdf([{
            element: page,
            width: layout.width,
            height: layout.height,
            marginTop: layout.top,
            marginBottom: layout.bottom,
        }], options);
    });
};
