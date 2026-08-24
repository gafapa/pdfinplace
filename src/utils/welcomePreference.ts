const WELCOME_DISMISSED_STORAGE_KEY = 'pdfinplace.welcome-hidden';
const WELCOME_DISMISSED_VALUE = 'true';

export const isWelcomeDismissed = () => {
    if (typeof window === 'undefined') {
        return true;
    }
    try {
        return localStorage.getItem(WELCOME_DISMISSED_STORAGE_KEY) === WELCOME_DISMISSED_VALUE;
    } catch {
        return true;
    }
};

export const setWelcomeDismissed = () => {
    try {
        localStorage.setItem(WELCOME_DISMISSED_STORAGE_KEY, WELCOME_DISMISSED_VALUE);
    } catch (error) {
        console.error('Could not save the welcome preference:', error);
    }
};
