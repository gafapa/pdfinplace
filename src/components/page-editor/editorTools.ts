import type { Annotation } from '../../types/annotations';
import type { ContentEdit } from '../../features/content-editor/types';
import type { FormValues } from '../../features/forms/formTypes';

export type Tool = 'form' | 'content' | 'select' | 'text' | 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow' | 'highlight' | 'redaction' | 'image';
export type ShapeTool = Extract<Tool, 'rectangle' | 'circle' | 'line' | 'arrow' | 'highlight' | 'redaction'>;
export type InteractionMode = 'idle' | 'drawing' | 'moving' | 'resizing';
export type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br' | null;

export interface EditorSnapshot {
    annotations: Annotation[];
    contentEdits: ContentEdit[];
    formValues: FormValues;
}

export const isShapeTool = (tool: Tool): tool is ShapeTool =>
    tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow' || tool === 'highlight' || tool === 'redaction';

/** Tools that hand the page over to another layer, hiding the annotation tools' settings. */
export const isLayerTool = (tool: Tool) => tool === 'content' || tool === 'form';

export const TEXT_FONTS = ['Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New'] as const;
export type TextFont = (typeof TEXT_FONTS)[number];
export const isTextFont = (font: string): font is TextFont => TEXT_FONTS.includes(font as TextFont);
export const STROKE_GRAPHIC_OPTIONS = [1, 2, 4, 8, 16, 32] as const;
export const FILL_OPACITY_OPTIONS = [1, 0.6, 0.3] as const;
export const FONT_SIZE_OPTIONS = [12, 16, 20, 24, 32, 48, 64] as const;
