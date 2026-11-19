import { create } from 'zustand';
import type { AlbumGroup, Track } from '../types/track';
import {
    bridgeApi,
    fetchSingleTrackRealCover,
    normalizeAudioPathForMatch,
    queryTracksExactFloorDurations,
} from '../api/mockBridge';
import { groupLibraryTracksByAlbum } from '../algorithms/autoGrouping';
import {
    enqueueTracksForRealBpmKeyAnalysis,
    getCachedRealAudioAnalysis,
} from '../utils/audioAnalyzer';
import {
    ensureArtworkCacheLoaded,
    getCachedCoverSync,
    setCachedCover,
} from '../utils/artworkCache';
import {
    useWorkflowStore,
    type TrackComputedMetaBatchItem,
} from './useWorkflowStore';
import { usePlayerStore } from './usePlayerStore';

/**
 * 媒體庫即時篩選條件 (規格書 2.2 Instant Filter)
 */
export interface LibraryFilter {
    searchQuery: string;         // 曲名 / 演出者 / 專輯名稱關鍵字搜尋
    minBpm: number | null;       // 最低 BPM 過濾
    maxBpm: number | null;       // 最高 BPM 過濾
    selectedKey: string | null;  // 指定 Camelot Key 調性 (如 "8A")，null 代表全部
    selectedGenre: string | null;// 指定曲風，null 代表全部
}

interface PlaylistState {
    // 1. 原始媒體庫與過濾後清單 (供 @tanstack/react-virtual 虛擬滾動直接讀取)
    allTracks: Track[];
    filteredTracks: Track[];
    filteredAlbumGroups: AlbumGroup[];
    availableGenres: string[];
    availableKeys: string[];
    isLoading: boolean;

    // 2. 篩選器狀態与檢視模式
    filter: LibraryFilter;
    viewMode: 'tracks' | 'albums'; // 支援以「單曲列表」或「整張專輯」檢視並拖入畫布

    // 3. 多選曲目狀態、代表選取曲目 (selectedTrack)、自動捲動定位目標、當前選中歌單與播放清單下拉更新版本號
    selectedTrackIds: string[];
    selectedTrack: Track | null;
    setSelectedTrack: (track: Track | null) => void;
    scrollTarget: { trackId: string; timestamp: number } | null;
    clearScrollTarget: () => void;
    selectedPlaylistValue: string;
    setSelectedPlaylistValue: (val: string) => void;
    hasInitializedLibrary: boolean;
    playlistRefreshVersion: number;
    notifyFoobarPlaylistsChanged: () => void;

    // 4. 操作 Actions
    loadMediaLibrary: (forceReload?: boolean) => Promise<void>;
    setSearchQuery: (query: string) => void;
    setBpmRange: (minBpm: number | null, maxBpm: number | null) => void;
    setSelectedKey: (key: string | null) => void;
    setSelectedGenre: (genre: string | null) => void;
    resetFilters: () => void;
    setViewMode: (mode: 'tracks' | 'albums') => void;

    // 選取、多選與單曲聚焦自動捲動操作 (僅設定 selectedTrack，絕不影響總時間軸 currentTrack)
    toggleSelectTrack: (
        trackId: string,
        multiSelect?: boolean,
        explicitTrack?: Track
    ) => void;
    selectTrackRange: (targetTrackId: string, explicitTrack?: Track) => void;
    focusTrackInLibrary: (trackId: string, explicitTrack?: Track) => void;
    clearSelection: () => void;
    getSelectedTracks: () => Track[];

    // 同步更新曲目的 Cue 點 (供雙向 Cue 點標記系統同步回媒體庫)
    updateTrackCuePoints: (trackId: string, cuePoints: Track['cuePoints']) => void;

    // 同步更新由真實 PCM 解碼計算出的 BPM、Camelot Key、Duration 或真實封面
    updateTrackComputedMeta: (
        trackId: string,
        path: string,
        patch: {
            bpm?: number;
            key?: string;
            duration?: number;
            coverUrl?: string;
        }
    ) => void;
    batchUpdateTrackComputedMeta: (items: TrackComputedMetaBatchItem[]) => void;

    // [方向 A & 2a/2b/2d/2e] 設定、追加或移除智慧媒體庫工作清單中的曲目
    setLibraryTracksFromHost: (tracks: Track[]) => void;
    appendTracksToLibrary: (newTracks: Track[]) => number;
    removeTrackFromLibrary: (trackId: string) => void;
}

const DEFAULT_FILTER: LibraryFilter = {
    searchQuery: '',
    minBpm: null,
    maxBpm: null,
    selectedKey: null,
    selectedGenre: null,
};

