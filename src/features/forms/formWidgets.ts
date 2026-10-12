import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { FormChoiceOption, FormFieldValue, FormValues, FormWidget, FormWidgetType } from './formTypes';

const WIDGET_TYPES = new Set<FormWidgetType>(['text', 'checkbox', 'radiobutton', 'combobox', 'listbox']);
const widgetCache = new WeakMap<PDFDocumentProxy, Promise<FormWidget[]>>();

interface RawFieldObject {
    id?: string;
    name?: string;
    type?: string;
    page?: number;
    rect?: number[];
    editable?: boolean;
    hidden?: boolean;
    value?: unknown;
    multiline?: boolean;
    password?: boolean;
    charLimit?: number;
    exportValues?: unknown;
    items?: unknown;
    multipleSelection?: boolean;
}

const toOptions = (items: unknown): FormChoiceOption[] => Array.isArray(items)
    ? items.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const { exportValue, displayValue } = item as Record<string, unknown>;
        if (typeof exportValue !== 'string') return [];
        return [{ exportValue, displayValue: typeof displayValue === 'string' ? displayValue : exportValue }];
    })
    : [];

const toWidget = (raw: RawFieldObject): FormWidget | null => {
    const type = raw.type as FormWidgetType;
    if (!WIDGET_TYPES.has(type) || raw.hidden || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    if (typeof raw.page !== 'number' || raw.page < 0 || !Array.isArray(raw.rect) || raw.rect.length !== 4) return null;
    const [x1, y1, x2, y2] = raw.rect.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite) || x1 === x2 || y1 === y2) return null;
    const exportValue = typeof raw.exportValues === 'string' ? raw.exportValues : undefined;
    const rawValue = typeof raw.value === 'string' ? raw.value : '';
    let initialValue: FormFieldValue = rawValue;
    if (type === 'checkbox') initialValue = rawValue !== '' && rawValue !== 'Off';
    else if (type === 'radiobutton') initialValue = rawValue === 'Off' ? '' : rawValue;
    else if (type === 'listbox') initialValue = rawValue ? [rawValue] : [];
    return {
        id: raw.id,
        name: raw.name,
        type,
        pageIndex: raw.page,
        rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
        editable: raw.editable !== false,
        initialValue,
        multiline: raw.multiline || undefined,
        password: raw.password || undefined,
        maxLength: raw.charLimit && raw.charLimit > 0 ? raw.charLimit : undefined,
        exportValue,
        options: type === 'combobox' || type === 'listbox' ? toOptions(raw.items) : undefined,
        multiSelect: type === 'listbox' ? Boolean(raw.multipleSelection) : undefined,
    };
};

/** Reads the document's fillable widgets once per pdf.js document. */
export const loadFormWidgets = (pdfDocument: PDFDocumentProxy): Promise<FormWidget[]> => {
    let pending = widgetCache.get(pdfDocument);
    if (!pending) {
        pending = pdfDocument.getFieldObjects()
            .then(fields => {
                if (!fields) return [];
                // pdf.js 6 returns a Map; older versions returned a plain object.
                const entries = fields instanceof Map ? [...fields.values()] : Object.values(fields as Record<string, unknown>);
                return entries.flatMap(list => Array.isArray(list) ? list : [])
                    .map(raw => toWidget(raw as RawFieldObject))
                    .filter((widget): widget is FormWidget => widget !== null);
            })
            .catch(() => []);
        widgetCache.set(pdfDocument, pending);
    }
    return pending;
};

/** The value to show for a widget: the filled value, or the one stored in the PDF. */
export const getWidgetValue = (widget: FormWidget, values: FormValues | undefined): FormFieldValue => {
    const value = values?.[widget.name];
    if (value === undefined) return widget.initialValue;
    switch (widget.type) {
        case 'checkbox': return value === true;
        case 'listbox': return Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
        default: return typeof value === 'string' ? value : '';
    }
};

const toStorageValue = (widget: FormWidget, value: FormFieldValue) => {
    switch (widget.type) {
        case 'checkbox': return value === true;
        case 'radiobutton': return value === widget.exportValue;
        case 'combobox': return [typeof value === 'string' ? value : ''];
        case 'listbox': return Array.isArray(value) ? value : [];
        default: return typeof value === 'string' ? value : '';
    }
};

/**
 * Puts the filled values into the document's annotation storage, so the next
 * render with AnnotationMode.ENABLE_STORAGE draws them. Fields without a
 * filled value revert to their stored appearance. pdf.js snapshots the
 * storage when render() is called, so call this right before rendering.
 */
export const applyFormValuesToStorage = (pdfDocument: PDFDocumentProxy, widgets: FormWidget[], values: FormValues | undefined) => {
    const storage = pdfDocument.annotationStorage;
    for (const widget of widgets) {
        const value = values?.[widget.name];
        if (value === undefined) {
            if (storage.has(widget.id)) storage.remove(widget.id);
        } else {
            storage.setValue(widget.id, { value: toStorageValue(widget, value) });
        }
    }
};

/** Value map shared by every page of one file (pages carry the same map). */
export const getFileFormValues = (pages: { fileId: string; formValues?: FormValues }[], fileId: string) =>
    pages.find(page => page.fileId === fileId && page.formValues)?.formValues;
