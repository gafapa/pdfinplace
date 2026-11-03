import { useState, useRef, useEffect, useCallback } from 'react';
import { PdfPreview } from './PdfPreview';
import {
    Type,
    Pencil,
    Square,
    Circle,
    Minus,
    ImageIcon,
    X,
    Images,
    MousePointer2,
    FilePenLine,
    Highlighter,
    MoveUpRight,
    EyeOff,
    TextCursorInput,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, TextAnnotationData, ShapeAnnotationData } from '../types/annotations';
import { useI18n } from '../i18n';
import { createId } from '../utils/createId';
import { getEditorCanvasSize, getLegacyEditorCanvasSize, scaleAnnotations, transformAnnotationBounds, type EditorCanvasSize } from '../utils/pageGeometry';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { ContentEditLayer } from '../features/content-editor/ContentEditLayer';
import { FormFieldLayer } from '../features/forms/FormFieldLayer';
import type { FormFieldValue, FormValues } from '../features/forms/formTypes';
import { isRedaction } from '../features/export/redaction';
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_OPACITY, REDACTION_COLOR } from '../utils/shapeGeometry';
import { contentEditErrorMessageKey } from '../features/content-editor/errorMessages';
import type { ContentEdit } from '../features/content-editor/types';
import { isLayerTool, isShapeTool, isTextFont, type EditorSnapshot, type InteractionMode, type ResizeHandle, type ShapeTool, type TextFont, type Tool } from './page-editor/editorTools';
import { useEditorHistory } from './page-editor/useEditorHistory';
import { useSavedAssets, type SavedAsset } from './page-editor/useSavedAssets';
import { AssetsPanel } from './page-editor/AssetsPanel';
import { ToolRail, type ToolItem } from './page-editor/ToolRail';
import { ContextBar, type ColorPreset, type ContextBarProps } from './page-editor/ContextBar';
import { ZoomControl } from './ZoomControl';
import { MIN_ZOOM, ZOOM_STEPS, nextZoomStep } from '../utils/zoomSteps';
import { DiscardDialog } from './page-editor/DiscardDialog';
import { drawEditorCanvas, measureTextLayout } from './page-editor/drawEditorCanvas';
import { readUploadedImage } from './page-editor/readUploadedImage';
import { EditorHeader } from './page-editor/EditorHeader';

const EMPTY_FORM_VALUES: FormValues = {};

interface PageEditorModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** `formValues` is passed only when the file's form values changed. */
    onSave: (
        annotations: Annotation[],
        contentEdits: ContentEdit[],
        canvasSize: EditorCanvasSize,
        formValues?: FormValues,
    ) => void;
    pdfDocument?: PDFDocumentProxy;
    pageIndex: number;
    pageRotation: number;
    initialAnnotations: Annotation[];
    initialContentEdits: ContentEdit[];
    initialCanvasWidth?: number;
    initialCanvasHeight?: number;
    initialFormValues?: FormValues;
    onRequestNavigate?: (delta: 1 | -1) => void;
    hasPreviousPage?: boolean;
    hasNextPage?: boolean;
    /** Position of the page in the document, for the header. */
    pagePosition?: number;
    pageCount?: number;
}

