import { useState, useRef, useEffect, useCallback } from 'react';
import { PdfPreview } from './PdfPreview';
import {
    Type,
    Bold,
    Italic,
    Pencil,
    Square,
    Circle,
    Minus,
    ImageIcon,
    Check,
    X,
    Trash2,
    ZoomIn,
    ZoomOut,
    MousePointer2,
    ChevronLeft,
    ChevronRight
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, TextAnnotationData, DrawingAnnotationData, ShapeAnnotationData, ImageAnnotationData } from '../types/annotations';
import { useI18n } from '../i18n';
import { createId } from '../utils/createId';

type Tool = 'select' | 'text' | 'draw' | 'rectangle' | 'circle' | 'line' | 'image';
type InteractionMode = 'idle' | 'drawing' | 'moving' | 'resizing';
type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br' | null;
type ShapeTool = Extract<Tool, 'rectangle' | 'circle' | 'line'>;
const TEXT_FONTS = ['Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New'] as const;
const STROKE_GRAPHIC_OPTIONS = [1, 2, 4, 8, 12, 16, 24, 32] as const;
const MIN_EDITOR_ZOOM = 0.5;
const MAX_EDITOR_ZOOM = 3;
const EDITOR_ZOOM_STEP = 0.25;
const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_IMAGE_PIXELS = 16_000_000;
const MAX_SAVED_ASSETS = 30;

interface PageEditorModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (annotations: Annotation[]) => void;
    pdfDocument?: PDFDocumentProxy;
    pageIndex: number;
    pageRotation: number;
    initialAnnotations: Annotation[];
}

interface SavedAsset {
    id: string;
    name: string;
    kind: 'signature' | 'stamp';
    dataUrl: string;
    width: number;
    height: number;
}

const SAVED_ASSETS_STORAGE_KEY = 'pageforge.saved-assets';
const LOCAL_PERSISTENCE_STORAGE_KEY = 'pageforge.local-persistence-enabled';

const isLocalPersistenceEnabled = () => {
    if (typeof window === 'undefined') {
        return false;
    }

    return localStorage.getItem(LOCAL_PERSISTENCE_STORAGE_KEY) === 'true';
};

const getInitialAssetsPanelOpen = () => {
    if (typeof window === 'undefined') {
        return false;
    }

    const savedValue = localStorage.getItem('pageforge.assets-panel-open');
    return savedValue === null ? false : savedValue === 'true';
};

