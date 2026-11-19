import { useRef, useState } from 'react';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { createFoobarPlaylistWithTracks } from '../../api/mockBridge';
import {
    buildM3U8Content,
    parseWorkflowProjectJson,
    saveExportedFileWithDialog,
} from '../../utils/projectExporter';
import {
    getSavedSlotsStatus,
    type QuickSlotId,
} from '../../utils/localStorageCache';

// ============================================================================
// [組件] PresetManager：DJ 工作流專案 (.json) 匯出入、.m3u8 匯出、快速記憶槽 (Slot 1~3) 與寫入新的 foobar2000 播放清單控制項
// ============================================================================
export function PresetManager() {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [statusToast, setStatusToast] = useState<{
        text: string;
        type: 'success' | 'error';
    } | null>(null);
    const [slotStatus, setSlotStatus] = useState<Record<QuickSlotId, boolean>>(
        () => getSavedSlotsStatus()
    );

    // [狀態] 控制「寫入新的播放清單」浮動膠囊輸入框
    const [isWritePopoverOpen, setIsWritePopoverOpen] = useState(false);
    const [newPlaylistName, setNewPlaylistName] = useState('');
    const [isWritingPlaylist, setIsWritingPlaylist] = useState(false);

    const {
        nodes,
        playlist,
        exportProjectData,
        importProjectData,
        saveToQuickSlot,
        loadFromQuickSlot,
        resetCanvasToDefault,
    } = useWorkflowStore();
    const isLiveLocked = usePlayerStore((s) => s.isLiveLocked);
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const notifyFoobarPlaylistsChanged = usePlaylistStore(
        (s) => s.notifyFoobarPlaylistsChanged
    );

    // [輔助函式] 顯示非阻斷式狀態提示訊息（避免使用 window.alert）
    const showFeedback = (text: string, type: 'success' | 'error' = 'success') => {
        setStatusToast({ text, type });
        setTimeout(() => {
            setStatusToast((prev) => (prev?.text === text ? null : prev));
        }, 2800);
    };

    // [功能段落 1] 快速記憶槽操作 (左鍵點擊：讀取或首次寫入；Shift+點擊：強制覆寫儲存)
    const handleQuickSlotClick = (
        slotId: QuickSlotId,
        e: React.MouseEvent<HTMLButtonElement>
    ) => {
        const hasSaved = slotStatus[slotId];

        if (e.shiftKey || !hasSaved) {
            const ok = saveToQuickSlot(slotId);
            if (ok) {
                setSlotStatus(getSavedSlotsStatus());
                showFeedback(`已將當前畫布儲存至記憶槽 Slot ${slotId}`);
            } else {
                showFeedback('畫布為空，無法儲存至記憶槽', 'error');
            }
            return;
        }

        if (isLiveLocked) {
            showFeedback('演出鎖定中，無法切換記憶槽', 'error');
            return;
        }

        const loaded = loadFromQuickSlot(slotId);
        if (loaded) {
            showFeedback(`已從記憶槽 Slot ${slotId} 還原工作流`);
        } else {
            showFeedback(`記憶槽 Slot ${slotId} 尚無資料`, 'error');
        }
    };

    // [功能段落 2] 打開或關閉「寫入新的播放清單」浮動膠囊輸入框，並將計算好的 Flat Play Queue 寫入 foobar2000 新建播放清單
    const handleToggleWritePopover = () => {
        if (playlist.length === 0) {
            showFeedback('目前線性播放佇列為空，請先在畫布加入曲目卡片', 'error');
            return;
        }
        if (!isWritePopoverOpen) {
            const stamp = new Date().toISOString().slice(0, 10);
            setNewPlaylistName(`DJ Set ${stamp}`);
        }
        setIsWritePopoverOpen((prev) => !prev);
    };

    const handleConfirmWriteNewPlaylist = async () => {
        if (playlist.length === 0) {
            showFeedback('目前播放佇列為空，無法寫入播放清單', 'error');
            return;
        }
        const targetName =
            newPlaylistName.trim() ||
            `DJ Set ${new Date().toISOString().slice(0, 10)}`;

        setIsWritingPlaylist(true);
        try {
            const res = await createFoobarPlaylistWithTracks(
                targetName,
                playlist.map((item) => ({
                    trackId: item.trackId,
                    path: item.path,
                })),
                allTracks
            );
            if (res.success) {
                setIsWritePopoverOpen(false);
                notifyFoobarPlaylistsChanged();
                showFeedback(
                    `✅ 已建立播放清單「${res.name}」並寫入 ${res.addedCount} 首曲目`
                );
            } else {
                showFeedback(res.error ?? '寫入新的播放清單失敗', 'error');
            }
        } finally {
            setIsWritingPlaylist(false);
        }
    };

    // [功能段落 3] 匯出 .json 工作流專案檔（支援彈出選擇儲存位置視窗，且不記錄 Base64 封面快取與播放位置）
    const handleExportJson = async () => {
        if (nodes.length === 0) {
            showFeedback('目前畫布無節點可匯出', 'error');
            return;
        }
        const projectData = exportProjectData();
        const jsonString = JSON.stringify(projectData, null, 2);
        const dateStamp = new Date().toISOString().slice(0, 10);
        const res = await saveExportedFileWithDialog({
            title: '儲存 DJ 工作流專案檔 (.json)',
            defaultFilename: `foobar2000-dj-set-${dateStamp}.json`,
            content: jsonString,
            mimeType: 'application/json;charset=utf-8',
            description: 'DJ Workflow Project (.json)',
            extension: '.json',
        });
        if (res.canceled) return;
        if (res.saved) {
            showFeedback(
                res.filePath
                    ? `已儲存專案檔：${res.filePath}`
                    : '已匯出 .json 工作流專案檔'
            );
        } else {
            showFeedback(res.error ?? '儲存 .json 專案檔失敗', 'error');
        }
    };

    // [功能段落 4] 匯入 .json 工作流專案檔並還原畫布
    const handleImportJsonChange = async (
        e: React.ChangeEvent<HTMLInputElement>
    ) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        try {
            const rawText = await file.text();
            const parsed = parseWorkflowProjectJson(rawText);
            if (!parsed.valid || !parsed.project) {
                showFeedback(parsed.error ?? '專案檔格式無效', 'error');
                return;
            }
            importProjectData(parsed.project);
            showFeedback(
                `成功載入專案：${parsed.project.nodes.length} 張卡片、${parsed.project.edges.length} 條連線`
            );
        } catch {
            showFeedback('讀取專案檔案失敗', 'error');
        }
    };

    // [功能段落 5] 匯出標準 .m3u8 歌單檔（支援彈出選擇儲存位置視窗）
    const handleExportM3U8 = async () => {
        if (playlist.length === 0) {
            showFeedback('目前播放佇列為空，無法匯出 .m3u8', 'error');
            return;
        }
        const m3u8Content = buildM3U8Content(playlist);
        const dateStamp = new Date().toISOString().slice(0, 10);
        const res = await saveExportedFileWithDialog({
            title: '儲存 M3U8 播放清單 (.m3u8)',
            defaultFilename: `foobar2000-dj-playlist-${dateStamp}.m3u8`,
            content: m3u8Content,
            mimeType: 'audio/x-mpegurl;charset=utf-8',
            description: 'M3U8 Playlist (.m3u8)',
            extension: '.m3u8',
        });
        if (res.canceled) return;
        if (res.saved) {
            showFeedback(
                res.filePath
                    ? `已儲存 .m3u8 歌單 (${playlist.length} 首)：${res.filePath}`
                    : `已匯出 .m3u8 歌單 (${playlist.length} 首)`
            );
        } else {
            showFeedback(res.error ?? '儲存 .m3u8 歌單失敗', 'error');
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-1.5 relative">
            {/* 隱藏的 JSON 檔案上傳 Input */}
            <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportJsonChange}
                className="hidden"
            />

            {/* [方向 B] 快速記憶槽 Slot 1 ~ 3 */}
            <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg px-1.5 py-1">
                <span className="text-[10px] font-mono text-slate-400 px-1">
                    記憶槽
                </span>
                {([1, 2, 3] as QuickSlotId[]).map((slotId) => {
                    const isSaved = slotStatus[slotId];
                    return (
                        <button
                            key={slotId}
                            onClick={(e) => handleQuickSlotClick(slotId, e)}
                            className={`w-9 py-0.5 text-[10px] font-mono font-bold rounded border flex items-center justify-center gap-0.5 transition cursor-pointer ${isSaved
                                    ? 'bg-cyan-950/90 border-cyan-600/80 text-cyan-300 hover:bg-cyan-800'
                                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                }`}
                            title={
                                isSaved
                                    ? `點擊載入 Slot ${slotId}；按住 Shift 點擊可覆寫存檔`
                                    : `點擊將當前畫布存入 Slot ${slotId}`
                            }
                        >
                            <span>S{slotId}</span>
                            <span
                                className={
                                    isSaved
                                        ? 'text-cyan-400'
                                        : 'text-slate-700'
                                }
                            >
                                ●
                            </span>
                        </button>
                    );
                })}
                <button
                    disabled={isLiveLocked}
                    onClick={() => {
                        resetCanvasToDefault();
                        showFeedback('已重置畫布為預設專輯節點並清除自動快取');
                    }}
                    className="px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-rose-300 hover:bg-slate-800 rounded transition disabled:opacity-40 cursor-pointer"
                    title="重置畫布至初始預設狀態"
                >
                    ↺重置
                </button>
            </div>

            {/* [功能 1] 寫入新的播放清單按鈕 + 浮動膠囊式輸入框 */}
            <div className="relative">
                <button
                    type="button"
                    onClick={handleToggleWritePopover}
                    className={`px-2.5 py-1.5 text-xs font-semibold border rounded-lg transition cursor-pointer ${
                        isWritePopoverOpen
                            ? 'bg-emerald-700 text-white border-emerald-400 shadow-lg'
                            : 'bg-emerald-950/80 hover:bg-emerald-800/80 text-emerald-300 border-emerald-700/70'
                    }`}
                    title="將當前計算好的 Flat Play Queue 寫入 foobar2000 新建立的播放清單"
                >
                    📝 寫入新的播放清單
                </button>

                {isWritePopoverOpen && (
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-full left-0 mt-2 z-50 flex items-center gap-1.5 bg-slate-900/95 border-2 border-emerald-500/90 rounded-full px-3 py-1.5 shadow-2xl backdrop-blur-md whitespace-nowrap"
                    >
                        <span className="text-[11px] font-semibold text-emerald-300 pl-0.5">
                            清單名稱:
                        </span>
                        <input
                            type="text"
                            value={newPlaylistName}
                            onChange={(e) => setNewPlaylistName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleConfirmWriteNewPlaylist();
                                } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setIsWritePopoverOpen(false);
                                }
                            }}
                            placeholder="輸入 foobar2000 新歌單名稱..."
                            autoFocus
                            className="w-44 bg-slate-950 border border-slate-700 focus:border-emerald-400 rounded-full px-3 py-1 text-xs text-slate-100 focus:outline-none"
                        />
                        <button
                            type="button"
                            disabled={isWritingPlaylist}
                            onClick={() => void handleConfirmWriteNewPlaylist()}
                            className="px-3 py-1 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold transition cursor-pointer"
                        >
                            {isWritingPlaylist ? '寫入中...' : '確認'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsWritePopoverOpen(false)}
                            className="w-6 h-6 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center text-xs transition cursor-pointer"
                            title="取消"
                        >
                            ✕
                        </button>
                    </div>
                )}
            </div>

            <button
                disabled={isLiveLocked}
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition disabled:opacity-40 cursor-pointer"
                title="匯入先前儲存的 .json DJ 工作流專案檔"
            >
                📂 匯入 (.json)
            </button>

            <button
                onClick={handleExportJson}
                className="px-2.5 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 rounded-lg transition cursor-pointer"
                title="將當前畫布節點座標、Cue 點、Loop 與轉場設定匯出為 .json 專案檔"
            >
                💾 匯出 (.json)
            </button>

            <button
                onClick={handleExportM3U8}
                className="px-2.5 py-1.5 text-xs font-semibold bg-indigo-950/90 hover:bg-indigo-800 text-indigo-200 border border-indigo-700/70 rounded-lg transition cursor-pointer"
                title="將當前線性播放佇列匯出為標準 .m3u8 歌單檔"
            >
                🎵 匯出 (.m3u8)
            </button>

            {/* 狀態提示浮動標籤：採用 absolute 懸浮定位於工具列正下方，完全不佔用工具列排版寬度 */}
            {statusToast && (
                <div
                    className={`
                        absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 whitespace-nowrap pointer-events-none
                        px-3 py-1.5 text-[11px] font-semibold rounded-lg border shadow-2xl backdrop-blur-md transition-all
                        ${statusToast.type === 'error'
                            ? 'bg-rose-950/95 border-rose-500 text-rose-200'
                            : 'bg-cyan-950/95 border-cyan-400 text-cyan-200'
                        }
                    `}
                >
                    {statusToast.text}
                </div>
            )}
        </div>
    );
}
