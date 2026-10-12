/** Zoom levels shared by the page grid and the page editor, so both step alike. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];

/**
 * The next level above or below `current`. A value between levels (such as an
 * older saved zoom) moves to the nearest level in that direction.
 */
export const nextZoomStep = (current: number, direction: 1 | -1, max: number = ZOOM_STEPS[ZOOM_STEPS.length - 1]) => {
    const levels = ZOOM_STEPS.filter(level => level <= max);
    const next = direction > 0
        ? levels.find(level => level > current + 0.001)
        : [...levels].reverse().find(level => level < current - 0.001);
    return next ?? (direction > 0 ? levels[levels.length - 1] : levels[0]);
};
