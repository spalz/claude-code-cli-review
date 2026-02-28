export interface ReviewFileInfo {
    path: string;
    name: string;
    external: boolean;
    active: boolean;
    done: boolean;
    unresolved: number;
    total: number;
    sessionId?: string;
}

export interface ReviewStateUpdate {
    remaining: number;
    total: number;
    currentFile: string | null;
    unresolvedHunks: number;
    totalHunks: number;
    files: ReviewFileInfo[];
    currentHunkIndex: number;
    currentFileIndex: number;
    unresolvedFileCount: number;
    canUndo: boolean;
    canRedo: boolean;
    activeEditorInReview: boolean;
}

export interface KeybindingInfo {
    key: string;
    desc: string;
}