const PLAYLIST_SELECTION_STORAGE_KEY = 'foobar_dj_selected_playlist_v1';
const WORKING_TRACKS_STORAGE_KEY = 'foobar_dj_working_library_tracks_v1';
const SELECTED_TRACK_IDS_STORAGE_KEY = 'foobar_dj_selected_track_ids_v1';
const SELECTED_TRACK_OBJ_STORAGE_KEY = 'foobar_dj_selected_track_obj_v1';
const LIBRARY_VIEW_MODE_STORAGE_KEY = 'foobar_dj_library_view_mode_v1';

const getInitialPlaylistSelection = (): string => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const saved = window.localStorage.getItem(
                PLAYLIST_SELECTION_STORAGE_KEY
            );
            if (saved) return saved;
        }
    } catch {
        // 忽略存取限制
    }
    return '__AUTO_INIT__';
};

const loadSavedSelectedTrackIds = (): string[] => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(
                SELECTED_TRACK_IDS_STORAGE_KEY
            );
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter((id): id is string => typeof id === 'string');
            }
        }
    } catch {
        // ignore
    }
    return [];
};

// [修復問題 1：避免多選曲目時頻繁同步執行 JSON.stringify 與 localStorage.setItem 阻塞主執行緒]
// 造成錯誤的原因：先前每次點擊 Ctrl / Shift 多選曲目時皆在點擊事件內同步序列化寫入 localStorage，連續快速多選或大範圍多選時會造成主執行緒 I/O 卡頓。
// 修改的目的：將選取狀態的 localStorage 持久化改為 150ms 防抖非同步寫入，讓 UI 選取狀態可於 0ms 立即更新。
let saveSelectedIdsTimer: ReturnType<typeof setTimeout> | null = null;
const saveSelectedTrackIds = (ids: string[]): void => {
    if (saveSelectedIdsTimer) {
        clearTimeout(saveSelectedIdsTimer);
    }
    saveSelectedIdsTimer = setTimeout(() => {
        saveSelectedIdsTimer = null;
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem(
                    SELECTED_TRACK_IDS_STORAGE_KEY,
                    JSON.stringify(ids)
                );
            }
        } catch {
            // ignore
        }
    }, 150);
};

const loadSavedSelectedTrack = (): Track | null => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(
                SELECTED_TRACK_OBJ_STORAGE_KEY
            );
            if (!raw) return null;
            const parsed = JSON.parse(raw) as Track | null;
            if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
                return parsed;
            }
        }
    } catch {
        // ignore
    }
    return null;
};

let saveSelectedTrackTimer: ReturnType<typeof setTimeout> | null = null;
const saveSelectedTrack = (track: Track | null): void => {
    if (saveSelectedTrackTimer) {
        clearTimeout(saveSelectedTrackTimer);
    }
    saveSelectedTrackTimer = setTimeout(() => {
        saveSelectedTrackTimer = null;
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                if (!track) {
                    window.localStorage.removeItem(SELECTED_TRACK_OBJ_STORAGE_KEY);
                    return;
                }
                const compact: Track = {
                    ...track,
                    coverUrl:
                        track.coverUrl &&
                        track.coverUrl.startsWith('data:') &&
                        track.coverUrl.length > 4096
                            ? undefined
                            : track.coverUrl,
                };
                window.localStorage.setItem(
                    SELECTED_TRACK_OBJ_STORAGE_KEY,
                    JSON.stringify(compact)
                );
            }
        } catch {
            // ignore
        }
    }, 150);
};

const loadSavedViewMode = (): 'tracks' | 'albums' => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(
                LIBRARY_VIEW_MODE_STORAGE_KEY
            );
            if (raw === 'albums' || raw === 'tracks') return raw;
        }
    } catch {
        // ignore
    }
    return 'tracks';
};

const loadCachedWorkingTracks = (): Track[] | null => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(WORKING_TRACKS_STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as Track[];
            if (Array.isArray(parsed)) {
                return parsed.map((t) => {
                    const cachedAnalysis = getCachedRealAudioAnalysis(
                        t.path || t.id
                    );
                    const cachedCover = getCachedCoverSync(
                        t.path,
                        t.artist,
                        t.album
                    );
                    return {
                        ...t,
                        ...(cachedAnalysis
                            ? {
                                  bpm: cachedAnalysis.bpm,
                                  key: cachedAnalysis.key,
                              }
                            : {}),
                        ...(cachedCover && !t.coverUrl
                            ? { coverUrl: cachedCover }
                            : {}),
                    };
                });
            }
        }
    } catch {
        // 忽略解析錯誤
    }
    return null;
};

const saveCachedWorkingTracks = (tracks: Track[]): void => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            // 將超過 4KB 的真實 Base64 封面先存入 IndexedDB 永久快取，再將精簡結構寫入 localStorage
            const compact = tracks.map((t) => {
                if (t.coverUrl && t.coverUrl.startsWith('data:')) {
                    setCachedCover(t.path, t.coverUrl, t.artist, t.album);
                }
                return {
                    ...t,
                    coverUrl:
                        t.coverUrl &&
                        t.coverUrl.startsWith('data:') &&
                        t.coverUrl.length > 4096
                            ? ''
                            : t.coverUrl,
                };
            });
            window.localStorage.setItem(
                WORKING_TRACKS_STORAGE_KEY,
                JSON.stringify(compact)
            );
        }
    } catch {
        // 忽略配額限制
    }
};

