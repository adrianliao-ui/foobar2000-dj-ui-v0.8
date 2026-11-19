import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import {
    getThemePresetMeta,
    isM3LayoutTheme,
    useThemeStore,
} from '../../store/useThemeStore';
import type { FoobarPlaylistSummary } from '../../api/mockBridge';
import {
    FOOBAR_PLAYABLE_EXTENSIONS,
    createBlankFoobarPlaylist,
    deleteFoobarPlaylist,
    fetchFoobarPlaylists,
    fetchMediaLibraryStatus,
    fetchTracksFromFoobarPlaylist,
    fetchTracksFromNativeFoobarHost,
    isPlayableAudioFileName,
    normalizeAudioPathForMatch,
    overwriteFoobarPlaylist,
    parseLocalAudioFilesToTracks,
    pickNativeLocalAudioTracks,
    renameFoobarPlaylist,
} from '../../api/mockBridge';
import type { Track } from '../../types/track';
import { getSuggestedNextTracks } from '../../algorithms/harmonicMixing';
import {
    extractEmbeddedCoverFromLocalAudioFile,
    registerLocalAudioFile,
} from '../../utils/waveformService';
import { InstantSearch } from './InstantSearch';
import { VirtualTrackList } from './VirtualTrackList';

const HTML_FILE_INPUT_ACCEPT = [
    'audio/*',
    ...FOOBAR_PLAYABLE_EXTENSIONS.map((ext) => `.${ext}`),
].join(',');

// ============================================================================
// [區塊 2] MediaLibrary：左側智慧媒體庫主面板容器
// 支援：1. 左上角收折按鈕
//       2a. ➕ 新建 Playlist... (於 foobar2000 建立空白歌單並同步下拉清單)
//       2b. ➕ 加入本地檔案 (支援多選音訊檔或整個資料夾，追加至當前清單)
//       2c. 💾 保存當前歌單 (覆寫當前選中的 foobar2000 Playlist，含確認視窗，Media Library 唯讀保護)
//       2d. 下拉歌單重新命名 (✏️) 與刪除 (🗑️) + 確認步驟 + 未設定 Media Library / 無任何 Playlist 邊界處理
//       2e. 單曲試聽與右側 ✕ 移除曲目
// ============================================================================
export interface MediaLibraryProps {
    isCollapsed: boolean;
    onToggleCollapse: () => void;
}

type ActiveModalMode =
    | 'none'
    | 'create_playlist'
    | 'add_local_menu'
    | 'import_from_playlist'
    | 'confirm_overwrite'
    | 'rename_playlist'
    | 'confirm_delete';

