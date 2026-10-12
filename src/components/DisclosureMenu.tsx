import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface DisclosureMenuProps {
    label: string;
    icon: ReactNode;
    className?: string;
    buttonClassName: string;
    panelClassName?: string;
    /** Receives a function that closes the menu, for items that act and close. */
    children: (close: () => void) => ReactNode;
}

/** A button that opens a small panel of actions; outside clicks and Escape close it. */
export const DisclosureMenu = ({ label, icon, className = '', buttonClassName, panelClassName = '', children }: DisclosureMenuProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    const close = useCallback(() => setIsOpen(false), []);

    useEffect(() => {
        if (!isOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // Keep the workspace from also treating this Escape as "clear selection".
            event.stopPropagation();
            setIsOpen(false);
            buttonRef.current?.focus();
        };
        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [isOpen]);

    return (
        <div ref={containerRef} className={`header-menu ${className}`}>
            <button
                ref={buttonRef}
                type="button"
                className={buttonClassName}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                aria-label={label}
                title={label}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                    event.stopPropagation();
                    setIsOpen(previous => !previous);
                }}
            >
                {icon}
            </button>
            {isOpen ? (
                <div id={panelId} className={`menu-panel ${panelClassName}`} onPointerDown={event => event.stopPropagation()}>
                    {children(close)}
                </div>
            ) : null}
        </div>
    );
};
