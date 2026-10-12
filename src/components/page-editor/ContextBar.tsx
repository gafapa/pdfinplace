import type { CSSProperties, ReactNode } from 'react';
import { Bold, Copy, EyeOff, FilePenLine, Info, Italic, PaintBucket, TextCursorInput, Trash2, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import { FILL_OPACITY_OPTIONS, FONT_SIZE_OPTIONS, STROKE_GRAPHIC_OPTIONS, TEXT_FONTS, type TextFont } from './editorTools';

export interface ColorPreset {
    hex: string;
    label: string;
}

export type ContextBarProps = {
    usesFallbackFont: boolean;
} & (
    | { mode: 'content'; editCount: number }
    | { mode: 'form'; fieldCount: number }
    | { mode: 'redaction' }
    | {
        mode: 'annotate';
        /** Names the selected annotation in the select tool. */
        selectionLabel: string | null;
        text: null | {
            fontSize: number;
            fontFamily: TextFont;
            bold: boolean;
            italic: boolean;
            onFontSizeChange: (size: number) => void;
            onFontFamilyChange: (family: TextFont) => void;
            onBoldChange: (bold: boolean) => void;
            onItalicChange: (italic: boolean) => void;
        };
        color: null | { value: string; presets: ColorPreset[]; onChange: (color: string) => void };
        stroke: null | { width: number; color: string; onChange: (width: number) => void };
        fill: null | {
            enabled: boolean;
            color: string;
            opacity: number;
            onToggle: () => void;
            onColorChange: (color: string) => void;
            onOpacityChange: (opacity: number) => void;
        };
        selection: null | { onDuplicate: () => void; onDelete: () => void };
        hasRedactions: boolean;
    }
);

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The active tool's settings, in one bar above the page (below it on phones).
 * Layer tools (content, form, redaction) show what the mode does instead.
 */
export const ContextBar = (props: ContextBarProps) => {
    const { t } = useI18n();
    const fallbackWarning = props.usesFallbackFont ? (
        <span className="bar-button bar-button--warning" role="img" aria-label={t('modal.contentFallbackFont')} title={t('modal.contentFallbackFont')}>
            <TriangleAlert aria-hidden="true" className="h-4 w-4" />
        </span>
    ) : null;

    if (props.mode === 'content' || props.mode === 'form') {
        const isContent = props.mode === 'content';
        const Icon = isContent ? FilePenLine : TextCursorInput;
        return (
            <div className="context-bar context-bar--hint" role="status" aria-live="polite">
                <span className="context-bar-hint">
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="context-bar-hint-text">
                        {isContent
                            ? props.usesFallbackFont ? t('modal.contentFallbackFont') : t('modal.editContent')
                            : t('modal.formHint')}
                    </span>
                    <span className="context-bar-chip">{isContent ? props.editCount : props.fieldCount}</span>
                </span>
            </div>
        );
    }

    if (props.mode === 'redaction') {
        return (
            <div className="context-bar context-bar--hint context-bar--warning" role="status" title={t('modal.redactionHint')}>
                <span className="context-bar-hint">
                    <EyeOff aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="context-bar-hint-text">{t('modal.redactionShortHint')}</span>
                </span>
            </div>
        );
    }

    const sections: { key: string; node: ReactNode }[] = [];
    if (props.selectionLabel) {
        sections.push({ key: 'selection-label', node: <span className="context-bar-label">{props.selectionLabel}</span> });
    }
    if (props.text) {
        const text = props.text;
        sections.push({
            key: 'text',
            node: (
                <>
                    <select
                        value={text.fontFamily}
                        onChange={event => text.onFontFamilyChange(event.target.value as TextFont)}
                        className="bar-select max-w-[9rem]"
                        aria-label={t('modal.fontFamily')}
                    >
                        {TEXT_FONTS.map(font => <option key={font} value={font}>{font}</option>)}
                    </select>
                    <select
                        value={text.fontSize}
                        onChange={event => text.onFontSizeChange(Number(event.target.value))}
                        className="bar-select"
                        aria-label={t('modal.fontSize')}
                    >
                        {FONT_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}px</option>)}
                    </select>
                    <button type="button" onClick={() => text.onBoldChange(!text.bold)} className="bar-button" title={t('modal.bold')} aria-label={t('modal.bold')} aria-pressed={text.bold}>
                        <Bold aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => text.onItalicChange(!text.italic)} className="bar-button" title={t('modal.italic')} aria-label={t('modal.italic')} aria-pressed={text.italic}>
                        <Italic aria-hidden="true" className="h-4 w-4" />
                    </button>
                </>
            ),
        });
    }
    if (props.color) {
        const color = props.color;
        const isPreset = color.presets.some(preset => sameColor(preset.hex, color.value));
        sections.push({
            key: 'color',
            node: (
                <div role="group" aria-label={t('modal.color')} className="swatches">
                    {color.presets.map(preset => (
                        <button
                            key={preset.hex}
                            type="button"
                            onClick={() => color.onChange(preset.hex)}
                            className="swatch"
                            style={{ '--swatch-color': preset.hex } as CSSProperties}
                            title={preset.label}
                            aria-label={preset.label}
                            aria-pressed={sameColor(preset.hex, color.value)}
                        />
                    ))}
                    <input
                        type="color"
                        value={color.value}
                        onChange={event => color.onChange(event.target.value)}
                        className="color-input"
                        data-active={!isPreset}
                        title={t('modal.customColor')}
                        aria-label={t('modal.customColor')}
                    />
                </div>
            ),
        });
    }
    if (props.stroke) {
        const stroke = props.stroke;
        sections.push({
            key: 'stroke',
            node: (
                <div role="group" aria-label={t('modal.strokeWidth')} className="stroke-options">
                    {STROKE_GRAPHIC_OPTIONS.map((width, index) => (
                        <button
                            key={width}
                            type="button"
                            onClick={() => stroke.onChange(width)}
                            className="stroke-option"
                            title={`${width}px`}
                            aria-label={`${width}px`}
                            aria-pressed={stroke.width === width}
                        >
                            <span className="block w-4 rounded-full" style={{ height: index + 1, backgroundColor: stroke.color }} />
                        </button>
                    ))}
                </div>
            ),
        });
    }
    if (props.fill) {
        const fill = props.fill;
        sections.push({
            key: 'fill',
            node: (
                <>
                    <button type="button" onClick={fill.onToggle} className="bar-button" title={t('modal.fillShape')} aria-label={t('modal.fillShape')} aria-pressed={fill.enabled}>
                        <PaintBucket aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <input
                        type="color"
                        value={fill.color}
                        onChange={event => fill.onColorChange(event.target.value)}
                        className="color-input color-input--square"
                        title={t('modal.fillColor')}
                        aria-label={t('modal.fillColor')}
                    />
                    {fill.enabled ? (
                        <select
                            value={fill.opacity}
                            onChange={event => fill.onOpacityChange(Number(event.target.value))}
                            className="bar-select"
                            title={t('modal.fillOpacity')}
                            aria-label={t('modal.fillOpacity')}
                        >
                            {FILL_OPACITY_OPTIONS.map(option => (
                                <option key={option} value={option}>{Math.round(option * 100)}%</option>
                            ))}
                        </select>
                    ) : null}
                </>
            ),
        });
    }
    if (props.selection) {
        const selection = props.selection;
        sections.push({
            key: 'selection-actions',
            node: (
                <>
                    <button type="button" onClick={selection.onDuplicate} className="bar-button" title={t('modal.duplicateSelection')} aria-label={t('modal.duplicateSelection')}>
                        <Copy aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={selection.onDelete} className="bar-button bar-button--danger" title={t('modal.deleteSelection')} aria-label={t('modal.deleteSelection')}>
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                </>
            ),
        });
    }
    const warnings = (
        <>
            {props.hasRedactions ? (
                <span className="bar-button bar-button--warning" role="img" aria-label={t('modal.redactionHint')} title={t('modal.redactionHint')}>
                    <EyeOff aria-hidden="true" className="h-4 w-4" />
                </span>
            ) : null}
            {fallbackWarning}
        </>
    );
    if (sections.length === 0 && !props.hasRedactions && !props.usesFallbackFont) return null;

    return (
        <div role="toolbar" aria-label={props.selectionLabel ?? t('modal.tools')} className="context-bar">
            {sections.length === 0 ? <Info aria-hidden="true" className="ml-1 h-4 w-4 text-gray-400" /> : null}
            {sections.map((section, index) => (
                <span key={section.key} className="contents">
                    {index > 0 ? <span className="context-bar-separator" aria-hidden="true" /> : null}
                    {section.node}
                </span>
            ))}
            {warnings}
        </div>
    );
};
