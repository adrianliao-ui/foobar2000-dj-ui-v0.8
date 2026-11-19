import { create } from 'zustand';
import type {
    HostStatus,
    PlayerState,
    StereoVULevels,
    VisualizerMode,
} from '../types/player';
import type { Track } from '../types/track';
import type { FlatPlayQueueItem } from '../types/workflow';
import {
    bridgeApi,
    extractFilenameStemForMatch,
    fetchSingleTrackRealCover,
    getDetectedHostBufferSec,
    isFoobarWebView,
    normalizeAudioPathForMatch,
    sendCommandToHost,
} from '../api/mockBridge';
import { resolveMasterTimelineSeek } from '../algorithms/topologicalSort';
import { extractDominantColorFromUrl } from '../utils/colorExtractor';

import { getCachedCoverSync } from '../utils/artworkCache';

// 記錄目前是否處於兩首曲目之間的 Silence 靜音過渡區間、Crossfade 增益與 Master 時間軸當前實際播放曲目 ID
let wasInSilenceGap = false;
let lastAppliedCrossfadeGain = 1.0;
let lastTimelineTrackId: string | null = null;
let lastProgressPersistMs = 0;
// 當正在向 C++ 宿主進行非同步查詢對時期間，暫停本地 advancePlaybackTick 介入，避免舊秒數觸發錯誤的切歌指令或覆寫 localStorage
let isResyncingFromHost = false;
let inFlightHostSyncPromise: Promise<void> | null = null;
// 記錄視窗從最小化/背景恢復可見的時間戳記，在宿主快照回傳前短暫凍結本地盲目推進，消除開窗瞬間 seekhead 先跳再拉回的閃動
let lastVisibilityRestoreAtMs = 0;
// 記錄最後一次更新 masterTimeSeconds 的高精度時間戳記，供 MasterTimeline 60FPS 視覺插值使用
let lastTickPerfMs = 0;
// 記錄當雙控制器交由 C++ 原生無縫切歌時，是否已發送過逾時備援切歌指令
let nativeGaplessFallbackSentForOrder: number | null = null;
// 記錄使用者最後一次手動點擊時間軸跳轉 (Seek) 或切換播放/暫停的時間戳記，防止非同步回傳的過時宿主進度造成 seekhead 往回跳 0.5~1s
let lastUserSeekOrToggleAtMs = 0;
// 記錄視窗進入背景/最小化當下的基準時間與基準總時間軸秒數，供離線/背景喚醒時精準計算真實經過秒數
let backgroundAnchorTimestampMs: number | null = null;
let backgroundAnchorMasterSec: number | null = null;

// 記錄目前已同步給宿主的 Stop After Current 狀態，以及當前曲目結束後的 Silence 區間起訖錨點
let lastAppliedStopAfterCurrent: boolean | null = null;
let activeSilenceEofTarget: {
    timelineEndSec: number;
    nextStartSec: number;
    mixOutSec: number;
} | null = null;
// 專用 Silence 靜音區間結束喚醒計時器，確保即使背景 tick 受節流也能在靜音秒數結束瞬間準時啟動下一首曲目
let silenceGapWakeTimer: ReturnType<typeof setTimeout> | null = null;
let latestCachedFlatQueue: FlatPlayQueueItem[] = [];
let latestCachedLibraryTracks: Track[] = [];

const clearSilenceGapWakeTimer = (): void => {
    if (silenceGapWakeTimer !== null) {
        clearTimeout(silenceGapWakeTimer);
        silenceGapWakeTimer = null;
    }
};

const markMasterClockUpdated = (): void => {
    lastTickPerfMs =
        typeof performance !== 'undefined' ? performance.now() : 0;
};

/**
 * 通知播放器視窗剛從最小化或背景狀態恢復顯示，短暫凍結本地盲推並等待宿主對時完成
 */
export const notifyWindowRestoredFromHidden = (): void => {
    lastVisibilityRestoreAtMs = Date.now();
};

/**
 * 供 MasterTimeline 60FPS requestAnimationFrame 讀取的平滑插值秒數（不觸發額外 Zustand re-render）
 */
export const getLiveInterpolatedMasterTime = (
    isPlaying: boolean,
    masterTimeSeconds: number,
    masterTotalDuration: number
): number => {
    if (
        !isPlaying ||
        isResyncingFromHost ||
        lastTickPerfMs <= 0 ||
        typeof performance === 'undefined'
    ) {
        return masterTimeSeconds;
    }
    if (
        lastVisibilityRestoreAtMs > 0 &&
        Date.now() - lastVisibilityRestoreAtMs < 280
    ) {
        return masterTimeSeconds;
    }
    const elapsedSec = Math.max(
        0,
        Math.min(0.22, (performance.now() - lastTickPerfMs) / 1000)
    );
    const interpolated = masterTimeSeconds + elapsedSec;
    return masterTotalDuration > 0
        ? Math.min(masterTotalDuration, interpolated)
        : interpolated;
};

const computeSilenceStopAfterCurrentMeta = (
    flatQueue: FlatPlayQueueItem[],
    queueOrder: number | undefined
): {
    shouldStop: boolean;
    eofTarget: {
        timelineEndSec: number;
        nextStartSec: number;
        mixOutSec: number;
    } | null;
} => {
    if (!queueOrder || flatQueue.length === 0) {
        return { shouldStop: false, eofTarget: null };
    }
    const idx = flatQueue.findIndex((item) => item.order === queueOrder);
    if (idx === -1) {
        return { shouldStop: false, eofTarget: null };
    }
    const currentItem = flatQueue[idx];
    const nextItem = idx + 1 < flatQueue.length ? flatQueue[idx + 1] : null;
    const isSilence =
        currentItem.transitionToNext?.type === 'SILENCE' &&
        (currentItem.transitionToNext?.duration ?? 0) > 0 &&
        Boolean(nextItem) &&
        nextItem!.timelineStartSec > currentItem.timelineEndSec;
    if (!isSilence || !nextItem) {
        return { shouldStop: false, eofTarget: null };
    }
    const mixOutSec = currentItem.cuePoints?.mixOut ?? currentItem.duration;
    // 造成原錯誤的原因：先前僅在 mixOutSec >= duration - 0.5 時才啟用 Stop After Current；當宿主 Audio Buffer 設為 1000ms~2000ms 且 mixOut 距結尾 0.6s~1.8s 時，C++ 解碼執行緒仍會先觸及實體 EOF 並偷跑解碼下一首。
    // 本次修改的目的：只要下一段過渡為 SILENCE，一律啟用宿主 Stop After Current，徹底與宿主緩衝區長度脫鉤。
    return {
        shouldStop: true,
        eofTarget: {
            timelineEndSec: currentItem.timelineEndSec,
            nextStartSec: nextItem.timelineStartSec,
            mixOutSec,
        },
    };
};

/**
 * 全局播放器操作介面 (PlayerActions)
 */
interface PlayerActions {
    // 預載曲目至介面（更新「主視覺與動態監控」封面與資訊，絕不影響總時間軸 seekhead 或觸發播放）
    preloadTrack: (track: Track, queueOrder?: number) => void;

    // 智慧媒體庫「試聽」按鈕專用：與總時間軸播放按鈕完全獨立，開始或停止試聽該首媒體庫曲目
    previewPlayTrack: (track: Track) => void;

    // 畫布 MiniWaveform 拉動 Mix-In / Mix-Out 即時聲音預聽（與總時間軸完全隔離，拉動 MIX-OUT 時從 mixOut 前 1.8s 播至 mixOut 自動停住，放開滑鼠即停）
    startCueScrubPreview: (
        track: Track,
        targetSec: number,
        handleType: 'mixIn' | 'mixOut'
    ) => void;
    stopCueScrubPreview: () => void;

    // 基本播放與曲目載入控制
    loadTrack: (track: Track, queueOrder?: number) => void;
    togglePlay: (
        flatQueue?: FlatPlayQueueItem[],
        libraryTracks?: Track[]
    ) => void;
    setPlaying: (isPlaying: boolean) => void;

    // 接收來自 foobar2000 宿主的狀態同步（純更新本地狀態，絕不回傳指令避免迴授斷音）
    syncPlaybackFromHost: (
        isPlaying: boolean,
        trackTimeSeconds?: number,
        hostState?: 'playing' | 'paused' | 'stopped'
    ) => void;

    // 接收來自 foobar2000 宿主的自然切歌事件 (playback:trackChanged)，即時將總時間軸 seekhead、當前曲目與封面同步至下一首歌
    syncTrackChangeFromHost: (
        hostTrack: {
            path: string;
            absolutePath?: string;
            handle?: string;
            title?: string;
            artist?: string;
            album?: string;
            duration?: number;
            position?: number;
            playlistRowIndex?: number | null;
        },
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[]
    ) => void;

    setVolume: (volume: number) => void;
    toggleMute: () => void;

    // Master 全局時間軸與單曲進度同步 (Instant Scrubbing 規格書 5.2)
    seekMasterTimeline: (
        globalSeconds: number,
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[],
        options?: { commitPersistence?: boolean; sendHostSeek?: boolean }
    ) => void;
    seekCurrentTrack: (trackOffsetSeconds: number) => void;
    advancePlaybackTick: (
        deltaSeconds: number,
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[]
    ) => void;
    persistPlaybackProgressNow: () => void;
    resetTimelinePosition: () => void;
    syncMasterTimelineWithHostPosition: (
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[]
    ) => Promise<void>;

    // [方向 C] DJ 段落跳轉控制 (上一首 / 下一首 / 快退快進 ±N 秒)
    skipToPreviousTrack: (
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[]
    ) => void;
    skipToNextTrack: (
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[]
    ) => void;
    nudgeMasterTimeline: (
        deltaSeconds: number,
        flatQueue: FlatPlayQueueItem[],
        libraryTracks: Track[]
    ) => void;

    // 總時間軸循環播放、演出鎖定模式與視窗置頂切換 (規格書 2.1)
    toggleTimelineLoop: () => void;
    toggleLiveLock: () => void;
    toggleAlwaysOnTop: () => void;

    // 視覺化模式、主色調與即時音訊電平更新 (規格書 2.3 & Phase 7)
    setVisualizerMode: (mode: VisualizerMode) => void;
    setDominantColor: (hexColor: string) => void;
    updateAudioMeters: (vuLevels: StereoVULevels, spectrumBins: number[]) => void;
    updateHostStatus: (partial: Partial<HostStatus>) => void;
    updateCurrentTrackComputedMeta: (
        trackId: string,
        path: string,
        patch: {
            bpm?: number;
            key?: string;
            duration?: number;
            coverUrl?: string;
        }
    ) => void;
}

export type PlayerStore = PlayerState & PlayerActions;

/**
 * [輔助函式] 根據單曲當前秒數與 Cue 點設定 (mixIn / mixOut / loopCount)，判讀目前處於哪個 Cue 區段標籤
 */
const evaluateActiveCueLabel = (
    track: Track | null,
    trackTimeSec: number
): string | null => {
    if (!track) return null;
    const { mixIn, mixOut, loopCount = 1 } = track.cuePoints;

    if (Math.abs(trackTimeSec - mixIn) <= 1.5) {
        return 'Mix-In 進歌點';
    }
    if (trackTimeSec >= mixOut - 1.5) {
        return 'Mix-Out 轉場區間';
    }
    if (loopCount > 1 && trackTimeSec >= mixIn && trackTimeSec <= mixOut) {
        return `Loop 區間循環中 (x${loopCount})`;
    }
    return null;
};

/**
 * [輔助函式] 產生模擬的 64 軌頻譜與 L/R 立體聲 VU 電平（僅供非 WebView2 瀏覽器預覽模式使用）
 */
const generateSimulatedMeters = (
    isPlaying: boolean,
    volume: number,
    isMuted: boolean
): { vuLevels: StereoVULevels; spectrumBins: number[] } => {
    const effectiveGain = isPlaying && !isMuted ? volume : 0;

    if (effectiveGain <= 0) {
        return {
            vuLevels: { leftPeak: 0, leftRms: 0, rightPeak: 0, rightRms: 0 },
            spectrumBins: Array.from({ length: 64 }, () => 0),
        };
    }

    const baseL = (0.45 + Math.random() * 0.4) * effectiveGain;
    const baseR = (0.45 + Math.random() * 0.4) * effectiveGain;

    const vuLevels: StereoVULevels = {
        leftPeak: Number(Math.min(1, baseL + 0.12).toFixed(3)),
        leftRms: Number((baseL * 0.78).toFixed(3)),
        rightPeak: Number(Math.min(1, baseR + 0.12).toFixed(3)),
        rightRms: Number((baseR * 0.78).toFixed(3)),
    };

    const spectrumBins = Array.from({ length: 64 }, (_, idx) => {
        const freqWeight = Math.max(0.15, 1 - idx / 75);
        const val = (0.2 + Math.random() * 0.75) * freqWeight * effectiveGain;
        return Number(Math.min(1, val).toFixed(3));
    });

    return { vuLevels, spectrumBins };
};

/**
 * 從媒體庫清單或 FlatPlayQueueItem 還原完整的目標 Track 物件，確保點擊總時間軸或切換上下首時絕不漏失目標曲目
 * [修復註記]
 * 造成錯誤的原因：當視窗最小化後在背景自然切入下一首歌時，佇列項目 (`FlatPlayQueueItem`) 自 `localStorage` 還原時可能已剝除大於 4KB 的 Base64 封面，
 * 且若僅用 `trackId` 比對可能因 ID 重新生成而未命中 `libraryTracks` 內的最新封面。
 * 修改的目的：同時支援 `trackId` 與正規化路徑 (`normalizeAudioPathForMatch`) 比對 `libraryTracks`，並自動從雙層封面快取 (`getCachedCoverSync`) 補齊封面，
 * 確保背景切歌或視窗開啟對時後，右側主視覺面板的大封面與曲目資訊立即顯示正確的下一首歌。
 */
const resolveTrackFromQueueOrLibrary = (
    trackId: string,
    queueOrder: number,
    flatQueue: FlatPlayQueueItem[],
    libraryTracks: Track[],
    fallbackTrack: Track | null
): Track | null => {
    const queueItem =
        flatQueue.find((item) => item.order === queueOrder) ??
        flatQueue.find((item) => item.trackId === trackId);

    const targetNormPath = normalizeAudioPathForMatch(queueItem?.path);

    const fromLib =
        libraryTracks.find((t) => t.id === trackId) ??
        (targetNormPath
            ? libraryTracks.find(
                  (t) => normalizeAudioPathForMatch(t.path) === targetNormPath
              )
            : undefined);

    if (fromLib) {
        const cachedCover =
            fromLib.coverUrl ||
            queueItem?.coverUrl ||
            getCachedCoverSync(fromLib.path, fromLib.artist, fromLib.album) ||
            '';
        return {
            ...fromLib,
            ...(cachedCover ? { coverUrl: cachedCover } : {}),
            ...(queueItem?.cuePoints ? { cuePoints: queueItem.cuePoints } : {}),
        };
    }

    if (queueItem) {
        const cachedCover =
            queueItem.coverUrl ||
            getCachedCoverSync(
                queueItem.path,
                queueItem.artist,
                queueItem.album
            ) ||
            '';
        return {
            id: queueItem.trackId,
            albumId: queueItem.albumId,
            title: queueItem.title,
            artist: queueItem.artist,
            album: queueItem.album,
            bpm: queueItem.bpm,
            key: queueItem.key,
            genre: 'DJ Workflow',
            rating: 5,
            duration: queueItem.duration,
            coverUrl: cachedCover,
            path: queueItem.path,
            format: queueItem.format,
            waveform: queueItem.waveform ?? [0.3, 0.6, 0.8, 0.7, 0.5],
            cuePoints: queueItem.cuePoints,
        };
    }

    return fallbackTrack;
};

/**
 * [修復最小化背景自然切歌後佇列定位錯誤]
 * 造成錯誤的原因：
 * 1. 先前在 `syncMasterTimelineWithHostPosition` 中直接使用未去除 `file://` 的路徑字串比對，導致比對失敗並退回舊的 `state.currentQueueOrder`（前一首歌）。
 * 2. 當佇列中有多首曲目時，若宿主已自然進入下一首歌，應優先從 `currentQueueOrder` 的當前與後續順向位置尋找匹配的曲目區段。
 * 修改的目的：
 * 透過正規化路徑集合 (`normPaths`)、檔名主幹 (`fileStems`)、標題與播放清單列索引 (`playlistRowIndex`) 進行多層次比對，
 * 當宿主曲目已改變時精準定位至總時間軸上的新曲目區段。
 */
