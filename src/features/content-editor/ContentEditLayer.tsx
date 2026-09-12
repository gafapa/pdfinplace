import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from 'react';
import { ImageIcon, LoaderCircle, RotateCcw, Trash2, Type } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    parseContentPage,
    rgbToCss,
    viewportDeltaToPdfDelta,
} from './parseContentPage';
import type { ContentBlock, ContentEdit, ParsedContentPage, TextContentBlock } from './types';

interface ContentEditLayerLabels {
    loading: string;
    empty: string;
    hint: string;
    editText: string;
    deleteSelection: string;
    restoreSelection: string;
    textElement: string;
    imageElement: string;
    parseFailed: string;
    pageTooLarge: string;
    tooManyElements: string;
}

interface ContentEditLayerProps {
    isActive: boolean;
    pdfDocument?: PDFDocumentProxy;
    pageIndex: number;
    displayRotation: number;
    width: number;
    height: number;
    edits: ContentEdit[];
    labels: ContentEditLayerLabels;
    onChange: (edits: ContentEdit[]) => void;
    onError: (message: string) => void;
}

interface DragState {
    pointerId: number;
    block: ContentBlock;
    clientX: number;
    clientY: number;
    scaleX: number;
    scaleY: number;
    moved: boolean;
}

interface PendingDragDelta {
    deltaX: number;
    deltaY: number;
}

const dirtyEditsFromBlocks = (blocks: ContentBlock[]) =>
    blocks.filter((block) => block.isDirty).map((block) => structuredClone(block));

const getBlockLabel = (block: ContentBlock, labels: ContentEditLayerLabels) =>
    block.type === 'text'
        ? `${labels.textElement}: ${block.originalText}`
        : labels.imageElement;

