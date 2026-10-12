import { Minus, Plus } from 'lucide-react';
import { useI18n } from '../i18n';

interface ZoomControlProps {
    zoom: number;
    onZoomOut: () => void;
    onZoomIn: () => void;
    canZoomOut: boolean;
    canZoomIn: boolean;
}

/** The "− 100 % +" control shared by the page grid and the page editor. */
export const ZoomControl = ({ zoom, onZoomOut, onZoomIn, canZoomOut, canZoomIn }: ZoomControlProps) => {
    const { t, locale } = useI18n();
    const label = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(zoom);
    return (
        <div role="group" aria-label={t('editor.zoom')} className="zoom-control">
            <button type="button" onClick={onZoomOut} disabled={!canZoomOut} title={t('editor.zoomOut')} aria-label={t('editor.zoomOut')}>
                <Minus aria-hidden="true" className="h-4 w-4" />
            </button>
            <span className="zoom-control-value" aria-live="polite">{label}</span>
            <button type="button" onClick={onZoomIn} disabled={!canZoomIn} title={t('editor.zoomIn')} aria-label={t('editor.zoomIn')}>
                <Plus aria-hidden="true" className="h-4 w-4" />
            </button>
        </div>
    );
};
