import { useEffect, useRef, useState } from 'react';
import { PdfPreview, type PdfPreviewProps } from './PdfPreview';

// One observer serves the whole grid. Cards stay mounted for keyboard sorting;
// only expensive PDF renderers/canvases are released outside the nearby viewport.
const listeners = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | null = null;

export const DeferredPdfPreview = (props: PdfPreviewProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
        observer ??= new IntersectionObserver(entries => {
            for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
        }, { rootMargin: '320px' });
        listeners.set(element, setVisible);
        observer.observe(element);
        return () => {
            observer?.unobserve(element);
            listeners.delete(element);
            if (listeners.size === 0) { observer?.disconnect(); observer = null; }
        };
    }, []);
    return (
        <div ref={containerRef} data-deferred-preview style={{ width: props.width ?? 200, height: props.height ?? props.width ?? 200 }}>
            {visible ? <PdfPreview {...props} /> : <div className="h-full w-full bg-gray-100" aria-hidden="true" />}
        </div>
    );
};
