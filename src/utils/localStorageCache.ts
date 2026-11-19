import type { WorkflowProjectFile } from '../types/workflow';
import { parseWorkflowProjectJson } from './projectExporter';

// ============================================================================
// [工具模組] localStorageCache：本地自動存檔 (Auto-Save) 與多組快速記憶槽 (Slot 1~3)
// ============================================================================

const AUTO_SAVE_KEY = 'foobar2000_dj_autosave_v2';
const SLOT_KEY_PREFIX = 'foobar2000_dj_slot_v2_';

export type QuickSlotId = 1 | 2 | 3;

/**
 * 壓縮專案中過大的 base64 封面字串，確保 localStorage 絕不因超過 5MB 配額而寫入失敗
 */
const compactProjectForStorage = (
    project: WorkflowProjectFile
): WorkflowProjectFile => {
    return {
        ...project,
        nodes: project.nodes.map((n) => ({
            ...n,
            tracks: n.tracks.map((t) => ({
                ...t,
                coverUrl:
                    t.coverUrl &&
                    t.coverUrl.startsWith('data:') &&
                    t.coverUrl.length > 4096
                        ? undefined
                        : t.coverUrl,
            })),
        })),
    };
};

/**
 * 儲存當前畫布狀態至本地自動快取（包含 nodes: [] 的空白畫布狀態）
 */
export const saveAutoSaveProject = (project: WorkflowProjectFile): void => {
    if (typeof window === 'undefined') return;
    try {
        const compact = compactProjectForStorage(project);
        window.localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(compact));
    } catch (err) {
        console.warn('無法寫入自動存檔快取:', err);
    }
};

/**
 * 讀取本地自動快取的工作流專案（包含使用者已清空畫布後的 nodes: [] 空專案）
 */
export const loadAutoSaveProject = (): WorkflowProjectFile | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(AUTO_SAVE_KEY);
        if (!raw) return null;
        const parsed = parseWorkflowProjectJson(raw);
        return parsed.valid && parsed.project ? parsed.project : null;
    } catch {
        return null;
    }
};

/**
 * 清除本地自動快取（僅於使用者明確點擊「重置預設畫布」時使用）
 */
export const clearAutoSaveProject = (): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(AUTO_SAVE_KEY);
    } catch {
        // 忽略存取限制錯誤
    }
};

/**
 * 將專案儲存至指定的快速記憶槽 (Slot 1 ~ 3)
 */
export const savePresetSlot = (
    slotId: QuickSlotId,
    project: WorkflowProjectFile
): void => {
    if (typeof window === 'undefined') return;
    try {
        const compact = compactProjectForStorage(project);
        window.localStorage.setItem(
            `${SLOT_KEY_PREFIX}${slotId}`,
            JSON.stringify(compact)
        );
    } catch (err) {
        console.warn(`無法寫入記憶槽 Slot ${slotId}:`, err);
    }
};

/**
 * 從指定的快速記憶槽 (Slot 1 ~ 3) 讀取專案
 */
export const loadPresetSlot = (
    slotId: QuickSlotId
): WorkflowProjectFile | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(`${SLOT_KEY_PREFIX}${slotId}`);
        if (!raw) return null;
        const parsed = parseWorkflowProjectJson(raw);
        return parsed.valid && parsed.project ? parsed.project : null;
    } catch {
        return null;
    }
};

/**
 * 檢查 Slot 1 ~ 3 是否已有儲存資料
 */
export const getSavedSlotsStatus = (): Record<QuickSlotId, boolean> => {
    if (typeof window === 'undefined') {
        return { 1: false, 2: false, 3: false };
    }
    return {
        1: Boolean(window.localStorage.getItem(`${SLOT_KEY_PREFIX}1`)),
        2: Boolean(window.localStorage.getItem(`${SLOT_KEY_PREFIX}2`)),
        3: Boolean(window.localStorage.getItem(`${SLOT_KEY_PREFIX}3`)),
    };
};
