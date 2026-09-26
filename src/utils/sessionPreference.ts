const SESSION_PERSISTENCE_STORAGE_KEY = 'pageforge.local-persistence-enabled';
const SESSION_PREFERENCE_EVENT = 'pdfinplace:session-persistence-change';

export const getSessionPersistencePreference = () => {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        return localStorage.getItem(SESSION_PERSISTENCE_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

export const setSessionPersistencePreference = (enabled: boolean) => {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        localStorage.setItem(SESSION_PERSISTENCE_STORAGE_KEY, String(enabled));
    } catch (error) {
        console.error('Could not save the session preference:', error);
    }

    window.dispatchEvent(new CustomEvent<boolean>(SESSION_PREFERENCE_EVENT, {
        detail: enabled,
    }));
};

export const subscribeToSessionPreference = (listener: (enabled: boolean) => void) => {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const handlePreferenceChange = (event: Event) => {
        const preferenceEvent = event as CustomEvent<boolean>;
        if (typeof preferenceEvent.detail === 'boolean') {
            listener(preferenceEvent.detail);
        }
    };

    window.addEventListener(SESSION_PREFERENCE_EVENT, handlePreferenceChange);
    return () => window.removeEventListener(SESSION_PREFERENCE_EVENT, handlePreferenceChange);
};
