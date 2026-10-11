export type OperationKind = 'import' | 'export' | 'images' | 'split' | 'protect' | 'unlock';
export interface OperationProgress {
    kind: OperationKind;
    completed: number;
    total: number;
    cancelling: boolean;
}
export class OperationCancelledError extends Error {
    constructor() { super('Operation cancelled.'); this.name = 'OperationCancelledError'; }
}
export interface OperationTask {
    signal: AbortSignal;
    check: () => void;
    checkpoint: (completed?: number, total?: number) => Promise<void>;
}

export const createOperationTask = (controller: AbortController, report: (completed: number, total: number) => void): OperationTask => {
    const check = () => { if (controller.signal.aborted) throw new OperationCancelledError(); };
    return {
        signal: controller.signal,
        check,
        checkpoint: async (completed, total) => {
            check();
            if (completed !== undefined && total !== undefined) report(completed, total);
            // Yield to input/paint between units so cancellation is actionable.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            check();
        },
    };
};
