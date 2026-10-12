import { describe, expect, it } from 'vitest';
import { nextZoomStep } from './zoomSteps';

describe('nextZoomStep', () => {
    it('moves one level at a time', () => {
        expect(nextZoomStep(1, 1)).toBe(1.25);
        expect(nextZoomStep(1, -1)).toBe(0.75);
    });

    it('snaps a value between levels to the next level in that direction', () => {
        expect(nextZoomStep(1.1, 1)).toBe(1.25);
        expect(nextZoomStep(1.1, -1)).toBe(1);
    });

    it('stays within the limits', () => {
        expect(nextZoomStep(0.5, -1)).toBe(0.5);
        expect(nextZoomStep(2, 1, 2)).toBe(2);
        expect(nextZoomStep(3, 1)).toBe(3);
    });
});