/**
 * 根據篩選條件即時計算符合的曲目清單
 */
const applyTrackFilters = (tracks: Track[], filter: LibraryFilter): Track[] => {
    const query = filter.searchQuery.trim().toLowerCase();

    return tracks.filter((track) => {
        // 1. 關鍵字檢索 (Title / Artist / Album)
        if (query) {
            const matchTitle = track.title.toLowerCase().includes(query);
            const matchArtist = track.artist.toLowerCase().includes(query);
            const matchAlbum = track.album.toLowerCase().includes(query);
            if (!matchTitle && !matchArtist && !matchAlbum) {
                return false;
            }
        }

        // 2. BPM 範圍過濾
        if (filter.minBpm !== null && track.bpm < filter.minBpm) {
            return false;
        }
        if (filter.maxBpm !== null && track.bpm > filter.maxBpm) {
            return false;
        }

        // 3. Key 調性過濾
        if (
            filter.selectedKey &&
            track.key.toUpperCase() !== filter.selectedKey.toUpperCase()
        ) {
            return false;
        }

        // 4. Genre 曲風過濾
        if (filter.selectedGenre && track.genre !== filter.selectedGenre) {
            return false;
        }

        return true;
    });
};

const computeDerivedLibraryState = (tracks: Track[], filter: LibraryFilter) => {
    const filtered = applyTrackFilters(tracks, filter);
    const groups = groupLibraryTracksByAlbum(filtered);
    const genreSet = new Set<string>();
    const keySet = new Set<string>();
    for (const t of tracks) {
        if (t.genre) genreSet.add(t.genre);
        if (t.key) keySet.add(t.key);
    }
    return {
        allTracks: tracks,
        filteredTracks: filtered,
        filteredAlbumGroups: groups,
        availableGenres: Array.from(genreSet).sort(),
        availableKeys: Array.from(keySet).sort(),
    };
};

/**
 * 批次非阻塞補齊真實專輯封面：
 * 1. 先從 IndexedDB 高速快取一次性掛載所有已知封面（僅觸發 1 次批量更新，0 IPC 開銷）
 * 2. 對真正尚未快取的新曲目，依專輯/資料夾去重並以每 15 首或每 350ms 合併更新一次，徹底消除逐條重載閃爍與畫布卡頓
 */
const hydrateMissingRealCovers = (
    tracks: Track[],
    onBatchCoversFound: (items: TrackComputedMetaBatchItem[]) => void
): void => {
    void (async () => {
        await ensureArtworkCacheLoaded();

        const instantCachedItems: TrackComputedMetaBatchItem[] = [];
        const needFetchTracks: Track[] = [];

        for (const tr of tracks) {
            if (tr.coverUrl) {
                if (tr.coverUrl.startsWith('data:')) {
                    setCachedCover(tr.path, tr.coverUrl, tr.artist, tr.album);
                }
                continue;
            }
            if (!tr.path || tr.path.startsWith('C:\\Music\\DJ_Set\\')) {
                continue;
            }

            const cached = getCachedCoverSync(tr.path, tr.artist, tr.album);
            if (cached) {
                instantCachedItems.push({
                    trackId: tr.id,
                    path: tr.path,
                    patch: { coverUrl: cached },
                });
            } else {
                needFetchTracks.push(tr);
            }
        }

        // 第一階段：已在 IndexedDB 的封面一次性瞬間掛載，完全不逐條閃爍！
        if (instantCachedItems.length > 0) {
            onBatchCoversFound(instantCachedItems);
        }

        if (needFetchTracks.length === 0) return;

        // 第二階段：針對從未快取過的新曲目，於背景擷取並以批次合併方式更新
        let pendingBatch: TrackComputedMetaBatchItem[] = [];
        let lastFlushTime = performance.now();

        const flushPending = () => {
            if (pendingBatch.length === 0) return;
            const toSend = pendingBatch;
            pendingBatch = [];
            lastFlushTime = performance.now();
            onBatchCoversFound(toSend);
        };

        for (const tr of needFetchTracks.slice(0, 80)) {
            const alreadyInMem = getCachedCoverSync(
                tr.path,
                tr.artist,
                tr.album
            );
            const realCover =
                alreadyInMem ??
                (await fetchSingleTrackRealCover(
                    tr.path,
                    tr.artist,
                    tr.album
                ));
            if (realCover) {
                pendingBatch.push({
                    trackId: tr.id,
                    path: tr.path,
                    patch: { coverUrl: realCover },
                });
            }

            const now = performance.now();
            if (
                pendingBatch.length >= 15 ||
                (pendingBatch.length > 0 && now - lastFlushTime >= 350)
            ) {
                flushPending();
                await new Promise((r) => setTimeout(r, 16));
            }
        }

        flushPending();
    })();
};