export const ContentEditLayer = ({
    isActive,
    pdfDocument,
    pageIndex,
    displayRotation,
    width,
    height,
    edits,
    labels,
    onChange,
    onError,
}: ContentEditLayerProps) => {
    const parseKey = `${pageIndex}:${displayRotation}:${width}:${height}`;
    const [parseResult, setParseResult] = useState<{
        key: string;
        page: ParsedContentPage | null;
    } | null>(null);
    const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
    const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
    const [draftText, setDraftText] = useState('');
    const layerRef = useRef<HTMLDivElement>(null);
    const blocksRef = useRef<ContentBlock[]>([]);
    const editsRef = useRef(edits);
    const dragRef = useRef<DragState | null>(null);
    const dragFrameRef = useRef<number | null>(null);
    const pendingDragRef = useRef<PendingDragDelta | null>(null);
    const loadedParseKeyRef = useRef<string | null>(null);

    useEffect(() => {
        editsRef.current = edits;
    }, [edits]);

    useEffect(() => {
        if (!isActive || !pdfDocument) return;
        if (loadedParseKeyRef.current === parseKey) return;

        let cancelled = false;

        void parseContentPage(
            pdfDocument,
            pageIndex,
            displayRotation,
            width,
            height,
            editsRef.current,
            {
                pageTooLarge: labels.pageTooLarge,
                tooManyElements: labels.tooManyElements,
            },
        ).then((page) => {
            if (cancelled) return;
            blocksRef.current = page.blocks;
            loadedParseKeyRef.current = parseKey;
            setParseResult({ key: parseKey, page });
        }).catch((error: unknown) => {
            if (cancelled) return;
            console.error('Failed to analyze the PDF page content:', error);
            setParseResult({ key: parseKey, page: null });
            onError(labels.parseFailed);
        });

        return () => {
            cancelled = true;
        };
    }, [displayRotation, height, isActive, onError, pageIndex, parseKey, pdfDocument, width, labels]);

    const parsedPage = parseResult?.key === parseKey ? parseResult.page : null;
    const isLoading = isActive && parseResult?.key !== parseKey;

    const updateBlocks = useCallback((
        updater: (blocks: ContentBlock[]) => ContentBlock[],
    ) => {
        const nextBlocks = updater(blocksRef.current);
        blocksRef.current = nextBlocks;
        setParseResult((current) => (
            current?.key === parseKey && current.page
                ? { ...current, page: { ...current.page, blocks: nextBlocks } }
                : current
        ));
        onChange(dirtyEditsFromBlocks(nextBlocks));
    }, [onChange, parseKey]);

    const moveBlockBy = useCallback((blockId: string, deltaX: number, deltaY: number) => {
        const viewportTransform = parsedPage?.viewportTransform;
        if (!viewportTransform) return;

        updateBlocks((blocks) => blocks.map((block) => {
            if (block.id !== blockId || block.deleted) return block;
            const nextX = Math.max(0, Math.min(width - block.width, block.x + deltaX));
            const nextY = Math.max(0, Math.min(height - block.height, block.y + deltaY));
            const appliedX = nextX - block.x;
            const appliedY = nextY - block.y;
            const pdfDelta = viewportDeltaToPdfDelta(viewportTransform, appliedX, appliedY);

            return {
                ...block,
                x: nextX,
                y: nextY,
                pdfX: block.pdfX + pdfDelta.dx,
                pdfY: block.pdfY + pdfDelta.dy,
                isDirty: true,
            };
        }));
    }, [height, parsedPage?.viewportTransform, updateBlocks, width]);

    const startTextEdit = useCallback((block: TextContentBlock) => {
        if (block.deleted) return;
        setSelectedBlockId(block.id);
        setEditingBlockId(block.id);
        setDraftText(block.text);
    }, []);

    const commitTextEdit = useCallback(() => {
        if (!editingBlockId) return;
        updateBlocks((blocks) => blocks.map((block) => {
            if (block.id !== editingBlockId || block.type !== 'text') return block;
            return {
                ...block,
                text: draftText,
                deleted: draftText.trim().length === 0,
                isDirty: block.isDirty || draftText !== block.originalText,
            };
        }));
        setEditingBlockId(null);
    }, [draftText, editingBlockId, updateBlocks]);

    const deleteBlock = useCallback((blockId: string) => {
        updateBlocks((blocks) => blocks.map((block) => (
            block.id === blockId
                ? {
                    ...block,
                    ...(block.type === 'text' ? { text: '' } : {}),
                    deleted: true,
                    isDirty: true,
                }
                : block
        )));
        setEditingBlockId(null);
    }, [updateBlocks]);

    const restoreBlock = useCallback((blockId: string) => {
        updateBlocks((blocks) => blocks.map((block) => {
            if (block.id !== blockId) return block;
            return {
                ...block,
                x: block.origX,
                y: block.origY,
                pdfX: block.origPdfX,
                pdfY: block.origPdfY,
                ...(block.type === 'text' ? { text: block.originalText } : {}),
                deleted: false,
                isDirty: false,
            };
        }));
        setEditingBlockId(null);
    }, [updateBlocks]);

    const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, block: ContentBlock) => {
        if (editingBlockId || block.deleted) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const bounds = layerRef.current?.getBoundingClientRect();
        dragRef.current = {
            pointerId: event.pointerId,
            block: structuredClone(block),
            clientX: event.clientX,
            clientY: event.clientY,
            scaleX: bounds ? bounds.width / width : 1,
            scaleY: bounds ? bounds.height / height : 1,
            moved: false,
        };
        setSelectedBlockId(block.id);
    }, [editingBlockId, height, width]);

    const applyPendingDrag = useCallback(() => {
        dragFrameRef.current = null;
        const pending = pendingDragRef.current;
        const drag = dragRef.current;
        const viewportTransform = parsedPage?.viewportTransform;
        if (!pending || !drag || !viewportTransform) {
            pendingDragRef.current = null;
            return;
        }
        pendingDragRef.current = null;

        const nextX = Math.max(0, Math.min(width - drag.block.width, drag.block.x + pending.deltaX));
        const nextY = Math.max(0, Math.min(height - drag.block.height, drag.block.y + pending.deltaY));
        const pdfDelta = viewportDeltaToPdfDelta(
            viewportTransform,
            nextX - drag.block.x,
            nextY - drag.block.y,
        );

        updateBlocks((blocks) => blocks.map((block) => (
            block.id === drag.block.id
                ? {
                    ...block,
                    x: nextX,
                    y: nextY,
                    pdfX: drag.block.pdfX + pdfDelta.dx,
                    pdfY: drag.block.pdfY + pdfDelta.dy,
                    isDirty: true,
                }
                : block
        )));
    }, [height, parsedPage?.viewportTransform, updateBlocks, width]);

    useEffect(() => () => {
        if (dragFrameRef.current !== null) {
            cancelAnimationFrame(dragFrameRef.current);
        }
    }, []);

    const handlePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !parsedPage?.viewportTransform) return;
        const deltaX = (event.clientX - drag.clientX) / Math.max(0.01, drag.scaleX);
        const deltaY = (event.clientY - drag.clientY) / Math.max(0.01, drag.scaleY);
        if (!drag.moved && Math.hypot(deltaX, deltaY) < 3) return;
        drag.moved = true;

        pendingDragRef.current = { deltaX, deltaY };
        if (dragFrameRef.current === null) {
            dragFrameRef.current = requestAnimationFrame(applyPendingDrag);
        }
    }, [applyPendingDrag, parsedPage?.viewportTransform]);

    const handlePointerEnd = useCallback((event: PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        dragRef.current = null;
        if (dragFrameRef.current !== null) {
            cancelAnimationFrame(dragFrameRef.current);
            dragFrameRef.current = null;
        }
        applyPendingDrag();
    }, [applyPendingDrag]);

    const handleBlockKeyDown = useCallback((
        event: KeyboardEvent<HTMLButtonElement>,
        block: ContentBlock,
    ) => {
        if (event.key === 'Enter' && block.type === 'text') {
            event.preventDefault();
            event.stopPropagation();
            startTextEdit(block);
            return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            event.stopPropagation();
            deleteBlock(block.id);
            return;
        }
        if (event.key === 'Escape') {
            event.stopPropagation();
            setSelectedBlockId(null);
            return;
        }

        const step = event.shiftKey ? 10 : 1;
        const movement = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        }[event.key];
        if (movement) {
            event.preventDefault();
            event.stopPropagation();
            moveBlockBy(block.id, movement[0], movement[1]);
        }
    }, [deleteBlock, moveBlockBy, startTextEdit]);

    if (!isActive) return null;

    const selectedBlock = parsedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;

    return (
        <div
            ref={layerRef}
            className="absolute inset-0 z-20 overflow-hidden rounded-lg"
            aria-label={labels.hint}
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) setSelectedBlockId(null);
            }}
        >
            {isLoading ? (
                <div role="status" className="absolute inset-0 z-50 flex items-center justify-center bg-white/72 text-sm font-medium text-gray-700 backdrop-blur-[1px]">
                    <LoaderCircle aria-hidden="true" className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" />
                    {labels.loading}
                </div>
            ) : null}

            {!isLoading && parsedPage?.blocks.length === 0 ? (
                <div role="status" className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg border border-gray-200 bg-white/95 px-3 py-2 text-xs font-medium text-gray-700 shadow-lg">
                    {labels.empty}
                </div>
            ) : null}

            {parsedPage?.blocks.map((block) => {
                const isSelected = selectedBlockId === block.id;
                const backgroundColor = rgbToCss(block.backgroundColor);

                return (
                    <div key={block.id}>
                        {block.isDirty ? (
                            <div
                                aria-hidden="true"
                                className="pointer-events-none absolute"
                                style={{
                                    left: block.origX - 2,
                                    top: block.origY - 2,
                                    width: block.width + 4,
                                    height: block.height + 4,
                                    backgroundColor,
                                    transform: `rotate(${block.screenRotation}deg)`,
                                    transformOrigin: 'top left',
                                }}
                            />
                        ) : null}

                        {block.isDirty && !block.deleted && block.type === 'text' ? (
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute block whitespace-pre"
                                style={{
                                    left: block.x,
                                    top: block.y,
                                    color: rgbToCss(block.pdfColor),
                                    fontFamily: block.fontInfo.cssFamily,
                                    fontSize: block.screenFontSize,
                                    fontStyle: block.fontInfo.italic ? 'italic' : 'normal',
                                    fontWeight: block.fontInfo.bold ? 700 : 400,
                                    lineHeight: 1,
                                    transform: `rotate(${block.screenRotation}deg) scaleX(${block.screenTextScaleX})`,
                                    transformOrigin: 'top left',
                                }}
                            >
                                {block.text}
                            </span>
                        ) : null}

                        {block.isDirty && !block.deleted && block.type === 'image' ? (
                            <img
                                aria-hidden="true"
                                src={block.imageDataUrl}
                                alt=""
                                draggable={false}
                                className="pointer-events-none absolute object-fill"
                                style={{
                                    left: block.x,
                                    top: block.y,
                                    width: block.width,
                                    height: block.height,
                                    transform: `rotate(${block.screenRotation}deg)`,
                                    transformOrigin: 'top left',
                                }}
                            />
                        ) : null}

                        {!block.deleted ? (
                            <button
                                type="button"
                                className={`absolute cursor-move touch-none rounded-sm bg-transparent outline-none transition-shadow motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 ${
                                    isSelected
                                        ? 'ring-2 ring-amber-500 ring-offset-1 shadow-[0_0_0_9999px_rgba(15,23,42,0.03)]'
                                        : 'hover:ring-1 hover:ring-amber-400/80'
                                }`}
                                style={{
                                    left: block.x,
                                    top: block.y,
                                    width: Math.max(12, block.width),
                                    height: Math.max(12, block.height),
                                    transform: `rotate(${block.screenRotation}deg)`,
                                    transformOrigin: 'top left',
                                }}
                                title={getBlockLabel(block, labels)}
                                aria-label={getBlockLabel(block, labels)}
                                aria-pressed={isSelected}
                                onPointerDown={(event) => handlePointerDown(event, block)}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerEnd}
                                onPointerCancel={handlePointerEnd}
                                onDoubleClick={() => {
                                    if (block.type === 'text') startTextEdit(block);
                                }}
                                onKeyDown={(event) => handleBlockKeyDown(event, block)}
                            >
                                <span className="sr-only">{getBlockLabel(block, labels)}</span>
                            </button>
                        ) : null}

                        {editingBlockId === block.id && block.type === 'text' ? (
                            <input
                                type="text"
                                autoFocus
                                value={draftText}
                                aria-label={labels.editText}
                                className="absolute z-40 min-w-32 rounded border-2 border-amber-500 bg-white px-2 py-1 text-gray-950 shadow-xl outline-none"
                                style={{
                                    left: block.x,
                                    top: block.y,
                                    width: Math.max(160, block.width),
                                    fontFamily: block.fontInfo.cssFamily,
                                    fontSize: block.screenFontSize,
                                    fontStyle: block.fontInfo.italic ? 'italic' : 'normal',
                                    fontWeight: block.fontInfo.bold ? 700 : 400,
                                }}
                                onChange={(event) => setDraftText(event.target.value)}
                                onBlur={commitTextEdit}
                                onPointerDown={(event) => event.stopPropagation()}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        commitTextEdit();
                                    } else if (event.key === 'Escape') {
                                        setEditingBlockId(null);
                                    }
                                }}
                            />
                        ) : null}
                    </div>
                );
            })}

            {selectedBlock ? (
                <div className="absolute bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-gray-200 bg-white/96 p-1.5 text-gray-700 shadow-xl backdrop-blur">
                    <span role="status" className="max-w-48 truncate px-2 text-xs font-semibold">
                        {selectedBlock.type === 'text' ? (
                            <><Type aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />{selectedBlock.originalText}</>
                        ) : (
                            <><ImageIcon aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />{labels.imageElement}</>
                        )}
                    </span>
                    {selectedBlock.type === 'text' && !selectedBlock.deleted ? (
                        <button
                            type="button"
                            onClick={() => startTextEdit(selectedBlock)}
                            className="inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-semibold hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                            title={labels.editText}
                        >
                            {labels.editText}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => restoreBlock(selectedBlock.id)}
                        disabled={!selectedBlock.isDirty}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-gray-100 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                        aria-label={labels.restoreSelection}
                        title={labels.restoreSelection}
                    >
                        <RotateCcw aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => deleteBlock(selectedBlock.id)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                        aria-label={labels.deleteSelection}
                        title={labels.deleteSelection}
                    >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                </div>
            ) : (
                <p className="pointer-events-none absolute bottom-3 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-2 text-center text-xs font-medium text-amber-950 shadow-sm">
                    {labels.hint}
                </p>
            )}
        </div>
    );
};
