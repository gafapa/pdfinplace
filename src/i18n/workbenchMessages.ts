import type { Locale } from './locales';

interface WorkbenchMessages {
    [key: string]: Record<string, string>;
    session: Record<'loading' | 'disabled' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict' | 'retry', string>;
    operation: Record<'import' | 'export' | 'images' | 'split' | 'protect' | 'unlock' | 'cancelling' | 'progress', string>;
}

export const WORKBENCH_MESSAGES: Record<Locale, WorkbenchMessages> = {
    es: {
        session: { loading: 'Restaurando sesión…', disabled: 'Guardado local desactivado', pending: 'Cambios pendientes de guardar', saving: 'Guardando en este dispositivo…', saved: 'Cambios guardados en este dispositivo', error: 'No se pudo guardar o restaurar la sesión. Exporta tu trabajo antes de reintentar.', conflict: 'Otra pestaña cambió la sesión. El guardado está pausado: exporta tu trabajo y después recarga.', retry: 'Reintentar' },
        operation: { import: 'Importando archivos', export: 'Preparando PDF', images: 'Preparando imágenes', split: 'Dividiendo PDF', protect: 'Protegiendo PDF', unlock: 'Desbloqueando PDF', cancelling: 'Cancelando; esperando a que termine el paso actual…', progress: '{{completed}} de {{total}}' },
    },
    en: {
        session: { loading: 'Restoring session…', disabled: 'Local saving is off', pending: 'Changes waiting to be saved', saving: 'Saving on this device…', saved: 'Changes saved on this device', error: 'Could not save or restore the session. Export your work before retrying.', conflict: 'Another tab changed the session. Saving is paused: export your work, then reload.', retry: 'Retry' },
        operation: { import: 'Importing files', export: 'Preparing PDF', images: 'Preparing images', split: 'Splitting PDF', protect: 'Protecting PDF', unlock: 'Unlocking PDF', cancelling: 'Cancelling; waiting for the current step to finish…', progress: '{{completed}} of {{total}}' },
    },
    gl: {
        session: { loading: 'Restaurando sesión…', disabled: 'Gardado local desactivado', pending: 'Cambios pendentes de gardar', saving: 'Gardando neste dispositivo…', saved: 'Cambios gardados neste dispositivo', error: 'Non se puido gardar ou restaurar a sesión. Exporta o teu traballo antes de reintentar.', conflict: 'Outra lapela cambiou a sesión. O gardado está pausado: exporta o teu traballo e despois recarga.', retry: 'Reintentar' },
        operation: { import: 'Importando ficheiros', export: 'Preparando PDF', images: 'Preparando imaxes', split: 'Dividindo PDF', protect: 'Protexendo PDF', unlock: 'Desbloqueando PDF', cancelling: 'Cancelando; agardando a que remate o paso actual…', progress: '{{completed}} de {{total}}' },
    },
    fr: {
        session: { loading: 'Restauration de la session…', disabled: 'Enregistrement local désactivé', pending: 'Modifications en attente d’enregistrement', saving: 'Enregistrement sur cet appareil…', saved: 'Modifications enregistrées sur cet appareil', error: 'Impossible d’enregistrer ou de restaurer la session. Exportez votre travail avant de réessayer.', conflict: 'Un autre onglet a modifié la session. L’enregistrement est suspendu : exportez votre travail, puis rechargez.', retry: 'Réessayer' },
        operation: { import: 'Importation des fichiers', export: 'Préparation du PDF', images: 'Préparation des images', split: 'Division du PDF', protect: 'Protection du PDF', unlock: 'Déverrouillage du PDF', cancelling: 'Annulation ; attente de la fin de l’étape actuelle…', progress: '{{completed}} sur {{total}}' },
    },
    de: {
        session: { loading: 'Sitzung wird wiederhergestellt…', disabled: 'Lokales Speichern deaktiviert', pending: 'Änderungen warten auf Speicherung', saving: 'Auf diesem Gerät wird gespeichert…', saved: 'Änderungen auf diesem Gerät gespeichert', error: 'Die Sitzung konnte nicht gespeichert oder wiederhergestellt werden. Exportieren Sie Ihre Arbeit vor dem erneuten Versuch.', conflict: 'Ein anderer Tab hat die Sitzung geändert. Speichern ist pausiert: Exportieren Sie Ihre Arbeit und laden Sie dann neu.', retry: 'Erneut versuchen' },
        operation: { import: 'Dateien werden importiert', export: 'PDF wird vorbereitet', images: 'Bilder werden vorbereitet', split: 'PDF wird geteilt', protect: 'PDF wird geschützt', unlock: 'PDF wird entsperrt', cancelling: 'Abbruch; der aktuelle Schritt wird noch abgeschlossen…', progress: '{{completed}} von {{total}}' },
    },
    pt: {
        session: { loading: 'A restaurar a sessão…', disabled: 'Gravação local desativada', pending: 'Alterações por guardar', saving: 'A guardar neste dispositivo…', saved: 'Alterações guardadas neste dispositivo', error: 'Não foi possível guardar ou restaurar a sessão. Exporte o trabalho antes de tentar novamente.', conflict: 'Outro separador alterou a sessão. A gravação está em pausa: exporte o trabalho e depois recarregue.', retry: 'Tentar novamente' },
        operation: { import: 'A importar ficheiros', export: 'A preparar PDF', images: 'A preparar imagens', split: 'A dividir PDF', protect: 'A proteger PDF', unlock: 'A desbloquear PDF', cancelling: 'A cancelar; a aguardar o fim do passo atual…', progress: '{{completed}} de {{total}}' },
    },
    ca: {
        session: { loading: 'Restaurant la sessió…', disabled: 'Desament local desactivat', pending: 'Canvis pendents de desar', saving: 'Desant en aquest dispositiu…', saved: 'Canvis desats en aquest dispositiu', error: 'No s’ha pogut desar o restaurar la sessió. Exporta la feina abans de tornar-ho a provar.', conflict: 'Una altra pestanya ha canviat la sessió. El desament està en pausa: exporta la feina i després recarrega.', retry: 'Torna-ho a provar' },
        operation: { import: 'Important fitxers', export: 'Preparant PDF', images: 'Preparant imatges', split: 'Dividint PDF', protect: 'Protegint PDF', unlock: 'Desbloquejant PDF', cancelling: 'Cancel·lant; esperant que acabi el pas actual…', progress: '{{completed}} de {{total}}' },
    },
    eu: {
        session: { loading: 'Saioa leheneratzen…', disabled: 'Tokiko gordetzea desgaituta', pending: 'Aldaketak gordetzeko zain', saving: 'Gailu honetan gordetzen…', saved: 'Aldaketak gailu honetan gordeta', error: 'Ezin izan da saioa gorde edo leheneratu. Esportatu lana berriro saiatu aurretik.', conflict: 'Beste fitxa batek saioa aldatu du. Gordetzea etenda dago: esportatu lana eta kargatu berriro.', retry: 'Saiatu berriro' },
        operation: { import: 'Fitxategiak inportatzen', export: 'PDFa prestatzen', images: 'Irudiak prestatzen', split: 'PDFa zatitzen', protect: 'PDFa babesten', unlock: 'PDFa desblokeatzen', cancelling: 'Bertan behera uzten; uneko urratsa amaitzeko zain…', progress: '{{completed}} / {{total}}' },
    },
};