const findMatchingQueueItemFromHost = (
    flatQueue: FlatPlayQueueItem[],
    currentQueueOrder: number,
    hostInfo: {
        path?: string | null;
        absolutePath?: string | null;
        handle?: string | null;
        title?: string | null;
        artist?: string | null;
        playlistRowIndex?: number | null;
    },
    wasNearCurrentTrackEnd = false
): FlatPlayQueueItem | null => {
    if (flatQueue.length === 0) return null;

    const normPaths = new Set<string>();
    const fileStems = new Set<string>();
    for (const candidate of [
        hostInfo.absolutePath,
        hostInfo.path,
        hostInfo.handle,
    ]) {
        const np = normalizeAudioPathForMatch(candidate);
        if (np) normPaths.add(np);
        const stem = extractFilenameStemForMatch(candidate);
        if (stem) fileStems.add(stem);
    }

    const cleanTitle = (hostInfo.title ?? '').trim().toLowerCase();

    const matchesByExactNormalizedPath = (item: FlatPlayQueueItem): boolean => {
        if (normPaths.size === 0) return false;
        const itemNorm = normalizeAudioPathForMatch(item.path);
        if (!itemNorm) return false;
        if (normPaths.has(itemNorm)) return true;
        for (const np of normPaths) {
            if (itemNorm.endsWith(np) || np.endsWith(itemNorm)) {
                return true;
            }
        }
        return false;
    };

    const matchesByStemOrTitle = (item: FlatPlayQueueItem): boolean => {
        const itemStem = extractFilenameStemForMatch(item.path);
        if (itemStem && fileStems.has(itemStem)) return true;
        if (cleanTitle && item.title.trim().toLowerCase() === cleanTitle) {
            return true;
        }
        return false;
    };

    const currentIdx = flatQueue.findIndex(
        (item) => item.order === currentQueueOrder
    );

    // 1. 若宿主提供了明確的播放清單列索引，且該列索引對應的佇列項目路徑吻合，直接採用該區段
    if (
        typeof hostInfo.playlistRowIndex === 'number' &&
        hostInfo.playlistRowIndex >= 0 &&
        hostInfo.playlistRowIndex < flatQueue.length
    ) {
        const rowItem = flatQueue[hostInfo.playlistRowIndex];
        if (
            matchesByExactNormalizedPath(rowItem) ||
            matchesByStemOrTitle(rowItem)
        ) {
            return rowItem;
        }
    }

    // [修復問題 1：當佇列有連續相同曲目區段 (如 B -> B') 且當前曲目已播至結尾時，優先匹配下一區段 B']
    // 造成原錯誤的原因：先前步驟 2 無條件先檢查 `flatQueue[currentIdx]`，當 B 與下一首 B' 為相同檔案路徑時，永遠命中當前區段 B，導致時間軸跳回 B 的起點。
    // 本次修改的目的：當 `wasNearCurrentTrackEnd === true` 且下一區段 (`currentIdx + 1`) 路徑與宿主吻合時，優先回傳下一區段。
    if (
        wasNearCurrentTrackEnd &&
        currentIdx !== -1 &&
        currentIdx + 1 < flatQueue.length &&
        matchesByExactNormalizedPath(flatQueue[currentIdx + 1])
    ) {
        return flatQueue[currentIdx + 1];
    }

    // 2. 若當前 queueOrder 所在的區段路徑與宿主當前播放曲目完全一致，代表仍在同一首歌內推進
    if (
        currentIdx !== -1 &&
        matchesByExactNormalizedPath(flatQueue[currentIdx])
    ) {
        return flatQueue[currentIdx];
    }

    // 3. 若宿主路徑已變更（例如在最小化背景播放期間自然進入下一首歌），從 currentIdx + 1 順向往後搜尋（支援循環繞回）
    if (normPaths.size > 0) {
        const startIdx = currentIdx !== -1 ? currentIdx + 1 : 0;
        for (let offset = 0; offset < flatQueue.length; offset++) {
            const idx = (startIdx + offset) % flatQueue.length;
            if (matchesByExactNormalizedPath(flatQueue[idx])) {
                return flatQueue[idx];
            }
        }
    }

    // 4. 次要備援：以純檔名主幹或曲名順向搜尋（先看當前區段，若無則往後找下一首）
    if (fileStems.size > 0 || cleanTitle) {
        if (currentIdx !== -1 && matchesByStemOrTitle(flatQueue[currentIdx])) {
            return flatQueue[currentIdx];
        }
        const startIdx = currentIdx !== -1 ? currentIdx + 1 : 0;
        for (let offset = 0; offset < flatQueue.length; offset++) {
            const idx = (startIdx + offset) % flatQueue.length;
            if (matchesByStemOrTitle(flatQueue[idx])) {
                return flatQueue[idx];
            }
        }
    }

    // [修復問題 2：防止佇列外歌曲被誤判為當前佇列曲目並把 seekhead 重置回該曲開頭]
    // 造成錯誤的原因：先前第 5 與第 6 步在路徑與曲名完全不吻合時，仍無條件退回 `flatQueue[playlistRowIndex]` 或 `flatQueue[currentIdx]`（例如第 2 首歌），
    // 導致當 foobar2000 播到第 2 首歌結尾並誤跳去播舊清單中的佇列外歌曲（進度 0.0s）時，系統把這首佇列外歌曲的 0.0s 套用到第 2 首歌身上，造成 seekhead 跳回第 2 首歌開頭！
    // 修改的目的：只要宿主有回傳明確的曲目路徑 (`normPaths.size > 0`) 或曲名 (`cleanTitle`)，且前 4 步皆無法在 `flatQueue` 中找到匹配曲目，
    // 代表宿主目前播放的是一首「不在播放佇列內的外部歌曲」，此時必須回傳 `null` 交由上層強制導正至佇列下一首歌！
    const hasExplicitHostTrackIdentity =
        normPaths.size > 0 || fileStems.size > 0 || Boolean(cleanTitle);
    if (hasExplicitHostTrackIdentity) {
        return null;
    }

    // 5. 當宿主完全未提供路徑或曲名、僅提供播放清單列索引時才使用列索引
    if (
        typeof hostInfo.playlistRowIndex === 'number' &&
        hostInfo.playlistRowIndex >= 0 &&
        hostInfo.playlistRowIndex < flatQueue.length
    ) {
        return flatQueue[hostInfo.playlistRowIndex];
    }

    // [修復問題 2：防止最小化背景切歌時因缺少曲目識別資訊而誤退回 flatQueue[0]（第一首歌）]
    // 造成錯誤的原因：先前第 6 步寫了 `return (currentIdx !== -1 ? flatQueue[currentIdx] : null) ?? flatQueue[0]`，
    // 當背景切歌事件未帶完整資訊時，退回 `flatQueue[0]` 或 `flatQueue[currentIdx]`（搭配 position = 0s）會導致時間軸與播放器跳回第一首重新播放。
    // 修改的目的：無任何曲目識別資訊且無有效列索引時回傳 `null`，交由上層依佇列順序推進至 `expectedNextItem`。
    return null;
};

const PLAYER_SELECTION_STORAGE_KEY = 'foobar_dj_player_selection_v1';

interface SavedPlayerSelection {
    currentTrack: Track | null;
    currentQueueOrder: number;
    trackTimeSeconds: number;
    masterTimeSeconds: number;
    isTimelineLoopEnabled: boolean;
    visualizerMode: VisualizerMode;
    dominantColor: string;
    wasPlaying?: boolean;
    lastUpdatedAt?: number;
}

const loadSavedPlayerSelection = (): SavedPlayerSelection => {
    const fallback: SavedPlayerSelection = {
        currentTrack: null,
        currentQueueOrder: 1,
        trackTimeSeconds: 0,
        masterTimeSeconds: 0,
        isTimelineLoopEnabled: false,
        visualizerMode: 'spectrum',
        dominantColor: '#06b6d4',
        wasPlaying: false,
        lastUpdatedAt: 0,
    };
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(
                PLAYER_SELECTION_STORAGE_KEY
            );
            if (!raw) return fallback;
            const parsed = JSON.parse(raw) as Partial<SavedPlayerSelection>;
            if (parsed && typeof parsed === 'object') {
                const rawTrack =
                    parsed.currentTrack &&
                    typeof parsed.currentTrack.id === 'string'
                        ? parsed.currentTrack
                        : null;
                const cachedCover = rawTrack
                    ? getCachedCoverSync(
                          rawTrack.path,
                          rawTrack.artist,
                          rawTrack.album
                      )
                    : undefined;
                return {
                    currentTrack: rawTrack
                        ? {
                              ...rawTrack,
                              coverUrl: cachedCover || rawTrack.coverUrl,
                          }
                        : null,
                    currentQueueOrder:
                        typeof parsed.currentQueueOrder === 'number'
                            ? parsed.currentQueueOrder
                            : 1,
                    trackTimeSeconds:
                        typeof parsed.trackTimeSeconds === 'number'
                            ? parsed.trackTimeSeconds
                            : 0,
                    masterTimeSeconds:
                        typeof parsed.masterTimeSeconds === 'number'
                            ? parsed.masterTimeSeconds
                            : 0,
                    isTimelineLoopEnabled: Boolean(
                        parsed.isTimelineLoopEnabled
                    ),
                    visualizerMode:
                        parsed.visualizerMode === 'spectrum' ||
                        parsed.visualizerMode === 'oscilloscope' ||
                        parsed.visualizerMode === 'particles'
                            ? parsed.visualizerMode
                            : 'spectrum',
                    dominantColor:
                        typeof parsed.dominantColor === 'string' &&
                        parsed.dominantColor
                            ? parsed.dominantColor
                            : '#06b6d4',
                    wasPlaying: Boolean(parsed.wasPlaying),
                    lastUpdatedAt:
                        typeof parsed.lastUpdatedAt === 'number'
                            ? parsed.lastUpdatedAt
                            : 0,
                };
            }
        }
    } catch {
        // ignore storage errors
    }
    return fallback;
};

const savePlayerSelection = (state: {
    currentTrack: Track | null;
    currentQueueOrder: number;
    trackTimeSeconds: number;
    masterTimeSeconds: number;
    isTimelineLoopEnabled: boolean;
    visualizerMode: VisualizerMode;
    dominantColor: string;
    isPlaying?: boolean;
}): void => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const compactTrack = state.currentTrack
                ? {
                      ...state.currentTrack,
                      coverUrl:
                          state.currentTrack.coverUrl &&
                          state.currentTrack.coverUrl.startsWith('data:') &&
                          state.currentTrack.coverUrl.length > 4096
                              ? undefined
                              : state.currentTrack.coverUrl,
                  }
                : null;
            const payload: SavedPlayerSelection = {
                currentTrack: compactTrack,
                currentQueueOrder: state.currentQueueOrder,
                trackTimeSeconds: state.trackTimeSeconds,
                masterTimeSeconds: state.masterTimeSeconds,
                isTimelineLoopEnabled: state.isTimelineLoopEnabled,
                visualizerMode: state.visualizerMode,
                dominantColor: state.dominantColor,
                wasPlaying: Boolean(state.isPlaying),
                lastUpdatedAt: Date.now(),
            };
            window.localStorage.setItem(
                PLAYER_SELECTION_STORAGE_KEY,
                JSON.stringify(payload)
            );
            lastProgressPersistMs = Date.now();
        }
    } catch {
        // ignore quota errors
    }
};

const initialPlayerSelection = loadSavedPlayerSelection();
let hasConsumedInitialBackgroundResume = false;

/**
 * [Zustand Store] 管理全局播放進度、Instant Scrubbing、段落跳轉、演出鎖定模式與音訊視覺化數據
 */
