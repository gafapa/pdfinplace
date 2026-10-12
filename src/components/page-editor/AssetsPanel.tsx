import { Check, ImageIcon, Pencil, Trash2, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { SavedAsset, SavedAssetsState } from './useSavedAssets';

interface AssetsPanelProps {
    assets: SavedAssetsState;
    onUpload: () => void;
    onInsert: (asset: SavedAsset) => void;
}

/** Library of saved signatures, stamps and images, opened from the editor corner. */
export const AssetsPanel = ({ assets, onUpload, onInsert }: AssetsPanelProps) => {
    const { t } = useI18n();
    const {
        savedAssets,
        isAssetsPanelOpen,
        setIsAssetsPanelOpen,
        renamingAssetId,
        assetNameDraft,
        setAssetNameDraft,
        beginRenamingAsset,
        cancelRenamingAsset,
        commitAssetName,
        removeSavedAsset,
    } = assets;

    if (!isAssetsPanelOpen) return null;

    return (
        <aside className="assets-panel" aria-labelledby="assets-panel-title">
            <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
                <div>
                    <h3 id="assets-panel-title" className="text-sm font-semibold text-gray-900">{t('modal.savedAssets')}</h3>
                    <p className="text-xs text-gray-600">{t('modal.savedAssetsHint')}</p>
                </div>
                <button
                    type="button"
                    onClick={() => setIsAssetsPanelOpen(false)}
                    className="toolbar-button toolbar-button--ghost h-9 w-9 shrink-0"
                    title={t('modal.closeAssetsPanel')}
                    aria-label={t('modal.closeAssetsPanel')}
                >
                    <X aria-hidden="true" className="h-4 w-4" />
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 custom-scrollbar">
                <button
                    type="button"
                    onClick={onUpload}
                    className="toolbar-button toolbar-button--labelled h-11 w-full"
                    title={t('modal.uploadLibraryImage')}
                >
                    <ImageIcon aria-hidden="true" className="h-4 w-4" />
                    {t('modal.uploadLibraryImage')}
                </button>

                <div className="mt-5 text-xs font-semibold text-gray-700">
                    {t('modal.savedItems')}
                </div>
                <div className="mt-2 space-y-3">
                    {savedAssets.length === 0 ? (
                        <p className="rounded-xl bg-gray-50 px-3 py-4 text-center text-xs leading-5 text-gray-500">
                            {t('modal.noSavedAssets')}
                        </p>
                    ) : savedAssets.map(asset => (
                        <div key={asset.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                            <button
                                type="button"
                                onClick={() => onInsert(asset)}
                                className="block w-full bg-gray-50 p-2 transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
                                title={`${t('modal.insertAsset')}: ${asset.name}`}
                                aria-label={`${t('modal.insertAsset')}: ${asset.name}`}
                            >
                                <img src={asset.dataUrl} alt="" className="h-24 w-full object-contain" />
                            </button>
                            <div className="flex min-h-12 items-center gap-1.5 border-t border-gray-100 px-2 py-1.5">
                                {renamingAssetId === asset.id ? (
                                    <input
                                        type="text"
                                        value={assetNameDraft}
                                        onChange={(event) => setAssetNameDraft(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                commitAssetName(asset.id);
                                            } else if (event.key === 'Escape') {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                cancelRenamingAsset();
                                            }
                                        }}
                                        autoFocus
                                        className="h-9 min-w-0 flex-1 rounded-lg border border-blue-300 px-2 text-sm text-gray-800 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
                                        aria-label={t('modal.assetNameLabel')}
                                    />
                                ) : (
                                    <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-gray-700">
                                        {asset.name}
                                    </span>
                                )}
                                {renamingAssetId === asset.id ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => commitAssetName(asset.id)}
                                            disabled={!assetNameDraft.trim()}
                                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-blue-700 hover:bg-blue-50 disabled:opacity-40"
                                            title={t('common.save')}
                                            aria-label={t('common.save')}
                                        >
                                            <Check aria-hidden="true" className="h-4 w-4" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={cancelRenamingAsset}
                                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
                                            title={t('common.cancel')}
                                            aria-label={t('common.cancel')}
                                        >
                                            <X aria-hidden="true" className="h-4 w-4" />
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => beginRenamingAsset(asset)}
                                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-blue-50 hover:text-blue-700"
                                            title={t('modal.renameAsset')}
                                            aria-label={`${t('modal.renameAsset')}: ${asset.name}`}
                                        >
                                            <Pencil aria-hidden="true" className="h-4 w-4" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => removeSavedAsset(asset.id)}
                                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-red-50 hover:text-red-600"
                                            title={t('common.delete')}
                                            aria-label={`${t('common.delete')}: ${asset.name}`}
                                        >
                                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </aside>
    );
};
