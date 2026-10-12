import { useEffect, useState, type CSSProperties } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { FormFieldValue, FormValues, FormWidget } from './formTypes';
import { getWidgetValue, loadFormWidgets } from './formWidgets';

interface PlacedWidget {
    widget: FormWidget;
    label: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

interface FormFieldLayerProps {
    isActive: boolean;
    pdfDocument?: PDFDocumentProxy;
    /** 1-based page number. */
    pageIndex: number;
    /** Native plus user rotation, as shown in the editor. */
    displayRotation: number;
    /** Editor canvas size the layer covers. */
    width: number;
    height: number;
    values: FormValues;
    onChange: (name: string, value: FormFieldValue) => void;
    /** Reports how many fillable fields the page has (0 hides the tool). */
    onFieldCount?: (count: number) => void;
}

const lastNamePart = (name: string) => name.split('.').filter(Boolean).at(-1) ?? name;

/**
 * Fillable inputs placed over the page's AcroForm widgets. Inputs are opaque so
 * the field appearance drawn by the preview underneath never shows through
 * stale while typing.
 */
export const FormFieldLayer = ({
    isActive,
    pdfDocument,
    pageIndex,
    displayRotation,
    width,
    height,
    values,
    onChange,
    onFieldCount,
}: FormFieldLayerProps) => {
    const [placed, setPlaced] = useState<PlacedWidget[]>([]);

    useEffect(() => {
        let cancelled = false;
        if (!pdfDocument) {
            setPlaced([]);
            onFieldCount?.(0);
            return;
        }
        void (async () => {
            try {
                const widgets = (await loadFormWidgets(pdfDocument)).filter(widget => widget.pageIndex === pageIndex - 1 && widget.editable);
                const page = await pdfDocument.getPage(pageIndex);
                const viewport = page.getViewport({ scale: 1, rotation: displayRotation });
                // Field tooltips (/TU) make better labels than internal field names.
                const tooltips = new Map<string, string>();
                for (const annotation of await page.getAnnotations()) {
                    if (typeof annotation.id === 'string' && typeof annotation.alternativeText === 'string' && annotation.alternativeText.trim()) {
                        tooltips.set(annotation.id, annotation.alternativeText.trim());
                    }
                }
                if (cancelled) return;
                const scale = width / viewport.width;
                const next = widgets.map(widget => {
                    const [x1, y1] = viewport.convertToViewportPoint(widget.rect[0], widget.rect[1]);
                    const [x2, y2] = viewport.convertToViewportPoint(widget.rect[2], widget.rect[3]);
                    return {
                        widget,
                        label: tooltips.get(widget.id) ?? lastNamePart(widget.name),
                        left: Math.min(x1, x2) * scale,
                        top: Math.min(y1, y2) * scale,
                        width: Math.abs(x2 - x1) * scale,
                        height: Math.abs(y2 - y1) * scale,
                    };
                }).sort((first, second) => (first.top - second.top) || (first.left - second.left));
                setPlaced(next);
                onFieldCount?.(next.length);
            } catch (error) {
                console.error('Failed to read the form fields:', error);
                if (!cancelled) {
                    setPlaced([]);
                    onFieldCount?.(0);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pdfDocument, pageIndex, displayRotation, width, onFieldCount]);

    if (!isActive || placed.length === 0) return null;

    return (
        <div className="absolute inset-0 z-[20]" style={{ width, height }}>
            {placed.map(({ widget, label, left, top, width: boxWidth, height: boxHeight }) => {
                const value = getWidgetValue(widget, values);
                const style: CSSProperties = { left, top, width: boxWidth, height: boxHeight };
                const fontSize = Math.max(8, Math.min(16, boxHeight * 0.62));
                const fieldClass = 'form-field-input absolute rounded-sm border border-blue-300 bg-blue-50 text-gray-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-300';
                if (widget.type === 'checkbox' || widget.type === 'radiobutton') {
                    const checked = widget.type === 'checkbox' ? value === true : value === widget.exportValue;
                    const size = Math.max(10, Math.min(boxWidth, boxHeight) * 0.8);
                    return (
                        <label key={widget.id} className="absolute flex items-center justify-center rounded-sm border border-blue-300 bg-blue-50" style={style} title={label}>
                            <input
                                type={widget.type === 'checkbox' ? 'checkbox' : 'radio'}
                                name={widget.type === 'radiobutton' ? `form-${pageIndex}-${widget.name}` : undefined}
                                checked={checked}
                                aria-label={label}
                                onChange={event => {
                                    if (widget.type === 'checkbox') onChange(widget.name, event.target.checked);
                                    else if (event.target.checked) onChange(widget.name, widget.exportValue ?? '');
                                }}
                                onClick={event => {
                                    // A second click clears a radio group, as PDF viewers allow.
                                    if (widget.type === 'radiobutton' && checked) {
                                        event.preventDefault();
                                        onChange(widget.name, '');
                                    }
                                }}
                                className="cursor-pointer accent-blue-600"
                                style={{ width: size, height: size }}
                            />
                        </label>
                    );
                }
                if (widget.type === 'combobox' || widget.type === 'listbox') {
                    const options = widget.options ?? [];
                    const selected = Array.isArray(value) ? value : value ? [String(value)] : [];
                    const multiple = widget.type === 'listbox' && widget.multiSelect;
                    return (
                        <select
                            key={widget.id}
                            aria-label={label}
                            title={label}
                            multiple={multiple}
                            size={widget.type === 'listbox' ? Math.max(2, Math.min(options.length, Math.floor(boxHeight / (fontSize * 1.3)))) : undefined}
                            value={multiple ? selected : selected[0] ?? ''}
                            onChange={event => {
                                const chosen = [...event.target.selectedOptions].map(option => option.value);
                                onChange(widget.name, widget.type === 'listbox' ? chosen : chosen[0] ?? '');
                            }}
                            className={`${fieldClass} px-1`}
                            style={{ ...style, fontSize }}
                        >
                            {widget.type === 'combobox' && !options.some(option => option.exportValue === selected[0]) ? <option value="">{selected[0] ?? ''}</option> : null}
                            {options.map(option => <option key={option.exportValue} value={option.exportValue}>{option.displayValue}</option>)}
                        </select>
                    );
                }
                const common = {
                    'aria-label': label,
                    title: label,
                    value: typeof value === 'string' ? value : '',
                    maxLength: widget.maxLength,
                    className: `${fieldClass} px-1`,
                    style: { ...style, fontSize },
                };
                return widget.multiline ? (
                    <textarea key={widget.id} {...common} onChange={event => onChange(widget.name, event.target.value)} className={`${common.className} resize-none py-0.5 leading-tight`} />
                ) : (
                    <input key={widget.id} type={widget.password ? 'password' : 'text'} {...common} onChange={event => onChange(widget.name, event.target.value)} />
                );
            })}
        </div>
    );
};