export const PageEditorModal = ({
    isOpen,
    onClose,
    onSave,
    pdfDocument,
    pageIndex,
    pageRotation,
    initialAnnotations,
    initialContentEdits,
    initialCanvasWidth,
    initialCanvasHeight,
    initialFormValues,
    onRequestNavigate,
    hasPreviousPage = false,
    hasNextPage = false,
    pagePosition,
    pageCount,
}: PageEditorModalProps) => {
    const { t } = useI18n();
    const [activeTool, setActiveTool] = useState<Tool>('select');
    const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations);
    const [contentEdits, setContentEdits] = useState<ContentEdit[]>(initialContentEdits);
    const initialFormValuesRef = useRef<FormValues>(initialFormValues ?? EMPTY_FORM_VALUES);
    const [formValues, setFormValues] = useState<FormValues>(initialFormValuesRef.current);
    // The preview keeps the values from before form mode while inputs cover the
    // fields, so typing does not re-render the page on every keystroke.
    const [previewFormValues, setPreviewFormValues] = useState<FormValues>(initialFormValuesRef.current);
    const [formFieldCount, setFormFieldCount] = useState(0);
    const [validatedContentEdits, setValidatedContentEdits] = useState<ContentEdit[] | null>(null);
    const [fallbackContentEdits, setFallbackContentEdits] = useState<ContentEdit[] | null>(null);
    const canSaveContent = contentEdits.length === 0 || validatedContentEdits === contentEdits;
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
    const [interactionMode, setInteractionMode] = useState<InteractionMode>('idle');
    const [resizeHandle, setResizeHandle] = useState<ResizeHandle>(null);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [initialAnnotationState, setInitialAnnotationState] = useState<Annotation | null>(null);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);

    const [currentDrawing, setCurrentDrawing] = useState<{ x: number; y: number }[]>([]);
    const [color, setColor] = useState('#000000');
    const [fillEnabled, setFillEnabled] = useState(false);
    const [fillColor, setFillColor] = useState('#000000');
    const [fillOpacity, setFillOpacity] = useState<number>(1);
    const [highlightColor, setHighlightColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
    const [strokeWidth, setStrokeWidth] = useState(2);
    const [fontSize, setFontSize] = useState(24);
    const [textFontFamily, setTextFontFamily] = useState<TextFont>('Arial');
    const [textBold, setTextBold] = useState(false);
    const [textItalic, setTextItalic] = useState(false);
    const [imageRenderTick, setImageRenderTick] = useState(0);
    const [nativeRotation, setNativeRotation] = useState(0);
    const [pageViewportSize, setPageViewportSize] = useState<EditorCanvasSize>(
        () => getLegacyEditorCanvasSize(pageRotation)
    );
    const [isGeometryReady, setIsGeometryReady] = useState(!pdfDocument);
    const [fitScale, setFitScale] = useState(1);
    const [editorZoom, setEditorZoom] = useState(1);
    const [uploadTarget, setUploadTarget] = useState<'canvas' | 'library'>('canvas');
    const [errorMessage, setErrorMessage] = useState('');
    // Kept separate from `errorMessage` (and from each other) so an unrelated
    // error, a content-parse failure, and a content-preview-invalid state
    // never clobber or hide one another.
    const [contentParseError, setContentParseError] = useState('');
    const [contentPreviewInvalid, setContentPreviewInvalid] = useState(false);
    const [contentPreviewErrorCode, setContentPreviewErrorCode] = useState('');
    const handleContentPreview = useCallback((edits: ContentEdit[], valid: boolean, usedFallbackFont = false, errorCode = '') => {
        setValidatedContentEdits(valid ? edits : null);
        setFallbackContentEdits(valid && usedFallbackFont ? edits : null);
        setContentPreviewInvalid(!valid);
        setContentPreviewErrorCode(valid ? '' : errorCode);
    }, []);
    const handleContentParseError = useCallback((message: string) => {
        setContentParseError(message);
    }, []);
    const displayedErrorMessage = errorMessage
        || contentParseError
        || (contentPreviewInvalid ? t(contentEditErrorMessageKey(contentPreviewErrorCode)) : '');
    const dismissDisplayedError = useCallback(() => {
        setErrorMessage('');
        setContentParseError('');
        setContentPreviewInvalid(false);
        setContentPreviewErrorCode('');
    }, []);
    const [isDiscardDialogOpen, setIsDiscardDialogOpen] = useState(false);

    const assets = useSavedAssets(
        { persistenceFailed: t('modal.assetPersistenceFailed'), libraryTooLarge: t('modal.assetLibraryTooLarge') },
        setErrorMessage,
    );

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const savedSnapshotRef = useRef<string | null>(null);
    const editorViewportRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const editingTextIdRef = useRef<string | null>(null);
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const canvasBoundsRef = useRef<DOMRect | null>(null);
    const pointerMoveFrameRef = useRef<number | null>(null);
    const pendingPointerCoordsRef = useRef<{ x: number; y: number } | null>(null);
    const drawingStartRef = useRef<{ x: number; y: number } | null>(null);
    const annotationsInitializedRef = useRef(false);
    const initialSnapshotRef = useRef<Annotation[] | null>(null);
    // Annotations when a move/resize gesture started, restored if it ends without moving.
    const gestureAnnotationsRef = useRef<Annotation[] | null>(null);
    const closeRequestRef = useRef<() => void>(() => {});

    const totalRotation = (nativeRotation + pageRotation) % 360;
    const { width: canvasWidth, height: canvasHeight } = getEditorCanvasSize(
        pageViewportSize.width,
        pageViewportSize.height,
    );
    const editorScale = fitScale * editorZoom;
    const handleDialogClose = useCallback(() => closeRequestRef.current(), []);
    const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, handleDialogClose);

    // Sync ref with state for event handlers
    useEffect(() => {
        editingTextIdRef.current = editingTextId;
    }, [editingTextId]);

    useEffect(() => {
        if (activeTool !== 'form') setPreviewFormValues(formValues);
    }, [activeTool, formValues]);

    const getTextLayout = useCallback((data: TextAnnotationData) => (
        measureTextLayout(data, canvasRef.current?.getContext('2d'))
    ), []);

    const updateTextAnnotation = useCallback((annotationId: string, updater: (data: TextAnnotationData) => TextAnnotationData) => {
        setAnnotations(prev => prev.map(ann => {
            if (ann.id !== annotationId || ann.type !== 'text') {
                return ann;
            }

            const nextData = updater(ann.data as TextAnnotationData);
            const layout = getTextLayout(nextData);
            return {
                ...ann,
                data: nextData,
                width: layout.width,
                height: layout.height
            };
        }));
    }, [getTextLayout]);

    useEffect(() => {
        let isCancelled = false;

        const loadNativeRotation = async () => {
            if (!isOpen || !pdfDocument) {
                setNativeRotation(0);
                setPageViewportSize(getLegacyEditorCanvasSize(pageRotation));
                setIsGeometryReady(true);
                return;
            }

            try {
                const page = await pdfDocument.getPage(pageIndex);
                if (!isCancelled) {
                    const nativePageRotation = page.rotate ?? 0;
                    const viewport = page.getViewport({
                        scale: 1,
                        rotation: (nativePageRotation + pageRotation) % 360,
                    });
                    setNativeRotation(nativePageRotation);
                    setPageViewportSize({ width: viewport.width, height: viewport.height });
                    setIsGeometryReady(true);
                }
            } catch {
                if (!isCancelled) {
                    setNativeRotation(0);
                    setPageViewportSize(getLegacyEditorCanvasSize(pageRotation));
                    setIsGeometryReady(true);
                }
            }
        };

        loadNativeRotation();

        return () => {
            isCancelled = true;
        };
    }, [isOpen, pdfDocument, pageIndex, pageRotation]);

    useEffect(() => {
        if (!isOpen || !isGeometryReady || annotationsInitializedRef.current) return;

        const sourceSize = initialCanvasWidth && initialCanvasHeight
            ? { width: initialCanvasWidth, height: initialCanvasHeight }
            : getLegacyEditorCanvasSize(totalRotation);
        const targetSize = { width: canvasWidth, height: canvasHeight };
        const scaledAnnotations = scaleAnnotations(initialAnnotations, sourceSize, targetSize);
        initialSnapshotRef.current = scaledAnnotations;
        setAnnotations(scaledAnnotations);
        savedSnapshotRef.current = JSON.stringify({
            annotations: scaledAnnotations,
            contentEdits: initialContentEdits,
            formValues: initialFormValuesRef.current,
        });
        annotationsInitializedRef.current = true;
    }, [
        isOpen,
        isGeometryReady,
        initialAnnotations,
        initialCanvasWidth,
        initialCanvasHeight,
        initialContentEdits,
        totalRotation,
        canvasWidth,
        canvasHeight,
    ]);

    // Editor-local undo history. A snapshot is recorded once an interaction
    // (drag, resize, text editing) has finished, so one gesture is one step.
    const restoreSnapshot = useCallback((entry: EditorSnapshot) => {
        setAnnotations(entry.annotations);
        setContentEdits(entry.contentEdits);
        setFormValues(entry.formValues);
        setSelectedAnnotationId(null);
    }, []);
    const canRestoreHistory = useCallback(() => !editingTextIdRef.current, []);
    const history = useEditorHistory({ annotations, contentEdits, formValues }, {
        canRecord: annotationsInitializedRef.current && interactionMode === 'idle' && !editingTextId,
        // Seed with the scaled initial annotations, not the unscaled props.
        canSeed: annotations === initialSnapshotRef.current,
        canRestore: canRestoreHistory,
        onRestore: restoreSnapshot,
    });
    const restoreHistoryEntry = history.restore;
    const canUndoEdit = history.canUndo && !editingTextId;
    const canRedoEdit = history.canRedo && !editingTextId;

    useEffect(() => {
        if (!isOpen) return;

        let resizeFrame: number | null = null;
        const recalculateScale = () => {
            const viewport = editorViewportRef.current;
            if (!viewport) return;

            const viewportStyles = window.getComputedStyle(viewport);
            const horizontalPadding = Number.parseFloat(viewportStyles.paddingLeft) + Number.parseFloat(viewportStyles.paddingRight);
            const verticalPadding = Number.parseFloat(viewportStyles.paddingTop) + Number.parseFloat(viewportStyles.paddingBottom);
            const scrollbarReserve = 20;
            const availableWidth = viewport.offsetWidth - horizontalPadding - scrollbarReserve;
            const availableHeight = viewport.offsetHeight - verticalPadding - scrollbarReserve;
            const widthScale = availableWidth / canvasWidth;
            const heightScale = availableHeight / canvasHeight;
            const nextScale = Math.min(1, widthScale, heightScale);
            const normalizedScale = Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1;
            setFitScale(previousScale => (
                Math.abs(previousScale - normalizedScale) < 0.001 ? previousScale : normalizedScale
            ));
        };

        const scheduleScaleRecalculation = () => {
            if (resizeFrame !== null) {
                cancelAnimationFrame(resizeFrame);
            }
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                recalculateScale();
            });
        };

        scheduleScaleRecalculation();

        const observer = new ResizeObserver(scheduleScaleRecalculation);
        if (editorViewportRef.current) observer.observe(editorViewportRef.current);
        window.addEventListener('resize', scheduleScaleRecalculation);

        return () => {
            if (resizeFrame !== null) {
                cancelAnimationFrame(resizeFrame);
            }
            observer.disconnect();
            window.removeEventListener('resize', scheduleScaleRecalculation);
        };
    }, [isOpen, canvasWidth, canvasHeight]);

    const activeTextId = editingTextId ?? selectedAnnotationId;
    const activeTextAnnotation = activeTextId
        ? annotations.find(ann => ann.id === activeTextId && ann.type === 'text')
        : null;
    const activeTextData = activeTextAnnotation?.type === 'text'
        ? activeTextAnnotation.data as TextAnnotationData
        : null;
    const hasActiveTextAnnotation = Boolean(activeTextAnnotation);
    const toolbarColor = activeTextData?.color ?? color;
    const toolbarFontSize = activeTextData?.fontSize ?? fontSize;
    const toolbarFontFamily = activeTextData && isTextFont(activeTextData.fontFamily) ? activeTextData.fontFamily : textFontFamily;
    const toolbarBold = activeTextData?.bold ?? textBold;
    const toolbarItalic = activeTextData?.italic ?? textItalic;
    const selectedAnnotation = annotations.find(ann => ann.id === selectedAnnotationId);
    const selectedShapeData = selectedAnnotation?.type === 'shape' ? selectedAnnotation.data as ShapeAnnotationData : undefined;
    const selectedFillableShape = selectedShapeData?.shapeType === 'rectangle' || selectedShapeData?.shapeType === 'circle';
    // A drawn shape stays selected while its tool is still active; the fill
    // controls then configure the next shape, and edit the selection only in
    // the select tool.
    const editsSelectedShapeFill = activeTool === 'select' && selectedFillableShape;
    const toolbarFillEnabled = editsSelectedShapeFill ? Boolean(selectedShapeData.fillColor) : fillEnabled;
    const toolbarFillColor = editsSelectedShapeFill && selectedShapeData.fillColor ? selectedShapeData.fillColor : fillColor;
    const toolbarFillOpacity = editsSelectedShapeFill ? selectedShapeData.fillOpacity ?? 1 : fillOpacity;
    const isHighlightContext = activeTool === 'highlight';
    const pickerColor = isHighlightContext ? highlightColor : toolbarColor;
    // Redactions are always black: there is no colour to pick.
    const showColorPicker = activeTool !== 'redaction' && selectedShapeData?.shapeType !== 'redaction';
    const hasRedactions = annotations.some(isRedaction);

    const updateSelectedShapeFill = (changes: Partial<Pick<ShapeAnnotationData, 'fillColor' | 'fillOpacity'>>) => {
        if (!editsSelectedShapeFill) return;
        setAnnotations(previous => previous.map(annotation => annotation.id === selectedAnnotationId
            ? { ...annotation, data: { ...annotation.data, ...changes } as ShapeAnnotationData }
            : annotation));
    };

    /** Builds a shape from a drag, using the current tool settings. */
    const buildShapeAnnotation = useCallback((tool: ShapeTool, start: { x: number; y: number }, end: { x: number; y: number }): Annotation => {
        const isLinear = tool === 'line' || tool === 'arrow';
        const isHighlight = tool === 'highlight';
        const isRedactionBox = tool === 'redaction';
        const filled = !isLinear && (isHighlight || fillEnabled);
        const width = Math.max(1, Math.abs(end.x - start.x));
        const height = Math.max(1, Math.abs(end.y - start.y));
        const left = Math.min(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const data: ShapeAnnotationData = isRedactionBox
            ? { shapeType: 'redaction', strokeColor: REDACTION_COLOR, fillColor: REDACTION_COLOR, fillOpacity: 1, strokeWidth: 0 }
            : {
                shapeType: tool,
                strokeColor: color,
                fillColor: isHighlight ? highlightColor : filled ? fillColor : '',
                fillOpacity: isHighlight ? HIGHLIGHT_OPACITY : filled ? fillOpacity : undefined,
                strokeWidth: isHighlight ? 0 : strokeWidth,
                x1: (start.x - left) / width,
                y1: (start.y - top) / height,
                x2: (end.x - left) / width,
                y2: (end.y - top) / height,
            };
        return { id: createId(), type: 'shape', x: left, y: top, width, height, rotation: 0, data };
    }, [color, fillColor, fillEnabled, fillOpacity, highlightColor, strokeWidth]);

    const applyTextStyleToActive = useCallback((updater: (data: TextAnnotationData) => TextAnnotationData) => {
        if (!activeTextId) {
            return;
        }
        updateTextAnnotation(activeTextId, updater);
    }, [activeTextId, updateTextAnnotation]);

    const beginTextAnnotationEdit = useCallback((annotation: Annotation) => {
        if (annotation.type !== 'text') return;

        const data = annotation.data as TextAnnotationData;
        setFontSize(data.fontSize);
        if (isTextFont(data.fontFamily)) {
            setTextFontFamily(data.fontFamily);
        }
        setColor(data.color);
        setTextBold(data.bold);
        setTextItalic(data.italic);
        setSelectedAnnotationId(annotation.id);
        setEditingTextId(annotation.id);
        editingTextIdRef.current = annotation.id;
    }, []);

    const getFinalizedAnnotations = useCallback((source: Annotation[]): Annotation[] => {
        const id = editingTextIdRef.current;
        if (!id) {
            return source;
        }

        const ann = source.find(a => a.id === id);
        if (ann && (ann.data as TextAnnotationData).text.trim() === '') {
            return source.filter(a => a.id !== id);
        }

        return source;
    }, []);

    const handleTextEditComplete = useCallback(() => {
        const id = editingTextIdRef.current;
        if (id) {
            setAnnotations(prev => getFinalizedAnnotations(prev));
            setEditingTextId(null);
            editingTextIdRef.current = null;
        }
    }, [getFinalizedAnnotations]);

    const hasUnsavedChanges = useCallback(() => {
        if (savedSnapshotRef.current === null) return false;
        const snapshot = JSON.stringify({
            annotations: getFinalizedAnnotations(annotations),
            contentEdits,
            formValues,
        });
        return snapshot !== savedSnapshotRef.current;
    }, [annotations, contentEdits, formValues, getFinalizedAnnotations]);

    const handleCloseRequest = useCallback(() => {
        if (!hasUnsavedChanges()) {
            onClose();
            return;
        }
        setIsDiscardDialogOpen(true);
    }, [hasUnsavedChanges, onClose]);

    useEffect(() => {
        closeRequestRef.current = handleCloseRequest;
    }, [handleCloseRequest]);

    const commitChanges = useCallback(() => {
        if (!canSaveContent) return false;
        if (editingTextIdRef.current) {
            handleTextEditComplete();
        }
        const finalizedAnnotations = getFinalizedAnnotations(annotations);
        const changedFormValues = formValues !== initialFormValuesRef.current ? formValues : undefined;
        onSave(finalizedAnnotations, contentEdits, { width: canvasWidth, height: canvasHeight }, changedFormValues);
        return true;
    }, [annotations, contentEdits, formValues, canSaveContent, canvasWidth, canvasHeight, getFinalizedAnnotations, handleTextEditComplete, onSave]);

    const handleNavigateRequest = useCallback((delta: 1 | -1) => {
        if (commitChanges()) onRequestNavigate?.(delta);
    }, [commitChanges, onRequestNavigate]);

    const handleFormValueChange = useCallback((name: string, value: FormFieldValue) => {
        setFormValues(previous => ({ ...previous, [name]: value }));
    }, []);

    const createImageLikeAnnotation = useCallback((
        dataUrl: string,
        imageWidth: number,
        imageHeight: number,
    ): Annotation => {
        const maxWidth = canvasWidth * 0.8;
        const maxHeight = canvasHeight * 0.8;
        const fitScale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
        const fittedWidth = Math.max(40, imageWidth * fitScale);
        const fittedHeight = Math.max(40, imageHeight * fitScale);

        return {
            id: createId(),
            type: 'image',
            x: Math.max(0, (canvasWidth - fittedWidth) / 2),
            y: Math.max(0, (canvasHeight - fittedHeight) / 2),
            width: fittedWidth,
            height: fittedHeight,
            rotation: 0,
            data: { dataUrl, originalWidth: imageWidth, originalHeight: imageHeight }
        };
    }, [canvasWidth, canvasHeight]);

    const insertSavedAsset = useCallback((asset: SavedAsset) => {
        const newAnnotation = createImageLikeAnnotation(
            asset.dataUrl,
            asset.width,
            asset.height,
        );
        setAnnotations(prev => [...prev, newAnnotation]);
        setSelectedAnnotationId(newAnnotation.id);
        setActiveTool('select');
    }, [createImageLikeAnnotation]);

    const deleteSelection = useCallback(() => {
        setAnnotations(previous => previous.filter(annotation => annotation.id !== selectedAnnotationId));
        setSelectedAnnotationId(null);
    }, [selectedAnnotationId]);

    const duplicateSelection = useCallback(() => {
        const source = annotations.find(annotation => annotation.id === selectedAnnotationId);
        if (!source) return;
        const offset = 16;
        const copy = {
            ...transformAnnotationBounds(source, {
                x: Math.min(source.x + offset, Math.max(0, canvasWidth - source.width)),
                y: Math.min(source.y + offset, Math.max(0, canvasHeight - source.height)),
                width: source.width,
                height: source.height,
            }),
            id: createId(),
        };
        setAnnotations(previous => [...previous, copy]);
        setSelectedAnnotationId(copy.id);
    }, [annotations, selectedAnnotationId, canvasWidth, canvasHeight]);

    const nudgeSelection = useCallback((dx: number, dy: number) => {
        setAnnotations(previous => previous.map(annotation => annotation.id === selectedAnnotationId
            ? transformAnnotationBounds(annotation, { x: annotation.x + dx, y: annotation.y + dy, width: annotation.width, height: annotation.height })
            : annotation));
    }, [selectedAnnotationId]);

    // Keyboard listener for Delete and Escape (capture phase so it can decide
    // before the dialog-focus handler closes the modal)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isFormField = Boolean(
                target && (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'SELECT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable
                ),
            );

            if (e.key === 'Escape') {
                if (editingTextIdRef.current) {
                    e.preventDefault();
                    e.stopPropagation();
                    handleTextEditComplete();
                } else if (!isFormField) {
                    handleCloseRequest();
                }
                return;
            }

            if (isFormField || editingTextIdRef.current) return;

            const hasModifier = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            if (hasModifier && !e.altKey && (key === 'z' || key === 'y')) {
                e.preventDefault();
                e.stopPropagation();
                restoreHistoryEntry(key === 'y' || e.shiftKey ? 1 : -1);
                return;
            }
            if (hasModifier && !e.altKey && key === 'd' && selectedAnnotationId) {
                e.preventDefault();
                duplicateSelection();
                return;
            }

            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotationId) {
                e.preventDefault();
                deleteSelection();
                return;
            }

            const step = e.shiftKey ? 10 : 1;
            const nudges: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };
            if (nudges[e.key] && selectedAnnotationId && !isLayerTool(activeTool)) {
                e.preventDefault();
                nudgeSelection(...nudges[e.key]);
            }
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [selectedAnnotationId, activeTool, handleCloseRequest, handleTextEditComplete, restoreHistoryEntry, duplicateSelection, deleteSelection, nudgeSelection]);

    // Focus textarea when editing starts
    useEffect(() => {
        if (editingTextId) {
            const timer = setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.focus();
                    const val = textareaRef.current.value;
                    textareaRef.current.setSelectionRange(val.length, val.length);
                }
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [editingTextId]);

    useEffect(() => {
        return () => {
            if (pointerMoveFrameRef.current !== null) {
                cancelAnimationFrame(pointerMoveFrameRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const referencedDataUrls = new Set(
            annotations
                .filter((ann) => ann.type === 'image' || ann.type === 'signature')
                .map((ann) => (ann.data as { dataUrl: string }).dataUrl)
        );

        imageCacheRef.current.forEach((_, dataUrl) => {
            if (!referencedDataUrls.has(dataUrl) && !assets.savedAssets.some((asset) => asset.dataUrl === dataUrl)) {
                imageCacheRef.current.delete(dataUrl);
            }
        });
    }, [annotations, assets.savedAssets]);

    const getCachedImage = useCallback((dataUrl: string) => {
        const cachedImage = imageCacheRef.current.get(dataUrl);
        if (cachedImage) {
            return cachedImage;
        }

        const image = new Image();
        image.onload = () => setImageRenderTick(prev => prev + 1);
        image.src = dataUrl;
        imageCacheRef.current.set(dataUrl, image);
        return image;
    }, []);

    const drawAnnotations = useCallback(() => {
        const context = canvasRef.current?.getContext('2d');
        if (!context) return;
        const isDrafting = interactionMode === 'drawing' && currentDrawing.length > 0;
        drawEditorCanvas(context, {
            annotations,
            selectedAnnotationId,
            editingTextId,
            getImage: getCachedImage,
            draft: !isDrafting ? undefined
                : activeTool === 'draw' ? { kind: 'path', points: currentDrawing, color, strokeWidth }
                    : isShapeTool(activeTool) ? { kind: 'shape', annotation: buildShapeAnnotation(activeTool, currentDrawing[0], currentDrawing[currentDrawing.length - 1]) }
                        : undefined,
        });
    }, [annotations, selectedAnnotationId, interactionMode, currentDrawing, activeTool, color, strokeWidth, editingTextId, getCachedImage, buildShapeAnnotation]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: Image loading must redraw the canvas even when the callback is stable.
    useEffect(() => {
        drawAnnotations();
    }, [drawAnnotations, imageRenderTick]);

    const getCanvasCoords = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvasBoundsRef.current ?? canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (canvasWidth / rect.width),
            y: (e.clientY - rect.top) * (canvasHeight / rect.height)
        };
    };

    const updatePointerInteraction = useCallback((coords: { x: number; y: number }) => {
        if (interactionMode === 'moving' && selectedAnnotationId && initialAnnotationState) {
            const dx = coords.x - dragStart.x;
            const dy = coords.y - dragStart.y;
            setAnnotations(prev => prev.map(ann =>
                ann.id === selectedAnnotationId
                    ? transformAnnotationBounds(ann, {
                        x: initialAnnotationState.x + dx,
                        y: initialAnnotationState.y + dy,
                        width: initialAnnotationState.width,
                        height: initialAnnotationState.height,
                    })
                    : ann
            ));
        } else if (interactionMode === 'resizing' && selectedAnnotationId && initialAnnotationState && resizeHandle) {
            const dx = coords.x - dragStart.x;
            const dy = coords.y - dragStart.y;

            setAnnotations(prev => prev.map(ann => {
                if (ann.id !== selectedAnnotationId) return ann;

                let { x, y, width, height } = initialAnnotationState;
                if (resizeHandle === 'br') {
                    width += dx;
                    height += dy;
                } else if (resizeHandle === 'tl') {
                    x += dx;
                    y += dy;
                    width -= dx;
                    height -= dy;
                } else if (resizeHandle === 'tr') {
                    y += dy;
                    width += dx;
                    height -= dy;
                } else if (resizeHandle === 'bl') {
                    x += dx;
                    width -= dx;
                    height += dy;
                }

                const targetWidth = Math.max(10, width);
                const targetHeight = Math.max(10, height);
                if (width < 10 && (resizeHandle === 'tl' || resizeHandle === 'bl')) {
                    x = initialAnnotationState.x + initialAnnotationState.width - targetWidth;
                }
                if (height < 10 && (resizeHandle === 'tl' || resizeHandle === 'tr')) {
                    y = initialAnnotationState.y + initialAnnotationState.height - targetHeight;
                }

                return transformAnnotationBounds(initialAnnotationState, {
                    x,
                    y,
                    width: targetWidth,
                    height: targetHeight,
                });
            }));
        } else if (interactionMode === 'drawing') {
            setCurrentDrawing(prev => [...prev, coords]);
        }
    }, [dragStart.x, dragStart.y, initialAnnotationState, interactionMode, resizeHandle, selectedAnnotationId]);

    const schedulePointerInteractionUpdate = useCallback((coords: { x: number; y: number }) => {
        pendingPointerCoordsRef.current = coords;

        if (pointerMoveFrameRef.current !== null) {
            return;
        }

        pointerMoveFrameRef.current = requestAnimationFrame(() => {
            pointerMoveFrameRef.current = null;
            const latestCoords = pendingPointerCoordsRef.current;
            pendingPointerCoordsRef.current = null;
            if (latestCoords) {
                updatePointerInteraction(latestCoords);
            }
        });
    }, [updatePointerInteraction]);

    const isPointInHandle = (px: number, py: number, ann: Annotation): ResizeHandle => {
        const handleSize = 10;
        if (Math.abs(px - ann.x) < handleSize && Math.abs(py - ann.y) < handleSize) return 'tl';
        if (Math.abs(px - (ann.x + ann.width)) < handleSize && Math.abs(py - ann.y) < handleSize) return 'tr';
        if (Math.abs(px - ann.x) < handleSize && Math.abs(py - (ann.y + ann.height)) < handleSize) return 'bl';
        if (Math.abs(px - (ann.x + ann.width)) < handleSize && Math.abs(py - (ann.y + ann.height)) < handleSize) return 'br';
        return null;
    };

    const isPointInAnnotation = (px: number, py: number, ann: Annotation): boolean => {
        return px >= ann.x && px <= ann.x + (ann.width || 0) && py >= ann.y && py <= ann.y + (ann.height || 0);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const startPointerInteraction = () => {
            e.preventDefault();
            canvasBoundsRef.current = e.currentTarget.getBoundingClientRect();
            e.currentTarget.setPointerCapture(e.pointerId);
        };
        // If clicking outside while editing, complete it but DON'T RETURN yet
        // so we can start the next action (like creating another text box)
        if (editingTextIdRef.current) {
            handleTextEditComplete();
        }

        const coords = getCanvasCoords(e);
        setDragStart(coords);

        if (activeTool === 'select') {
            if (selectedAnnotationId) {
                const ann = annotations.find(a => a.id === selectedAnnotationId);
                if (ann) {
                    const handle = isPointInHandle(coords.x, coords.y, ann);
                    if (handle) {
                        startPointerInteraction();
                        setInteractionMode('resizing');
                        gestureAnnotationsRef.current = annotations;
                        setResizeHandle(handle);
                        setInitialAnnotationState({ ...ann });
                        return;
                    }
                }
            }

            const hit = [...annotations].reverse().find(ann => isPointInAnnotation(coords.x, coords.y, ann));
            if (hit) {
                startPointerInteraction();
                setSelectedAnnotationId(hit.id);
                setInteractionMode('moving');
                gestureAnnotationsRef.current = annotations;
                setInitialAnnotationState({ ...hit });
            } else {
                setSelectedAnnotationId(null);
            }
        } else if (activeTool === 'text') {
            startPointerInteraction();
            const id = createId();
            const textData: TextAnnotationData = {
                text: '',
                fontSize,
                fontFamily: textFontFamily,
                color,
                bold: textBold,
                italic: textItalic
            };
            const layout = getTextLayout(textData);
            const newAnnotation: Annotation = {
                id,
                type: 'text',
                x: coords.x,
                y: coords.y,
                width: layout.width,
                height: layout.height,
                rotation: 0,
                data: textData
            };
            setAnnotations(prev => [...prev, newAnnotation]);
            setSelectedAnnotationId(id);
            setEditingTextId(id);
            editingTextIdRef.current = id;
        } else if (activeTool === 'draw' || isShapeTool(activeTool)) {
            startPointerInteraction();
            drawingStartRef.current = coords;
            setInteractionMode('drawing');
            setCurrentDrawing([coords]);
        }
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (interactionMode === 'idle') return;
        e.preventDefault();
        if (editingTextIdRef.current) return;
        const coords = getCanvasCoords(e);
        schedulePointerInteractionUpdate(coords);
    };

    const handlePointerUp = (e?: React.PointerEvent<HTMLCanvasElement>) => {
        if (e) {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.preventDefault();
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
        }

        const pendingCoords = pendingPointerCoordsRef.current;
        if (pointerMoveFrameRef.current !== null) {
            cancelAnimationFrame(pointerMoveFrameRef.current);
            pointerMoveFrameRef.current = null;
        }
        pendingPointerCoordsRef.current = null;

        const gestureStart = gestureAnnotationsRef.current;
        gestureAnnotationsRef.current = null;
        const endCoords = e?.type === 'pointerup' ? getCanvasCoords(e) : pendingCoords;
        const isClickWithoutMove = gestureStart !== null && endCoords !== null
            && Math.abs(endCoords.x - dragStart.x) < 0.5 && Math.abs(endCoords.y - dragStart.y) < 0.5;
        if (isClickWithoutMove) {
            // Selecting by clicking must not leave an empty undo step behind.
            setAnnotations(gestureStart);
        } else if (endCoords && interactionMode !== 'drawing') {
            updatePointerInteraction(endCoords);
        }

        // A release can arrive before the last animation-frame update commits.
        // Keep the synchronous gesture start and always use the release position.
        const drawingStart = drawingStartRef.current;
        drawingStartRef.current = null;
        const drawingPoints = drawingStart && currentDrawing[0] !== drawingStart ? [drawingStart] : currentDrawing;
        const finalizedDrawing = drawingStart && endCoords ? [...drawingPoints, endCoords] : drawingPoints;

        if (drawingStart && finalizedDrawing.length > 0) {
            const start = finalizedDrawing[0];
            const end = finalizedDrawing[finalizedDrawing.length - 1];

            let newAnn: Annotation | null = null;
            if (activeTool === 'draw' && finalizedDrawing.length > 1) {
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const point of finalizedDrawing) {
                    if (point.x < minX) minX = point.x;
                    if (point.y < minY) minY = point.y;
                    if (point.x > maxX) maxX = point.x;
                    if (point.y > maxY) maxY = point.y;
                }
                newAnn = {
                    id: createId(),
                    type: 'drawing',
                    x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0,
                    data: { points: finalizedDrawing, strokeColor: color, strokeWidth }
                };
            } else if (isShapeTool(activeTool) && finalizedDrawing.length >= 2) {
                newAnn = buildShapeAnnotation(activeTool, start, end);
            }

            if (newAnn) {
                const created = newAnn;
                setAnnotations(prev => [...prev, created]);
                setSelectedAnnotationId(created.id);
            }
            setCurrentDrawing([]);
        }

        setInteractionMode('idle');
        setResizeHandle(null);
        setInitialAnnotationState(null);
        canvasBoundsRef.current = null;
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setErrorMessage('');
        const target = uploadTarget;
        setUploadTarget('canvas');
        e.target.value = '';
        const uploaded = await readUploadedImage(file);
        if (!uploaded.ok) {
            setErrorMessage(t(uploaded.errorKey));
            return;
        }
        const { dataUrl, image } = uploaded;
        imageCacheRef.current.set(dataUrl, image);
        if (target === 'canvas') {
            const newAnnotation = createImageLikeAnnotation(dataUrl, image.width, image.height);
            setAnnotations(prev => [...prev, newAnnotation]);
            setSelectedAnnotationId(newAnnotation.id);
            setActiveTool('select');
            return;
        }
        const uploadedName = file.name.replace(/.[^.]+$/, '').trim();
        const wasSaved = assets.addSavedAsset({
            id: createId(),
            name: uploadedName || `${t('modal.image')} ${assets.savedAssets.length + 1}`,
            dataUrl,
            width: image.width,
            height: image.height,
        });
        if (!wasSaved) imageCacheRef.current.delete(dataUrl);
    };

    const handleSave = () => {
        if (commitChanges()) onClose();
    };

    if (!isOpen) return null;

    const currentEditingTextId = editingTextId;
    const currentEditingText = currentEditingTextId ? annotations.find(a => a.id === currentEditingTextId) : null;
    const showTextControls = activeTool === 'text' || Boolean(activeTextAnnotation);
    // The context bar only shows settings that apply to the current tool.
    const showStrokeControls = activeTool === 'draw' || (isShapeTool(activeTool) && activeTool !== 'highlight' && activeTool !== 'redaction');
    const drawsWithColor = activeTool === 'text' || activeTool === 'draw' || activeTool === 'highlight' || (isShapeTool(activeTool) && activeTool !== 'redaction');
    const toolGroups: ToolItem[][] = [
        [
            { id: 'select', icon: MousePointer2, label: t('modal.select') },
            { id: 'content', icon: FilePenLine, label: t('modal.editContent'), shortLabel: t('modal.contentShort') },
            ...(formFieldCount > 0 ? [{ id: 'form' as const, icon: TextCursorInput, label: t('modal.fillForm'), shortLabel: t('modal.formShort') }] : []),
        ],
        [
            { id: 'text', icon: Type, label: t('modal.text') },
            { id: 'highlight', icon: Highlighter, label: t('modal.highlight') },
            { id: 'draw', icon: Pencil, label: t('modal.draw') },
        ],
        [
            { id: 'rectangle', icon: Square, label: t('modal.rect') },
            { id: 'circle', icon: Circle, label: t('modal.circle') },
            { id: 'line', icon: Minus, label: t('modal.line') },
            { id: 'arrow', icon: MoveUpRight, label: t('modal.arrow') },
        ],
        [
            { id: 'image', icon: ImageIcon, label: t('modal.image') },
            { id: 'redaction', icon: EyeOff, label: t('modal.redact') },
        ],
    ];
    const annotationColors: ColorPreset[] = [
        { hex: '#000000', label: t('modal.colorBlack') },
        { hex: '#dc2626', label: t('modal.colorRed') },
        { hex: '#2563eb', label: t('modal.colorBlue') },
        { hex: '#16a34a', label: t('modal.colorGreen') },
        { hex: '#ea580c', label: t('modal.colorOrange') },
        { hex: '#7c3aed', label: t('modal.colorViolet') },
    ];
    const highlightColors: ColorPreset[] = [
        { hex: DEFAULT_HIGHLIGHT_COLOR, label: t('modal.colorYellow') },
        { hex: '#4ade80', label: t('modal.colorGreen') },
        { hex: '#f472b6', label: t('modal.colorPink') },
        { hex: '#60a5fa', label: t('modal.colorBlue') },
    ];
    const selectionLabel = (() => {
        if (activeTool !== 'select' || !selectedAnnotation) return null;
        if (selectedAnnotation.type === 'shape' && selectedShapeData) {
            const shapeLabels: Record<ShapeAnnotationData['shapeType'], string> = {
                rectangle: t('modal.rect'),
                circle: t('modal.circle'),
                line: t('modal.line'),
                arrow: t('modal.arrow'),
                highlight: t('modal.highlight'),
                redaction: t('modal.redact'),
            };
            return shapeLabels[selectedShapeData.shapeType];
        }
        return selectedAnnotation.type === 'text' ? t('modal.text')
            : selectedAnnotation.type === 'drawing' ? t('modal.draw')
                : t('modal.image');
    })();
    const usesFallbackFont = contentEdits.length > 0 && fallbackContentEdits === contentEdits;
    const contextBarProps: ContextBarProps = activeTool === 'content'
        ? { mode: 'content', editCount: contentEdits.length, usesFallbackFont }
        : activeTool === 'form'
            ? { mode: 'form', fieldCount: formFieldCount, usesFallbackFont }
            : activeTool === 'redaction'
                ? { mode: 'redaction', usesFallbackFont }
                : {
                    mode: 'annotate',
                    usesFallbackFont,
                    selectionLabel,
                    hasRedactions,
                    text: showTextControls ? {
                        fontSize: toolbarFontSize,
                        fontFamily: toolbarFontFamily,
                        bold: toolbarBold,
                        italic: toolbarItalic,
                        onFontSizeChange: nextSize => {
                            setFontSize(nextSize);
                            if (hasActiveTextAnnotation) applyTextStyleToActive(data => ({ ...data, fontSize: nextSize }));
                        },
                        onFontFamilyChange: nextFamily => {
                            setTextFontFamily(nextFamily);
                            if (hasActiveTextAnnotation) applyTextStyleToActive(data => ({ ...data, fontFamily: nextFamily }));
                        },
                        onBoldChange: nextBold => {
                            setTextBold(nextBold);
                            if (hasActiveTextAnnotation) applyTextStyleToActive(data => ({ ...data, bold: nextBold }));
                        },
                        onItalicChange: nextItalic => {
                            setTextItalic(nextItalic);
                            if (hasActiveTextAnnotation) applyTextStyleToActive(data => ({ ...data, italic: nextItalic }));
                        },
                    } : null,
                    color: showColorPicker && (drawsWithColor || hasActiveTextAnnotation) ? {
                        value: pickerColor,
                        presets: isHighlightContext ? highlightColors : annotationColors,
                        onChange: nextColor => {
                            if (isHighlightContext) {
                                setHighlightColor(nextColor);
                                return;
                            }
                            setColor(nextColor);
                            if (hasActiveTextAnnotation) {
                                applyTextStyleToActive(data => ({ ...data, color: nextColor }));
                            }
                        },
                    } : null,
                    stroke: showStrokeControls ? { width: strokeWidth, color: toolbarColor, onChange: setStrokeWidth } : null,
                    // Fill configures the next shape, or edits the selected one in the select tool.
                    fill: activeTool === 'rectangle' || activeTool === 'circle' || editsSelectedShapeFill ? {
                        enabled: toolbarFillEnabled,
                        color: toolbarFillColor,
                        opacity: toolbarFillOpacity,
                        onToggle: () => {
                            const enabled = !toolbarFillEnabled;
                            setFillEnabled(enabled);
                            updateSelectedShapeFill({ fillColor: enabled ? toolbarFillColor : '' });
                        },
                        onColorChange: nextColor => {
                            setFillColor(nextColor);
                            setFillEnabled(true);
                            updateSelectedShapeFill({ fillColor: nextColor });
                        },
                        onOpacityChange: nextOpacity => {
                            setFillOpacity(nextOpacity);
                            updateSelectedShapeFill({ fillOpacity: nextOpacity });
                        },
                    } : null,
                    selection: selectedAnnotationId ? { onDuplicate: duplicateSelection, onDelete: deleteSelection } : null,
                };
    const selectTool = (tool: Tool) => {
        if (tool === 'image') {
            setUploadTarget('canvas');
            fileInputRef.current?.click();
            return;
        }
        if (isLayerTool(tool)) {
            assets.setIsAssetsPanelOpen(false);
            setSelectedAnnotationId(null);
        }
        setActiveTool(tool);
    };

    return (
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-editor-title"
            tabIndex={-1}
            className="workspace-shell fixed inset-0 z-[50] flex flex-col overflow-hidden"
        >
            <div aria-live="assertive" aria-atomic="true">
                {displayedErrorMessage ? (
                    <div role="alert" className="absolute left-1/2 top-16 z-[80] flex w-[min(92vw,32rem)] -translate-x-1/2 items-start gap-3 rounded-lg border border-red-200 bg-white p-3 text-sm text-red-800 shadow-xl">
                        <span className="flex-1">{displayedErrorMessage}</span>
                        <button
                            type="button"
                            onClick={dismissDisplayedError}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-red-50"
                            title={t('common.close')}
                            aria-label={t('common.close')}
                        >
                            <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                    </div>
                ) : null}
            </div>
            <EditorHeader
                pagePosition={pagePosition ?? pageIndex}
                pageCount={onRequestNavigate ? pageCount : undefined}
                navigation={onRequestNavigate ? { hasPrevious: hasPreviousPage, hasNext: hasNextPage, onNavigate: handleNavigateRequest } : undefined}
                canSave={canSaveContent}
                canUndo={canUndoEdit}
                canRedo={canRedoEdit}
                onUndo={() => restoreHistoryEntry(-1)}
                onRedo={() => restoreHistoryEntry(1)}
                onCancel={handleCloseRequest}
                onSave={handleSave}
            />

            <div className="editor-body">
                <ToolRail groups={toolGroups} activeTool={activeTool} onToolSelect={selectTool} />

                <div className="editor-canvas-area">
                    <div ref={editorViewportRef} className={`workspace-canvas editor-viewport custom-scrollbar ${assets.isAssetsPanelOpen ? 'editor-viewport--with-panel' : ''}`}>
                        <div className="flex min-h-full w-max min-w-full items-start justify-center">
                            <div
                                className="relative mx-auto"
                                style={{
                                    width: canvasWidth * editorScale,
                                    height: canvasHeight * editorScale
                                }}
                            >
                                <div
                                    className="relative origin-top-left shadow-2xl bg-white rounded-lg"
                                    style={{
                                        width: canvasWidth,
                                        height: canvasHeight,
                                        transform: `scale(${editorScale})`
                                    }}
                                >
                                    <PdfPreview
                                        pdfDocument={pdfDocument}
                                        pageIndex={pageIndex}
                                        width={canvasWidth}
                                        height={canvasHeight}
                                        rotation={pageRotation}
                                        contentEdits={contentEdits}
                                        formValues={previewFormValues}
                                        onContentPreview={handleContentPreview}
                                        className="rounded-lg ring-1 ring-gray-200"
                                    />
                                    <canvas
                                        ref={canvasRef}
                                        width={canvasWidth}
                                        height={canvasHeight}
                                        role="img"
                                        aria-label={t('modal.canvasLabel')}
                                        className={`absolute top-0 left-0 z-[10] ${
                                            isLayerTool(activeTool)
                                                ? 'pointer-events-none'
                                                : activeTool === 'select'
                                                    ? 'touch-auto cursor-default'
                                                    : 'touch-none cursor-crosshair'
                                        }`}
                                        onPointerDown={handlePointerDown}
                                        onPointerMove={handlePointerMove}
                                        onPointerUp={handlePointerUp}
                                        onPointerCancel={handlePointerUp}
                                        onDoubleClick={(e) => {
                                            if (editingTextIdRef.current) return;
                                            const coords = getCanvasCoords(e);
                                            const hit = [...annotations].reverse().find(ann => ann.type === 'text' && isPointInAnnotation(coords.x, coords.y, ann));
                                            if (hit) {
                                                beginTextAnnotationEdit(hit);
                                            }
                                        }}
                                    />

                                    <ContentEditLayer
                                        isActive={activeTool === 'content'}
                                        pdfDocument={pdfDocument}
                                        pageIndex={pageIndex}
                                        displayRotation={totalRotation}
                                        width={canvasWidth}
                                        height={canvasHeight}
                                        edits={contentEdits}
                                        labels={{
                                            loading: t('modal.contentLoading'),
                                            empty: t('modal.contentEmpty'),
                                            hint: t('modal.contentHint'),
                                            editText: t('modal.editExistingText'),
                                            deleteSelection: t('modal.deleteSelection'),
                                            restoreSelection: t('modal.restoreContent'),
                                            moveLeft: t('modal.moveContentLeft'),
                                            moveRight: t('modal.moveContentRight'),
                                            moveUp: t('modal.moveContentUp'),
                                            moveDown: t('modal.moveContentDown'),
                                            textElement: t('modal.textElement'),
                                            imageElement: t('modal.imageElement'),
                                            parseFailed: t('modal.contentParseFailed'),
                                            pageTooLarge: t('modal.pageTooLarge'),
                                            tooManyElements: t('modal.tooManyElements'),
                                        }}
                                        onChange={setContentEdits}
                                        onError={handleContentParseError}
                                    />

                                    <FormFieldLayer
                                        isActive={activeTool === 'form'}
                                        pdfDocument={pdfDocument}
                                        pageIndex={pageIndex}
                                        displayRotation={totalRotation}
                                        width={canvasWidth}
                                        height={canvasHeight}
                                        values={formValues}
                                        onChange={handleFormValueChange}
                                        onFieldCount={setFormFieldCount}
                                    />

                                    {currentEditingText && !isLayerTool(activeTool) && (
                                        <textarea
                                            ref={textareaRef}
                                            className="absolute bg-white border-2 border-blue-500 rounded shadow-[0_0_20px_rgba(59,130,246,0.5)] p-2 outline-none resize-none whitespace-pre-wrap leading-tight text-gray-900 text-left overflow-auto z-[100]"
                                            style={{
                                                left: currentEditingText.x,
                                                top: currentEditingText.y,
                                                minWidth: '150px',
                                                width: Math.max(150, currentEditingText.width || 0),
                                                minHeight: '60px',
                                                height: Math.max(80, currentEditingText.height || 0),
                                                fontSize: `${(currentEditingText.data as TextAnnotationData).fontSize}px`,
                                                color: (currentEditingText.data as TextAnnotationData).color,
                                                fontFamily: (currentEditingText.data as TextAnnotationData).fontFamily,
                                                lineHeight: 1.25,
                                                transform: `rotate(${currentEditingText.rotation}deg)`,
                                                transformOrigin: 'top left'
                                            }}
                                            autoFocus
                                            placeholder={t('modal.typeHere')}
                                            value={(currentEditingText.data as TextAnnotationData).text}
                                            onMouseDown={(e) => e.stopPropagation()}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleTextEditComplete();
                                            }}
                                            onChange={(e) => {
                                                const newText = e.target.value;
                                                if (!editingTextId) return;
                                                updateTextAnnotation(editingTextId, data => ({ ...data, text: newText }));
                                            }}
                                            onBlur={handleTextEditComplete}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <ContextBar {...contextBarProps} />

                    <div className="editor-corner">
                        <ZoomControl
                            zoom={editorZoom}
                            onZoomOut={() => setEditorZoom(current => nextZoomStep(current, -1))}
                            onZoomIn={() => setEditorZoom(current => nextZoomStep(current, 1))}
                            canZoomOut={editorZoom > MIN_ZOOM + 0.001}
                            canZoomIn={editorZoom < ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001}
                        />
                        <button
                            type="button"
                            onClick={() => assets.setIsAssetsPanelOpen(previous => !previous)}
                            disabled={isLayerTool(activeTool)}
                            className="toolbar-button toolbar-button--labelled"
                            title={assets.isAssetsPanelOpen ? t('modal.closeAssetsPanel') : t('modal.openAssetsPanel')}
                            aria-label={assets.isAssetsPanelOpen ? t('modal.closeAssetsPanel') : t('modal.openAssetsPanel')}
                            aria-pressed={assets.isAssetsPanelOpen}
                        >
                            <Images aria-hidden="true" className="h-4 w-4" />
                            <span className="header-label-lg">{t('modal.library')}</span>
                        </button>
                    </div>

                    <AssetsPanel
                        assets={assets}
                        onUpload={() => {
                            setUploadTarget('library');
                            fileInputRef.current?.click();
                        }}
                        onInsert={insertSavedAsset}
                    />
                </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" className="hidden" onChange={handleImageUpload} />
            {isDiscardDialogOpen ? (
                <DiscardDialog
                    onCancel={() => setIsDiscardDialogOpen(false)}
                    onDiscard={() => {
                        setIsDiscardDialogOpen(false);
                        onClose();
                    }}
                />
            ) : null}
        </div>
    );
};