export function MediaLibrary({
    isCollapsed,
    onToggleCollapse,
}: MediaLibraryProps) {
    const {
        allTracks,
        filteredTracks,
        isLoading: isLibLoading,
        selectedTrackIds,
        selectedPlaylistValue,
        setSelectedPlaylistValue,
        playlistRefreshVersion,
        clearSelection,
        getSelectedTracks,
        focusTrackInLibrary,
        setLibraryTracksFromHost,
        appendTracksToLibrary,
    } = usePlaylistStore();

    const addTracksToCanvas = useWorkflowStore((s) => s.addTracksToCanvas);
    const workflowNodes = useWorkflowStore((s) => s.nodes);
    const isLiveLocked = usePlayerStore((s) => s.isLiveLocked);
    const currentTrack = usePlayerStore((s) => s.currentTrack);

    const filesInputRef = useRef<HTMLInputElement | null>(null);
    const folderInputRef = useRef<HTMLInputElement | null>(null);

    const [syncHint, setSyncHint] = useState<string | null>(null);
    const [foobarPlaylists, setFoobarPlaylists] = useState<
        FoobarPlaylistSummary[]
    >([]);
    const [mediaLibStatus, setMediaLibStatus] = useState<{
        isConfigured: boolean;
        count: number;
    }>({ isConfigured: true, count: 0 });

    // 浮動式互動面板狀態 (絕對定位浮層，完全不推擠下方搜尋欄與曲目列表)
    const [modalMode, setModalMode] = useState<ActiveModalMode>('none');
    const [inputText, setInputText] = useState<string>('');
    const [isBusy, setIsBusy] = useState<boolean>(false);

    // [功能 2f] 「📥 從歌單導入」面板專屬狀態：來源歌單、預覽曲目清單、勾選 ID 與過濾字詞
    const [importSourceValue, setImportSourceValue] = useState<string>('');
    const [importSourceTracks, setImportSourceTracks] = useState<Track[]>([]);
    const [isLoadingImportTracks, setIsLoadingImportTracks] =
        useState<boolean>(false);
    const [importSelectedIds, setImportSelectedIds] = useState<string[]>([]);
    const [importFilterText, setImportFilterText] = useState<string>('');

    // [修復問題 5] 根據當前播放曲目的最新 BPM 與 Camelot Key（整合媒體庫與畫布節點最新計算結果），即時計算最契合的推薦下一首清單
    const suggestedTracks = useMemo(() => {
        if (!currentTrack) return [];
        const normCurPath = normalizeAudioPathForMatch(currentTrack.path);
        const matchedLib = allTracks.find(
            (t) =>
                t.id === currentTrack.id ||
                (Boolean(normCurPath) &&
                    normalizeAudioPathForMatch(t.path) === normCurPath)
        );
        let matchedNodeTrack: Track | undefined;
        for (const node of workflowNodes) {
            const found = node.data.albumGroup.tracks.find(
                (nt) =>
                    nt.id === currentTrack.id ||
                    (Boolean(normCurPath) &&
                        normalizeAudioPathForMatch(nt.path) === normCurPath)
            );
            if (found) {
                matchedNodeTrack = found;
                break;
            }
        }
        const effectiveCurrentTrack: Track = {
            ...currentTrack,
            bpm:
                matchedLib?.bpm ||
                matchedNodeTrack?.bpm ||
                currentTrack.bpm ||
                124,
            key:
                matchedLib?.key ||
                matchedNodeTrack?.key ||
                currentTrack.key ||
                '8A',
        };
        return getSuggestedNextTracks(effectiveCurrentTrack, allTracks, {
            limit: 3,
        });
    }, [currentTrack, allTracks, workflowNodes]);

    // 取得目前下拉選單所選中的 Playlist 物件（若選中 Media Library 或無可用歌單則為 null）
    const selectedPlaylistObj = useMemo(() => {
        if (
            selectedPlaylistValue === '__ALL_LIBRARY__' ||
            selectedPlaylistValue === '__NO_PLAYLIST__' ||
            selectedPlaylistValue === '__AUTO_INIT__'
        ) {
            return null;
        }
        const idx = Number(selectedPlaylistValue);
        return foobarPlaylists.find((p) => p.index === idx) ?? null;
    }, [selectedPlaylistValue, foobarPlaylists]);

    // 判斷目前選中的項目是否可覆寫 / 可改名 / 可刪除
    const isMediaLibrarySelected =
        selectedPlaylistValue === '__ALL_LIBRARY__' ||
        selectedPlaylistValue === '__AUTO_INIT__';
    const isNoPlaylistSelected = selectedPlaylistValue === '__NO_PLAYLIST__';
    const isSelectedPlaylistLocked = Boolean(
        selectedPlaylistObj?.isLocked || selectedPlaylistObj?.isAutoplaylist
    );
    const canSaveToSelectedPlaylist =
        Boolean(selectedPlaylistObj) && !isSelectedPlaylistLocked;
    const canRenameOrDeleteSelectedPlaylist =
        Boolean(selectedPlaylistObj) && !selectedPlaylistObj?.isLocked;

    const showHint = useCallback((msg: string) => {
        setSyncHint(msg);
        window.setTimeout(() => {
            setSyncHint((prev) => (prev === msg ? null : prev));
        }, 3800);
    }, []);

    // 重新整理 Media Library 狀態與 foobar2000 Playlists 清單
    const syncPlaylistsAndLibraryStatus = useCallback(async () => {
        const [libStat, list] = await Promise.all([
            fetchMediaLibraryStatus(),
            fetchFoobarPlaylists(),
        ]);
        setMediaLibStatus(libStat);
        setFoobarPlaylists(list);
        return { libStat, list };
    }, []);

    // 初始化與當 Header「寫入新的播放清單」觸發版本號更新時，自動同步下拉清單並保持現有選取狀態（防止最小化還原後跳回 Media Library）
    useEffect(() => {
        let isMounted = true;
        void (async () => {
            const { libStat, list } = await syncPlaylistsAndLibraryStatus();
            if (!isMounted) return;

            const currentVal = usePlaylistStore.getState().selectedPlaylistValue;
            const currentTracks = usePlaylistStore.getState().allTracks;

            // 1. 若先前已選中某個有效 Playlist 索引，保持選取該 Playlist；若記憶體曲目剛好為空則自動從該 Playlist 補載曲目
            if (
                currentVal !== '__ALL_LIBRARY__' &&
                currentVal !== '__NO_PLAYLIST__' &&
                currentVal !== '__AUTO_INIT__' &&
                list.some((p) => String(p.index) === currentVal)
            ) {
                if (currentTracks.length === 0) {
                    const plTracks = await fetchTracksFromFoobarPlaylist(
                        Number(currentVal)
                    );
                    if (isMounted && plTracks && plTracks.length > 0) {
                        setLibraryTracksFromHost(plTracks);
                    }
                }
                return;
            }

            // 2. 若使用者先前明確選中 __ALL_LIBRARY__ 且 Media Library 有曲目，維持 __ALL_LIBRARY__
            if (
                currentVal === '__ALL_LIBRARY__' &&
                libStat.isConfigured &&
                libStat.count > 0
            ) {
                return;
            }

            // 3. 初次啟動 (__AUTO_INIT__) 或原選取項目已不存在時：
            if (libStat.isConfigured && libStat.count > 0) {
                setSelectedPlaylistValue('__ALL_LIBRARY__');
                return;
            }

            // [2d 情境 A] Media Library 未設定 (0 首)，但有已建立的 Playlist：自動定位至活動中或第一個 Playlist 並載入曲目
            if (list.length > 0) {
                const target = list.find((p) => p.isActive) ?? list[0];
                const nextVal = String(target.index);
                setSelectedPlaylistValue(nextVal);
                if (currentTracks.length === 0) {
                    const plTracks = await fetchTracksFromFoobarPlaylist(
                        target.index
                    );
                    if (isMounted && plTracks) {
                        setLibraryTracksFromHost(plTracks);
                    }
                }
                return;
            }

            // [2d 情境 B] 既無任何 Playlist，同時又沒有設定 Media Library：進入無可用歌單狀態
            setSelectedPlaylistValue('__NO_PLAYLIST__');
        })();
        return () => {
            isMounted = false;
        };
    }, [
        playlistRefreshVersion,
        syncPlaylistsAndLibraryStatus,
        setSelectedPlaylistValue,
        setLibraryTracksFromHost,
    ]);

    // 當使用者從下拉清單切換歌單或 Media Library 時載入對應曲目
    const handleSelectFoobarPlaylist = async (value: string) => {
        setModalMode('none');
        setSelectedPlaylistValue(value);

        if (value === '__NO_PLAYLIST__') {
            setLibraryTracksFromHost([]);
            return;
        }

        if (value === '__ALL_LIBRARY__') {
            const libStat = await fetchMediaLibraryStatus();
            setMediaLibStatus(libStat);
            if (!libStat.isConfigured || libStat.count === 0) {
                setLibraryTracksFromHost([]);
                showHint(
                    '⚠️ foobar2000 尚未設定媒體庫資料夾（0 首）。請切換至其他 Playlist 或點擊「➕ 新建 Playlist...」'
                );
                return;
            }
            const hostTracks = await fetchTracksFromNativeFoobarHost();
            const safeTracks = hostTracks ?? [];
            setLibraryTracksFromHost(safeTracks);
            showHint(`✅ 已載入全部媒體庫（共 ${safeTracks.length} 首）`);
            return;
        }

        const plIndex = Number(value);
        if (!Number.isFinite(plIndex) || plIndex < 0) return;

        const targetPl = foobarPlaylists.find((p) => p.index === plIndex);
        const plName = targetPl?.name ?? `Playlist #${plIndex + 1}`;

        const plTracks = await fetchTracksFromFoobarPlaylist(plIndex);
        const safeTracks = plTracks ?? [];
        setLibraryTracksFromHost(safeTracks);
        if (safeTracks.length > 0) {
            showHint(
                `✅ 已導入播放清單「${plName}」（共 ${safeTracks.length} 首）`
            );
        } else {
            showHint(
                `ℹ️ 播放清單「${plName}」目前為空白（0 首），可點擊「➕ 加入本地檔案」追加曲目`
            );
        }
    };

    // ========================================================================
    // [功能 2a] ➕ 新建 Playlist... (建立空白 Playlist 並切換至該歌單)
    // ========================================================================
    const handleOpenCreatePlaylist = () => {
        if (modalMode === 'create_playlist') {
            setModalMode('none');
            return;
        }
        setInputText(`New Playlist ${foobarPlaylists.length + 1}`);
        setModalMode('create_playlist');
    };

    const handleConfirmCreatePlaylist = async () => {
        const name = inputText.trim() || `New Playlist ${foobarPlaylists.length + 1}`;
        setIsBusy(true);
        try {
            const res = await createBlankFoobarPlaylist(name);
            if (!res.success) {
                showHint(`❌ ${res.error ?? '建立空白播放清單失敗'}`);
                return;
            }
            const { list } = await syncPlaylistsAndLibraryStatus();
            const createdPl =
                (typeof res.index === 'number'
                    ? list.find((p) => p.index === res.index)
                    : undefined) ?? list[list.length - 1];

            if (createdPl) {
                setSelectedPlaylistValue(String(createdPl.index));
            }
            setLibraryTracksFromHost([]);
            setModalMode('none');
            showHint(
                `✅ 已於 foobar2000 建立空白播放清單「${res.name}」（可加入本地檔案後點擊保存）`
            );
        } finally {
            setIsBusy(false);
        }
    };

    // ========================================================================
    // [功能 2b] ➕ 加入本地檔案 (支援多選檔案或整個資料夾，追加進當前清單)
    // ========================================================================
    const appendImportedTracksWithFallbackPlaylist = async (
        importedTracks: Track[],
        sourceLabel: string
    ) => {
        if (importedTracks.length === 0) {
            showHint('⚠️ 未偵測到 foobar2000 可播放的音訊檔案格式');
            return;
        }

        // [2d 情境 B 自動恢復] 若目前無任何 Playlist 且未設定 Media Library，自動建立一個 Default 播放清單承接檔案
        if (selectedPlaylistValue === '__NO_PLAYLIST__') {
            const created = await createBlankFoobarPlaylist('Default');
            const { list } = await syncPlaylistsAndLibraryStatus();
            if (created.success && list.length > 0) {
                const target =
                    list.find((p) => p.index === created.index) ?? list[0];
                setSelectedPlaylistValue(String(target.index));
            }
        }

        const addedCount = appendTracksToLibrary(importedTracks);
        setModalMode('none');

        if (addedCount > 0) {
            const skipped = importedTracks.length - addedCount;
            showHint(
                `✅ 已從${sourceLabel}追加 ${addedCount} 首曲目至當前清單${
                    skipped > 0 ? `（略過 ${skipped} 首重複曲目）` : ''
                }！`
            );
        } else {
            showHint('ℹ️ 所選曲目皆已在當前智慧媒體庫清單中（未重複加入）');
        }
    };

    const handlePickLocalFiles = async (mode: 'files' | 'folder') => {
        setIsBusy(true);
        try {
            const nativeRes = await pickNativeLocalAudioTracks(mode);
            if (nativeRes.supported) {
                if (!nativeRes.cancelled) {
                    await appendImportedTracksWithFallbackPlaylist(
                        nativeRes.tracks,
                        mode === 'files' ? '本地檔案' : '本地資料夾'
                    );
                } else {
                    setModalMode('none');
                }
                return;
            }
        } finally {
            setIsBusy(false);
        }

        // 瀏覽器環境或原生對話框未啟用時，使用 HTML <input type="file">
        if (mode === 'files') {
            filesInputRef.current?.click();
        } else {
            folderInputRef.current?.click();
        }
    };

    const handleHtmlAudioFilesSelected = async (
        e: React.ChangeEvent<HTMLInputElement>,
        sourceLabel: string
    ) => {
        const fileList = e.target.files;
        if (!fileList || fileList.length === 0) return;
        const rawFiles = Array.from(fileList);
        const validFiles = rawFiles.filter(
            (f) => f.type.startsWith('audio/') || isPlayableAudioFileName(f.name)
        );
        const tracks = parseLocalAudioFilesToTracks(validFiles);
        tracks.forEach((tr, idx) => {
            const fileObj = validFiles[idx];
            if (fileObj) {
                registerLocalAudioFile(tr.path, tr.id, fileObj);
                void extractEmbeddedCoverFromLocalAudioFile(fileObj).then(
                    (coverDataUrl) => {
                        if (coverDataUrl) {
                            usePlaylistStore
                                .getState()
                                .updateTrackComputedMeta(tr.id, tr.path, {
                                    coverUrl: coverDataUrl,
                                });
                        }
                    }
                );
            }
        });
        e.target.value = '';
        await appendImportedTracksWithFallbackPlaylist(tracks, sourceLabel);
    };

    // ========================================================================
    // [功能 2f] 📥 從歌單導入 (從已建立的 Playlist 導入全部或勾選的多首曲目，追加至當前清單)
    // ========================================================================
    const loadTracksForImportSource = useCallback(async (sourceVal: string) => {
        if (!sourceVal) {
            setImportSourceTracks([]);
            setImportSelectedIds([]);
            return;
        }
        setIsLoadingImportTracks(true);
        try {
            if (sourceVal === '__ALL_LIBRARY__') {
                const libTracks =
                    (await fetchTracksFromNativeFoobarHost()) ?? [];
                setImportSourceTracks(libTracks);
                setImportSelectedIds(libTracks.map((t) => t.id));
                return;
            }
            const plIdx = Number(sourceVal);
            if (Number.isFinite(plIdx) && plIdx >= 0) {
                const plTracks =
                    (await fetchTracksFromFoobarPlaylist(plIdx)) ?? [];
                setImportSourceTracks(plTracks);
                setImportSelectedIds(plTracks.map((t) => t.id));
            }
        } finally {
            setIsLoadingImportTracks(false);
        }
    }, []);

    const handleOpenImportFromPlaylist = async () => {
        if (modalMode === 'import_from_playlist') {
            setModalMode('none');
            return;
        }
        setImportFilterText('');
        setModalMode('import_from_playlist');
        const { libStat, list } = await syncPlaylistsAndLibraryStatus();

        // 預設挑選一個與當前選中歌單不同的已建立 Playlist，若無則選第一個 Playlist 或全部媒體庫
        const otherPl =
            list.find((p) => String(p.index) !== selectedPlaylistValue) ??
            list[0];
        const defaultSource = otherPl
            ? String(otherPl.index)
            : libStat.isConfigured && libStat.count > 0
              ? '__ALL_LIBRARY__'
              : '';
        setImportSourceValue(defaultSource);
        await loadTracksForImportSource(defaultSource);
    };

    const handleChangeImportSource = async (nextVal: string) => {
        setImportSourceValue(nextVal);
        await loadTracksForImportSource(nextVal);
    };

    const filteredImportTracks = useMemo(() => {
        const q = importFilterText.trim().toLowerCase();
        if (!q) return importSourceTracks;
        return importSourceTracks.filter(
            (t) =>
                t.title.toLowerCase().includes(q) ||
                t.artist.toLowerCase().includes(q) ||
                t.album.toLowerCase().includes(q)
        );
    }, [importSourceTracks, importFilterText]);

    const handleToggleImportTrackId = (trackId: string) => {
        setImportSelectedIds((prev) =>
            prev.includes(trackId)
                ? prev.filter((id) => id !== trackId)
                : [...prev, trackId]
        );
    };

    const handleToggleSelectAllImportTracks = () => {
        const visibleIds = filteredImportTracks.map((t) => t.id);
        const allVisibleSelected =
            visibleIds.length > 0 &&
            visibleIds.every((id) => importSelectedIds.includes(id));
        if (allVisibleSelected) {
            const visibleSet = new Set(visibleIds);
            setImportSelectedIds((prev) =>
                prev.filter((id) => !visibleSet.has(id))
            );
        } else {
            setImportSelectedIds((prev) =>
                Array.from(new Set([...prev, ...visibleIds]))
            );
        }
    };

    const getImportSourceLabel = (): string => {
        if (importSourceValue === '__ALL_LIBRARY__') {
            return '全部媒體庫';
        }
        const pl = foobarPlaylists.find(
            (p) => String(p.index) === importSourceValue
        );
        return pl ? `歌單「${pl.name}」` : '來源歌單';
    };

    const handleConfirmImportAllFromPlaylist = async () => {
        if (importSourceTracks.length === 0) return;
        await appendImportedTracksWithFallbackPlaylist(
            importSourceTracks,
            getImportSourceLabel()
        );
    };

    const handleConfirmImportSelectedFromPlaylist = async () => {
        const idSet = new Set(importSelectedIds);
        const chosen = importSourceTracks.filter((t) => idSet.has(t.id));
        if (chosen.length === 0) {
            showHint('⚠️ 請至少勾選 1 首要導入的曲目');
            return;
        }
        await appendImportedTracksWithFallbackPlaylist(
            chosen,
            getImportSourceLabel()
        );
    };

    // ========================================================================
    // [功能 2c] 💾 保存當前歌單 (覆寫選中的 foobar2000 Playlist，含確認視窗)
    // ========================================================================
    const handleOpenSaveConfirm = () => {
        if (!canSaveToSelectedPlaylist || !selectedPlaylistObj) return;
        if (modalMode === 'confirm_overwrite') {
            setModalMode('none');
            return;
        }
        setModalMode('confirm_overwrite');
    };

    const handleConfirmOverwritePlaylist = async () => {
        if (!selectedPlaylistObj) return;
        setIsBusy(true);
        try {
            const res = await overwriteFoobarPlaylist(
                selectedPlaylistObj.index,
                allTracks
            );
            if (res.success) {
                await syncPlaylistsAndLibraryStatus();
                setModalMode('none');
                showHint(
                    `✅ 已將當前 ${allTracks.length} 首曲目覆寫保存至播放清單「${selectedPlaylistObj.name}」！`
                );
            } else {
                showHint(`❌ ${res.error ?? '覆寫保存播放清單失敗'}`);
            }
        } finally {
            setIsBusy(false);
        }
    };

    // ========================================================================
    // [功能 2d] 重新命名 (✏️) 與刪除 (🗑️) 下拉選單中的 foobar2000 Playlist
    // ========================================================================
    const handleOpenRenameModal = () => {
        if (!canRenameOrDeleteSelectedPlaylist || !selectedPlaylistObj) return;
        if (modalMode === 'rename_playlist') {
            setModalMode('none');
            return;
        }
        setInputText(selectedPlaylistObj.name);
        setModalMode('rename_playlist');
    };

    const handleConfirmRenamePlaylist = async () => {
        if (!selectedPlaylistObj) return;
        const cleanName = inputText.trim();
        if (!cleanName) {
            showHint('⚠️ 播放清單名稱不可為空白');
            return;
        }
        setIsBusy(true);
        try {
            const oldName = selectedPlaylistObj.name;
            const res = await renameFoobarPlaylist(
                selectedPlaylistObj.index,
                cleanName
            );
            if (res.success) {
                await syncPlaylistsAndLibraryStatus();
                setModalMode('none');
                showHint(`✅ 已將歌單「${oldName}」重新命名為「${cleanName}」`);
            } else {
                showHint(`❌ ${res.error ?? '重新命名失敗'}`);
            }
        } finally {
            setIsBusy(false);
        }
    };

    const handleOpenDeleteModal = () => {
        if (!canRenameOrDeleteSelectedPlaylist || !selectedPlaylistObj) return;
        if (modalMode === 'confirm_delete') {
            setModalMode('none');
            return;
        }
        setModalMode('confirm_delete');
    };

    const handleConfirmDeletePlaylist = async () => {
        if (!selectedPlaylistObj) return;
        const deletedName = selectedPlaylistObj.name;
        const deletedPosInArray = foobarPlaylists.findIndex(
            (p) => p.index === selectedPlaylistObj.index
        );

        setIsBusy(true);
        try {
            const res = await deleteFoobarPlaylist(selectedPlaylistObj.index);
            if (!res.success) {
                showHint(`❌ ${res.error ?? '刪除播放清單失敗'}`);
                return;
            }

            const { libStat, list: remainingPlaylists } =
                await syncPlaylistsAndLibraryStatus();
            setModalMode('none');

            // [2d 情境 A] 若刪除後仍有其他可用 Playlist，自動切換至相鄰的 Playlist 並載入其曲目（絕不跳去未設定的空媒體庫）
            if (remainingPlaylists.length > 0) {
                const nextPos = Math.max(
                    0,
                    Math.min(
                        deletedPosInArray >= 0 ? deletedPosInArray : 0,
                        remainingPlaylists.length - 1
                    )
                );
                const nextPl = remainingPlaylists[nextPos];
                setSelectedPlaylistValue(String(nextPl.index));
                const nextTracks =
                    (await fetchTracksFromFoobarPlaylist(nextPl.index)) ?? [];
                setLibraryTracksFromHost(nextTracks);
                showHint(
                    `🗑️ 已刪除歌單「${deletedName}」，已自動切換至「${nextPl.name}」`
                );
                return;
            }

            // 若已無任何 Playlist，檢查 Media Library 是否有設定曲目
            if (libStat.isConfigured && libStat.count > 0) {
                setSelectedPlaylistValue('__ALL_LIBRARY__');
                const libTracks =
                    (await fetchTracksFromNativeFoobarHost()) ?? [];
                setLibraryTracksFromHost(libTracks);
                showHint(
                    `🗑️ 已刪除歌單「${deletedName}」，已切換回全部媒體庫（${libTracks.length} 首）`
                );
                return;
            }

            // [2d 情境 B] 已無任何 Playlist 且未設定 Media Library (0 首)：清空智慧媒體庫列表並進入無可用歌單狀態
            setSelectedPlaylistValue('__NO_PLAYLIST__');
            setLibraryTracksFromHost([]);
            showHint(
                `🗑️ 已刪除歌單「${deletedName}」。目前無任何可用歌單且媒體庫未設定`
            );
        } finally {
            setIsBusy(false);
        }
    };

    const themeId = useThemeStore((s) => s.themeId);
    const activeThemeMeta = getThemePresetMeta(themeId);

    // [收折狀態] 渲染窄型側邊停靠條，釋放空間給中央畫布
    if (isCollapsed) {
        return (
            <div className="dj-surface-panel w-full lg:w-11 shrink-0 bg-slate-900 border border-slate-800 rounded-xl p-2 flex lg:flex-col items-center justify-between gap-3 transition-all duration-200">
                <button
                    onClick={onToggleCollapse}
                    className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-slate-700 flex items-center justify-center text-xs font-bold transition cursor-pointer shrink-0"
                    title="展開左側智慧媒體庫"
                >
                    ▶
                </button>

                <div
                    onClick={onToggleCollapse}
                    className="text-xs font-semibold text-cyan-400 tracking-widest lg:[writing-mode:vertical-rl] cursor-pointer select-none py-2"
                    title="點擊展開智慧媒體庫"
                >
                    🗂️ 智慧媒體庫 ({filteredTracks.length})
                </div>

                <div className="text-[10px] font-mono text-slate-500 hidden lg:block">
                    LIB
                </div>
            </div>
        );
    }

    const selectDropdownValue =
        selectedPlaylistValue === '__AUTO_INIT__'
            ? '__ALL_LIBRARY__'
            : selectedPlaylistValue;

    // [展開狀態] 完整智慧媒體庫面板
    return (
        <div
            className={`dj-surface-panel relative ${activeThemeMeta.layoutSpec.libWidthClass} shrink-0 h-full min-h-0 bg-slate-900 border border-slate-800 rounded-xl ${
                isM3LayoutTheme(themeId) ? 'p-2.5 gap-1.5' : 'p-3 gap-2'
            } flex flex-col transition-all duration-200`}
        >
            {/* 頂部標題列：收折按鈕置於左上角 */}
            <div className="flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <button
                        onClick={onToggleCollapse}
                        className="px-2 py-0.5 text-[11px] font-semibold bg-slate-800 hover:bg-cyan-600 text-slate-300 hover:text-white border border-slate-700 rounded-md transition cursor-pointer shrink-0"
                        title="向左收折智慧媒體庫以擴大畫布空間"
                    >
                        ◀ 收折
                    </button>
                    <h2 className="text-xs font-semibold text-cyan-400 truncate">
                        🗂️ 智慧媒體庫 (支援拖放與多選)
                    </h2>
                </div>
                <span className="text-[11px] text-slate-400 shrink-0 font-mono">
                    {isLibLoading
                        ? '讀取中...'
                        : `共 ${filteredTracks.length} 首`}
                </span>
            </div>

            {/* 頂部操作與歌單選擇定位錨點容器 (設為 relative，讓確認視窗與提示框以 absolute 懸浮於下方，絕不擠壓版面) */}
            <div className="relative flex flex-col gap-2 shrink-0">
                {/* [2a / 2b / 2f / 2c] 頂部四合一操作按鈕列：+新建 Playlist... / 加入本地檔案 / 從歌單導入 / 保存當前歌單 */}
                <div className="grid grid-cols-2 gap-1.5">
                    <button
                        type="button"
                        disabled={isLiveLocked || isBusy}
                        onClick={handleOpenCreatePlaylist}
                        className={`px-2 py-1.5 rounded-md border text-[11px] font-semibold transition cursor-pointer truncate disabled:opacity-40 ${
                            modalMode === 'create_playlist'
                                ? 'bg-cyan-600 border-cyan-400 text-white'
                                : 'bg-cyan-950/60 hover:bg-cyan-700 border-cyan-700/60 text-cyan-300 hover:text-white'
                        }`}
                        title="在 foobar2000 內建立新的空白 Playlist 並同步更新歌單下拉選單"
                    >
                        ➕ 新建 Playlist...
                    </button>

                    <button
                        type="button"
                        disabled={isLiveLocked || isBusy}
                        onClick={() =>
                            setModalMode((prev) =>
                                prev === 'add_local_menu'
                                    ? 'none'
                                    : 'add_local_menu'
                            )
                        }
                        className={`px-2 py-1.5 rounded-md border text-[11px] font-semibold transition cursor-pointer truncate disabled:opacity-40 ${
                            modalMode === 'add_local_menu'
                                ? 'bg-indigo-600 border-indigo-400 text-white'
                                : 'bg-slate-800 hover:bg-indigo-600 border-slate-700 text-slate-200 hover:text-white'
                        }`}
                        title="選擇本機多個音訊檔案或整個資料夾，追加入當前的智慧媒體庫清單"
                    >
                        ➕ 加入本地檔案
                    </button>

                    <button
                        type="button"
                        disabled={isLiveLocked || isBusy}
                        onClick={() => void handleOpenImportFromPlaylist()}
                        className={`px-2 py-1.5 rounded-md border text-[11px] font-semibold transition cursor-pointer truncate disabled:opacity-40 ${
                            modalMode === 'import_from_playlist'
                                ? 'bg-violet-600 border-violet-400 text-white'
                                : 'bg-violet-950/60 hover:bg-violet-700 border-violet-700/60 text-violet-200 hover:text-white'
                        }`}
                        title="從已建立的 foobar2000 Playlist 中導入全部曲目或勾選的多首曲目，追加至當前清單"
                    >
                        📥 從歌單導入
                    </button>

                    <button
                        type="button"
                        disabled={
                            isLiveLocked || isBusy || !canSaveToSelectedPlaylist
                        }
                        onClick={handleOpenSaveConfirm}
                        className={`px-2 py-1.5 rounded-md border text-[11px] font-semibold transition truncate ${
                            !canSaveToSelectedPlaylist
                                ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                                : modalMode === 'confirm_overwrite'
                                  ? 'bg-emerald-600 border-emerald-400 text-white cursor-pointer'
                                  : 'bg-emerald-950/70 hover:bg-emerald-700 border-emerald-700/70 text-emerald-300 hover:text-white cursor-pointer'
                        }`}
                        title={
                            isMediaLibrarySelected
                                ? 'foobar2000 Media Library 為唯讀曲庫，不可覆寫；請先於下方切換或新建 Playlist'
                                : isNoPlaylistSelected
                                  ? '目前無可用歌單，請先點擊「➕ 新建 Playlist...」'
                                  : isSelectedPlaylistLocked
                                    ? '此歌單為鎖定或自動播放清單 (Autoplaylist)，不可覆寫'
                                    : `將當前智慧媒體庫清單 (${allTracks.length} 首) 覆寫保存至「${selectedPlaylistObj?.name}」`
                        }
                    >
                        💾 保存當前歌單
                    </button>

                    {/* 隱藏的 HTML 多檔案與資料夾選取器 (供瀏覽器或備援使用) */}
                    <input
                        ref={filesInputRef}
                        type="file"
                        multiple
                        accept={HTML_FILE_INPUT_ACCEPT}
                        onChange={(e) =>
                            void handleHtmlAudioFilesSelected(e, '本地檔案')
                        }
                        className="hidden"
                    />
                    <input
                        ref={folderInputRef}
                        type="file"
                        multiple
                        // @ts-expect-error webkitdirectory 為標準瀏覽器與 WebView2 支援之資料夾選取屬性
                        webkitdirectory=""
                        accept={HTML_FILE_INPUT_ACCEPT}
                        onChange={(e) =>
                            void handleHtmlAudioFilesSelected(e, '本地資料夾')
                        }
                        className="hidden"
                    />
                </div>

                {/* [2d] foobar2000 本機播放清單 (Playlist) 下拉選單 + 重新命名 (✏️) / 刪除 (🗑️) / 重整 (↻) */}
                <div className="flex items-center gap-1 bg-slate-950/80 border border-slate-800 rounded-lg px-2 py-1.5">
                    <span className="text-[11px] font-semibold text-slate-400 shrink-0">
                        📋 歌單:
                    </span>
                    <select
                        value={selectDropdownValue}
                        onChange={(e) =>
                            void handleSelectFoobarPlaylist(e.target.value)
                        }
                        className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
                        title="選擇並導入 foobar2000 本機媒體庫或已建立的播放清單 (Playlist)"
                    >
                        {isNoPlaylistSelected && (
                            <option value="__NO_PLAYLIST__">
                                ⚠️ 無可用歌單（媒體庫未設定）
                            </option>
                        )}
                        <option value="__ALL_LIBRARY__">
                            {mediaLibStatus.isConfigured &&
                            mediaLibStatus.count > 0
                                ? `📚 全部媒體庫 (Media Library • ${mediaLibStatus.count} 首)`
                                : '📚 全部媒體庫 (未設定 / 0 首)'}
                        </option>
                        {foobarPlaylists.map((pl) => (
                            <option
                                key={`${pl.index}-${pl.name}`}
                                value={String(pl.index)}
                            >
                                🎵 {pl.name} ({pl.trackCount} 首)
                                {pl.isAutoplaylist ? ' [Auto]' : ''}
                            </option>
                        ))}
                    </select>

                    {/* [2d] 重新命名按鈕 */}
                    <button
                        type="button"
                        disabled={
                            isLiveLocked ||
                            isBusy ||
                            !canRenameOrDeleteSelectedPlaylist
                        }
                        onClick={handleOpenRenameModal}
                        className="px-1.5 py-1 rounded bg-slate-800 hover:bg-amber-600 disabled:opacity-35 disabled:hover:bg-slate-800 border border-slate-700 text-slate-200 hover:text-white text-[10px] transition cursor-pointer disabled:cursor-not-allowed shrink-0"
                        title={
                            canRenameOrDeleteSelectedPlaylist
                                ? `重新命名播放清單「${selectedPlaylistObj?.name}」`
                                : '請先選擇一個可編輯的 foobar2000 播放清單'
                        }
                    >
                        ✏️
                    </button>

                    {/* [2d] 刪除歌單按鈕 */}
                    <button
                        type="button"
                        disabled={
                            isLiveLocked ||
                            isBusy ||
                            !canRenameOrDeleteSelectedPlaylist
                        }
                        onClick={handleOpenDeleteModal}
                        className="px-1.5 py-1 rounded bg-slate-800 hover:bg-rose-600 disabled:opacity-35 disabled:hover:bg-slate-800 border border-slate-700 text-slate-200 hover:text-white text-[10px] transition cursor-pointer disabled:cursor-not-allowed shrink-0"
                        title={
                            canRenameOrDeleteSelectedPlaylist
                                ? `刪除播放清單「${selectedPlaylistObj?.name}」`
                                : '請先選擇一個可刪除的 foobar2000 播放清單'
                        }
                    >
                        🗑️
                    </button>

                    <button
                        type="button"
                        onClick={() => void syncPlaylistsAndLibraryStatus()}
                        className="px-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[10px] transition cursor-pointer shrink-0"
                        title="重新整理 foobar2000 播放清單與媒體庫狀態"
                    >
                        ↻
                    </button>
                </div>

                {/* ================================================================
                    [問題 8 修正] 浮動式互動確認框與狀態消息框 (absolute top-full z-50)
                    懸浮於歌單選單正下方，出現與消失時完全不影響下方搜尋欄與列表排版！
                   ================================================================ */}
                {(modalMode !== 'none' || syncHint) && (
                    <div className="absolute left-0 right-0 top-full mt-1.5 z-50 flex flex-col gap-1.5 pointer-events-auto">
                        {modalMode === 'create_playlist' && (
                            <div className="bg-slate-950/95 backdrop-blur-md border border-cyan-500/80 rounded-xl p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.85)] flex flex-col gap-1.5">
                                <div className="text-[11px] font-semibold text-cyan-300">
                                    ➕ 在 foobar2000 建立新的空白 Playlist
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <input
                                        type="text"
                                        value={inputText}
                                        onChange={(e) =>
                                            setInputText(e.target.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                void handleConfirmCreatePlaylist();
                                            } else if (e.key === 'Escape') {
                                                setModalMode('none');
                                            }
                                        }}
                                        placeholder="輸入新播放清單名稱..."
                                        autoFocus
                                        className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-cyan-400 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() =>
                                            void handleConfirmCreatePlaylist()
                                        }
                                        className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold cursor-pointer shrink-0"
                                    >
                                        建立
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setModalMode('none')}
                                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer shrink-0"
                                    >
                                        取消
                                    </button>
                                </div>
                            </div>
                        )}

                        {modalMode === 'add_local_menu' && (
                            <div className="bg-slate-950/95 backdrop-blur-md border border-indigo-500/80 rounded-xl p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.85)] flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-semibold text-indigo-300">
                                        ➕ 選擇追加至當前清單的方式（不清空現有曲目）
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setModalMode('none')}
                                        className="text-xs text-slate-400 hover:text-white cursor-pointer"
                                    >
                                        ✕
                                    </button>
                                </div>
                                <div className="grid grid-cols-2 gap-1.5">
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() =>
                                            void handlePickLocalFiles('files')
                                        }
                                        className="px-2.5 py-1.5 rounded bg-indigo-950/90 hover:bg-indigo-600 border border-indigo-700/70 text-indigo-200 hover:text-white text-[11px] font-semibold transition cursor-pointer"
                                    >
                                        📄 選取音訊檔案 (可多選)
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() =>
                                            void handlePickLocalFiles('folder')
                                        }
                                        className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-indigo-600 border border-slate-700 text-slate-200 hover:text-white text-[11px] font-semibold transition cursor-pointer"
                                    >
                                        📁 選取整個資料夾
                                    </button>
                                </div>
                            </div>
                        )}

                        {modalMode === 'import_from_playlist' && (
                            <div className="bg-slate-950/95 backdrop-blur-md border border-violet-500/85 rounded-xl p-2.5 shadow-[0_14px_32px_rgba(0,0,0,0.9)] flex flex-col gap-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-semibold text-violet-300">
                                        📥 從已建立的歌單導入曲目（追加至當前清單）
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setModalMode('none')}
                                        className="text-xs text-slate-400 hover:text-white cursor-pointer"
                                    >
                                        ✕
                                    </button>
                                </div>

                                {/* 步驟 1：選擇來源歌單下拉選單 */}
                                <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] font-semibold text-slate-400 shrink-0">
                                        來源歌單:
                                    </span>
                                    <select
                                        value={importSourceValue}
                                        onChange={(e) =>
                                            void handleChangeImportSource(
                                                e.target.value
                                            )
                                        }
                                        className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-violet-400 rounded px-2 py-1 text-[11px] text-slate-100 focus:outline-none cursor-pointer"
                                    >
                                        {foobarPlaylists.length === 0 &&
                                            (!mediaLibStatus.isConfigured ||
                                                mediaLibStatus.count === 0) && (
                                                <option value="">
                                                    ⚠️ 尚無可導入的歌單
                                                </option>
                                            )}
                                        {foobarPlaylists.map((pl) => (
                                            <option
                                                key={`imp-${pl.index}-${pl.name}`}
                                                value={String(pl.index)}
                                            >
                                                🎵 {pl.name} ({pl.trackCount} 首)
                                            </option>
                                        ))}
                                        {mediaLibStatus.isConfigured &&
                                            mediaLibStatus.count > 0 && (
                                                <option value="__ALL_LIBRARY__">
                                                    📚 全部媒體庫 (Media Library •{' '}
                                                    {mediaLibStatus.count} 首)
                                                </option>
                                            )}
                                    </select>
                                </div>

                                {/* 步驟 2：快速過濾與全選/取消全選 */}
                                <div className="flex items-center gap-1.5">
                                    <input
                                        type="text"
                                        value={importFilterText}
                                        onChange={(e) =>
                                            setImportFilterText(e.target.value)
                                        }
                                        placeholder="🔍 搜尋來源歌單曲名 / 演出者..."
                                        className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-violet-400 rounded px-2 py-1 text-[11px] text-slate-100 focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={
                                            handleToggleSelectAllImportTracks
                                        }
                                        disabled={
                                            filteredImportTracks.length === 0
                                        }
                                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-semibold text-slate-200 cursor-pointer shrink-0 disabled:opacity-40"
                                    >
                                        {filteredImportTracks.length > 0 &&
                                        filteredImportTracks.every((t) =>
                                            importSelectedIds.includes(t.id)
                                        )
                                            ? '取消全選'
                                            : '全選'}
                                    </button>
                                </div>

                                {/* 曲目多選勾選列表 */}
                                <div className="max-h-48 overflow-y-auto bg-slate-900/90 border border-slate-800 rounded-lg divide-y divide-slate-800/70">
                                    {isLoadingImportTracks ? (
                                        <div className="p-4 text-center text-[11px] text-slate-400">
                                            正在讀取歌單曲目...
                                        </div>
                                    ) : filteredImportTracks.length === 0 ? (
                                        <div className="p-4 text-center text-[11px] text-slate-500">
                                            此歌單目前沒有符合的曲目
                                        </div>
                                    ) : (
                                        filteredImportTracks.map((tr) => {
                                            const checked =
                                                importSelectedIds.includes(
                                                    tr.id
                                                );
                                            return (
                                                <label
                                                    key={tr.id}
                                                    className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer transition text-[11px] ${
                                                        checked
                                                            ? 'bg-violet-950/40 text-slate-100'
                                                            : 'hover:bg-slate-800/60 text-slate-300'
                                                    }`}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() =>
                                                            handleToggleImportTrackId(
                                                                tr.id
                                                            )
                                                        }
                                                        className="accent-violet-500 rounded cursor-pointer shrink-0"
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-semibold truncate">
                                                            {tr.title}
                                                        </div>
                                                        <div className="text-[10px] text-slate-400 truncate">
                                                            {tr.artist} •{' '}
                                                            {tr.album}
                                                        </div>
                                                    </div>
                                                    <span className="text-[10px] font-mono text-cyan-400 shrink-0">
                                                        {tr.bpm} BPM • {tr.key}
                                                    </span>
                                                </label>
                                            );
                                        })
                                    )}
                                </div>

                                {/* 底部操作：導入全部曲目 vs 導入勾選的多首曲目 */}
                                <div className="flex items-center justify-between gap-1.5 pt-0.5">
                                    <button
                                        type="button"
                                        disabled={
                                            isBusy ||
                                            isLoadingImportTracks ||
                                            importSourceTracks.length === 0
                                        }
                                        onClick={() =>
                                            void handleConfirmImportAllFromPlaylist()
                                        }
                                        className="flex-1 px-2.5 py-1.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-[11px] font-bold transition cursor-pointer truncate"
                                    >
                                        📥 導入全部 ({importSourceTracks.length}{' '}
                                        首)
                                    </button>
                                    <button
                                        type="button"
                                        disabled={
                                            isBusy ||
                                            isLoadingImportTracks ||
                                            importSelectedIds.length === 0
                                        }
                                        onClick={() =>
                                            void handleConfirmImportSelectedFromPlaylist()
                                        }
                                        className="flex-1 px-2.5 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[11px] font-bold transition cursor-pointer truncate"
                                    >
                                        ➕ 導入已選 ({importSelectedIds.length}{' '}
                                        首)
                                    </button>
                                </div>
                            </div>
                        )}

                        {modalMode === 'confirm_overwrite' &&
                            selectedPlaylistObj && (
                                <div className="bg-slate-950/95 backdrop-blur-md border border-emerald-500/90 rounded-xl p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.85)] flex flex-col gap-2">
                                    <div className="text-[11px] text-emerald-200 leading-relaxed">
                                        ⚠️ 確定要將當前智慧媒體庫內的{' '}
                                        <span className="font-mono font-bold text-white">
                                            {allTracks.length} 首
                                        </span>{' '}
                                        曲目覆寫入 foobar2000 播放清單「
                                        <span className="font-bold text-emerald-300">
                                            {selectedPlaylistObj.name}
                                        </span>
                                        」（原 {selectedPlaylistObj.trackCount}{' '}
                                        首）嗎？
                                    </div>
                                    <div className="flex items-center justify-end gap-1.5">
                                        <button
                                            type="button"
                                            disabled={isBusy}
                                            onClick={() =>
                                                void handleConfirmOverwritePlaylist()
                                            }
                                            className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer"
                                        >
                                            {isBusy
                                                ? '保存中...'
                                                : '確認覆蓋保存'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setModalMode('none')}
                                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer"
                                        >
                                            取消
                                        </button>
                                    </div>
                                </div>
                            )}

                        {modalMode === 'rename_playlist' &&
                            selectedPlaylistObj && (
                                <div className="bg-slate-950/95 backdrop-blur-md border border-amber-500/85 rounded-xl p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.85)] flex flex-col gap-1.5">
                                    <div className="text-[11px] font-semibold text-amber-300 truncate">
                                        ✏️ 重新命名播放清單「
                                        {selectedPlaylistObj.name}」
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <input
                                            type="text"
                                            value={inputText}
                                            onChange={(e) =>
                                                setInputText(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    void handleConfirmRenamePlaylist();
                                                } else if (e.key === 'Escape') {
                                                    setModalMode('none');
                                                }
                                            }}
                                            placeholder="輸入新的播放清單名稱..."
                                            autoFocus
                                            className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-amber-400 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none"
                                        />
                                        <button
                                            type="button"
                                            disabled={isBusy}
                                            onClick={() =>
                                                void handleConfirmRenamePlaylist()
                                            }
                                            className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold cursor-pointer shrink-0"
                                        >
                                            確認改名
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setModalMode('none')}
                                            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer shrink-0"
                                        >
                                            取消
                                        </button>
                                    </div>
                                </div>
                            )}

                        {modalMode === 'confirm_delete' &&
                            selectedPlaylistObj && (
                                <div className="bg-slate-950/95 backdrop-blur-md border border-rose-500/90 rounded-xl p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.85)] flex flex-col gap-2">
                                    <div className="text-[11px] text-rose-200 leading-relaxed">
                                        🗑️ 確定要從 foobar2000 永久刪除播放清單「
                                        <span className="font-bold text-white">
                                            {selectedPlaylistObj.name}
                                        </span>
                                        」（共 {selectedPlaylistObj.trackCount}{' '}
                                        首）嗎？
                                    </div>
                                    <div className="flex items-center justify-end gap-1.5">
                                        <button
                                            type="button"
                                            disabled={isBusy}
                                            onClick={() =>
                                                void handleConfirmDeletePlaylist()
                                            }
                                            className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold cursor-pointer"
                                        >
                                            {isBusy ? '刪除中...' : '確認刪除'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setModalMode('none')}
                                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer"
                                        >
                                            取消
                                        </button>
                                    </div>
                                </div>
                            )}

                        {syncHint && (
                            <div className="px-3 py-2 rounded-xl bg-slate-950/95 backdrop-blur-md border border-cyan-500/60 shadow-[0_10px_24px_rgba(0,0,0,0.85)] flex items-center justify-between gap-2 text-[11px] text-cyan-200">
                                <span className="leading-snug">{syncHint}</span>
                                <button
                                    type="button"
                                    onClick={() => setSyncHint(null)}
                                    className="text-slate-400 hover:text-white text-xs cursor-pointer shrink-0"
                                >
                                    ✕
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* 即時搜尋與 BPM / Key / Genre 過濾面板 */}
            <div className="shrink-0">
                <InstantSearch />
            </div>

            {/* 基於 @tanstack/react-virtual 的虛擬滾動曲目/專輯列表 (自動延展填滿高度) */}
            <VirtualTrackList />

            {/* 智慧混音推薦下一首區塊 (由 getSuggestedNextTracks 即時演算) */}
            {currentTrack && suggestedTracks.length > 0 && (
                <div
                    className={`bg-slate-950/85 border border-slate-800 ${
                        isM3LayoutTheme(themeId) ? 'rounded-xl' : 'rounded-lg'
                    } p-2 flex flex-col gap-1.5 shrink-0`}
                >
                    <div className="flex items-center justify-between text-[10px]">
                        <span
                            className={`font-semibold truncate ${
                                themeId === 'm3-cafe-mica'
                                    ? 'text-[#366e4b]'
                                    : themeId === 'm3-dark'
                                      ? 'text-[#80cbc4]'
                                      : 'text-emerald-400'
                            }`}
                        >
                            🎯 推薦混音下一首 (依 {currentTrack.bpm}BPM /{' '}
                            {currentTrack.key})
                        </span>
                        <span className="font-mono text-slate-400 shrink-0">
                            Top {suggestedTracks.length}
                        </span>
                    </div>

                    <div className="flex flex-col gap-1">
                        {suggestedTracks.map(({ track, analysis }) => {
                            const isHighlighted = selectedTrackIds.includes(
                                track.id
                            );
                            const isM3Style = isM3LayoutTheme(themeId);
                            const isCafeMica = themeId === 'm3-cafe-mica';
                            return (
                                <div
                                    key={track.id}
                                    draggable={!isLiveLocked}
                                    onDragStart={(e) => {
                                        if (isLiveLocked) {
                                            e.preventDefault();
                                            return;
                                        }
                                        e.dataTransfer.effectAllowed = 'copy';
                                        e.dataTransfer.setData(
                                            'application/x-foobar-dj-tracks',
                                            JSON.stringify([track.id])
                                        );
                                    }}
                                    onClick={() => {
                                        // 點擊推薦曲目會將媒體庫內的該曲設置為選取中的曲目 (selectedTrack)，並自動捲動定位，絕不改變 currentTrack
                                        focusTrackInLibrary(track.id, track);
                                    }}
                                    // [修正：推薦混音曲目統一套用 M3 選中與一般狀態規範]
                                    className={`px-2.5 py-1.5 ${
                                        isM3Style ? 'rounded-xl' : 'rounded'
                                    } border flex items-center justify-between gap-1.5 transition ${
                                        !isLiveLocked
                                            ? 'cursor-grab active:cursor-grabbing'
                                            : 'cursor-pointer'
                                    } ${
                                        isCafeMica
                                            ? isHighlighted
                                                ? 'bg-[#f4dec8]/95 border-[#c87d4b] ring-1 ring-[#c87d4b]/55 shadow-sm'
                                                : 'bg-[#fffaf4]/88 hover:bg-[#f6eadc] border-[#c49874]/30 hover:border-[#c87d4b]/55'
                                            : isM3Style
                                              ? isHighlighted
                                                  ? 'bg-[#1e3252] border-[#8ab4f8] ring-1 ring-[#8ab4f8]/50 shadow-sm'
                                                  : 'bg-[#191e29] hover:bg-[#232a3b] border-[#a8c7fa]/14 hover:border-[#a8c7fa]/35'
                                              : isHighlighted
                                                ? 'bg-cyan-950/60 border-cyan-400 ring-1 ring-cyan-400/60'
                                                : 'bg-slate-900/90 hover:bg-slate-800/80 border-slate-800/80'
                                    }`}
                                    title={`${analysis.keyRelationMessage}（點擊於媒體庫與畫布高亮定位此曲目；可直接拖曳至畫布建立卡片）`}
                                >
                                    <div className="min-w-0 flex-1 leading-tight">
                                        <div className="flex items-center gap-1.5">
                                            <span
                                                style={{
                                                    backgroundColor:
                                                        analysis.suggestedEdgeColor,
                                                }}
                                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                            />
                                            <span
                                                className={`text-[11px] leading-tight font-semibold truncate ${
                                                    isHighlighted
                                                        ? isCafeMica
                                                            ? 'text-[#3d1f0d]'
                                                            : 'text-[#d3e3fd]'
                                                        : 'text-slate-100'
                                                }`}
                                            >
                                                {track.title}
                                            </span>
                                        </div>
                                        <div className="text-[10px] leading-tight font-mono text-slate-400 truncate mt-0.5">
                                            {track.bpm}BPM • {track.key} •{' '}
                                            <span
                                                className={
                                                    isCafeMica
                                                        ? 'text-[#a85d2e]'
                                                        : isM3Style
                                                          ? 'text-[#8ab4f8]'
                                                          : 'text-cyan-300'
                                                }
                                            >
                                                {analysis.score}分 (
                                                {analysis.suggestedPitchText})
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 多選批次加入畫布操作列 */}
            {selectedTrackIds.length > 0 && !isLiveLocked && (
                <div
                    className={`p-2 border flex items-center justify-between shrink-0 ${
                        themeId === 'm3-cafe-mica'
                            ? 'bg-[#f4dec8]/95 border-[#c87d4b]/65 rounded-xl'
                            : themeId === 'm3-dark'
                              ? 'bg-[#1e3252]/90 border-[#8ab4f8]/60 rounded-xl'
                              : 'bg-cyan-950/60 border-cyan-800/80 rounded-lg'
                    }`}
                >
                    <span
                        className={`text-xs font-medium ${
                            themeId === 'm3-cafe-mica'
                                ? 'text-[#3d1f0d]'
                                : themeId === 'm3-dark'
                                  ? 'text-[#d3e3fd]'
                                  : 'text-cyan-300'
                        }`}
                    >
                        已選 {selectedTrackIds.length} 首
                    </span>
                    <div className="flex gap-1.5">
                        <button
                            onClick={() => {
                                addTracksToCanvas(getSelectedTracks());
                                clearSelection();
                            }}
                            className="px-2.5 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded font-semibold cursor-pointer"
                        >
                            批次生成專輯節點
                        </button>
                        <button
                            onClick={clearSelection}
                            className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded cursor-pointer"
                        >
                            取消
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
