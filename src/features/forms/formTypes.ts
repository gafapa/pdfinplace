/**
 * A filled form value, keyed by the field's fully qualified name:
 * text and combo boxes hold a string, check boxes a boolean, radio groups the
 * selected export value ('' for none) and list boxes the selected export values.
 */
export type FormFieldValue = string | boolean | string[];
export type FormValues = Record<string, FormFieldValue>;

export type FormWidgetType = 'text' | 'checkbox' | 'radiobutton' | 'combobox' | 'listbox';

export interface FormChoiceOption {
    exportValue: string;
    displayValue: string;
}

/** One visible, fillable widget of an AcroForm field, read through pdf.js. */
export interface FormWidget {
    /** pdf.js annotation id, used as the annotation storage key. */
    id: string;
    name: string;
    type: FormWidgetType;
    /** 0-based page index. */
    pageIndex: number;
    /** Widget rectangle in PDF user space: [x1, y1, x2, y2]. */
    rect: [number, number, number, number];
    editable: boolean;
    /** Value stored in the PDF, normalized like FormFieldValue. */
    initialValue: FormFieldValue;
    multiline?: boolean;
    password?: boolean;
    maxLength?: number;
    /** On-state name of a check box or radio button. */
    exportValue?: string;
    options?: FormChoiceOption[];
    multiSelect?: boolean;
}