export const usePlayerStore = create<PlayerStore>((set, get) => ({
    // 初始狀態 (對應 PlayerState，優先還原最小化前的選中曲目與狀態)
    currentTrack: initialPlayerSelection.currentTrack,
    currentQueueOrder: initialPlayerSelection.currentQueueOrder,
    isPlaying: false,
    isPreviewPlaying: false,
    previewTrackId: null,
    previewTrack: null,
    previewTimeSeconds: 0,
    volume: 0.85,
    isMuted: false,
    trackTimeSeconds: initialPlayerSelection.trackTimeSeconds,
    masterTimeSeconds: initialPlayerSelection.masterTimeSeconds,
    masterTotalDuration: 0,
    isTimelineLoopEnabled: initialPlayerSelection.isTimelineLoopEnabled,
    isLiveLocked: false,
    activeCueLabel: evaluateActiveCueLabel(
        initialPlayerSelection.currentTrack,
        initialPlayerSelection.trackTimeSeconds
    ),
    visualizerMode: initialPlayerSelection.visualizerMode,
    vuLevels: { leftPeak: 0, leftRms: 0, rightPeak: 0, rightRms: 0 },
    spectrumBins: Array.from({ length: 64 }, () => 0),
    dominantColor: initialPlayerSelection.dominantColor,
    hostStatus: {
        isConnectedToBridge: isFoobarWebView(),
        audioDevice: isFoobarWebView()
            ? 'ASIO / WASAPI Exclusive (foobar2000)'
            : 'Web Audio Mock Output (Browser Dev)',
        isAlwaysOnTop: false,
    },

    // 0. 載入曲目至 currentTrack（更新右側「主視覺與動態監控」封面與資訊，絕不觸發播放，亦絕不影響總時間軸 seekhead 與 queueOrder）
    preloadTrack: (track) => {
        const startSec = track.cuePoints?.mixIn ?? 0;
        set((state) => ({
            currentTrack: track,
            ...(state.isPlaying
                ? {}
                : {
                      trackTimeSeconds: startSec,
                      activeCueLabel: evaluateActiveCueLabel(track, startSec),
                  }),
        }));
        savePlayerSelection(get());

        if (track.coverUrl) {
            void extractDominantColorFromUrl(track.coverUrl).then((hex) => {
                if (get().currentTrack?.id === track.id) {
                    set({ dominantColor: hex });
                    savePlayerSelection(get());
                }
            });
        } else if (
            track.path &&
            !track.path.startsWith('C:\\Music\\DJ_Set\\')
        ) {
            void fetchSingleTrackRealCover(
                track.path,
                track.artist,
                track.album
            ).then((realCover) => {
                if (!realCover) return;
                get().updateCurrentTrackComputedMeta(track.id, track.path, {
                    coverUrl: realCover,
                });
            });
        }
    },

    // 0.5 智慧媒體庫「試聽」按鈕專用：與底部 Master 總時間軸按鈕完全獨立！
    // 只控制 isPreviewPlaying / previewTrack，絕不覆寫總時間軸的 currentTrack 或 seekhead，確保駱駝色輪「當前」永遠錨定時間軸位置
    previewPlayTrack: (track) => {
        const {
            isPreviewPlaying,
            previewTrackId,
            previewTimeSeconds,
            currentTrack,
            volume,
            isMuted,
        } = get();

        const isThisTrackAlreadyPreviewing =
            isPreviewPlaying && previewTrackId === track.id;

        if (isThisTrackAlreadyPreviewing) {
            wasInSilenceGap = false;
            if (lastAppliedCrossfadeGain !== 1.0) {
                lastAppliedCrossfadeGain = 1.0;
                bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
            }
            sendCommandToHost('SET_PLAYBACK_STATE', {
                isPlaying: false,
                trackId: track.id,
                path: track.path,
                title: track.title,
                offsetSeconds: previewTimeSeconds,
            });
            set({
                isPreviewPlaying: false,
                previewTrackId: null,
                previewTrack: null,
                previewTimeSeconds: 0,
                vuLevels: {
                    leftPeak: 0,
                    leftRms: 0,
                    rightPeak: 0,
                    rightRms: 0,
                },
                spectrumBins: Array.from({ length: 64 }, () => 0),
            });
            if (currentTrack?.coverUrl) {
                void extractDominantColorFromUrl(currentTrack.coverUrl).then(
                    (hex) => {
                        if (!get().isPreviewPlaying) {
                            set({ dominantColor: hex });
                        }
                    }
                );
            }
            return;
        }

        wasInSilenceGap = false;
        if (lastAppliedCrossfadeGain !== 1.0) {
            lastAppliedCrossfadeGain = 1.0;
            bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
        }

        const startSec = 0;
        bridgeApi.cueOrPlayTrack(track, startSec, true, { isPreview: true });

        const simulated = isFoobarWebView()
            ? null
            : generateSimulatedMeters(true, volume, isMuted);

        set((state) => ({
            // 若總時間軸原本正在播放，因硬體音訊通道切換至試聽，將總時間軸保持在原 seekhead 並設為未播放
            isPlaying: false,
            isPreviewPlaying: true,
            previewTrackId: track.id,
            previewTrack: track,
            previewTimeSeconds: startSec,
            vuLevels: simulated ? simulated.vuLevels : state.vuLevels,
            spectrumBins: simulated
                ? simulated.spectrumBins
                : state.spectrumBins,
        }));

        if (track.coverUrl) {
            void extractDominantColorFromUrl(track.coverUrl).then((hex) => {
                if (
                    get().isPreviewPlaying &&
                    get().previewTrackId === track.id
                ) {
                    set({ dominantColor: hex });
                }
            });
        } else if (
            track.path &&
            !track.path.startsWith('C:\\Music\\DJ_Set\\')
        ) {
            void fetchSingleTrackRealCover(track.path).then((realCover) => {
                if (!realCover) return;
                get().updateCurrentTrackComputedMeta(track.id, track.path, {
                    coverUrl: realCover,
                });
                if (
                    get().isPreviewPlaying &&
                    get().previewTrackId === track.id
                ) {
                    void extractDominantColorFromUrl(realCover).then((hex) => {
                        if (
                            get().isPreviewPlaying &&
                            get().previewTrackId === track.id
                        ) {
                            set({ dominantColor: hex });
                        }
                    });
                }
            });
        }
    },

    // 0.6 畫布 MiniWaveform 拉動 Mix-In / Mix-Out 時的即時聲音預聽（與總時間軸完全隔離）
    startCueScrubPreview: (track, targetSec, handleType) => {
        const { volume, isMuted } = get();
        wasInSilenceGap = false;
        clearSilenceGapWakeTimer();
        if (lastAppliedCrossfadeGain !== 1.0) {
            lastAppliedCrossfadeGain = 1.0;
            bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
        }

        const safeDur = Math.max(1, track.duration);
        const clampedTarget = Math.max(0, Math.min(safeDur, targetSec));
        // 拉動 MIX-OUT 時，從 mixOut 前 1.8 秒開始播放，方便聽清楚收尾落點；拉動 MIX-IN 時直接從 mixIn 開始播放
        const mixInFloor = Math.max(0, track.cuePoints?.mixIn ?? 0);
        const playStartSec =
            handleType === 'mixOut'
                ? Math.max(mixInFloor, Math.max(0, clampedTarget - 1.8))
                : clampedTarget;

        bridgeApi.cueOrPlayTrack(track, playStartSec, true, {
            isPreview: true,
        });

        const simulated = isFoobarWebView()
            ? null
            : generateSimulatedMeters(true, volume, isMuted);

        set((state) => ({
            isPlaying: false,
            isPreviewPlaying: true,
            previewTrackId: track.id,
            previewTrack: track,
            previewTimeSeconds: playStartSec,
            vuLevels: simulated ? simulated.vuLevels : state.vuLevels,
            spectrumBins: simulated
                ? simulated.spectrumBins
                : state.spectrumBins,
        }));
    },

    stopCueScrubPreview: () => {
        const {
            isPreviewPlaying,
            previewTrack,
            previewTimeSeconds,
            currentTrack,
        } = get();
        if (!isPreviewPlaying) return;

        sendCommandToHost('SET_PLAYBACK_STATE', {
            isPlaying: false,
            trackId: previewTrack?.id ?? '',
            path: previewTrack?.path ?? '',
            title: previewTrack?.title ?? '',
            offsetSeconds: previewTimeSeconds,
        });
        set({
            isPreviewPlaying: false,
            previewTrackId: null,
            previewTrack: null,
            previewTimeSeconds: 0,
            vuLevels: {
                leftPeak: 0,
                leftRms: 0,
                rightPeak: 0,
                rightRms: 0,
            },
            spectrumBins: Array.from({ length: 64 }, () => 0),
        });
        if (currentTrack?.coverUrl) {
            void extractDominantColorFromUrl(currentTrack.coverUrl).then(
                (hex) => {
                    if (!get().isPreviewPlaying) {
                        set({ dominantColor: hex });
                    }
                }
            );
        }
    },

    // 1. 使用者點選曲目載入（同步通知 foobar2000 切換至該曲目並定位至 Mix-In）
    loadTrack: (track, queueOrder = 1) => {
        const startSec = track.cuePoints?.mixIn ?? 0;
        bridgeApi.cueOrPlayTrack(track, startSec, get().isPlaying, {
            queueOrder,
        });
        lastTimelineTrackId = track.id;

        set({
            currentTrack: track,
            currentQueueOrder: queueOrder,
            isPreviewPlaying: false,
            previewTrackId: null,
            previewTrack: null,
            previewTimeSeconds: 0,
            trackTimeSeconds: startSec,
            activeCueLabel: evaluateActiveCueLabel(track, startSec),
        });
        savePlayerSelection(get());

        if (track.coverUrl) {
            void extractDominantColorFromUrl(track.coverUrl).then((hex) => {
                if (get().currentTrack?.id === track.id) {
                    set({ dominantColor: hex });
                    savePlayerSelection(get());
                }
            });
        } else if (
            track.path &&
            !track.path.startsWith('C:\\Music\\DJ_Set\\')
        ) {
            void fetchSingleTrackRealCover(
                track.path,
                track.artist,
                track.album
            ).then((realCover) => {
                if (!realCover) return;
                get().updateCurrentTrackComputedMeta(track.id, track.path, {
                    coverUrl: realCover,
                });
            });
        }
    },

    // 2. Master 總時間軸播放 / 暫停切換（與媒體庫試聽按鈕完全獨立；啟動時自動停止試聽並對準時間軸 seekhead）
    togglePlay: (flatQueue, libraryTracks) => {
        lastUserSeekOrToggleAtMs = Date.now();
        const {
            isPlaying,
            currentTrack,
            trackTimeSeconds,
            masterTimeSeconds,
            volume,
            isMuted,
        } = get();
        const nextPlaying = !isPlaying;

        wasInSilenceGap = false;
        if (lastAppliedCrossfadeGain !== 1.0) {
            lastAppliedCrossfadeGain = 1.0;
            bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
        }

        // 若正要啟動 Master Timeline 播放且有佇列，確保對準當前 masterTimeSeconds 所在的佇列曲目與偏移秒數（若已在尾端則自動回到 0s）
        if (nextPlaying && flatQueue && flatQueue.length > 0) {
            const totalDuration =
                flatQueue[flatQueue.length - 1].timelineEndSec;
            const effectiveMasterTime =
                totalDuration > 0 && masterTimeSeconds >= totalDuration - 0.1
                    ? 0
                    : masterTimeSeconds;
            const seekTarget = resolveMasterTimelineSeek(
                flatQueue,
                effectiveMasterTime
            );
            if (seekTarget) {
                const targetTrack = resolveTrackFromQueueOrLibrary(
                    seekTarget.trackId,
                    seekTarget.queueOrder,
                    flatQueue,
                    libraryTracks ?? [],
                    currentTrack
                );
                if (targetTrack) {
                    lastTimelineTrackId = targetTrack.id;
                    const inSilence = Boolean(seekTarget.isInSilenceGap);
                    wasInSilenceGap = inSilence;

                    // [修復功能 1.3 & 3] 若在 Crossfade 或 Silence 區間按下播放，同步套用當前區間的 Crossfade 增益或保持宿主靜音待命並推進時間軸
                    const targetGain = seekTarget.crossfadeGain ?? 1.0;
                    lastAppliedCrossfadeGain = targetGain;
                    bridgeApi.setCrossfadeOutputVolume(
                        isMuted ? 0 : Math.max(0, Math.min(1, volume * targetGain))
                    );

                    if (inSilence) {
                        activeSilenceEofTarget = null;
                        lastAppliedStopAfterCurrent = false;
                        bridgeApi.pauseForSilenceGap();
                    } else {
                        const stopMeta = computeSilenceStopAfterCurrentMeta(
                            flatQueue,
                            seekTarget.queueOrder
                        );
                        activeSilenceEofTarget = stopMeta.eofTarget;
                        lastAppliedStopAfterCurrent = stopMeta.shouldStop;
                        bridgeApi.cueOrPlayTrack(
                            targetTrack,
                            seekTarget.trackOffsetSeconds,
                            true,
                            {
                                queueOrder: seekTarget.queueOrder,
                                stopAfterCurrent: stopMeta.shouldStop,
                            }
                        );
                    }
                    const meters =
                        isFoobarWebView() || inSilence
                            ? null
                            : generateSimulatedMeters(
                                  true,
                                  volume * targetGain,
                                  isMuted
                              );
                    markMasterClockUpdated();
                    set((state) => ({
                        currentTrack: targetTrack,
                        currentQueueOrder: seekTarget.queueOrder,
                        isPlaying: true,
                        isPreviewPlaying: false,
                        previewTrackId: null,
                        previewTrack: null,
                        previewTimeSeconds: 0,
                        trackTimeSeconds: seekTarget.trackOffsetSeconds,
                        masterTimeSeconds: effectiveMasterTime,
                        masterTotalDuration: totalDuration,
                        activeCueLabel:
                            seekTarget.transitionLabel ??
                            evaluateActiveCueLabel(
                                targetTrack,
                                seekTarget.trackOffsetSeconds
                            ),
                        vuLevels: inSilence
                            ? {
                                  leftPeak: 0,
                                  leftRms: 0,
                                  rightPeak: 0,
                                  rightRms: 0,
                              }
                            : meters
                              ? meters.vuLevels
                              : state.vuLevels,
                        spectrumBins: inSilence
                            ? Array.from({ length: 64 }, () => 0)
                            : meters
                              ? meters.spectrumBins
                              : state.spectrumBins,
                    }));
                    backgroundAnchorTimestampMs = Date.now();
                    backgroundAnchorMasterSec = effectiveMasterTime;
                    savePlayerSelection(get());

                    void extractDominantColorFromUrl(targetTrack.coverUrl).then(
                        (hex) => {
                            if (get().currentTrack?.id === targetTrack.id) {
                                set({ dominantColor: hex });
                            }
                        }
                    );
                    return;
                }
            }
        }

        sendCommandToHost('SET_PLAYBACK_STATE', {
            isPlaying: nextPlaying,
            trackId: currentTrack?.id ?? '',
            path: currentTrack?.path ?? '',
            title: currentTrack?.title ?? '',
            offsetSeconds: trackTimeSeconds,
        });

        if (isFoobarWebView()) {
            set({
                isPlaying: nextPlaying,
                isPreviewPlaying: false,
                previewTrackId: null,
                previewTrack: null,
                previewTimeSeconds: 0,
            });
            if (!nextPlaying) {
                set({
                    vuLevels: {
                        leftPeak: 0,
                        leftRms: 0,
                        rightPeak: 0,
                        rightRms: 0,
                    },
                    spectrumBins: Array.from({ length: 64 }, () => 0),
                });
            }
        } else {
            const meters = generateSimulatedMeters(nextPlaying, volume, isMuted);
            set({
                isPlaying: nextPlaying,
                isPreviewPlaying: false,
                previewTrackId: null,
                previewTrack: null,
                previewTimeSeconds: 0,
                vuLevels: meters.vuLevels,
                spectrumBins: meters.spectrumBins,
            });
        }
        // 無論是按下播放或按下暫停，立即將當前精準的 masterTimeSeconds 與 trackTimeSeconds 保存至 localStorage
        savePlayerSelection(get());
    },

    setPlaying: (isPlaying) => {
        lastUserSeekOrToggleAtMs = Date.now();
        const { currentTrack, trackTimeSeconds, volume, isMuted } = get();
        wasInSilenceGap = false;
        if (lastAppliedCrossfadeGain !== 1.0) {
            lastAppliedCrossfadeGain = 1.0;
            bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
        }

        sendCommandToHost('SET_PLAYBACK_STATE', {
            isPlaying,
            trackId: currentTrack?.id ?? '',
            path: currentTrack?.path ?? '',
            title: currentTrack?.title ?? '',
            offsetSeconds: trackTimeSeconds,
        });

        if (isFoobarWebView()) {
            set({
                isPlaying,
                ...(isPlaying
                    ? {}
                    : {
                          isPreviewPlaying: false,
                          previewTrackId: null,
                          previewTrack: null,
                          previewTimeSeconds: 0,
                      }),
            });
            if (!isPlaying) {
                set({
                    vuLevels: {
                        leftPeak: 0,
                        leftRms: 0,
                        rightPeak: 0,
                        rightRms: 0,
                    },
                    spectrumBins: Array.from({ length: 64 }, () => 0),
                });
            }
        } else {
            const meters = generateSimulatedMeters(isPlaying, volume, isMuted);
            set({
                isPlaying,
                ...(isPlaying
                    ? {}
                    : {
                          isPreviewPlaying: false,
                          previewTrackId: null,
                          previewTrack: null,
                          previewTimeSeconds: 0,
                      }),
                vuLevels: meters.vuLevels,
                spectrumBins: meters.spectrumBins,
            });
        }
        savePlayerSelection(get());
    },

    // 被動同步來自 foobar2000 的播放狀態，區分「媒體庫試聽狀態 (isPreviewPlaying)」與「總時間軸狀態 (isPlaying)」
    syncPlaybackFromHost: (hostPlaying, trackTimeSeconds, hostState) => {
        set((state) => {
            // 情況 1：目前處於媒體庫「試聽」狀態 (isPreviewPlaying)
            if (state.isPreviewPlaying) {
                const isTransientStopDuringPreview =
                    hostState === 'stopped' &&
                    state.previewTrack !== null &&
                    state.previewTimeSeconds < state.previewTrack.duration - 1.5;

                if (isTransientStopDuringPreview) {
                    return {};
                }

                if (!hostPlaying) {
                    return {
                        isPreviewPlaying: false,
                        previewTrackId: null,
                        previewTrack: null,
                        previewTimeSeconds: 0,
                        vuLevels: {
                            leftPeak: 0,
                            leftRms: 0,
                            rightPeak: 0,
                            rightRms: 0,
                        },
                    };
                }

                return {
                    ...(typeof trackTimeSeconds === 'number'
                        ? { previewTimeSeconds: trackTimeSeconds }
                        : {}),
                };
            }

            // 情況 2：目前處於 Master 總時間軸播放狀態 (isPlaying)
            // 造成原錯誤的原因：當視窗最小化時，背景計時器受節流使 state.masterTimeSeconds 落後於真實時間，若宿主因 Stop After Current 在實體 EOF 送出 stopped，原本僅檢查 state.masterTimeSeconds 會漏攔截並將 isPlaying 設為 false 導致背景播放中斷。
            // 本次修改的目的：結合真實時鐘錨點 (estimatedWallMasterSec) 判斷是否抵達 SILENCE 區間，確保最小化背景播放時遇到 SILENCE 也能穩定銜接下一首。
            const estimatedWallMasterSec =
                backgroundAnchorTimestampMs !== null &&
                backgroundAnchorMasterSec !== null
                    ? backgroundAnchorMasterSec +
                      Math.max(
                          0,
                          (Date.now() - backgroundAnchorTimestampMs) / 1000
                      )
                    : state.masterTimeSeconds;
            const effectiveCheckMasterSec = Math.max(
                state.masterTimeSeconds,
                estimatedWallMasterSec
            );

            const isMidQueueTrackEof =
                state.isPlaying &&
                hostState === 'stopped' &&
                state.masterTotalDuration > 0 &&
                (state.masterTimeSeconds < state.masterTotalDuration - 0.5 ||
                    Boolean(activeSilenceEofTarget));

            if (isMidQueueTrackEof) {
                if (
                    activeSilenceEofTarget &&
                    effectiveCheckMasterSec >=
                        activeSilenceEofTarget.timelineEndSec - 3.5
                ) {
                    const eofTarget = activeSilenceEofTarget;
                    const silenceStartGlobalSec = Math.min(
                        eofTarget.nextStartSec,
                        Math.max(
                            eofTarget.timelineEndSec,
                            effectiveCheckMasterSec
                        )
                    );
                    const remainSilenceSec = Math.max(
                        0,
                        eofTarget.nextStartSec - silenceStartGlobalSec
                    );
                    const remainSilence = Number(remainSilenceSec.toFixed(1));

                    // 造成原錯誤的原因：
                    // 1. 當宿主在第一首 EOF 因 Stop After Current 或 jitSession endOfQueue 送出 stopped 時，若靜音倒數結束時呼叫 advancePlaybackTick，可能因視窗剛恢復 (lastVisibilityRestoreAtMs < 280ms) 或對時鎖 (isResyncingFromHost) 而被攔截直接 return，導致第二首永遠無法啟動。
                    // 2. 若在背景喚醒時直接用 seekMasterTimeline 跳至 nextStartSec，就能繞過 advancePlaybackTick 的視覺防抖門檻並直接啟動第二首。
                    // 本次修改的目的：進入 Silence 區間時排程倒數計時器，當 remainSilenceSec <= 0 時立即呼叫 seekMasterTimeline 啟動第二首，否則在計時器到期時以真實牆鐘秒數呼叫 seekMasterTimeline 推進至第二首。
                    wasInSilenceGap = true;
                    backgroundAnchorTimestampMs = Date.now();
                    backgroundAnchorMasterSec = silenceStartGlobalSec;
                    markMasterClockUpdated();

                    clearSilenceGapWakeTimer();
                    const triggerSilenceEndTransition = () => {
                        silenceGapWakeTimer = null;
                        const latestState = get();
                        if (
                            !latestState.isPlaying ||
                            latestCachedFlatQueue.length === 0
                        ) {
                            return;
                        }
                        const liveWallSec =
                            backgroundAnchorTimestampMs !== null &&
                            backgroundAnchorMasterSec !== null
                                ? backgroundAnchorMasterSec +
                                  Math.max(
                                      0,
                                      (Date.now() -
                                          backgroundAnchorTimestampMs) /
                                          1000
                                  )
                                : eofTarget.nextStartSec + 0.04;
                        const targetGlobalSec = Math.max(
                            eofTarget.nextStartSec + 0.02,
                            liveWallSec
                        );
                        wasInSilenceGap = false;
                        lastVisibilityRestoreAtMs = 0;
                        latestState.seekMasterTimeline(
                            targetGlobalSec,
                            latestCachedFlatQueue,
                            latestCachedLibraryTracks,
                            { commitPersistence: true, sendHostSeek: true }
                        );
                    };

                    if (remainSilenceSec <= 0.02) {
                        setTimeout(triggerSilenceEndTransition, 10);
                    } else {
                        silenceGapWakeTimer = setTimeout(
                            triggerSilenceEndTransition,
                            Math.max(
                                30,
                                Math.round(remainSilenceSec * 1000) + 25
                            )
                        );
                    }

                    return {
                        trackTimeSeconds: eofTarget.mixOutSec,
                        masterTimeSeconds: Number(
                            silenceStartGlobalSec.toFixed(2)
                        ),
                        activeCueLabel: `Silence 靜音過渡中 (${remainSilence}s)`,
                        vuLevels: {
                            leftPeak: 0,
                            leftRms: 0,
                            rightPeak: 0,
                            rightRms: 0,
                        },
                        spectrumBins: Array.from({ length: 64 }, () => 0),
                    };
                }

                return {
                    vuLevels: {
                        leftPeak: 0,
                        leftRms: 0,
                        rightPeak: 0,
                        rightRms: 0,
                    },
                };
            }

            // [修復問題 3 (Silence 情況 A)] 若目前正處於兩首曲目之間的 Silence 靜音過渡區間 (wasInSilenceGap)，
            // 宿主 C++ 是被我們主動呼叫 `pauseForSilenceGap()` 暫停的，此時前端計時器必須保持 `isPlaying: true` 繼續走完空白區間，
            // 絕不可被宿主傳來的 `!hostPlaying` 狀態覆寫成 `isPlaying: false`（否則 Pause 按鈕會變回 Play 且 seekhead 停住）！
            if (wasInSilenceGap && state.isPlaying && !hostPlaying) {
                return {
                    vuLevels: {
                        leftPeak: 0,
                        leftRms: 0,
                        rightPeak: 0,
                        rightRms: 0,
                    },
                };
            }

            // [修復問題 3] 若使用者剛在 850ms 內執行過手動點擊時間軸跳轉或切換播放/暫停，忽略宿主事件附帶的過時舊秒數，防止 seekhead 往回跳 0.5~1s
            const isWithinUserActionGuard =
                Date.now() - lastUserSeekOrToggleAtMs < 850;

            return {
                isPlaying: hostPlaying,
                ...(typeof trackTimeSeconds === 'number' &&
                !isWithinUserActionGuard
                    ? { trackTimeSeconds }
                    : {}),
                ...(!hostPlaying
                    ? {
                          vuLevels: {
                              leftPeak: 0,
                              leftRms: 0,
                              rightPeak: 0,
                              rightRms: 0,
                          },
                      }
                    : { vuLevels: state.vuLevels }),
            };
        });
        savePlayerSelection(get());
    },

    // [修復最小化背景自然切歌 & 修復問題 2：單曲播至結尾誤播佇列外歌曲且 seekhead 跳回該曲開頭的問題]
    // 造成錯誤的原因：
    // 1. 當某首佇列曲目（如第 2 首）實際音訊檔長度比排程結束點早 0.1~0.3 秒結束時，foobar2000 C++ 引擎會先觸發 EOF 並自動跳往「DJ Workflow Set」的下一列。
    // 2. 若下一列是舊工作階段殘留的佇列外歌曲（不在 `flatQueue` 內），或是因畫布重新排序導致下一列並非總時間軸排程的下一首（第 3 首），
    //    就會發生「播放不在佇列內的歌」且「seekhead 跳回第 2 首開頭」的異常。
    // 修改的目的：
    // 當收到宿主 `playback:trackChanged` 時，若發現宿主跳往的曲目不在 `flatQueue` 內 (`!matchedItem`)，
    // 或當前曲目已播至接近結尾（距結束 <= 3.5 秒）但宿主跳往的並非總時間軸排程的下一首 (`expectedNextItem`)，
    // 立即強制將總時間軸與宿主導正至 `expectedNextItem`（例如正常進入第 3 首歌）！
    syncTrackChangeFromHost: (hostTrack, flatQueue, libraryTracks) => {
        const state = get();
        // 嚴格保持「智慧媒體庫單曲試聽」與「總時間軸」隔離
        if (state.isPreviewPlaying || flatQueue.length === 0) return;
        latestCachedFlatQueue = flatQueue;
        latestCachedLibraryTracks = libraryTracks;

        const totalDuration = flatQueue[flatQueue.length - 1].timelineEndSec;
        const currentIdx = flatQueue.findIndex(
            (item) => item.order === state.currentQueueOrder
        );
        const currentItem = currentIdx !== -1 ? flatQueue[currentIdx] : null;
        const expectedNextItem =
            currentIdx >= 0 && currentIdx + 1 < flatQueue.length
                ? flatQueue[currentIdx + 1]
                : state.isTimelineLoopEnabled
                  ? flatQueue[0]
                  : null;

        const isWindowHidden =
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden';

        const estimatedWallMasterSec =
            state.isPlaying &&
            backgroundAnchorTimestampMs !== null &&
            backgroundAnchorMasterSec !== null
                ? backgroundAnchorMasterSec +
                  Math.max(0, (Date.now() - backgroundAnchorTimestampMs) / 1000)
                : state.masterTimeSeconds;
        const effectiveMasterSec = Math.max(
            state.masterTimeSeconds,
            estimatedWallMasterSec
        );

        // 造成原錯誤的原因：先前在 hasPendingSilenceAfterCurrent 中排除了 isWindowHidden，導致視窗最小化時若發生切歌事件會直接跳過 SILENCE 靜音區間。
        // 本次修改的目的：移除 !isWindowHidden 限制並結合 effectiveMasterSec，確保前景與背景最小化皆能 100% 攔截 SILENCE 靜音過渡。
        const hasPendingSilenceAfterCurrent =
            state.isPlaying &&
            Boolean(currentItem) &&
            Boolean(expectedNextItem) &&
            currentItem!.transitionToNext.type === 'SILENCE' &&
            (currentItem!.transitionToNext.duration ?? 0) > 0 &&
            expectedNextItem!.timelineStartSec > currentItem!.timelineEndSec &&
            effectiveMasterSec >= currentItem!.timelineEndSec - 3.0 &&
            effectiveMasterSec < expectedNextItem!.timelineStartSec - 0.15;

        if (hasPendingSilenceAfterCurrent && currentItem && expectedNextItem) {
            wasInSilenceGap = true;
            if (lastAppliedCrossfadeGain !== 1.0) {
                lastAppliedCrossfadeGain = 1.0;
                bridgeApi.setCrossfadeOutputVolume(
                    state.isMuted ? 0 : state.volume
                );
            }
            bridgeApi.pauseForSilenceGap();

            const silenceStartGlobalSec = Math.max(
                currentItem.timelineEndSec,
                effectiveMasterSec
            );
            const remainSilenceSec = Math.max(
                0,
                expectedNextItem.timelineStartSec - silenceStartGlobalSec
            );
            const silenceDuration = Number(remainSilenceSec.toFixed(1));
            const nextStartTargetSec = expectedNextItem.timelineStartSec;
            markMasterClockUpdated();
            set({
                trackTimeSeconds:
                    currentItem.cuePoints?.mixOut ?? currentItem.duration,
                masterTimeSeconds: Number(silenceStartGlobalSec.toFixed(2)),
                masterTotalDuration: totalDuration,
                isPlaying: true,
                activeCueLabel: `Silence 靜音過渡中 (${silenceDuration}s)`,
                vuLevels: {
                    leftPeak: 0,
                    leftRms: 0,
                    rightPeak: 0,
                    rightRms: 0,
                },
                spectrumBins: Array.from({ length: 64 }, () => 0),
            });
            backgroundAnchorTimestampMs = Date.now();
            backgroundAnchorMasterSec = silenceStartGlobalSec;
            clearSilenceGapWakeTimer();
            silenceGapWakeTimer = setTimeout(
                () => {
                    silenceGapWakeTimer = null;
                    const latestState = get();
                    if (!latestState.isPlaying || flatQueue.length === 0) {
                        return;
                    }
                    const liveWallSec =
                        backgroundAnchorTimestampMs !== null &&
                        backgroundAnchorMasterSec !== null
                            ? backgroundAnchorMasterSec +
                              Math.max(
                                  0,
                                  (Date.now() - backgroundAnchorTimestampMs) /
                                      1000
                              )
                            : nextStartTargetSec + 0.04;
                    const targetGlobalSec = Math.max(
                        nextStartTargetSec + 0.02,
                        liveWallSec
                    );
                    wasInSilenceGap = false;
                    lastVisibilityRestoreAtMs = 0;
                    latestState.seekMasterTimeline(
                        targetGlobalSec,
                        flatQueue,
                        libraryTracks,
                        { commitPersistence: true, sendHostSeek: true }
                    );
                },
                Math.max(30, Math.round(remainSilenceSec * 1000) + 25)
            );
            savePlayerSelection(get());
            return;
        }

        // 若使用者剛在 600ms 內主動操作跳轉，忽略非同步延遲抵達的舊切歌事件
        if (Date.now() - lastUserSeekOrToggleAtMs < 600) return;

        const wasNearCurrentTrackEnd =
            Boolean(currentItem) &&
            (state.masterTimeSeconds >= currentItem!.timelineEndSec - 4.0 ||
                estimatedWallMasterSec >= currentItem!.timelineEndSec - 4.0 ||
                state.trackTimeSeconds >=
                    (currentItem!.cuePoints?.mixOut ?? currentItem!.duration) -
                        4.0);

        const matchedItem = findMatchingQueueItemFromHost(
            flatQueue,
            state.currentQueueOrder,
            hostTrack,
            wasNearCurrentTrackEnd
        );

        const rawPos =
            typeof hostTrack.position === 'number' &&
            Number.isFinite(hostTrack.position) &&
            hostTrack.position >= 0
                ? hostTrack.position
                : 0;

        // [修復問題 1：防止曲目播完時不進入下一首而跳回該曲開頭重新播放]
        // 造成原錯誤的原因：先前 `jumpedToUnexpectedOrderInBackground` 寫了 `matchedItem!.order !== currentItem?.order`，
        // 導致當曲目已播至結尾 (`wasNearCurrentTrackEnd === true`) 但宿主切歌事件卻跳回本曲開頭 (`matchedItem.order === currentItem.order` 且 `rawPos < 1.5`) 時未被攔截，
        // 進而把前端 `masterTimeSeconds` 與 `seekhead` 重置回該曲起點重播。
        // 本次修改的目的：當曲目已接近結尾且收到跳回本曲開頭的事件（且該區段並非正在執行單曲內部未完成的 Loop 循環）時，強制導正至 `expectedNextItem`（下一首曲目）。
        const replayedSameTrackAtEnd =
            state.isPlaying &&
            wasNearCurrentTrackEnd &&
            Boolean(expectedNextItem) &&
            Boolean(matchedItem) &&
            matchedItem!.order === currentItem?.order &&
            expectedNextItem!.order !== currentItem?.order &&
            rawPos < 1.5;

        // 情況 1：宿主自動跳去播放了一首「不在播放佇列 (flatQueue) 內」的歌，
        // 或在最小化背景播放 / 當前曲目播至結尾時誤跳回本曲開頭或第一首 (而非排程的 expectedNextItem)
        const jumpedToUnexpectedOrderInBackground =
            replayedSameTrackAtEnd ||
            (state.isPlaying &&
                Boolean(expectedNextItem) &&
                Boolean(matchedItem) &&
                matchedItem!.order !== expectedNextItem!.order &&
                matchedItem!.order !== currentItem?.order &&
                (wasNearCurrentTrackEnd ||
                    isWindowHidden ||
                    matchedItem!.order === 1));

        if (!matchedItem || jumpedToUnexpectedOrderInBackground) {
            if (expectedNextItem) {
                get().seekMasterTimeline(
                    expectedNextItem.timelineStartSec,
                    flatQueue,
                    libraryTracks
                );
                return;
            }
            // 若已是佇列最後一首歌且未開啟循環播放，立即停止宿主播放，絕不讓宿主繼續播佇列外的歌
            sendCommandToHost('SET_PLAYBACK_STATE', { isPlaying: false });
            set({
                isPlaying: false,
                masterTimeSeconds: totalDuration,
                vuLevels: {
                    leftPeak: 0,
                    leftRms: 0,
                    rightPeak: 0,
                    rightRms: 0,
                },
                spectrumBins: Array.from({ length: 64 }, () => 0),
            });
            savePlayerSelection(get());
            return;
        }

        const mixIn = matchedItem.cuePoints?.mixIn ?? 0;

        // 若宿主剛自然切入下一首歌的 0.0s，且該曲目在 DJ 畫布設定了 Mix-In 進歌點 (> 0.25s)，自動通知宿主跳至 Mix-In 點並對齊時間軸
        const effectiveTrackSec =
            rawPos < 0.25 && mixIn > 0.25 ? mixIn : rawPos;
        if (rawPos < 0.25 && mixIn > 0.25) {
            bridgeApi.seekTrack(matchedItem.trackId, mixIn);
        }

        const offsetFromMixIn = Math.max(0, effectiveTrackSec - mixIn);
        const newGlobalSec = Math.min(
            matchedItem.timelineEndSec,
            Math.max(
                matchedItem.timelineStartSec,
                matchedItem.timelineStartSec + offsetFromMixIn
            )
        );

        // 計算新進度點對應的 Crossfade 增益（例如剛跨過中點 switchSec 切入下首歌時，增益應從 0.0 開始線性淡入）
        const seekAtNewGlobal = resolveMasterTimelineSeek(
            flatQueue,
            newGlobalSec
        );
        const nextGain = seekAtNewGlobal?.crossfadeGain ?? 1.0;
        if (Math.abs(nextGain - lastAppliedCrossfadeGain) >= 0.01) {
            lastAppliedCrossfadeGain = nextGain;
            bridgeApi.setCrossfadeOutputVolume(
                state.isMuted
                    ? 0
                    : Math.max(0, Math.min(1, state.volume * nextGain))
            );
        }

        const resolvedTrack = resolveTrackFromQueueOrLibrary(
            matchedItem.trackId,
            matchedItem.order,
            flatQueue,
            libraryTracks,
            state.currentTrack
        );

        lastTimelineTrackId = resolvedTrack?.id ?? matchedItem.trackId;
        nativeGaplessFallbackSentForOrder = null;
        wasInSilenceGap = false;

        const stopMeta = computeSilenceStopAfterCurrentMeta(
            flatQueue,
            matchedItem.order
        );
        activeSilenceEofTarget = stopMeta.eofTarget;
        if (lastAppliedStopAfterCurrent !== stopMeta.shouldStop) {
            lastAppliedStopAfterCurrent = stopMeta.shouldStop;
            bridgeApi.setStopAfterCurrent(stopMeta.shouldStop);
        }

        markMasterClockUpdated();
        set({
            currentTrack: resolvedTrack ?? state.currentTrack,
            currentQueueOrder: matchedItem.order,
            trackTimeSeconds: Number(effectiveTrackSec.toFixed(2)),
            masterTimeSeconds: Number(newGlobalSec.toFixed(2)),
            masterTotalDuration: totalDuration,
            isPlaying: true,
            activeCueLabel:
                seekAtNewGlobal?.transitionLabel ??
                evaluateActiveCueLabel(
                    resolvedTrack ?? state.currentTrack,
                    effectiveTrackSec
                ),
        });
        backgroundAnchorTimestampMs = Date.now();
        backgroundAnchorMasterSec = newGlobalSec;
        savePlayerSelection(get());

        // 同步補齊新曲目的真實封面與背景主色調，確保右側主視覺與動態監控面板、小 CD 圖示與駱駝色輪完全一致
        if (resolvedTrack) {
            if (resolvedTrack.coverUrl) {
                void extractDominantColorFromUrl(resolvedTrack.coverUrl).then(
                    (hex) => {
                        if (
                            !get().isPreviewPlaying &&
                            get().currentTrack?.id === resolvedTrack.id
                        ) {
                            set({ dominantColor: hex });
                            savePlayerSelection(get());
                        }
                    }
                );
            } else if (
                resolvedTrack.path &&
                !resolvedTrack.path.startsWith('C:\\Music\\DJ_Set\\')
            ) {
                void fetchSingleTrackRealCover(
                    resolvedTrack.path,
                    resolvedTrack.artist,
                    resolvedTrack.album
                ).then((realCover) => {
                    if (!realCover) return;
                    get().updateCurrentTrackComputedMeta(
                        resolvedTrack.id,
                        resolvedTrack.path,
                        { coverUrl: realCover }
                    );
                });
            }
        }
    },

    // 3. 音量與靜音控制
    // [修復功能 1.3：Crossfade 期間調整音量滑桿 (setVolume) 的防呆保護機制]
    // 設計目的：
    // 1. 當未在播放 (`!isPlaying`) 或處於 Silence 區間 (`wasInSilenceGap`) 時調整音量滑桿，自動將 `lastAppliedCrossfadeGain` 重置為 `1.0`，避免殘留衰減係數。
    // 2. 當正在 Crossfade 區間內播放時調整音量滑桿，以使用者最新設定的基準音量 (`clamped`) 乘上當前包絡線增益 (`lastAppliedCrossfadeGain`) 即時輸出，
    //    且當 Crossfade 結束時會自動恢復至使用者新設定的 `clamped` 100% 音量。
    setVolume: (volume) => {
        const clamped = Math.max(0, Math.min(1, volume));
        const state = get();
        if (!state.isPlaying || wasInSilenceGap) {
            lastAppliedCrossfadeGain = 1.0;
        }
        const effective = Math.max(
            0,
            Math.min(1, clamped * lastAppliedCrossfadeGain)
        );
        sendCommandToHost('SET_MASTER_VOLUME', { volume: effective });
        set({ volume: clamped, isMuted: clamped === 0 });
    },

    toggleMute: () => {
        const nextMuted = !get().isMuted;
        sendCommandToHost('SET_MUTE', { isMuted: nextMuted });
        set({ isMuted: nextMuted });
    },

    // 4. Master 全局時間軸 Instant Scrubbing (規格書 5.2)
    // 支援 60FPS 零阻塞拖曳模式 (commitPersistence=false 避免拖曳期間同步寫入 localStorage 造成卡頓；sendHostSeek 可節流控制)
    seekMasterTimeline: (
        globalSeconds,
        flatQueue,
        libraryTracks,
        options
    ) => {
        if (flatQueue.length === 0) return;

        const commitPersistence = options?.commitPersistence ?? true;
        const sendHostSeek = options?.sendHostSeek ?? true;
        if (sendHostSeek) {
            lastUserSeekOrToggleAtMs = Date.now();
        }

        const totalDuration = flatQueue[flatQueue.length - 1].timelineEndSec;
        const clampedSec = Math.max(0, Math.min(totalDuration, globalSeconds));
        const seekTarget = resolveMasterTimelineSeek(flatQueue, clampedSec);
        if (!seekTarget) return;

        const prevTrackId = get().currentTrack?.id;
        const targetTrack = resolveTrackFromQueueOrLibrary(
            seekTarget.trackId,
            seekTarget.queueOrder,
            flatQueue,
            libraryTracks,
            get().currentTrack
        );

        lastTimelineTrackId = targetTrack?.id ?? null;

        const inSilence = Boolean(seekTarget.isInSilenceGap);
        wasInSilenceGap = inSilence;

        // [修復功能 1.3：在 Crossfade 期間拖曳或點擊跳轉時間軸 (seekMasterTimeline) 的音量防呆機制]
        // 造成錯誤的原因：先前僅在 `sendHostSeek === true` 且差值 `>= 0.02` 時才更新音量，若使用者在 Crossfade 半衰減期間快速把時間軸拉出 Crossfade 區間，
        // 可能因 75ms 節流或微差判斷而使音量卡在衰減狀態，或者跳入 Crossfade 中點 (gain = 0) 時未即時歸零。
        // 修改的目的：只要目標位置的 `gain` 與 `lastAppliedCrossfadeGain` 不同（特別是回到 `1.0` 一般區間或進入 `0.0` 中點時），
        // 立即同步更新 `lastAppliedCrossfadeGain` 並通知宿主調整輸出音量，確保任何時刻跳轉時間軸都不會發生音量鎖死或爆音！
        const gain = inSilence ? 1.0 : (seekTarget.crossfadeGain ?? 1.0);
        const shouldForceGainSync =
            (gain === 1.0 && lastAppliedCrossfadeGain !== 1.0) ||
            (gain === 0 && lastAppliedCrossfadeGain !== 0) ||
            (sendHostSeek && Math.abs(gain - lastAppliedCrossfadeGain) >= 0.01);

        if (shouldForceGainSync) {
            lastAppliedCrossfadeGain = gain;
            const { volume, isMuted } = get();
            bridgeApi.setCrossfadeOutputVolume(
                isMuted ? 0 : Math.max(0, Math.min(1, volume * gain))
            );
        }

        if (sendHostSeek) {
            if (inSilence) {
                activeSilenceEofTarget = null;
                lastAppliedStopAfterCurrent = false;
                if (get().isPlaying) {
                    bridgeApi.pauseForSilenceGap();
                }
            } else if (targetTrack && !get().isPreviewPlaying) {
                const stopMeta = computeSilenceStopAfterCurrentMeta(
                    flatQueue,
                    seekTarget.queueOrder
                );
                activeSilenceEofTarget = stopMeta.eofTarget;
                lastAppliedStopAfterCurrent = stopMeta.shouldStop;
                bridgeApi.cueOrPlayTrack(
                    targetTrack,
                    seekTarget.trackOffsetSeconds,
                    get().isPlaying,
                    {
                        queueOrder: seekTarget.queueOrder,
                        isAutoTransition: false,
                        stopAfterCurrent: stopMeta.shouldStop,
                    }
                );
            }
        }

        nativeGaplessFallbackSentForOrder = null;
        markMasterClockUpdated();
        set({
            currentTrack: targetTrack ?? null,
            currentQueueOrder: seekTarget.queueOrder,
            trackTimeSeconds: seekTarget.trackOffsetSeconds,
            masterTimeSeconds: seekTarget.globalTimeSeconds,
            masterTotalDuration: totalDuration,
            activeCueLabel:
                seekTarget.transitionLabel ??
                evaluateActiveCueLabel(
                    targetTrack ?? null,
                    seekTarget.trackOffsetSeconds
                ),
        });

        if (get().isPlaying) {
            backgroundAnchorTimestampMs = Date.now();
            backgroundAnchorMasterSec = seekTarget.globalTimeSeconds;
        }

        if (commitPersistence) {
            savePlayerSelection(get());
        }

        if (targetTrack && targetTrack.id !== prevTrackId) {
            const coverToUse =
                targetTrack.coverUrl ||
                getCachedCoverSync(
                    targetTrack.path,
                    targetTrack.artist,
                    targetTrack.album
                );
            if (coverToUse) {
                void extractDominantColorFromUrl(coverToUse).then((hex) => {
                    if (
                        !get().isPreviewPlaying &&
                        get().currentTrack?.id === targetTrack.id
                    ) {
                        set({ dominantColor: hex });
                        if (commitPersistence) {
                            savePlayerSelection(get());
                        }
                    }
                });
            } else if (
                targetTrack.path &&
                !targetTrack.path.startsWith('C:\\Music\\DJ_Set\\')
            ) {
                void fetchSingleTrackRealCover(
                    targetTrack.path,
                    targetTrack.artist,
                    targetTrack.album
                ).then((realCover) => {
                    if (!realCover) return;
                    get().updateCurrentTrackComputedMeta(
                        targetTrack.id,
                        targetTrack.path,
                        { coverUrl: realCover }
                    );
                });
            }
        }
    },

    // 5. 單曲內部微觀波形 Seek
    seekCurrentTrack: (trackOffsetSeconds) => {
        lastUserSeekOrToggleAtMs = Date.now();
        const { currentTrack, isPlaying } = get();
        if (!currentTrack) return;

        const clampedOffset = Math.max(
            0,
            Math.min(currentTrack.duration, trackOffsetSeconds)
        );
        bridgeApi.cueOrPlayTrack(currentTrack, clampedOffset, isPlaying, {
            queueOrder: get().currentQueueOrder,
        });

        set({
            trackTimeSeconds: clampedOffset,
            activeCueLabel: evaluateActiveCueLabel(currentTrack, clampedOffset),
        });
        savePlayerSelection(get());
    },

    // 6. 播放時計時推進器 (完全獨立處理「智慧媒體庫單曲試聽 isPreviewPlaying」與「Master 總時間軸佇列播放 isPlaying」)
    advancePlaybackTick: (deltaSeconds, flatQueue, libraryTracks) => {
        const {
            isPlaying,
            isPreviewPlaying,
            previewTrack,
            previewTimeSeconds,
            masterTimeSeconds,
            trackTimeSeconds,
            volume,
            isMuted,
            currentTrack,
            currentQueueOrder,
        } = get();

        const inWebView = isFoobarWebView();

        // [分支 1] 智慧媒體庫「試聽」獨立計時推進：完全不影響 Master 總時間軸 seekhead、isPlaying 或 currentTrack！
        if (isPreviewPlaying && previewTrack) {
            const nextPreviewTime = previewTimeSeconds + deltaSeconds;
            if (nextPreviewTime >= previewTrack.duration) {
                sendCommandToHost('SET_PLAYBACK_STATE', { isPlaying: false });
                set({
                    isPreviewPlaying: false,
                    previewTrackId: null,
                    previewTrack: null,
                    previewTimeSeconds: 0,
                    vuLevels: {
                        leftPeak: 0,
                        leftRms: 0,
                        rightPeak: 0,
                        rightRms: 0,
                    },
                    spectrumBins: Array.from({ length: 64 }, () => 0),
                });
                return;
            }

            const simulated = inWebView
                ? null
                : generateSimulatedMeters(true, volume, isMuted);

            set((state) => ({
                previewTimeSeconds: Number(nextPreviewTime.toFixed(2)),
                vuLevels: simulated ? simulated.vuLevels : state.vuLevels,
                spectrumBins: simulated
                    ? simulated.spectrumBins
                    : state.spectrumBins,
            }));
            return;
        }

        // [分支 2] Master 總時間軸播放推進
        // 若目前正在等待 C++ 宿主回傳最新對時快照 (isResyncingFromHost)，或視窗剛從最小化恢復顯示 (< 280ms) 等待宿主快照期間，暫停本地盲推，防止 seekhead 先跳向錯誤位置再被宿主快照拉回
        if (
            !isPlaying ||
            isResyncingFromHost ||
            (lastVisibilityRestoreAtMs > 0 &&
                Date.now() - lastVisibilityRestoreAtMs < 280)
        ) {
            return;
        }

        // 若無佇列但有單曲播放中，僅推進單曲秒數
        if (flatQueue.length === 0 && currentTrack) {
            const { mixIn, mixOut, loopCount = 1 } = currentTrack.cuePoints;
            let nextTrackTime = trackTimeSeconds + deltaSeconds;

            if (loopCount > 1 && nextTrackTime >= mixOut) {
                nextTrackTime = mixIn;
                bridgeApi.cueOrPlayTrack(currentTrack, mixIn, true);
            }

            if (nextTrackTime >= currentTrack.duration) {
                if (get().isTimelineLoopEnabled) {
                    const loopStart = currentTrack.cuePoints?.mixIn ?? 0;
                    bridgeApi.cueOrPlayTrack(currentTrack, loopStart, true);
                    set({
                        trackTimeSeconds: loopStart,
                        activeCueLabel: '總時間軸循環重播中',
                    });
                    return;
                }
                sendCommandToHost('SET_PLAYBACK_STATE', { isPlaying: false });
                set({
                    isPlaying: false,
                    trackTimeSeconds: currentTrack.duration,
                    activeCueLabel: null,
                    vuLevels: {
                        leftPeak: 0,
                        leftRms: 0,
                        rightPeak: 0,
                        rightRms: 0,
                    },
                    spectrumBins: Array.from({ length: 64 }, () => 0),
                });
                return;
            }

            const simulated = inWebView
                ? null
                : generateSimulatedMeters(true, volume, isMuted);

            set((state) => ({
                trackTimeSeconds: Number(nextTrackTime.toFixed(2)),
                activeCueLabel: evaluateActiveCueLabel(
                    currentTrack,
                    nextTrackTime
                ),
                vuLevels: simulated ? simulated.vuLevels : state.vuLevels,
                spectrumBins: simulated
                    ? simulated.spectrumBins
                    : state.spectrumBins,
            }));
            return;
        }

        if (flatQueue.length === 0) return;
        latestCachedFlatQueue = flatQueue;
        latestCachedLibraryTracks = libraryTracks;

        const totalDuration = flatQueue[flatQueue.length - 1].timelineEndSec;
        const nextGlobalTime = masterTimeSeconds + deltaSeconds;

        if (nextGlobalTime >= totalDuration) {
            wasInSilenceGap = false;
            lastTimelineTrackId = null;
            nativeGaplessFallbackSentForOrder = null;
            if (lastAppliedCrossfadeGain !== 1.0) {
                lastAppliedCrossfadeGain = 1.0;
                bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
            }

            // 若開啟了「循環播放整條時間軸」，自動無縫跳回時間軸 0.0s 第一首曲目繼續播放
            if (get().isTimelineLoopEnabled && totalDuration > 0) {
                get().seekMasterTimeline(0, flatQueue, libraryTracks);
                return;
            }

            sendCommandToHost('SET_PLAYBACK_STATE', { isPlaying: false });
            markMasterClockUpdated();
            set({
                isPlaying: false,
                masterTimeSeconds: totalDuration,
                vuLevels: {
                    leftPeak: 0,
                    leftRms: 0,
                    rightPeak: 0,
                    rightRms: 0,
                },
            });
            savePlayerSelection(get());
            return;
        }

        const seekTarget = resolveMasterTimelineSeek(flatQueue, nextGlobalTime);
        if (!seekTarget) return;

        // [情況 A] 正處於兩首曲目之間的 SILENCE 靜音過渡區間：暫停 foobar2000 音訊輸出，但保持 Master Timeline 繼續往前走！
        if (seekTarget.isInSilenceGap) {
            if (!wasInSilenceGap) {
                wasInSilenceGap = true;
                if (lastAppliedCrossfadeGain !== 1.0) {
                    lastAppliedCrossfadeGain = 1.0;
                    bridgeApi.setCrossfadeOutputVolume(isMuted ? 0 : volume);
                }
                bridgeApi.pauseForSilenceGap();
            }

            // 排程或更新 Silence 結束喚醒計時器，確保最小化背景期間靜音倒數完畢時必定觸發下一首播放
            const nextQueueItemForSilence = flatQueue.find(
                (item) => item.order === seekTarget.queueOrder + 1
            );
            if (nextQueueItemForSilence) {
                const remainSec = Math.max(
                    0,
                    nextQueueItemForSilence.timelineStartSec - nextGlobalTime
                );
                clearSilenceGapWakeTimer();
                silenceGapWakeTimer = setTimeout(
                    () => {
                        silenceGapWakeTimer = null;
                        const latestState = get();
                        if (!latestState.isPlaying || flatQueue.length === 0) {
                            return;
                        }
                        const liveWallSec =
                            backgroundAnchorTimestampMs !== null &&
                            backgroundAnchorMasterSec !== null
                                ? backgroundAnchorMasterSec +
                                  Math.max(
                                      0,
                                      (Date.now() -
                                          backgroundAnchorTimestampMs) /
                                          1000
                                  )
                                : nextQueueItemForSilence.timelineStartSec +
                                  0.04;
                        const targetGlobalSec = Math.max(
                            nextQueueItemForSilence.timelineStartSec + 0.02,
                            liveWallSec
                        );
                        wasInSilenceGap = false;
                        lastVisibilityRestoreAtMs = 0;
                        latestState.seekMasterTimeline(
                            targetGlobalSec,
                            flatQueue,
                            libraryTracks,
                            { commitPersistence: true, sendHostSeek: true }
                        );
                    },
                    Math.max(30, Math.round(remainSec * 1000) + 25)
                );
            }

            markMasterClockUpdated();
            set({
                trackTimeSeconds: seekTarget.trackOffsetSeconds,
                masterTimeSeconds: Number(nextGlobalTime.toFixed(2)),
                masterTotalDuration: totalDuration,
                activeCueLabel:
                    seekTarget.transitionLabel ?? 'Silence 靜音過渡中',
                vuLevels: {
                    leftPeak: 0,
                    leftRms: 0,
                    rightPeak: 0,
                    rightRms: 0,
                },
                spectrumBins: Array.from({ length: 64 }, () => 0),
            });
            backgroundAnchorTimestampMs = Date.now();
            backgroundAnchorMasterSec = nextGlobalTime;
            if (Date.now() - lastProgressPersistMs >= 800) {
                savePlayerSelection(get());
            }
            return;
        }

        // [情況 B] 位於一般曲目播放或 CROSSFADE 過渡區間
        clearSilenceGapWakeTimer();
        const exitedSilenceGap = wasInSilenceGap;
        wasInSilenceGap = false;

        // 造成原錯誤的原因：先前設了 <= 0.12s 的 preSilenceGuardTriggered 提前呼叫 pauseForSilenceGap，但啟用 Stop After Current 後宿主已不會偷跑下一首，提前 120ms 暫停反而切掉曲末尾音。
        // 本次修改的目的：移除提前 120ms 強制切斷，統一於抵達 timelineEndSec (seekTarget.isInSilenceGap) 時精準進入靜音區間。

        // 動態套用 Crossfade 音量漸變增益 (1.0 -> 0.0 -> 1.0)
        const gain = seekTarget.crossfadeGain ?? 1.0;
        if (
            Math.abs(gain - lastAppliedCrossfadeGain) >= 0.015 ||
            (gain === 1.0 && lastAppliedCrossfadeGain !== 1.0) ||
            (gain === 0 && lastAppliedCrossfadeGain !== 0)
        ) {
            lastAppliedCrossfadeGain = gain;
            const { volume, isMuted } = get();
            const effectiveVol = isMuted
                ? 0
                : Math.max(0, Math.min(1, volume * gain));
            bridgeApi.setCrossfadeOutputVolume(effectiveVol);
        }

        const targetTrack = resolveTrackFromQueueOrLibrary(
            seekTarget.trackId,
            seekTarget.queueOrder,
            flatQueue,
            libraryTracks,
            currentTrack
        );

        // 使用 lastTimelineTrackId 與 currentQueueOrder 判斷時間軸是否跨入下一首曲目
        const isTrackTransition =
            Boolean(targetTrack) &&
            (targetTrack?.id !== lastTimelineTrackId ||
                seekTarget.queueOrder !== currentQueueOrder ||
                exitedSilenceGap);
        const isLoopRewind =
            Boolean(targetTrack) &&
            !exitedSilenceGap &&
            seekTarget.queueOrder === currentQueueOrder &&
            trackTimeSeconds - seekTarget.trackOffsetSeconds > 1.5;

        const stopMeta = computeSilenceStopAfterCurrentMeta(
            flatQueue,
            seekTarget.queueOrder
        );
        activeSilenceEofTarget = stopMeta.eofTarget;

        // 檢查是否符合「純 C++ 原生無縫推進 (Native Gapless)」之條件：
        // 1. 前一首播放至實體 EOF (mixOut >= duration - 0.15)
        // 2. 前一首過渡模式為 CUT 或 CROSSFADE（非 SILENCE，因 CUT 與未提早切出的 CROSSFADE 在宿主端皆為無縫連續預緩衝下一首）
        // 3. 下一首無設定開頭跳過 (mixIn < 0.2s)
        // 4. 順向進入下一列 (seekTarget.queueOrder === currentQueueOrder + 1) 且非 Loop 繞回
        const prevQueueItem =
            isTrackTransition && !exitedSilenceGap
                ? flatQueue.find((item) => item.order === currentQueueOrder)
                : undefined;
        const prevMixOut = prevQueueItem
            ? (prevQueueItem.cuePoints?.mixOut ?? prevQueueItem.duration)
            : 0;
        const targetMixIn = Math.max(0, targetTrack?.cuePoints?.mixIn ?? 0);
        const prevTransitionType =
            prevQueueItem?.transitionToNext?.type ?? 'CUT';
        const canRelyOnNativeGapless =
            inWebView &&
            isTrackTransition &&
            !exitedSilenceGap &&
            Boolean(prevQueueItem) &&
            seekTarget.queueOrder === currentQueueOrder + 1 &&
            prevMixOut >= prevQueueItem!.duration - 0.15 &&
            prevTransitionType !== 'SILENCE' &&
            targetMixIn < 0.2 &&
            (prevQueueItem!.cuePoints?.loopCount ?? 1) <= 1;

        // 造成原錯誤的原因：
        // 1. 先前 canRelyOnNativeGapless 僅允許 'CUT'，導致 CROSSFADE 在背景自然跨曲或開啟視窗時進入 else 分支，將 launchOffsetSeconds 強制設為 targetMixIn (0s) 並呼叫 cueOrPlayTrack 重頭播放該曲！
        // 2. 當視窗從長時間最小化喚醒時，若單次 tick 的 deltaSeconds 很大 (> 1.0s) 且非 SILENCE 過渡，宿主早已在背景播放新曲目至中段，若進入 else 分支把 effectiveTrackOffset 拉回 targetMixIn (0s)，就會造成開啟視窗瞬間跳回該曲開頭。
        // 本次修改的目的：
        // 1. 將未提早切出的 CROSSFADE 一併納入 canRelyOnNativeGapless（不重發 playTrack 重置進度，僅由計時器平滑控制 Crossfade 音量）。
        // 2. 若為非 SILENCE 之背景大跨度喚醒 (inWebView && isTrackTransition && !exitedSilenceGap && prevTransitionType !== 'SILENCE' && deltaSeconds > 1.0)，不強制拉回 0s，改為立即觸發 syncMasterTimelineWithHostPosition 對齊宿主真實秒數。
        // 3. 若為 SILENCE 過渡結束 (exitedSilenceGap 或 prevTransitionType === 'SILENCE')，宿主因 Stop After Current 正處於停止狀態，必定從 targetMixIn 準時發送 cueOrPlayTrack 啟動下一首！
        const isBackgroundThrottledNonSilenceJump =
            inWebView &&
            isTrackTransition &&
            !exitedSilenceGap &&
            prevTransitionType !== 'SILENCE' &&
            deltaSeconds > 1.0;

        let effectiveGlobalTime = nextGlobalTime;
        let effectiveTrackOffset = seekTarget.trackOffsetSeconds;

        if (targetTrack && (isTrackTransition || isLoopRewind)) {
            lastTimelineTrackId = targetTrack.id;
            lastAppliedStopAfterCurrent = stopMeta.shouldStop;

            if (canRelyOnNativeGapless) {
                nativeGaplessFallbackSentForOrder = null;
                bridgeApi.setStopAfterCurrent(stopMeta.shouldStop);
            } else if (isBackgroundThrottledNonSilenceJump) {
                nativeGaplessFallbackSentForOrder = null;
                bridgeApi.setStopAfterCurrent(stopMeta.shouldStop);
                void get().syncMasterTimelineWithHostPosition(
                    flatQueue,
                    libraryTracks
                );
            } else {
                nativeGaplessFallbackSentForOrder = seekTarget.queueOrder;
                const launchOffsetSeconds = isTrackTransition
                    ? targetMixIn
                    : seekTarget.trackOffsetSeconds;
                if (isTrackTransition && deltaSeconds > 0.25) {
                    const currentQueueItem = flatQueue.find(
                        (item) => item.order === seekTarget.queueOrder
                    );
                    const extraOffset = Math.max(
                        0,
                        seekTarget.trackOffsetSeconds - targetMixIn
                    );
                    effectiveGlobalTime = Math.max(
                        currentQueueItem?.timelineStartSec ?? 0,
                        nextGlobalTime - extraOffset
                    );
                    effectiveTrackOffset = targetMixIn;
                }

                bridgeApi.cueOrPlayTrack(
                    targetTrack,
                    launchOffsetSeconds,
                    true,
                    {
                        queueOrder: seekTarget.queueOrder,
                        isAutoTransition:
                            isTrackTransition &&
                            !exitedSilenceGap &&
                            prevTransitionType !== 'SILENCE',
                        stopAfterCurrent: stopMeta.shouldStop,
                    }
                );
            }
        } else if (lastAppliedStopAfterCurrent !== stopMeta.shouldStop) {
            lastAppliedStopAfterCurrent = stopMeta.shouldStop;
            bridgeApi.setStopAfterCurrent(stopMeta.shouldStop);
        }

        const simulated = inWebView
            ? null
            : generateSimulatedMeters(true, volume * gain, isMuted);

        markMasterClockUpdated();
        set((state) => ({
            ...(isTrackTransition && targetTrack
                ? { currentTrack: targetTrack }
                : {}),
            currentQueueOrder: seekTarget.queueOrder,
            trackTimeSeconds: Number(effectiveTrackOffset.toFixed(2)),
            masterTimeSeconds: Number(effectiveGlobalTime.toFixed(2)),
            masterTotalDuration: totalDuration,
            activeCueLabel:
                seekTarget.transitionLabel ??
                evaluateActiveCueLabel(
                    targetTrack ?? null,
                    effectiveTrackOffset
                ),
            vuLevels: simulated ? simulated.vuLevels : state.vuLevels,
            spectrumBins: simulated
                ? simulated.spectrumBins
                : state.spectrumBins,
        }));

        backgroundAnchorTimestampMs = Date.now();
        backgroundAnchorMasterSec = effectiveGlobalTime;

        // 播放推進期間每 800ms 或跨曲目轉場時自動將最新 seekhead 位置持久化，確保最小化或暫停後絕對不會跳回舊點擊位置！
        if (isTrackTransition || Date.now() - lastProgressPersistMs >= 800) {
            savePlayerSelection(get());
        }

        if (isTrackTransition && targetTrack) {
            if (targetTrack.coverUrl) {
                void extractDominantColorFromUrl(targetTrack.coverUrl).then(
                    (hex) => {
                        if (get().currentTrack?.id === targetTrack.id) {
                            set({ dominantColor: hex });
                            savePlayerSelection(get());
                        }
                    }
                );
            } else if (
                targetTrack.path &&
                !targetTrack.path.startsWith('C:\\Music\\DJ_Set\\')
            ) {
                void fetchSingleTrackRealCover(
                    targetTrack.path,
                    targetTrack.artist,
                    targetTrack.album
                ).then((realCover) => {
                    if (!realCover) return;
                    get().updateCurrentTrackComputedMeta(
                        targetTrack.id,
                        targetTrack.path,
                        { coverUrl: realCover }
                    );
                });
            }
        }
    },

    persistPlaybackProgressNow: () => {
        const state = get();
        if (state.isPlaying) {
            backgroundAnchorTimestampMs = Date.now();
            backgroundAnchorMasterSec = state.masterTimeSeconds;
        } else {
            backgroundAnchorTimestampMs = null;
            backgroundAnchorMasterSec = null;
        }
        savePlayerSelection(state);
    },

    /**
     * [修復問題 2：清空畫布所有節點後，再重新加入節點時 seekhead 不會退回 0 秒位置的問題]
     * 造成錯誤的原因：
     * 先前當呼叫 `clearCanvas()` 或刪除畫布最後一個節點使 `flatQueue` 清空時，僅清空了 `useWorkflowStore.playlist`，
     * 而未重置 `usePlayerStore` 內的 `masterTimeSeconds` 與 `localStorage` 保存值，導致重新加入節點後 `seekhead` 仍停留在舊秒數位置。
     * 修改的目的：
     * 當畫布佇列被清空時，將 `masterTimeSeconds`、`trackTimeSeconds`、`currentQueueOrder` 與 `currentTrack` 歸零重置並寫入持久化儲存。
     */
    resetTimelinePosition: () => {
        const state = get();
        lastTimelineTrackId = null;
        wasInSilenceGap = false;
        backgroundAnchorTimestampMs = null;
        backgroundAnchorMasterSec = null;

        if (lastAppliedCrossfadeGain !== 1.0) {
            lastAppliedCrossfadeGain = 1.0;
            bridgeApi.setCrossfadeOutputVolume(
                state.isMuted ? 0 : state.volume
            );
        }

        if (state.isPlaying) {
            sendCommandToHost('SET_PLAYBACK_STATE', { isPlaying: false });
        }

        set({
            currentTrack: null,
            currentQueueOrder: 1,
            isPlaying: false,
            trackTimeSeconds: 0,
            masterTimeSeconds: 0,
            masterTotalDuration: 0,
            activeCueLabel: null,
            ...(state.isPreviewPlaying
                ? {}
                : {
                      vuLevels: {
                          leftPeak: 0,
                          leftRms: 0,
                          rightPeak: 0,
                          rightRms: 0,
                      },
                      spectrumBins: Array.from({ length: 64 }, () => 0),
                  }),
        });
        savePlayerSelection(get());
    },

    /**
     * [修復最小化後開啟視窗時 seekhead 回溯到前一首歌尾部、專輯封面與曲目資訊停留在前一首的問題]
     * [修復問題 3 (Silence 情況 A)：當前曲目有設置 mix-out 點時，播放至該點就會停住 (Pause 變回 Play) 且 seekhead 不再前進的問題]
     * 造成錯誤的原因：
     * 1. 當曲目設有 `mixOut < duration` 且轉場為 `SILENCE` 時，`advancePlaybackTick` 在到達 `mixOut` 時會設定 `wasInSilenceGap = true` 並呼叫 `bridgeApi.pauseForSilenceGap()` 暫停 C++ 宿主音訊，同時讓前端 `isPlaying` 保持 `true` 繼續推進 `masterTimeSeconds`。
     * 2. 但是 `App.tsx` 每 2 秒（20 ticks）會定時呼叫一次 `syncMasterTimelineWithHostPosition` 向宿主查詢快照 (`snap`)；
     *    因為宿主在 Silence 期間處於 `snap.isPaused === true`（`snap.isPlaying === false`），且 `snap.playbackTime` 停在 `mixOut`，
     *    `syncMasterTimelineWithHostPosition` 竟直接執行 `wasInSilenceGap = false; set({ isPlaying: snap.isPlaying (false), masterTimeSeconds: matchedItem.timelineEndSec })`！
     *    這導致進入 Silence 最多 2 秒內，播放狀態就被強制改成暫停（Pause 按鈕變回 Play），且 `seekhead` 被拉回並卡死在該曲結尾不再前進！
     * 修改的目的：
     * 當目前正處於 Silence 靜音過渡區間 (`wasInSilenceGap` 為 `true`，或 `isPlaying` 為 `true` 且當前 `masterTimeSeconds` 落於 `isInSilenceGap` 區間) 時，
     * 直接跳過 `syncMasterTimelineWithHostPosition` 的宿主狀態覆寫，完全交由前端計時器穩定走完 Silence 空白區間並準時切入下一首歌！
     */
    syncMasterTimelineWithHostPosition: async (flatQueue, libraryTracks) => {
        if (flatQueue.length === 0) return;
        latestCachedFlatQueue = flatQueue;
        latestCachedLibraryTracks = libraryTracks;

        // 若使用者剛在 850ms 內執行過手動點擊時間軸跳轉或切換播放/暫停，跳過此次背景輪詢對時，避免非同步回傳的舊秒數把 seekhead 往回拉
        if (Date.now() - lastUserSeekOrToggleAtMs < 850) return;

        // 單飛鎖 (Single-flight deduplication)：避免 visibilitychange、focus 與定時對時同時重疊發起多個 IPC 快照查詢
        if (inFlightHostSyncPromise) {
            return inFlightHostSyncPromise;
        }

        // 若正在播放且處於兩首曲目之間的 Silence 靜音過渡區間：
        // 造成原錯誤的原因：當視窗在 Silence 期間最小化，且使用者在靜音秒數已經過完後才打開視窗時，
        // 先前直接 `if (wasInSilenceGap) return;` 或在 `snap.isStopped` 中把 `silenceGlobal` 夾在 `nextStartSec` 並 return，
        // 導致時間軸永遠卡在第二首歌開頭 (`nextStartSec`) 且宿主維持停止狀態，不會啟動第二首歌播放！
        // 本次修改的目的：先以真實時鐘錨點 `estWallSec` 檢查 Silence 是否已經走完；若已達 `nextStartSec`，立即推進時間軸啟動第二首曲目。
        const currentStateBeforeSync = get();
        if (currentStateBeforeSync.isPlaying) {
            const estWallSec =
                backgroundAnchorTimestampMs !== null &&
                backgroundAnchorMasterSec !== null
                    ? backgroundAnchorMasterSec +
                      Math.max(
                          0,
                          (Date.now() - backgroundAnchorTimestampMs) / 1000
                      )
                    : currentStateBeforeSync.masterTimeSeconds;
            const effectiveSyncSec = Math.max(
                currentStateBeforeSync.masterTimeSeconds,
                estWallSec
            );
            const currentSeekCheck = resolveMasterTimelineSeek(
                flatQueue,
                currentStateBeforeSync.masterTimeSeconds
            );
            if (wasInSilenceGap || currentSeekCheck?.isInSilenceGap) {
                lastVisibilityRestoreAtMs = 0;
                const liveSeekCheck = resolveMasterTimelineSeek(
                    flatQueue,
                    effectiveSyncSec
                );
                if (liveSeekCheck && !liveSeekCheck.isInSilenceGap) {
                    // 造成原錯誤的原因：先前在此處呼叫 advancePlaybackTick，可能因 isResyncingFromHost 或 lastVisibilityRestoreAtMs 門檻被攔截，導致打開視窗後仍停在 Silence 或第二首開頭。
                    // 本次修改的目的：當真實經過時間 effectiveSyncSec 已跨過 Silence 區間時，直接呼叫 seekMasterTimeline 啟動第二首曲目並恢復播放。
                    wasInSilenceGap = false;
                    clearSilenceGapWakeTimer();
                    get().seekMasterTimeline(
                        effectiveSyncSec,
                        flatQueue,
                        libraryTracks,
                        { commitPersistence: true, sendHostSeek: true }
                    );
                    return;
                }
                if (liveSeekCheck && liveSeekCheck.isInSilenceGap) {
                    wasInSilenceGap = true;
                    const nextQueueItem = flatQueue.find(
                        (item) => item.order === liveSeekCheck.queueOrder + 1
                    );
                    if (nextQueueItem) {
                        const remainSec = Math.max(
                            0,
                            nextQueueItem.timelineStartSec - effectiveSyncSec
                        );
                        markMasterClockUpdated();
                        set({
                            masterTimeSeconds: Number(
                                effectiveSyncSec.toFixed(2)
                            ),
                            activeCueLabel:
                                liveSeekCheck.transitionLabel ??
                                `Silence 靜音過渡中 (${remainSec.toFixed(1)}s)`,
                        });
                        clearSilenceGapWakeTimer();
                        silenceGapWakeTimer = setTimeout(
                            () => {
                                silenceGapWakeTimer = null;
                                const latestState = get();
                                if (
                                    !latestState.isPlaying ||
                                    flatQueue.length === 0
                                ) {
                                    return;
                                }
                                wasInSilenceGap = false;
                                lastVisibilityRestoreAtMs = 0;
                                latestState.seekMasterTimeline(
                                    nextQueueItem.timelineStartSec + 0.02,
                                    flatQueue,
                                    libraryTracks,
                                    {
                                        commitPersistence: true,
                                        sendHostSeek: true,
                                    }
                                );
                            },
                            Math.max(30, Math.round(remainSec * 1000) + 25)
                        );
                    }
                }
                return;
            }
        }

        const totalDuration = flatQueue[flatQueue.length - 1].timelineEndSec;
        const wasJustRestoredFromHidden =
            lastVisibilityRestoreAtMs > 0 &&
            Date.now() - lastVisibilityRestoreAtMs < 1500;
        isResyncingFromHost = true;

        const runSync = async () => {
            try {
                const snap = await bridgeApi.queryHostPlaybackSnapshot();
                lastVisibilityRestoreAtMs = 0;

                // 再次檢查：若在等待 IPC 回傳期間使用者執行了手動跳轉、切換播放/暫停或剛進入了 Silence 靜音區間，直接放棄此次舊快照
                if (
                    Date.now() - lastUserSeekOrToggleAtMs < 850 ||
                    wasInSilenceGap
                ) {
                    return;
                }

                // 若宿主因 Stop After Current（或 Silence 期間被 pauseForSilenceGap 暫停）處於 stopped / paused，判斷靜音秒數是否已走完：
                // - 若已達 nextStartSec，立即呼叫 seekMasterTimeline 啟動下一首曲目（解決最小化打開視窗後停在第二首開頭不動的問題）
                // - 若尚未走完，進入靜音倒數並排程喚醒計時器
                if (
                    snap.supported &&
                    (snap.isStopped || snap.isPaused) &&
                    get().isPlaying &&
                    activeSilenceEofTarget
                ) {
                    const eofTarget = activeSilenceEofTarget;
                    const estSec =
                        backgroundAnchorTimestampMs !== null &&
                        backgroundAnchorMasterSec !== null
                            ? backgroundAnchorMasterSec +
                              Math.max(
                                  0,
                                  (Date.now() - backgroundAnchorTimestampMs) /
                                      1000
                              )
                            : get().masterTimeSeconds;
                    if (estSec >= eofTarget.nextStartSec - 0.05) {
                        wasInSilenceGap = false;
                        isResyncingFromHost = false;
                        clearSilenceGapWakeTimer();
                        get().seekMasterTimeline(
                            Math.max(eofTarget.nextStartSec + 0.02, estSec),
                            flatQueue,
                            libraryTracks,
                            { commitPersistence: true, sendHostSeek: true }
                        );
                        return;
                    }
                    if (estSec >= eofTarget.timelineEndSec - 3.5) {
                        wasInSilenceGap = true;
                        const silenceGlobal = Math.min(
                            eofTarget.nextStartSec,
                            Math.max(eofTarget.timelineEndSec, estSec)
                        );
                        const remainSec = Math.max(
                            0,
                            eofTarget.nextStartSec - silenceGlobal
                        );
                        markMasterClockUpdated();
                        set({
                            trackTimeSeconds: eofTarget.mixOutSec,
                            masterTimeSeconds: Number(silenceGlobal.toFixed(2)),
                            masterTotalDuration: totalDuration,
                            isPlaying: true,
                        });
                        backgroundAnchorTimestampMs = Date.now();
                        backgroundAnchorMasterSec = silenceGlobal;
                        clearSilenceGapWakeTimer();
                        silenceGapWakeTimer = setTimeout(
                            () => {
                                silenceGapWakeTimer = null;
                                const latestState = get();
                                if (!latestState.isPlaying) return;
                                wasInSilenceGap = false;
                                lastVisibilityRestoreAtMs = 0;
                                latestState.seekMasterTimeline(
                                    eofTarget.nextStartSec + 0.02,
                                    flatQueue,
                                    libraryTracks,
                                    {
                                        commitPersistence: true,
                                        sendHostSeek: true,
                                    }
                                );
                            },
                            Math.max(30, Math.round(remainSec * 1000) + 25)
                        );
                        savePlayerSelection(get());
                        return;
                    }
                }

                // 情況 A：C++ 宿主回報目前正在播放或暫停，且提供了精確的單曲秒數 (playbackTime)
                if (
                    snap.supported &&
                    (snap.isPlaying || snap.isPaused) &&
                    snap.playbackTime !== null
                ) {
                    const state = get();
                    if (state.isPreviewPlaying) return;

                    const matchedItem = findMatchingQueueItemFromHost(
                        flatQueue,
                        state.currentQueueOrder,
                        {
                            path: snap.path,
                            absolutePath: snap.absolutePath,
                            handle: snap.handle,
                            title: snap.title,
                            artist: snap.artist,
                            playlistRowIndex: snap.playlistRowIndex,
                        }
                    );

                    // 若宿主正在播放一首不在 flatQueue 內的外部殘留曲目，且目前總時間軸處於播放狀態，立即導正至排程的下一首曲目
                    if (!matchedItem && state.isPlaying && snap.isPlaying) {
                        const currentIdx = flatQueue.findIndex(
                            (item) => item.order === state.currentQueueOrder
                        );
                        const expectedNextItem =
                            currentIdx >= 0 &&
                            currentIdx + 1 < flatQueue.length
                                ? flatQueue[currentIdx + 1]
                                : state.isTimelineLoopEnabled
                                  ? flatQueue[0]
                                  : null;
                        if (expectedNextItem) {
                            get().seekMasterTimeline(
                                expectedNextItem.timelineStartSec,
                                flatQueue,
                                libraryTracks
                            );
                            return;
                        }
                    }

                    if (matchedItem) {
                        // 造成原錯誤的原因：若宿主在背景因 Silence 切入第二首並被 pauseForSilenceGap 暫停在第二首開頭 (snap.isPaused && snap.playbackTime <= 0.5)，
                        // 先前情況 A 直接執行 set({ isPlaying: snap.isPlaying (false) })，導致打開視窗後 seekhead 被鎖死在第二首開頭且停止播放！
                        // 本次修改的目的：當 state.isPlaying === true 但宿主卻暫停在下一首開頭時，依真實牆鐘時間恢復播放或進入剩餘 Silence 倒數。
                        if (
                            state.isPlaying &&
                            snap.isPaused &&
                            !snap.isPlaying &&
                            matchedItem.order > state.currentQueueOrder &&
                            snap.playbackTime <= 0.5
                        ) {
                            const estSec =
                                backgroundAnchorTimestampMs !== null &&
                                backgroundAnchorMasterSec !== null
                                    ? backgroundAnchorMasterSec +
                                      Math.max(
                                          0,
                                          (Date.now() -
                                              backgroundAnchorTimestampMs) /
                                              1000
                                      )
                                    : matchedItem.timelineStartSec;
                            isResyncingFromHost = false;
                            wasInSilenceGap = false;
                            clearSilenceGapWakeTimer();
                            get().seekMasterTimeline(
                                Math.max(
                                    matchedItem.timelineStartSec + 0.02,
                                    estSec
                                ),
                                flatQueue,
                                libraryTracks,
                                { commitPersistence: true, sendHostSeek: true }
                            );
                            return;
                        }
                        // [修復問題 1：防止原生無縫跨曲交界處被 2 秒定時對時拉回前一首或跳回前一首開頭]
                        // 造成原錯誤的原因：當前端 `advancePlaybackTick` 經由 `canRelyOnNativeGapless` 剛跨入下一首 (`state.currentQueueOrder` 已 +1)，
                        // 若 C++ 宿主尚在輸出緩衝區播放前一首最後 0.1~0.8 秒（或誤跳回前一首開頭），先前在 `elapsedInExpected < 1.4s` 時未 `return` 跳出，
                        // 直接往下執行把前端 `currentQueueOrder` 與 `masterTimeSeconds` 硬拉回前一首。
                        // 本次修改的目的：當 `matchedItem.order < state.currentQueueOrder` 時：
                        // 1. 若超過緩衝寬限期、或宿主在前一首的秒數居然掉回開頭 (`snap.playbackTime < 1.5`)，立即補發 `cueOrPlayTrack` 強制切入當前排程曲目；
                        // 2. 若尚在緩衝寬限期內（宿主正播完前一首尾端最後零點幾秒），直接 `return` 忽略此次過時快照，絕不把已進入下一首的時間軸拉回前一首！
                        if (
                            state.isPlaying &&
                            snap.isPlaying &&
                            matchedItem.order < state.currentQueueOrder
                        ) {
                            const expectedNowItem = flatQueue.find(
                                (item) => item.order === state.currentQueueOrder
                            );
                            const elapsedInExpected = expectedNowItem
                                ? state.masterTimeSeconds -
                                  expectedNowItem.timelineStartSec
                                : 0;
                            const graceWindowSec = Math.max(
                                1.0,
                                getDetectedHostBufferSec() + 0.4
                            );
                            const hostRewoundToPrevTrackStart =
                                snap.playbackTime < 1.5 &&
                                (matchedItem.duration ?? 0) > 5;

                            if (
                                expectedNowItem &&
                                nativeGaplessFallbackSentForOrder !==
                                    state.currentQueueOrder &&
                                (elapsedInExpected >= graceWindowSec ||
                                    hostRewoundToPrevTrackStart)
                            ) {
                                const fallbackTrack =
                                    resolveTrackFromQueueOrLibrary(
                                        expectedNowItem.trackId,
                                        expectedNowItem.order,
                                        flatQueue,
                                        libraryTracks,
                                        state.currentTrack
                                    );
                                if (fallbackTrack) {
                                    nativeGaplessFallbackSentForOrder =
                                        expectedNowItem.order;
                                    const stopMeta =
                                        computeSilenceStopAfterCurrentMeta(
                                            flatQueue,
                                            expectedNowItem.order
                                        );
                                    bridgeApi.cueOrPlayTrack(
                                        fallbackTrack,
                                        expectedNowItem.cuePoints?.mixIn ?? 0,
                                        true,
                                        {
                                            queueOrder: expectedNowItem.order,
                                            isAutoTransition: true,
                                            stopAfterCurrent:
                                                stopMeta.shouldStop,
                                        }
                                    );
                                    return;
                                }
                            }
                            if (elapsedInExpected < graceWindowSec) {
                                return;
                            }
                        }

                        const mixIn = matchedItem.cuePoints?.mixIn ?? 0;
                        const mixOut =
                            matchedItem.cuePoints?.mixOut ??
                            matchedItem.duration;
                        const singleSpan = Math.max(0.5, mixOut - mixIn);
                        const currentOffsetFromMixIn = Math.max(
                            0,
                            snap.playbackTime - mixIn
                        );

                        // 若該區段有設定 Loop 且仍在同一區段內，保留已經走過的循環圈數
                        const prevElapsedInItem = Math.max(
                            0,
                            state.masterTimeSeconds -
                                matchedItem.timelineStartSec
                        );
                        const completedLoops =
                            matchedItem.order === state.currentQueueOrder &&
                            (matchedItem.cuePoints?.loopCount ?? 1) > 1
                                ? Math.floor(prevElapsedInItem / singleSpan)
                                : 0;

                        const newGlobalSec = Math.min(
                            matchedItem.timelineEndSec,
                            Math.max(
                                matchedItem.timelineStartSec,
                                matchedItem.timelineStartSec +
                                    completedLoops * singleSpan +
                                    currentOffsetFromMixIn
                            )
                        );

                        // 造成原錯誤的原因：對時成功後未同步重算該位置的 Crossfade 增益，且每 2 秒對時若因緩衝區微差 (<= 0.35s) 硬覆寫 masterTimeSeconds 會造成 seekhead 微幅前後抖動。
                        // 本次修改的目的：
                        // 1. 同步計算並套用新位置的 crossfadeGain；
                        // 2. 同曲目正常播放且非剛從最小化恢復時，若誤差在 0.35s 死區內則維持平滑推進不硬拉。
                        const seekAtSynced = resolveMasterTimelineSeek(
                            flatQueue,
                            newGlobalSec
                        );
                        const syncedGain = seekAtSynced?.crossfadeGain ?? 1.0;
                        if (
                            Math.abs(syncedGain - lastAppliedCrossfadeGain) >=
                            0.015
                        ) {
                            lastAppliedCrossfadeGain = syncedGain;
                            bridgeApi.setCrossfadeOutputVolume(
                                state.isMuted
                                    ? 0
                                    : Math.max(
                                          0,
                                          Math.min(
                                              1,
                                              state.volume * syncedGain
                                          )
                                      )
                            );
                        }

                        const stopMeta = computeSilenceStopAfterCurrentMeta(
                            flatQueue,
                            matchedItem.order
                        );
                        activeSilenceEofTarget = stopMeta.eofTarget;
                        if (
                            lastAppliedStopAfterCurrent !== stopMeta.shouldStop
                        ) {
                            lastAppliedStopAfterCurrent = stopMeta.shouldStop;
                            bridgeApi.setStopAfterCurrent(stopMeta.shouldStop);
                        }

                        const isWithinSmoothDeadband =
                            !wasJustRestoredFromHidden &&
                            matchedItem.order === state.currentQueueOrder &&
                            state.isPlaying &&
                            snap.isPlaying &&
                            Math.abs(newGlobalSec - state.masterTimeSeconds) <=
                                0.35;

                        const finalGlobalSec = isWithinSmoothDeadband
                            ? state.masterTimeSeconds
                            : newGlobalSec;
                        const finalTrackSec = isWithinSmoothDeadband
                            ? state.trackTimeSeconds
                            : snap.playbackTime;

                        const resolvedTrack = resolveTrackFromQueueOrLibrary(
                            matchedItem.trackId,
                            matchedItem.order,
                            flatQueue,
                            libraryTracks,
                            state.currentTrack
                        );
                        const prevTrackId = state.currentTrack?.id;
                        lastTimelineTrackId =
                            resolvedTrack?.id ?? matchedItem.trackId;
                        hasConsumedInitialBackgroundResume = true;
                        wasInSilenceGap = false;

                        if (!isWithinSmoothDeadband) {
                            markMasterClockUpdated();
                        }

                        set({
                            currentTrack: resolvedTrack ?? state.currentTrack,
                            currentQueueOrder: matchedItem.order,
                            trackTimeSeconds: Number(finalTrackSec.toFixed(2)),
                            masterTimeSeconds: Number(
                                finalGlobalSec.toFixed(2)
                            ),
                            masterTotalDuration: totalDuration,
                            isPlaying: snap.isPlaying,
                            activeCueLabel:
                                seekAtSynced?.transitionLabel ??
                                evaluateActiveCueLabel(
                                    resolvedTrack ?? state.currentTrack,
                                    finalTrackSec
                                ),
                        });

                        backgroundAnchorTimestampMs = snap.isPlaying
                            ? Date.now()
                            : null;
                        backgroundAnchorMasterSec = snap.isPlaying
                            ? finalGlobalSec
                            : null;
                        savePlayerSelection(get());

                        // 若對時後曲目已切換（例如背景已進入下一首歌）或當前曲目缺少封面，立即同步更新封面與主色調
                        if (
                            resolvedTrack &&
                            (resolvedTrack.id !== prevTrackId ||
                                !state.currentTrack?.coverUrl)
                        ) {
                            if (resolvedTrack.coverUrl) {
                                void extractDominantColorFromUrl(
                                    resolvedTrack.coverUrl
                                ).then((hex) => {
                                    if (
                                        !get().isPreviewPlaying &&
                                        get().currentTrack?.id ===
                                            resolvedTrack.id
                                    ) {
                                        set({ dominantColor: hex });
                                        savePlayerSelection(get());
                                    }
                                });
                            } else if (
                                resolvedTrack.path &&
                                !resolvedTrack.path.startsWith(
                                    'C:\\Music\\DJ_Set\\'
                                )
                            ) {
                                void fetchSingleTrackRealCover(
                                    resolvedTrack.path,
                                    resolvedTrack.artist,
                                    resolvedTrack.album
                                ).then((realCover) => {
                                    if (!realCover) return;
                                    get().updateCurrentTrackComputedMeta(
                                        resolvedTrack.id,
                                        resolvedTrack.path,
                                        { coverUrl: realCover }
                                    );
                                });
                            }
                        }
                        return;
                    }
                }

                // 情況 B：離線預覽模式或視窗在播放中最小化後重掛載/喚醒（當 C++ getPosition 未回傳時），
                // 依據真實經過的系統時鐘 (Wall-Clock Elapsed Time) 補償推進
                const latestSaved = loadSavedPlayerSelection();
                const anchorMs =
                    backgroundAnchorTimestampMs ??
                    (!hasConsumedInitialBackgroundResume &&
                    latestSaved.wasPlaying &&
                    latestSaved.lastUpdatedAt
                        ? latestSaved.lastUpdatedAt
                        : null);
                const anchorBaseSec =
                    backgroundAnchorMasterSec ??
                    (!hasConsumedInitialBackgroundResume
                        ? latestSaved.masterTimeSeconds
                        : get().masterTimeSeconds);

                const wasActivePlaying =
                    get().isPlaying ||
                    (!hasConsumedInitialBackgroundResume &&
                        Boolean(latestSaved.wasPlaying));

                if (wasActivePlaying && anchorMs && anchorMs > 0) {
                    hasConsumedInitialBackgroundResume = true;
                    const elapsedWallSec = Math.max(
                        0,
                        (Date.now() - anchorMs) / 1000
                    );
                    const stillPlaying = snap.supported
                        ? snap.isPlaying && !snap.isStopped
                        : true;

                    let targetGlobalSec = stillPlaying
                        ? anchorBaseSec + elapsedWallSec
                        : anchorBaseSec;

                    if (
                        stillPlaying &&
                        totalDuration > 0 &&
                        targetGlobalSec >= totalDuration
                    ) {
                        if (get().isTimelineLoopEnabled) {
                            targetGlobalSec = targetGlobalSec % totalDuration;
                        } else {
                            targetGlobalSec = totalDuration;
                        }
                    }

                    const seekTarget = resolveMasterTimelineSeek(
                        flatQueue,
                        targetGlobalSec
                    );
                    if (seekTarget) {
                        const prevTrackId = get().currentTrack?.id;
                        const targetTrack = resolveTrackFromQueueOrLibrary(
                            seekTarget.trackId,
                            seekTarget.queueOrder,
                            flatQueue,
                            libraryTracks,
                            get().currentTrack
                        );
                        lastTimelineTrackId = targetTrack?.id ?? null;
                        const nextIsPlaying =
                            stillPlaying &&
                            (targetGlobalSec < totalDuration ||
                                get().isTimelineLoopEnabled);

                        markMasterClockUpdated();
                        set({
                            currentTrack: targetTrack ?? get().currentTrack,
                            currentQueueOrder: seekTarget.queueOrder,
                            trackTimeSeconds: seekTarget.trackOffsetSeconds,
                            masterTimeSeconds: Number(
                                seekTarget.globalTimeSeconds.toFixed(2)
                            ),
                            masterTotalDuration: totalDuration,
                            isPlaying: nextIsPlaying,
                            activeCueLabel:
                                seekTarget.transitionLabel ??
                                evaluateActiveCueLabel(
                                    targetTrack ?? null,
                                    seekTarget.trackOffsetSeconds
                                ),
                        });

                        backgroundAnchorTimestampMs = nextIsPlaying
                            ? Date.now()
                            : null;
                        backgroundAnchorMasterSec = nextIsPlaying
                            ? seekTarget.globalTimeSeconds
                            : null;
                        savePlayerSelection(get());

                        if (targetTrack && targetTrack.id !== prevTrackId) {
                            if (targetTrack.coverUrl) {
                                void extractDominantColorFromUrl(
                                    targetTrack.coverUrl
                                ).then((hex) => {
                                    if (
                                        !get().isPreviewPlaying &&
                                        get().currentTrack?.id ===
                                            targetTrack.id
                                    ) {
                                        set({ dominantColor: hex });
                                        savePlayerSelection(get());
                                    }
                                });
                            } else if (
                                targetTrack.path &&
                                !targetTrack.path.startsWith(
                                    'C:\\Music\\DJ_Set\\'
                                )
                            ) {
                                void fetchSingleTrackRealCover(
                                    targetTrack.path,
                                    targetTrack.artist,
                                    targetTrack.album
                                ).then((realCover) => {
                                    if (!realCover) return;
                                    get().updateCurrentTrackComputedMeta(
                                        targetTrack.id,
                                        targetTrack.path,
                                        { coverUrl: realCover }
                                    );
                                });
                            }
                        }
                    }
                }
            } finally {
                isResyncingFromHost = false;
                inFlightHostSyncPromise = null;
            }
        };

        inFlightHostSyncPromise = runSync();
        return inFlightHostSyncPromise;
    },

    // 7. [方向 C] 跳轉至上一首曲目起點（若在當前曲目播放超過 3 秒則回到本曲起點）
    skipToPreviousTrack: (flatQueue, libraryTracks) => {
        if (flatQueue.length === 0) return;
        const { currentQueueOrder, masterTimeSeconds } = get();
        const currentIdx = flatQueue.findIndex(
            (item) => item.order === currentQueueOrder
        );
        if (currentIdx === -1) {
            get().seekMasterTimeline(0, flatQueue, libraryTracks);
            return;
        }

        const currentItem = flatQueue[currentIdx];
        if (
            masterTimeSeconds - currentItem.timelineStartSec > 3.0 ||
            currentIdx === 0
        ) {
            get().seekMasterTimeline(
                currentItem.timelineStartSec,
                flatQueue,
                libraryTracks
            );
        } else {
            const prevItem = flatQueue[currentIdx - 1];
            get().seekMasterTimeline(
                prevItem.timelineStartSec,
                flatQueue,
                libraryTracks
            );
        }
    },

    // 8. [方向 C] 跳轉至下一首曲目起點
    skipToNextTrack: (flatQueue, libraryTracks) => {
        if (flatQueue.length === 0) return;
        const { currentQueueOrder } = get();
        const currentIdx = flatQueue.findIndex(
            (item) => item.order === currentQueueOrder
        );
        const nextIdx =
            currentIdx >= 0 && currentIdx < flatQueue.length - 1
                ? currentIdx + 1
                : 0;
        const nextItem = flatQueue[nextIdx];
        get().seekMasterTimeline(
            nextItem.timelineStartSec,
            flatQueue,
            libraryTracks
        );
    },

    // 9. [方向 C] 快退 / 快進微調全局時間軸秒數 (例如 ±5s)
    nudgeMasterTimeline: (deltaSeconds, flatQueue, libraryTracks) => {
        if (flatQueue.length === 0) {
            const { currentTrack, trackTimeSeconds } = get();
            if (currentTrack) {
                get().seekCurrentTrack(trackTimeSeconds + deltaSeconds);
            }
            return;
        }
        const nextGlobal = get().masterTimeSeconds + deltaSeconds;
        get().seekMasterTimeline(nextGlobal, flatQueue, libraryTracks);
    },

    // 10. 總時間軸循環播放切換、演出鎖定模式與視窗置頂 (規格書 2.1)
    toggleTimelineLoop: () => {
        set((state) => ({
            isTimelineLoopEnabled: !state.isTimelineLoopEnabled,
        }));
        savePlayerSelection(get());
    },

    toggleLiveLock: () => {
        set((state) => ({ isLiveLocked: !state.isLiveLocked }));
    },

    toggleAlwaysOnTop: () => {
        const nextTop = !get().hostStatus.isAlwaysOnTop;
        sendCommandToHost('SET_ALWAYS_ON_TOP', { isAlwaysOnTop: nextTop });
        set((state) => ({
            hostStatus: {
                ...state.hostStatus,
                isAlwaysOnTop: nextTop,
            },
        }));
    },

    // 11. 視覺化面板控制
    setVisualizerMode: (mode) => {
        set({ visualizerMode: mode });
        savePlayerSelection(get());
    },

    setDominantColor: (hexColor) => {
        set({ dominantColor: hexColor });
        savePlayerSelection(get());
    },

    updateAudioMeters: (vuLevels, spectrumBins) => {
        // [修復錯誤 1.1 & 1.2：防止在 SILENCE 靜音過渡區間或暫停狀態下，非同步殘留的音訊取樣覆蓋歸零後的 VU Meter 造成閃爍]
        // 錯誤原因：當進入 SILENCE 靜音過渡區間時，advancePlaybackTick 每 100ms 將 vuLevels 歸零，但若此時仍有在途的 HOST_AUDIO_METERS 事件抵達，
        //          直接寫入 vuLevels 會導致畫面在「mix-out 瞬間音量」與「0」之間高速閃爍。
        // 修改目的：在 wasInSilenceGap 期間或未播放狀態下，強制維持 VU Meter 與頻譜為 0，徹底消除不正常閃動。
        const state = get();
        if (wasInSilenceGap || (!state.isPlaying && !state.isPreviewPlaying)) {
            set({
                vuLevels: {
                    leftPeak: 0,
                    leftRms: 0,
                    rightPeak: 0,
                    rightRms: 0,
                },
                spectrumBins: Array.from({ length: 64 }, () => 0),
            });
            return;
        }
        set({ vuLevels, spectrumBins });
    },

    updateHostStatus: (partial) => {
        set((state) => ({
            hostStatus: {
                ...state.hostStatus,
                ...partial,
            },
        }));
    },

    updateCurrentTrackComputedMeta: (trackId, path, patch) => {
        const { currentTrack, previewTrack } = get();
        const normInputPath = normalizeAudioPathForMatch(path);
        const matches = (t: Track | null) =>
            Boolean(t) &&
            (t!.id === trackId ||
                (Boolean(path) && t!.path === path) ||
                (Boolean(normInputPath) &&
                    normalizeAudioPathForMatch(t!.path) === normInputPath));

        const matchCurrent = matches(currentTrack);
        const matchPreview = matches(previewTrack);
        if (!matchCurrent && !matchPreview) return;

        set((state) => ({
            ...(matchCurrent && state.currentTrack
                ? {
                      currentTrack: {
                          ...state.currentTrack,
                          ...(patch.bpm !== undefined
                              ? { bpm: patch.bpm }
                              : {}),
                          ...(patch.key !== undefined
                              ? { key: patch.key }
                              : {}),
                          ...(patch.duration !== undefined
                              ? { duration: patch.duration }
                              : {}),
                          ...(patch.coverUrl !== undefined
                              ? { coverUrl: patch.coverUrl }
                              : {}),
                      },
                  }
                : {}),
            ...(matchPreview && state.previewTrack
                ? {
                      previewTrack: {
                          ...state.previewTrack,
                          ...(patch.bpm !== undefined
                              ? { bpm: patch.bpm }
                              : {}),
                          ...(patch.key !== undefined
                              ? { key: patch.key }
                              : {}),
                          ...(patch.duration !== undefined
                              ? { duration: patch.duration }
                              : {}),
                          ...(patch.coverUrl !== undefined
                              ? { coverUrl: patch.coverUrl }
                              : {}),
                      },
                  }
                : {}),
        }));
        savePlayerSelection(get());

        if (matchCurrent && patch.coverUrl) {
            void extractDominantColorFromUrl(patch.coverUrl).then((hex) => {
                if (matches(get().currentTrack)) {
                    set({ dominantColor: hex });
                    savePlayerSelection(get());
                }
            });
        }
    },
}));