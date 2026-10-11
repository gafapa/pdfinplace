import { describe, expect, it, vi } from 'vitest';
import { createOperationTask, OperationCancelledError } from './editorOperation';

describe('cooperative operation cancellation', () => {
    it('rejects at the next checkpoint before committing a staged result', async () => {
        const controller = new AbortController();
        const report = vi.fn();
        const task = createOperationTask(controller, report);
        const download = vi.fn();
        const work = async () => {
            await task.checkpoint(0, 5);
            task.check();
            download();
        };
        const pending = work();
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
        expect(download).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledWith(0, 5);
    });

    it('checks cancellation before reporting progress for another unit', async () => {
        const controller = new AbortController();
        const report = vi.fn();
        const task = createOperationTask(controller, report);
        controller.abort();
        await expect(task.checkpoint(1, 2)).rejects.toBeInstanceOf(OperationCancelledError);
        expect(report).not.toHaveBeenCalled();
        expect(() => task.check()).toThrow(OperationCancelledError);
    });
});