// [0ms 瞬時還原引擎] 於 Store 建立當下同步讀取快取中的曲目清單，
// 確保最小化再開啟時，左側媒體庫清單在第 0 幀即刻完整呈現，絕不重新顯示「讀取中」或逐條重繪！
const initialPlaylistSelection = getInitialPlaylistSelection();
const initialCachedTracks =
    initialPlaylistSelection !== '__AUTO_INIT__'
        ? loadCachedWorkingTracks()
        : null;
const initialDerivedLibrary =
    initialCachedTracks && initialCachedTracks.length > 0
        ? computeDerivedLibraryState(initialCachedTracks, DEFAULT_FILTER)
        : null;

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
    allTracks: initialDerivedLibrary?.allTracks ?? [],
    filteredTracks: initialDerivedLibrary?.filteredTracks ?? [],
    filteredAlbumGroups: initialDerivedLibrary?.filteredAlbumGroups ?? [],
    availableGenres: initialDerivedLibrary?.availableGenres ?? [],
    availableKeys: initialDerivedLibrary?.availableKeys ?? [],
    isLoading: false,

    filter: { ...DEFAULT_FILTER },
    viewMode: loadSavedViewMode(),
    selectedTrackIds: loadSavedSelectedTrackIds(),
    selectedTrack: loadSavedSelectedTrack(),
    setSelectedTrack: (track) => {
        saveSelectedTrack(track);
        set({ selectedTrack: track });
    },
    scrollTarget: null,
    clearScrollTarget: () => set({ scrollTarget: null }),
    selectedPlaylistValue: initialPlaylistSelection,
    setSelectedPlaylistValue: (val) => {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem(
                    PLAYLIST_SELECTION_STORAGE_KEY,
                    val
                );
            }
        } catch {
            // 忽略 localStorage 例外
        }
        set({ selectedPlaylistValue: val });
    },
    hasInitializedLibrary: initialDerivedLibrary !== null,
    playlistRefreshVersion: 0,
    notifyFoobarPlaylistsChanged: () =>
        set((state) => ({
            playlistRefreshVersion: state.playlistRefreshVersion + 1,
        })),

    loadMediaLibrary: async (forceReload = false) => {
        // [防清空保護 1] 若已由 0ms 同步快取或先前載入完成且並非強制重載，僅需一次性掛載 IndexedDB 封面與快取分析即可！
        if (get().hasInitializedLibrary && !forceReload) {
            const currentAll = get().allTracks;
            if (currentAll.length > 0) {
                hydrateMissingRealCovers(currentAll, (batch) => {
                    get().batchUpdateTrackComputedMeta(batch);
                });
                enqueueTracksForRealBpmKeyAnalysis(
                    currentAll,
                    (trackId, path, result) => {
                        get().updateTrackComputedMeta(trackId, path, {
                            bpm: result.bpm,
                            key: result.key,
                            duration: result.duration,
                        });
                    },
                    (batch) => {
                        get().batchUpdateTrackComputedMeta(
                            batch.map((b) => ({
                                trackId: b.trackId,
                                path: b.path,
                                patch: {
                                    bpm: b.result.bpm,
                                    key: b.result.key,
                                    duration: b.result.duration,
                                },
                            }))
                        );
                    }
                );
                // [修復問題 1.1：校正媒體庫快取中舊有進位整數 duration]
                // 造成原錯誤的原因：localStorage 快取曲目曾儲存 C++ %length_seconds% 四捨五入後的秒數（如 260.52s 存為 261s），再次拖入畫布時會使預設 mixOut 多出 1 秒而提早切歌。
                // 本次修改的目的：背景批次向宿主查詢 %length_seconds_fp% 並以 Math.floor 校正快取曲目的 duration 與預設 mixOut。
                void queryTracksExactFloorDurations(
                    currentAll.map((t) => t.path)
                ).then((exactMap) => {
                    if (exactMap.size === 0) return;
                    const patches: TrackComputedMetaBatchItem[] = [];
                    for (const t of get().allTracks) {
                        const floorDur =
                            exactMap.get(t.path) ??
                            exactMap.get(normalizeAudioPathForMatch(t.path));
                        if (
                            floorDur !== undefined &&
                            floorDur > 0 &&
                            floorDur !== t.duration
                        ) {
                            patches.push({
                                trackId: t.id,
                                path: t.path,
                                patch: { duration: floorDur },
                            });
                        }
                    }
                    if (patches.length > 0) {
                        get().batchUpdateTrackComputedMeta(patches);
                    }
                });
            }
            return;
        }

        // [防清空保護 2] 若視窗最小化後還原導致 WebView 重新掛載，優先還原先前保存的歌單選擇與工作曲目清單
        const savedSelection = get().selectedPlaylistValue;
        const cachedTracks = loadCachedWorkingTracks();
        if (
            !forceReload &&
            savedSelection !== '__AUTO_INIT__' &&
            cachedTracks !== null &&
            cachedTracks.length > 0
        ) {
            set({
                ...computeDerivedLibraryState(cachedTracks, get().filter),
                hasInitializedLibrary: true,
                isLoading: false,
            });
            hydrateMissingRealCovers(cachedTracks, (batch) => {
                get().batchUpdateTrackComputedMeta(batch);
            });
            enqueueTracksForRealBpmKeyAnalysis(
                cachedTracks,
                (trackId, path, result) => {
                    get().updateTrackComputedMeta(trackId, path, {
                        bpm: result.bpm,
                        key: result.key,
                        duration: result.duration,
                    });
                },
                (batch) => {
                    get().batchUpdateTrackComputedMeta(
                        batch.map((b) => ({
                            trackId: b.trackId,
                            path: b.path,
                            patch: {
                                bpm: b.result.bpm,
                                key: b.result.key,
                                duration: b.result.duration,
                            },
                        }))
                    );
                }
            );
            void queryTracksExactFloorDurations(
                cachedTracks.map((t) => t.path)
            ).then((exactMap) => {
                if (exactMap.size === 0) return;
                const patches: TrackComputedMetaBatchItem[] = [];
                for (const t of get().allTracks) {
                    const floorDur =
                        exactMap.get(t.path) ??
                        exactMap.get(normalizeAudioPathForMatch(t.path));
                    if (
                        floorDur !== undefined &&
                        floorDur > 0 &&
                        floorDur !== t.duration
                    ) {
                        patches.push({
                            trackId: t.id,
                            path: t.path,
                            patch: { duration: floorDur },
                        });
                    }
                }
                if (patches.length > 0) {
                    get().batchUpdateTrackComputedMeta(patches);
                }
            });
            return;
        }

        set({ isLoading: true });
        try {
            const tracks = await bridgeApi.getLibraryTracks();
            if (
                get().hasInitializedLibrary &&
                !forceReload &&
                get().allTracks.length > 0
            ) {
                set({ isLoading: false });
                return;
            }
            saveCachedWorkingTracks(tracks);
            set({
                ...computeDerivedLibraryState(tracks, get().filter),
                hasInitializedLibrary: true,
                isLoading: false,
            });
            hydrateMissingRealCovers(tracks, (batch) => {
                get().batchUpdateTrackComputedMeta(batch);
            });
            enqueueTracksForRealBpmKeyAnalysis(
                tracks,
                (trackId, path, result) => {
                    get().updateTrackComputedMeta(trackId, path, {
                        bpm: result.bpm,
                        key: result.key,
                        duration: result.duration,
                    });
                },
                (batch) => {
                    get().batchUpdateTrackComputedMeta(
                        batch.map((b) => ({
                            trackId: b.trackId,
                            path: b.path,
                            patch: {
                                bpm: b.result.bpm,
                                key: b.result.key,
                                duration: b.result.duration,
                            },
                        }))
                    );
                }
            );
        } catch (error) {
            console.error('載入媒體庫曲目失敗:', error);
            set({ isLoading: false });
        }
    },

    setSearchQuery: (searchQuery) => {
        const nextFilter = { ...get().filter, searchQuery };
        const filtered = applyTrackFilters(get().allTracks, nextFilter);
        set({
            filter: nextFilter,
            filteredTracks: filtered,
            filteredAlbumGroups: groupLibraryTracksByAlbum(filtered),
        });
    },

    setBpmRange: (minBpm, maxBpm) => {
        const nextFilter = { ...get().filter, minBpm, maxBpm };
        const filtered = applyTrackFilters(get().allTracks, nextFilter);
        set({
            filter: nextFilter,
            filteredTracks: filtered,
            filteredAlbumGroups: groupLibraryTracksByAlbum(filtered),
        });
    },

    setSelectedKey: (selectedKey) => {
        const nextFilter = { ...get().filter, selectedKey };
        const filtered = applyTrackFilters(get().allTracks, nextFilter);
        set({
            filter: nextFilter,
            filteredTracks: filtered,
            filteredAlbumGroups: groupLibraryTracksByAlbum(filtered),
        });
    },

    setSelectedGenre: (selectedGenre) => {
        const nextFilter = { ...get().filter, selectedGenre };
        const filtered = applyTrackFilters(get().allTracks, nextFilter);
        set({
            filter: nextFilter,
            filteredTracks: filtered,
            filteredAlbumGroups: groupLibraryTracksByAlbum(filtered),
        });
    },

    resetFilters: () => {
        const nextFilter = { ...DEFAULT_FILTER };
        const allTracks = get().allTracks;
        set({
            filter: nextFilter,
            filteredTracks: allTracks,
            filteredAlbumGroups: groupLibraryTracksByAlbum(allTracks),
        });
    },

    setViewMode: (viewMode) => {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem(
                    LIBRARY_VIEW_MODE_STORAGE_KEY,
                    viewMode
                );
            }
        } catch {
            // ignore
        }
        set({ viewMode });
    },

    toggleSelectTrack: (trackId, multiSelect = false, explicitTrack) => {
        const current = get().selectedTrackIds;
        const allTracks = get().allTracks;
        const resolvedClickedTrack =
            explicitTrack ??
            allTracks.find((t) => t.id === trackId) ??
            null;

        if (!multiSelect) {
            // 單選模式：若點擊已選取的唯一項目則取消，否則僅選取該項
            const isDeselecting =
                current.length === 1 && current[0] === trackId;
            const next = isDeselecting ? [] : [trackId];
            const nextSelectedTrack = isDeselecting
                ? null
                : resolvedClickedTrack;
            saveSelectedTrackIds(next);
            saveSelectedTrack(nextSelectedTrack);
            set({
                selectedTrackIds: next,
                selectedTrack: nextSelectedTrack,
            });
            return;
        }

        // 多選模式 (Ctrl / Cmd 點擊)
        const exists = current.includes(trackId);
        const next = exists
            ? current.filter((id) => id !== trackId)
            : [...current, trackId];
        const nextSelectedTrack = exists
            ? next.length > 0
                ? (allTracks.find((t) => t.id === next[next.length - 1]) ??
                  null)
                : null
            : resolvedClickedTrack ?? get().selectedTrack;
        saveSelectedTrackIds(next);
        saveSelectedTrack(nextSelectedTrack);
        set({
            selectedTrackIds: next,
            selectedTrack: nextSelectedTrack,
        });
    },

    selectTrackRange: (targetTrackId, explicitTrack) => {
        const { allTracks, filteredTracks, selectedTrackIds } = get();
        const resolvedTargetTrack =
            explicitTrack ??
            allTracks.find((t) => t.id === targetTrackId) ??
            get().selectedTrack;

        if (selectedTrackIds.length === 0) {
            saveSelectedTrackIds([targetTrackId]);
            saveSelectedTrack(resolvedTargetTrack);
            set({
                selectedTrackIds: [targetTrackId],
                selectedTrack: resolvedTargetTrack,
            });
            return;
        }

        const lastSelectedId = selectedTrackIds[selectedTrackIds.length - 1];
        const startIndex = filteredTracks.findIndex((t) => t.id === lastSelectedId);
        const endIndex = filteredTracks.findIndex((t) => t.id === targetTrackId);

        if (startIndex === -1 || endIndex === -1) {
            saveSelectedTrackIds([targetTrackId]);
            saveSelectedTrack(resolvedTargetTrack);
            set({
                selectedTrackIds: [targetTrackId],
                selectedTrack: resolvedTargetTrack,
            });
            return;
        }

        const [low, high] =
            startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
        const rangeIds = filteredTracks.slice(low, high + 1).map((t) => t.id);
        const merged = Array.from(new Set([...selectedTrackIds, ...rangeIds]));

        saveSelectedTrackIds(merged);
        saveSelectedTrack(resolvedTargetTrack);
        set({
            selectedTrackIds: merged,
            selectedTrack: resolvedTargetTrack,
        });
    },

    focusTrackInLibrary: (trackId, explicitTrack) => {
        const { allTracks, filteredTracks, viewMode } = get();
        const resolvedTrack =
            explicitTrack ??
            allTracks.find((t) => t.id === trackId) ??
            get().selectedTrack;
        const isVisibleInFiltered = filteredTracks.some(
            (t) => t.id === trackId
        );

        saveSelectedTrackIds([trackId]);
        saveSelectedTrack(resolvedTrack);
        // 若目標曲目因當前篩選條件被隱藏，自動重設篩選器以確保能捲動並高亮顯示該曲目
        if (!isVisibleInFiltered && allTracks.some((t) => t.id === trackId)) {
            const nextFilter = { ...DEFAULT_FILTER };
            set({
                filter: nextFilter,
                filteredTracks: allTracks,
                filteredAlbumGroups: groupLibraryTracksByAlbum(allTracks),
                viewMode: 'tracks',
                selectedTrackIds: [trackId],
                selectedTrack: resolvedTrack,
                scrollTarget: { trackId, timestamp: Date.now() },
            });
            return;
        }

        set({
            ...(viewMode !== 'tracks' ? { viewMode: 'tracks' } : {}),
            selectedTrackIds: [trackId],
            selectedTrack: resolvedTrack,
            scrollTarget: { trackId, timestamp: Date.now() },
        });
    },

    clearSelection: () => {
        saveSelectedTrackIds([]);
        saveSelectedTrack(null);
        set({ selectedTrackIds: [], selectedTrack: null });
    },

    getSelectedTracks: () => {
        const { allTracks, selectedTrackIds } = get();
        const idSet = new Set(selectedTrackIds);
        return allTracks.filter((t) => idSet.has(t.id));
    },

    updateTrackCuePoints: (trackId, cuePoints) => {
        const nextAll = get().allTracks.map((t) =>
            t.id === trackId ? { ...t, cuePoints: { ...cuePoints } } : t
        );
        saveCachedWorkingTracks(nextAll);
        const filtered = applyTrackFilters(nextAll, get().filter);
        const currentSel = get().selectedTrack;
        const nextSel =
            currentSel && currentSel.id === trackId
                ? { ...currentSel, cuePoints: { ...cuePoints } }
                : currentSel;
        if (nextSel !== currentSel) {
            saveSelectedTrack(nextSel);
        }
        set({
            allTracks: nextAll,
            filteredTracks: filtered,
            filteredAlbumGroups: groupLibraryTracksByAlbum(filtered),
            selectedTrack: nextSel,
        });
    },

    updateTrackComputedMeta: (trackId, path, patch) => {
        get().batchUpdateTrackComputedMeta([{ trackId, path, patch }]);
    },

    batchUpdateTrackComputedMeta: (items) => {
        if (!Array.isArray(items) || items.length === 0) return;

        const findMergedPatch = (t: Track) => {
            let merged: {
                bpm?: number;
                key?: string;
                duration?: number;
                coverUrl?: string;
            } | null = null;
            for (const item of items) {
                if (
                    t.id === item.trackId ||
                    (Boolean(item.path) && t.path === item.path)
                ) {
                    const currentMerged: {
                        bpm?: number;
                        key?: string;
                        duration?: number;
                        coverUrl?: string;
                    } = merged ?? {};
                    merged = { ...currentMerged, ...item.patch };
                }
            }
            return merged;
        };

        for (const item of items) {
            if (
                item.patch.coverUrl &&
                item.patch.coverUrl.startsWith('data:')
            ) {
                setCachedCover(item.path, item.patch.coverUrl);
            }
        }

        const currentAll = get().allTracks;
        let changed = false;
        const nextAll = currentAll.map((t) => {
            const patch = findMergedPatch(t);
            if (!patch) return t;
            changed = true;
            if (patch.coverUrl && patch.coverUrl.startsWith('data:')) {
                setCachedCover(t.path, patch.coverUrl, t.artist, t.album);
            }
            const nextDur =
                patch.duration !== undefined
                    ? Math.max(1, Math.floor(patch.duration))
                    : t.duration;
            // [修復問題 1.1] 當預設 mixOut 隨 duration 下修（例如 261s -> 260s）時同步收斂 mixOut，避免 mixOut 超出實際檔案尾端
            const shouldExtendMixOut =
                patch.duration !== undefined &&
                (Math.abs((t.cuePoints.mixOut ?? t.duration) - t.duration) <=
                    1.5 ||
                    (t.cuePoints.mixOut ?? t.duration) > nextDur);
            return {
                ...t,
                ...(patch.bpm !== undefined ? { bpm: patch.bpm } : {}),
                ...(patch.key !== undefined ? { key: patch.key } : {}),
                ...(patch.duration !== undefined ? { duration: nextDur } : {}),
                ...(patch.coverUrl !== undefined
                    ? { coverUrl: patch.coverUrl }
                    : {}),
                cuePoints: shouldExtendMixOut
                    ? { ...t.cuePoints, mixOut: nextDur }
                    : t.cuePoints,
            };
        });

        const currentSel = get().selectedTrack;
        const selPatch = currentSel ? findMergedPatch(currentSel) : null;
        const nextSel =
            selPatch && currentSel
                ? {
                      ...currentSel,
                      ...(selPatch.bpm !== undefined
                          ? { bpm: selPatch.bpm }
                          : {}),
                      ...(selPatch.key !== undefined
                          ? { key: selPatch.key }
                          : {}),
                      ...(selPatch.duration !== undefined
                          ? { duration: selPatch.duration }
                          : {}),
                      ...(selPatch.coverUrl !== undefined
                          ? { coverUrl: selPatch.coverUrl }
                          : {}),
                  }
                : currentSel;

        if (selPatch) {
            saveSelectedTrack(nextSel);
        }

        if (changed || selPatch) {
            if (changed) {
                saveCachedWorkingTracks(nextAll);
            }
            set({
                ...(changed
                    ? computeDerivedLibraryState(nextAll, get().filter)
                    : {}),
                ...(selPatch ? { selectedTrack: nextSel } : {}),
            });
        }

        // 一次性批次同步更新畫布節點與播放器當前曲目
        useWorkflowStore
            .getState()
            .batchUpdateTrackComputedMetaInWorkflow(items);
        const playerState = usePlayerStore.getState();
        for (const item of items) {
            playerState.updateCurrentTrackComputedMeta(
                item.trackId,
                item.path,
                item.patch
            );
        }
    },

    setLibraryTracksFromHost: (tracks) => {
        if (!Array.isArray(tracks)) return;
        const enrichedTracks = tracks.map((t) => {
            const cachedAnalysis = getCachedRealAudioAnalysis(t.path || t.id);
            const cachedCover = getCachedCoverSync(t.path, t.artist, t.album);
            return {
                ...t,
                ...(cachedAnalysis
                    ? { bpm: cachedAnalysis.bpm, key: cachedAnalysis.key }
                    : {}),
                ...(cachedCover && !t.coverUrl
                    ? { coverUrl: cachedCover }
                    : {}),
            };
        });
        saveCachedWorkingTracks(enrichedTracks);
        const validIds = new Set(enrichedTracks.map((t) => t.id));
        const preservedSelected = get().selectedTrackIds.filter((id) =>
            validIds.has(id)
        );
        saveSelectedTrackIds(preservedSelected);
        set({
            ...computeDerivedLibraryState(enrichedTracks, get().filter),
            selectedTrackIds: preservedSelected,
            hasInitializedLibrary: true,
            isLoading: false,
        });
        hydrateMissingRealCovers(enrichedTracks, (batch) => {
            get().batchUpdateTrackComputedMeta(batch);
        });
        enqueueTracksForRealBpmKeyAnalysis(
            enrichedTracks,
            (trackId, path, result) => {
                get().updateTrackComputedMeta(trackId, path, {
                    bpm: result.bpm,
                    key: result.key,
                    duration: result.duration,
                });
            },
            (batch) => {
                get().batchUpdateTrackComputedMeta(
                    batch.map((b) => ({
                        trackId: b.trackId,
                        path: b.path,
                        patch: {
                            bpm: b.result.bpm,
                            key: b.result.key,
                            duration: b.result.duration,
                        },
                    }))
                );
            }
        );
    },

    appendTracksToLibrary: (newTracks) => {
        if (!Array.isArray(newTracks) || newTracks.length === 0) return 0;
        const currentAll = get().allTracks;
        const existingKeys = new Set(
            currentAll.map((t) => `${t.path || ''}::${t.title}::${t.artist}`)
        );
        const existingIds = new Set(currentAll.map((t) => t.id));

        const uniqueToAdd: Track[] = [];
        newTracks.forEach((track, idx) => {
            const dedupeKey = `${track.path || ''}::${track.title}::${track.artist}`;
            if (existingKeys.has(dedupeKey)) return;
            existingKeys.add(dedupeKey);

            let safeId = track.id;
            if (existingIds.has(safeId)) {
                safeId = `${track.id}-append-${Date.now()}-${idx}`;
            }
            existingIds.add(safeId);
            uniqueToAdd.push({ ...track, id: safeId });
        });

        if (uniqueToAdd.length === 0) return 0;

        const nextAll = [...currentAll, ...uniqueToAdd];
        saveCachedWorkingTracks(nextAll);
        set({
            ...computeDerivedLibraryState(nextAll, get().filter),
            hasInitializedLibrary: true,
            isLoading: false,
        });

        hydrateMissingRealCovers(uniqueToAdd, (batch) => {
            get().batchUpdateTrackComputedMeta(batch);
        });
        enqueueTracksForRealBpmKeyAnalysis(
            uniqueToAdd,
            (trackId, path, result) => {
                get().updateTrackComputedMeta(trackId, path, {
                    bpm: result.bpm,
                    key: result.key,
                    duration: result.duration,
                });
            },
            (batch) => {
                get().batchUpdateTrackComputedMeta(
                    batch.map((b) => ({
                        trackId: b.trackId,
                        path: b.path,
                        patch: {
                            bpm: b.result.bpm,
                            key: b.result.key,
                            duration: b.result.duration,
                        },
                    }))
                );
            }
        );
        return uniqueToAdd.length;
    },

    removeTrackFromLibrary: (trackId) => {
        const currentAll = get().allTracks;
        const nextAll = currentAll.filter((t) => t.id !== trackId);
        const nextSelected = get().selectedTrackIds.filter(
            (id) => id !== trackId
        );
        const currentSel = get().selectedTrack;
        const nextSel =
            currentSel && currentSel.id === trackId ? null : currentSel;
        saveCachedWorkingTracks(nextAll);
        saveSelectedTrackIds(nextSelected);
        saveSelectedTrack(nextSel);
        set({
            ...computeDerivedLibraryState(nextAll, get().filter),
            selectedTrackIds: nextSelected,
            selectedTrack: nextSel,
        });
    },
}));