export const PageEditorModal = ({
    isOpen,
    onClose,
    onSave,
    pdfDocument,
    pageIndex,
    pageRotation,
    initialAnnotations
}: PageEditorModalProps) => {
    const { t } = useI18n();
    const [activeTool, setActiveTool] = useState<Tool>('select');
    const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations);
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
    const [interactionMode, setInteractionMode] = useState<InteractionMode>('idle');
    const [resizeHandle, setResizeHandle] = useState<ResizeHandle>(null);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [initialAnnotationState, setInitialAnnotationState] = useState<Annotation | null>(null);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);

    const [currentDrawing, setCurrentDrawing] = useState<{ x: number; y: number }[]>([]);
    const [color, setColor] = useState('#000000');
    const [strokeWidth, setStrokeWidth] = useState(2);
    const [fontSize, setFontSize] = useState(24);
    const [textFontFamily, setTextFontFamily] = useState<(typeof TEXT_FONTS)[number]>('Arial');
    const [textBold, setTextBold] = useState(false);
    const [textItalic, setTextItalic] = useState(false);
    const [imageRenderTick, setImageRenderTick] = useState(0);
    const [nativeRotation, setNativeRotation] = useState(0);
    const [fitScale, setFitScale] = useState(1);
    const [editorZoom, setEditorZoom] = useState(1);
    const [savedAssets, setSavedAssets] = useState<SavedAsset[]>(() => {
        try {
            if (!isLocalPersistenceEnabled()) {
                localStorage.removeItem(SAVED_ASSETS_STORAGE_KEY);
                return [];
            }

            const rawAssets = localStorage.getItem(SAVED_ASSETS_STORAGE_KEY);
            if (!rawAssets) {
                return [];
            }

            const parsedAssets = JSON.parse(rawAssets) as SavedAsset[];
            return Array.isArray(parsedAssets) ? parsedAssets : [];
        } catch (error) {
            console.error('Failed to restore saved assets:', error);
            return [];
        }
    });
    const [uploadTarget, setUploadTarget] = useState<'canvas' | 'signature' | 'stamp'>('canvas');
    const [isAssetsPanelOpen, setIsAssetsPanelOpen] = useState(getInitialAssetsPanelOpen);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const editorViewportRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const editingTextIdRef = useRef<string | null>(null);
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const canvasBoundsRef = useRef<DOMRect | null>(null);
    const pointerMoveFrameRef = useRef<number | null>(null);
    const pendingPointerCoordsRef = useRef<{ x: number; y: number } | null>(null);

    const totalRotation = (nativeRotation + pageRotation) % 360;
    const isLandscape = (totalRotation % 180) !== 0;
    const canvasWidth = isLandscape ? 1000 : 800;
    const canvasHeight = isLandscape ? 800 : 1000;
    const editorScale = fitScale * editorZoom;
    const editorZoomPercent = Math.round(editorZoom * 100);

    // Sync ref with state for event handlers
    useEffect(() => {
        editingTextIdRef.current = editingTextId;
    }, [editingTextId]);

    useEffect(() => {
        try {
            if (isLocalPersistenceEnabled()) {
                localStorage.setItem(SAVED_ASSETS_STORAGE_KEY, JSON.stringify(savedAssets));
            } else {
                localStorage.removeItem(SAVED_ASSETS_STORAGE_KEY);
            }
        } catch (error) {
            console.error('Failed to persist saved assets:', error);
        }
    }, [savedAssets]);

    useEffect(() => {
        localStorage.setItem('pageforge.assets-panel-open', String(isAssetsPanelOpen));
    }, [isAssetsPanelOpen]);

    const getTextLayout = useCallback((data: TextAnnotationData) => {
        const lines = data.text.split(/\r?\n/);
        const normalizedLines = lines.length > 0 ? lines : [''];
        const lineHeight = data.fontSize * 1.25;
        const font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize}px ${data.fontFamily}`;

        const measureCanvas = canvasRef.current;
        const measureCtx = measureCanvas?.getContext('2d');
        const measuredWidth = measureCtx ? (() => {
            measureCtx.save();
            measureCtx.font = font;
            const width = normalizedLines.reduce((max, line) => {
                const sample = line.length > 0 ? line : ' ';
                return Math.max(max, measureCtx.measureText(sample).width);
            }, 0);
            measureCtx.restore();
            return width;
        })() : normalizedLines.reduce((max, line) => Math.max(max, line.length * data.fontSize * 0.55), 0);

        return {
            lines: normalizedLines,
            lineHeight,
            width: Math.max(150, measuredWidth + 20),
            height: Math.max(60, normalizedLines.length * lineHeight + 20),
        };
    }, []);

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
                return;
            }

            try {
                const page = await pdfDocument.getPage(pageIndex);
                if (!isCancelled) {
                    setNativeRotation(page.rotate ?? 0);
                }
            } catch {
                if (!isCancelled) {
                    setNativeRotation(0);
                }
            }
        };

        loadNativeRotation();

        return () => {
            isCancelled = true;
        };
    }, [isOpen, pdfDocument, pageIndex]);

    useEffect(() => {
        if (!isOpen) return;

        const recalculateScale = () => {
            const viewport = editorViewportRef.current;
            if (!viewport) return;

            const availableWidth = viewport.clientWidth - 8;
            const availableHeight = viewport.clientHeight - 8;
            const widthScale = availableWidth / canvasWidth;
            const heightScale = availableHeight / canvasHeight;
            const nextScale = Math.min(1, widthScale, heightScale);
            setFitScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
        };

        recalculateScale();

        const observer = new ResizeObserver(recalculateScale);
        if (editorViewportRef.current) observer.observe(editorViewportRef.current);
        window.addEventListener('resize', recalculateScale);

        return () => {
            observer.disconnect();
            window.removeEventListener('resize', recalculateScale);
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
    const toolbarFontFamily = activeTextData && TEXT_FONTS.includes(activeTextData.fontFamily as (typeof TEXT_FONTS)[number])
        ? activeTextData.fontFamily as (typeof TEXT_FONTS)[number]
        : textFontFamily;
    const toolbarBold = activeTextData?.bold ?? textBold;
    const toolbarItalic = activeTextData?.italic ?? textItalic;

    const applyTextStyleToActive = useCallback((updater: (data: TextAnnotationData) => TextAnnotationData) => {
        if (!activeTextId) {
            return;
        }
        updateTextAnnotation(activeTextId, updater);
    }, [activeTextId, updateTextAnnotation]);

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

    const createImageLikeAnnotation = useCallback((
        dataUrl: string,
        imageWidth: number,
        imageHeight: number,
        type: 'image' | 'signature' = 'image',
    ): Annotation => {
        const maxWidth = canvasWidth * 0.8;
        const maxHeight = canvasHeight * 0.8;
        const fitScale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
        const fittedWidth = Math.max(40, imageWidth * fitScale);
        const fittedHeight = Math.max(40, imageHeight * fitScale);

        return {
            id: createId(),
            type,
            x: Math.max(0, (canvasWidth - fittedWidth) / 2),
            y: Math.max(0, (canvasHeight - fittedHeight) / 2),
            width: fittedWidth,
            height: fittedHeight,
            rotation: 0,
            data: { dataUrl, originalWidth: imageWidth, originalHeight: imageHeight }
        };
    }, [canvasWidth, canvasHeight]);

    const addSavedAsset = useCallback((asset: SavedAsset) => {
        setSavedAssets(prev => [asset, ...prev.filter(item => item.id !== asset.id)].slice(0, MAX_SAVED_ASSETS));
    }, []);

    const insertSavedAsset = useCallback((asset: SavedAsset) => {
        const newAnnotation = createImageLikeAnnotation(
            asset.dataUrl,
            asset.width,
            asset.height,
            asset.kind === 'signature' ? 'signature' : 'image',
        );
        setAnnotations(prev => [...prev, newAnnotation]);
        setSelectedAnnotationId(newAnnotation.id);
        setActiveTool('select');
    }, [createImageLikeAnnotation]);

    const saveSelectedAsset = useCallback((kind: 'signature' | 'stamp') => {
        if (!selectedAnnotationId) {
            return;
        }

        const selectedAnnotation = annotations.find(annotation => annotation.id === selectedAnnotationId);
        if (!selectedAnnotation || (selectedAnnotation.type !== 'image' && selectedAnnotation.type !== 'signature')) {
            return;
        }

        const data = selectedAnnotation.data as ImageAnnotationData;
        addSavedAsset({
            id: createId(),
            name: `${kind}-${savedAssets.length + 1}`,
            kind,
            dataUrl: data.dataUrl,
            width: data.originalWidth,
            height: data.originalHeight,
        });
    }, [selectedAnnotationId, annotations, addSavedAsset, savedAssets.length]);

    const removeSavedAsset = useCallback((assetId: string) => {
        setSavedAssets(prev => prev.filter(asset => asset.id !== assetId));
    }, []);

    // Keyboard listener for Delete
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedAnnotationId && !editingTextIdRef.current) {
                    setAnnotations(prev => prev.filter(a => a.id !== selectedAnnotationId));
                    setSelectedAnnotationId(null);
                }
            } else if (e.key === 'Escape') {
                if (editingTextIdRef.current) {
                    handleTextEditComplete();
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedAnnotationId, onClose, handleTextEditComplete]);

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
                .map((ann) => (ann.data as ImageAnnotationData).dataUrl)
        );

        imageCacheRef.current.forEach((_, dataUrl) => {
            if (!referencedDataUrls.has(dataUrl) && !savedAssets.some((asset) => asset.dataUrl === dataUrl)) {
                imageCacheRef.current.delete(dataUrl);
            }
        });
    }, [annotations, savedAssets]);

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
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        annotations.forEach(ann => {
            if (editingTextId === ann.id) return;

            ctx.save();
            const centerX = ann.x + (ann.width || 0) / 2;
            const centerY = ann.y + (ann.height || 0) / 2;
            const rotation = Number(ann.rotation) || 0;

            ctx.translate(centerX, centerY);
            ctx.rotate((rotation * Math.PI) / 180);
            ctx.translate(-centerX, -centerY);

            if (ann.type === 'drawing') {
                const data = ann.data as DrawingAnnotationData;
                ctx.strokeStyle = data.strokeColor;
                ctx.lineWidth = data.strokeWidth;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                data.points.forEach((point, i) => {
                    if (i === 0) ctx.moveTo(point.x, point.y);
                    else ctx.lineTo(point.x, point.y);
                });
                ctx.stroke();
            } else if (ann.type === 'shape') {
                const data = ann.data as ShapeAnnotationData;
                ctx.strokeStyle = data.strokeColor;
                ctx.lineWidth = data.strokeWidth;
                if (data.fillColor) ctx.fillStyle = data.fillColor;

                if (data.shapeType === 'rectangle') {
                    ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
                } else if (data.shapeType === 'circle') {
                    ctx.beginPath();
                    ctx.ellipse(ann.x + ann.width / 2, ann.y + ann.height / 2, Math.max(0.1, Math.abs(ann.width / 2)), Math.max(0.1, Math.abs(ann.height / 2)), 0, 0, 2 * Math.PI);
                    ctx.stroke();
                } else if (data.shapeType === 'line') {
                    ctx.beginPath();
                    const x1 = ann.x + (data.x1 ?? 0) * ann.width;
                    const y1 = ann.y + (data.y1 ?? 0) * ann.height;
                    const x2 = ann.x + (data.x2 ?? 1) * ann.width;
                    const y2 = ann.y + (data.y2 ?? 1) * ann.height;
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                }
            } else if (ann.type === 'text') {
                const data = ann.data as TextAnnotationData;
                ctx.fillStyle = data.color;
                ctx.font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize}px ${data.fontFamily}`;
                ctx.textBaseline = 'top';
                const { lines, lineHeight } = getTextLayout(data);
                lines.forEach((line, index) => {
                    ctx.fillText(line, ann.x, ann.y + (index * lineHeight));
                });
            } else if (ann.type === 'image' || ann.type === 'signature') {
                const data = ann.data as ImageAnnotationData;
                const img = getCachedImage(data.dataUrl);
                if (img.complete) {
                    ctx.drawImage(img, ann.x, ann.y, ann.width, ann.height);
                }
            }

            if (selectedAnnotationId === ann.id) {
                ctx.strokeStyle = '#3B82F6';
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 5]);
                ctx.strokeRect(ann.x - 2, ann.y - 2, ann.width + 4, ann.height + 4);
                ctx.setLineDash([]);

                const handleSize = 6;
                ctx.fillStyle = '#3B82F6';
                ctx.fillRect(ann.x - handleSize / 2, ann.y - handleSize / 2, handleSize, handleSize);
                ctx.fillRect(ann.x + ann.width - handleSize / 2, ann.y - handleSize / 2, handleSize, handleSize);
                ctx.fillRect(ann.x - handleSize / 2, ann.y + ann.height - handleSize / 2, handleSize, handleSize);
                ctx.fillRect(ann.x + ann.width - handleSize / 2, ann.y + ann.height - handleSize / 2, handleSize, handleSize);
            }

            ctx.restore();
        });

        if (interactionMode === 'drawing' && currentDrawing.length > 0) {
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = strokeWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (activeTool === 'draw') {
                ctx.beginPath();
                currentDrawing.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
                ctx.stroke();
            } else if (activeTool === 'rectangle') {
                const start = currentDrawing[0];
                const end = currentDrawing[currentDrawing.length - 1];
                ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
            } else if (activeTool === 'circle') {
                const start = currentDrawing[0];
                const end = currentDrawing[currentDrawing.length - 1];
                const w = end.x - start.x;
                const h = end.y - start.y;
                ctx.beginPath();
                ctx.ellipse(start.x + w / 2, start.y + h / 2, Math.max(0.1, Math.abs(w / 2)), Math.max(0.1, Math.abs(h / 2)), 0, 0, 2 * Math.PI);
                ctx.stroke();
            } else if (activeTool === 'line') {
                const start = currentDrawing[0];
                const end = currentDrawing[currentDrawing.length - 1];
                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();
            }
            ctx.restore();
        }
    }, [annotations, selectedAnnotationId, interactionMode, currentDrawing, activeTool, color, strokeWidth, editingTextId, getTextLayout, getCachedImage]);

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
                    ? { ...ann, x: initialAnnotationState.x + dx, y: initialAnnotationState.y + dy }
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

                return { ...ann, x, y, width: Math.max(10, width), height: Math.max(10, height) };
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

    const isShapeTool = (tool: Tool): tool is ShapeTool =>
        tool === 'rectangle' || tool === 'circle' || tool === 'line';

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
                setInitialAnnotationState({ ...hit });
            } else {
                setSelectedAnnotationId(null);
            }
        } else if (activeTool === 'text') {
            startPointerInteraction();
            // If we were editing, and the click is to finish, usually we don't want 
            // to immediately start another one at the SAME pixel.
            // But if it's a different pixel, it's fine.
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
        } else if (['draw', 'rectangle', 'circle', 'line'].includes(activeTool)) {
            startPointerInteraction();
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

        if (pendingCoords && interactionMode !== 'drawing') {
            updatePointerInteraction(pendingCoords);
        }

        const finalizedDrawing = pendingCoords && interactionMode === 'drawing'
            ? [...currentDrawing, pendingCoords]
            : currentDrawing;

        if (interactionMode === 'drawing' && finalizedDrawing.length > 0) {
            const start = finalizedDrawing[0];
            const end = finalizedDrawing[finalizedDrawing.length - 1];

            let newAnn: Annotation | null = null;
            if (activeTool === 'draw' && finalizedDrawing.length > 1) {
                const xs = finalizedDrawing.map(p => p.x);
                const ys = finalizedDrawing.map(p => p.y);
                const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
                newAnn = {
                    id: createId(),
                    type: 'drawing',
                    x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0,
                    data: { points: finalizedDrawing, strokeColor: color, strokeWidth }
                };
            } else if (isShapeTool(activeTool) && finalizedDrawing.length >= 2) {
                newAnn = {
                    id: createId(),
                    type: 'shape',
                    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
                    width: Math.max(1, Math.abs(end.x - start.x)), height: Math.max(1, Math.abs(end.y - start.y)), rotation: 0,
                    data: {
                        shapeType: activeTool,
                        strokeColor: color,
                        fillColor: '',
                        strokeWidth,
                        x1: (start.x - Math.min(start.x, end.x)) / Math.max(1, Math.abs(end.x - start.x)),
                        y1: (start.y - Math.min(start.y, end.y)) / Math.max(1, Math.abs(end.y - start.y)),
                        x2: (end.x - Math.min(start.x, end.x)) / Math.max(1, Math.abs(end.x - start.x)),
                        y2: (end.y - Math.min(start.y, end.y)) / Math.max(1, Math.abs(end.y - start.y)),
                    } as ShapeAnnotationData
                };
            }

            if (newAnn) {
                setAnnotations(prev => [...prev, newAnn!]);
                setSelectedAnnotationId(newAnn.id);
            }
            setCurrentDrawing([]);
        }

        setInteractionMode('idle');
        setResizeHandle(null);
        setInitialAnnotationState(null);
        canvasBoundsRef.current = null;
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/') || file.size > MAX_UPLOAD_IMAGE_BYTES) {
            alert(t('modal.imageFileTooLarge'));
            e.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const result = event.target?.result;
            if (typeof result !== 'string') {
                return;
            }
            const img = new Image();
            img.onload = () => {
                if (img.width * img.height > MAX_UPLOAD_IMAGE_PIXELS) {
                    alert(t('modal.imagePixelsTooLarge'));
                    return;
                }

                if (uploadTarget === 'canvas') {
                    imageCacheRef.current.set(result, img);
                    const newAnnotation = createImageLikeAnnotation(result, img.width, img.height);
                    setAnnotations(prev => [...prev, newAnnotation]);
                    setSelectedAnnotationId(newAnnotation.id);
                    setActiveTool('select');
                } else {
                    imageCacheRef.current.set(result, img);
                    addSavedAsset({
                        id: createId(),
                        name: `${uploadTarget}-${savedAssets.length + 1}`,
                        kind: uploadTarget,
                        dataUrl: result,
                        width: img.width,
                        height: img.height,
                    });
                }
            };
            img.src = result;
        };
        reader.readAsDataURL(file);
        setUploadTarget('canvas');
        e.target.value = '';
    };

    const handleSave = () => {
        const finalizedAnnotations = getFinalizedAnnotations(annotations);
        setAnnotations(finalizedAnnotations);
        setEditingTextId(null);
        editingTextIdRef.current = null;
        onSave(finalizedAnnotations);
        onClose();
    };

    if (!isOpen) return null;

    const currentEditingTextId = editingTextId;
    const currentEditingText = currentEditingTextId ? annotations.find(a => a.id === currentEditingTextId) : null;
    const showTextControls = activeTool === 'text';
    const toolItems = [
        { id: 'select', icon: MousePointer2, label: t('modal.select') },
        { id: 'text', icon: Type, label: t('modal.text') },
        { id: 'draw', icon: Pencil, label: t('modal.draw') },
        { id: 'rectangle', icon: Square, label: t('modal.rect') },
        { id: 'circle', icon: Circle, label: t('modal.circle') },
        { id: 'line', icon: Minus, label: t('modal.line') },
        { id: 'image', icon: ImageIcon, label: t('modal.image') },
    ] as const;

    return (
        <div className="fixed inset-0 bg-white/90 z-[50] flex flex-col overflow-hidden">
            <div className="bg-white border-b border-gray-200 text-gray-900 px-2 sm:px-3 py-2 shadow-sm z-[60]">
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                    <span className="font-semibold text-gray-700 shrink-0">{t('common.page')} {pageIndex}</span>
                    <div className="min-w-0 flex justify-center overflow-x-auto">
                        {showTextControls ? (
                            <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-gray-200 bg-white p-1 w-fit">
                                <select
                                    value={toolbarFontSize}
                                    onChange={(e) => {
                                        const nextSize = Number(e.target.value);
                                        setFontSize(nextSize);
                                        if (hasActiveTextAnnotation) {
                                            applyTextStyleToActive(data => ({ ...data, fontSize: nextSize }));
                                        }
                                    }}
                                    className="h-9 min-w-[86px] bg-white text-gray-700 text-xs rounded border border-gray-300 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 shrink-0"
                                >
                                    {[12, 16, 20, 24, 32, 48, 64].map(s => <option key={s} value={s}>{s}px</option>)}
                                </select>
                                <select
                                    value={toolbarFontFamily}
                                    onChange={(e) => {
                                        const nextFamily = e.target.value as (typeof TEXT_FONTS)[number];
                                        setTextFontFamily(nextFamily);
                                        if (hasActiveTextAnnotation) {
                                            applyTextStyleToActive(data => ({ ...data, fontFamily: nextFamily }));
                                        }
                                    }}
                                    className="h-9 min-w-[130px] bg-white text-gray-700 text-xs rounded border border-gray-300 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 shrink-0"
                                >
                                    {TEXT_FONTS.map(font => <option key={font} value={font}>{font}</option>)}
                                </select>
                            </div>
                        ) : (
                            <div className="h-9" />
                        )}
                    </div>
                    <div className="flex items-center gap-2 justify-self-end">
                        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-1">
                            <button
                                type="button"
                                onClick={() => setEditorZoom(prev => Math.max(MIN_EDITOR_ZOOM, Number((prev - EDITOR_ZOOM_STEP).toFixed(2))))}
                                disabled={editorZoom <= MIN_EDITOR_ZOOM}
                                className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-30"
                                title={t('editor.zoomOut')}
                                aria-label={t('editor.zoomOut')}
                            >
                                <ZoomOut className="h-3.5 w-3.5" />
                            </button>
                            <span className="min-w-12 text-center text-[11px] font-semibold tabular-nums text-gray-600">
                                {editorZoomPercent}%
                            </span>
                            <button
                                type="button"
                                onClick={() => setEditorZoom(prev => Math.min(MAX_EDITOR_ZOOM, Number((prev + EDITOR_ZOOM_STEP).toFixed(2))))}
                                disabled={editorZoom >= MAX_EDITOR_ZOOM}
                                className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-30"
                                title={t('editor.zoomIn')}
                                aria-label={t('editor.zoomIn')}
                            >
                                <ZoomIn className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <button
                            onClick={onClose}
                            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 transition-colors shrink-0"
                            title={t('common.cancel')}
                            aria-label={t('common.cancel')}
                        >
                            <X className="w-4 h-4" />
                        </button>
                        <button
                            onClick={handleSave}
                            className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors shadow-md shadow-blue-900/20 shrink-0"
                            title={t('common.save')}
                            aria-label={t('common.save')}
                        >
                            <Check className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="pointer-events-none absolute right-3 top-16 z-[70]">
                <div className="pointer-events-auto flex max-h-[calc(100vh-5rem)] flex-col gap-2 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
                    {toolItems.map(tool => (
                        <button
                            key={tool.id}
                            onClick={() => {
                                if (tool.id === 'image') {
                                    setUploadTarget('canvas');
                                    fileInputRef.current?.click();
                                    return;
                                }
                                setActiveTool(tool.id as Tool);
                            }}
                            className={`h-9 w-9 inline-flex items-center justify-center rounded-md border border-gray-200 transition-all shrink-0 ${activeTool === tool.id ? 'bg-blue-600 text-white shadow-inner border-blue-600' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                            title={tool.label}
                            aria-label={tool.label}
                        >
                            <tool.icon className="w-4 h-4" />
                        </button>
                    ))}
                    <div className="h-px bg-gray-200 my-1"></div>
                    <input
                        type="color"
                        value={toolbarColor}
                        onChange={(e) => {
                            const nextColor = e.target.value;
                            setColor(nextColor);
                            if (hasActiveTextAnnotation) {
                                applyTextStyleToActive(data => ({ ...data, color: nextColor }));
                            }
                        }}
                        title="Color"
                        aria-label="Color"
                        className="h-9 w-9 rounded-md cursor-pointer border border-gray-300 p-0 overflow-hidden bg-white shrink-0"
                    />
                    <div className="w-9 rounded-md border border-gray-300 bg-white p-1">
                        <div className="flex flex-col items-center gap-1">
                            {STROKE_GRAPHIC_OPTIONS.map((w) => (
                                <button
                                    key={w}
                                    type="button"
                                    onClick={() => setStrokeWidth(w)}
                                    className={`h-4 w-full rounded-sm px-1 transition-colors ${strokeWidth === w ? 'bg-blue-100' : 'hover:bg-gray-100'}`}
                                    title={`${w}px`}
                                    aria-label={`${w}px`}
                                >
                                    <span
                                        className="block w-full rounded-full"
                                        style={{
                                            height: Math.max(1, Math.min(6, Math.round(w / 4))),
                                            backgroundColor: toolbarColor,
                                            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)'
                                        }}
                                    />
                                </button>
                            ))}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            const nextBold = !toolbarBold;
                            setTextBold(nextBold);
                            if (hasActiveTextAnnotation) {
                                applyTextStyleToActive(data => ({ ...data, bold: nextBold }));
                            }
                        }}
                        className={`h-9 w-9 inline-flex items-center justify-center rounded-md border transition-colors shrink-0 ${toolbarBold ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-700 bg-white border-gray-200 hover:bg-gray-50'}`}
                        title={t('modal.bold')}
                    >
                        <Bold className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const nextItalic = !toolbarItalic;
                            setTextItalic(nextItalic);
                            if (hasActiveTextAnnotation) {
                                applyTextStyleToActive(data => ({ ...data, italic: nextItalic }));
                            }
                        }}
                        className={`h-9 w-9 inline-flex items-center justify-center rounded-md border transition-colors shrink-0 ${toolbarItalic ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-700 bg-white border-gray-200 hover:bg-gray-50'}`}
                        title={t('modal.italic')}
                    >
                        <Italic className="w-4 h-4" />
                    </button>
                    <div className="h-px bg-gray-200 my-1"></div>
                    <button
                        onClick={() => { setAnnotations(prev => prev.filter(a => a.id !== selectedAnnotationId)); setSelectedAnnotationId(null); }}
                        disabled={!selectedAnnotationId}
                        className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-gray-200 transition-colors text-gray-700 bg-white hover:bg-red-100 hover:text-red-600 disabled:opacity-30 disabled:hover:bg-white disabled:hover:text-gray-700"
                        title={t('modal.deleteSelection')}
                        aria-label={t('modal.deleteSelection')}
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="pointer-events-none absolute left-0 top-16 bottom-3 z-[70] flex items-start">
                <div className="pointer-events-auto flex h-full items-end">
                    <div
                        className={`h-full overflow-hidden rounded-r-2xl border-y border-r border-gray-200 bg-white/95 shadow-xl backdrop-blur transition-all duration-300 ${
                            isAssetsPanelOpen
                                ? 'w-[min(18rem,calc(100vw-4rem))] translate-x-0 opacity-100'
                                : 'w-0 -translate-x-4 opacity-0'
                        }`}
                    >
                        <div className="flex h-full min-h-0 flex-col">
                            <div className="border-b border-gray-200 bg-gradient-to-r from-blue-50 via-white to-white px-4 py-3">
                                <div className="text-sm font-semibold text-gray-900">{t('modal.savedAssets')}</div>
                                <div className="text-[11px] text-gray-500">{t('modal.savedAssetsHint')}</div>
                            </div>
                            <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-4 py-4 custom-scrollbar">
                                <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-3">
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                                        {t('modal.libraryUpload')}
                                    </div>
                                    <div className="grid gap-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setUploadTarget('signature');
                                                fileInputRef.current?.click();
                                            }}
                                            className="inline-flex h-9 w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
                                        >
                                            {t('modal.uploadSignature')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setUploadTarget('stamp');
                                                fileInputRef.current?.click();
                                            }}
                                            className="inline-flex h-9 w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
                                        >
                                            {t('modal.uploadStamp')}
                                        </button>
                                    </div>
                                </section>

                                <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-3">
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                                        {t('modal.saveSelection')}
                                    </div>
                                    <div className="grid gap-2">
                                        <button
                                            type="button"
                                            onClick={() => saveSelectedAsset('signature')}
                                            disabled={!selectedAnnotationId}
                                            className="inline-flex h-9 w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                                        >
                                            {t('modal.saveAsSignature')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => saveSelectedAsset('stamp')}
                                            disabled={!selectedAnnotationId}
                                            className="inline-flex h-9 w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                                        >
                                            {t('modal.saveAsStamp')}
                                        </button>
                                    </div>
                                </section>

                                <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-3">
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                                        {t('modal.savedItems')}
                                    </div>
                                    <div className="space-y-2">
                                        {savedAssets.length === 0 ? (
                                            <p className="text-[11px] text-gray-500">{t('modal.noSavedAssets')}</p>
                                        ) : savedAssets.map(asset => (
                                            <div key={asset.id} className="rounded-xl border border-gray-200 bg-white p-2">
                                                <button
                                                    type="button"
                                                    onClick={() => insertSavedAsset(asset)}
                                                    className="block w-full overflow-hidden rounded-lg bg-gray-50"
                                                    title={t('modal.insertAsset')}
                                                >
                                                    <img src={asset.dataUrl} alt={asset.name} className="h-20 w-full object-contain" />
                                                </button>
                                                <div className="mt-2 flex items-center justify-between gap-2">
                                                    <span className="truncate text-xs font-medium text-gray-700">{asset.name}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => removeSavedAsset(asset.id)}
                                                        className="rounded-lg p-1 text-gray-500 hover:bg-red-50 hover:text-red-600"
                                                        title={t('common.delete')}
                                                        aria-label={t('common.delete')}
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setIsAssetsPanelOpen((prev) => !prev)}
                        className="mb-4 inline-flex h-12 w-10 items-center justify-center rounded-r-2xl border border-l-0 border-gray-200 bg-white/95 text-gray-700 shadow-lg backdrop-blur transition hover:bg-gray-50"
                        title={isAssetsPanelOpen ? t('modal.closeAssetsPanel') : t('modal.openAssetsPanel')}
                        aria-label={isAssetsPanelOpen ? t('modal.closeAssetsPanel') : t('modal.openAssetsPanel')}
                    >
                        {isAssetsPanelOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                </div>
            </div>

            <div ref={editorViewportRef} className={`flex-1 overflow-auto custom-scrollbar bg-white p-2 pr-14 sm:p-4 sm:pr-16 lg:p-8 lg:pr-20 ${isAssetsPanelOpen ? 'lg:pl-[20rem]' : ''}`}>
                <div className="flex min-h-full w-max min-w-full items-start justify-center">
                    <div
                        className="relative mx-auto"
                        style={{
                            width: canvasWidth * editorScale,
                            height: canvasHeight * editorScale
                        }}
                    >
                        <div
                            ref={overlayRef}
                            className="relative origin-top-left shadow-2xl bg-white rounded-lg"
                            style={{
                                width: canvasWidth,
                                height: canvasHeight,
                                transform: `scale(${editorScale})`
                            }}
                        >
                            <PdfPreview pdfDocument={pdfDocument} pageIndex={pageIndex} width={canvasWidth} height={canvasHeight} rotation={pageRotation} className="rounded-lg ring-1 ring-gray-200" />
                        <canvas
                                ref={canvasRef}
                                width={canvasWidth}
                                height={canvasHeight}
                                className={`absolute top-0 left-0 z-[10] ${activeTool === 'select' ? 'touch-auto cursor-default' : 'touch-none cursor-crosshair'}`}
                                onPointerDown={handlePointerDown}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onPointerCancel={handlePointerUp}
                                onDoubleClick={(e) => {
                                    if (editingTextIdRef.current) return;
                                    const coords = getCanvasCoords(e);
                                    const hit = [...annotations].reverse().find(ann => ann.type === 'text' && isPointInAnnotation(coords.x, coords.y, ann));
                                    if (hit) {
                                        setSelectedAnnotationId(hit.id);
                                        setEditingTextId(hit.id);
                                        editingTextIdRef.current = hit.id;
                                    }
                                }}
                            />

                            {currentEditingText && (
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
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
        </div>
    );
};
