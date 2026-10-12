import type { PDFDocument, PDFField, PDFFont } from 'pdf-lib';
import { loadPdfLib } from '../../hooks/editorResources';
import type { FormValues } from './formTypes';

/** Thrown when filled form values cannot be written into a document. */
export class FormFillError extends Error {
    readonly fieldName: string;

    constructor(fieldName: string, cause?: unknown) {
        super(`The form field "${fieldName}" could not be filled.`);
        this.name = 'FormFillError';
        this.fieldName = fieldName;
        if (cause !== undefined) this.cause = cause;
    }
}

/** Picks a font able to draw a text value, or null when none of the bundled fonts can. */
export type FormFontPicker = (text: string) => Promise<PDFFont | null>;

/**
 * Writes filled values into the document's AcroForm and regenerates the
 * appearance of every changed text and choice field, so viewers (and the
 * flattened export) show the new values. Check boxes and radio buttons keep
 * their own on/off appearances; only their state changes.
 */
export const applyFormValuesToPdf = async (document: PDFDocument, values: FormValues, pickFont: FormFontPicker) => {
    const names = Object.keys(values);
    if (names.length === 0) return;
    const { PDFCheckBox, PDFDropdown, PDFHexString, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField } = await loadPdfLib();
    const form = document.getForm();
    const appearanceUpdates: Array<{ field: PDFField; text: string }> = [];

    for (const name of names) {
        const value = values[name];
        const field = form.getFieldMaybe(name);
        if (!field || field.isReadOnly()) continue;
        try {
            if (field instanceof PDFTextField) {
                const maxLength = field.getMaxLength();
                const text = typeof value === 'string' ? value : '';
                const clamped = maxLength !== undefined ? [...text].slice(0, maxLength).join('') : text;
                field.setText(clamped || undefined);
                appearanceUpdates.push({ field, text: clamped });
            } else if (field instanceof PDFCheckBox) {
                if (value === true) field.check();
                else field.uncheck();
            } else if (field instanceof PDFRadioGroup) {
                // Select by the widget's on-state name, which is what pdf.js reports
                // as the export value even when the field also has an /Opt array.
                const onValue = typeof value === 'string' && value
                    ? field.acroField.getOnValues().find(candidate => candidate.decodeText() === value)
                    : undefined;
                field.acroField.setValue(onValue ?? PDFName.of('Off'));
                form.markFieldAsDirty(field.ref);
            } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
                const selected = (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []);
                field.acroField.setValues(selected.map(option => PDFHexString.fromText(option)));
                form.markFieldAsDirty(field.ref);
                appearanceUpdates.push({ field, text: selected.join(' ') });
            }
        } catch (error) {
            throw new FormFillError(name, error);
        }
    }

    for (const { field, text } of appearanceUpdates) {
        const font = await pickFont(text.replace(/[\r\n\t]+/g, ' '));
        if (!font) throw new FormFillError(field.getName());
        try {
            if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) {
                field.updateAppearances(font);
            }
        } catch (error) {
            throw new FormFillError(field.getName(), error);
        }
    }
    // Fonts are only written into the document on flush; pages are copied out
    // of this document without saving it, so flush now.
    await document.flush();
};
