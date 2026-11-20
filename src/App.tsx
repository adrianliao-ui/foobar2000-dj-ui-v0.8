import { useEffect, useRef, useState } from 'react';
import { usePlaylistStore } from './store/usePlaylistStore';
import { useWorkflowStore } from './store/useWorkflowStore';
import {
    notifyWindowRestoredFromHidden,
    usePlayerStore,
} from './store/usePlayerStore';
import { getThemePresetMeta, useThemeStore } from './store/useThemeStore';
import { applyLanguageToDomTree } from './utils/i18nDomTranslator';
import {
    bridgeApi,
    isFoobarWebView,
    subscribeToHostEvents,
} from './api/mockBridge';
import { audioStreamSocket } from './api/websocket';
import { HeaderBar } from './components/Header/HeaderBar';
import { MediaLibrary } from './components/Library/MediaLibrary';
import { DJCanvas } from './components/Canvas/DJCanvas';
import { VisualizerPanel } from './components/Visualizer/VisualizerPanel';
import { MasterTimeline } from './components/Timeline/MasterTimeline';

// ============================================================================
// [主元件] App：整合五大模組化核心區域、DJ 鍵盤快捷鍵與 foo_ui_webview2 C++ 宿主事件監聽
// ============================================================================
const PANEL_COLLAPSE_STORAGE_KEY = 'foobar_dj_panel_collapse_v1';

const loadSavedPanelCollapse = (): { lib: boolean; vis: boolean } => {
    try {
        const raw = localStorage.getItem(PANEL_COLLAPSE_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as { lib?: boolean; vis?: boolean };
            return {
                lib: Boolean(parsed?.lib),
                vis: Boolean(parsed?.vis),
            };
        }
    } catch {
        // ignore
    }
    return { lib: false, vis: false };
};

export default function App() {
    // [狀態管理] 控制左側智慧媒體庫與右側主視覺監控面板的收折狀態（自動持久化至 localStorage）
    const [isLibraryCollapsed, setIsLibraryCollapsed] = useState<boolean>(
        () => loadSavedPanelCollapse().lib
    );
    const [isVisualizerCollapsed, setIsVisualizerCollapsed] = useState<boolean>(
        () => loadSavedPanelCollapse().vis
    );

    useEffect(() => {
        try {
            localStorage.setItem(
                PANEL_COLLAPSE_STORAGE_KEY,
                JSON.stringify({
                    lib: isLibraryCollapsed,
                    vis: isVisualizerCollapsed,
                })
            );
        } catch {
            // ignore
        }
    }, [isLibraryCollapsed, isVisualizerCollapsed]);

    // [Store 1] 媒體庫初始化與全部曲目清單
    const loadMediaLibrary = usePlaylistStore((s) => s.loadMediaLibrary);
    const setLibraryTracksFromHost = usePlaylistStore(
        (s) => s.setLibraryTracksFromHost
    );
    const allTracks = usePlaylistStore((s) => s.allTracks);

    // [Store 2] 工作流畫布初始化與拓撲佇列
    const initWorkflowLibrary = useWorkflowStore((s) => s.fetchLibrary);
    const playlist = useWorkflowStore((s) => s.playlist);

    // [Store 3] 播放器計時推進器、快捷鍵控制與 C++ 宿主電平更新
    const isPlaying = usePlayerStore((s) => s.isPlaying);
    const isPreviewPlaying = usePlayerStore((s) => s.isPreviewPlaying);
    const currentTrack = usePlayerStore((s) => s.currentTrack);
    const preloadTrack = usePlayerStore((s) => s.preloadTrack);
    const updateCurrentTrackComputedMeta = usePlayerStore(
        (s) => s.updateCurrentTrackComputedMeta
    );
    const togglePlay = usePlayerStore((s) => s.togglePlay);
    const toggleLiveLock = usePlayerStore((s) => s.toggleLiveLock);
    const skipToPreviousTrack = usePlayerStore((s) => s.skipToPreviousTrack);
    const skipToNextTrack = usePlayerStore((s) => s.skipToNextTrack);
    const nudgeMasterTimeline = usePlayerStore((s) => s.nudgeMasterTimeline);
    const advancePlaybackTick = usePlayerStore((s) => s.advancePlaybackTick);
    const persistPlaybackProgressNow = usePlayerStore(
        (s) => s.persistPlaybackProgressNow
    );
    const syncMasterTimelineWithHostPosition = usePlayerStore(
        (s) => s.syncMasterTimelineWithHostPosition
    );
    const updateAudioMeters = usePlayerStore((s) => s.updateAudioMeters);
    const updateHostStatus = usePlayerStore((s) => s.updateHostStatus);
    const syncPlaybackFromHost = usePlayerStore((s) => s.syncPlaybackFromHost);
    const syncTrackChangeFromHost = usePlayerStore(
        (s) => s.syncTrackChangeFromHost
    );
    // 造成原錯誤的原因：原先 lastTickWallMs 為計時器 useEffect 內部區域變數，視窗從最小化還原或背景切歌對時後未同步重置，
    // 導致下一次 runTick 仍帶入最小化期間累積的數十秒 rawDeltaSec，誤觸跨曲目切換並呼叫 cueOrPlayTrack(0) 跳回曲目開頭。
    // 本次修改的目的：提升為元件層級 Ref，於視窗還原、window:stateChanged 與 HOST_TRACK_CHANGED 對時瞬間立即重置為當前時間。
    const lastTickWallMsRef = useRef<number>(0);
    const wasHostWindowMinimizedRef = useRef<boolean>(false);

    // [生命週期 1] 初始化載入媒體庫、預設畫布節點，並於 WebView2 環境主動發送握手訊號與同步背景播放進度
    useEffect(() => {
        void loadMediaLibrary();
        void initWorkflowLibrary();
        if (isFoobarWebView()) {
            bridgeApi.sendHandshakePing();
        }
    }, [loadMediaLibrary, initWorkflowLibrary]);

    // [生命週期 1b] 視窗最小化與還原對時保護：
    // 1. 視窗最小化/隱藏前，立即保存最新播放位置 (masterTimeSeconds / trackTimeSeconds)
    // 2. 視窗開啟/還原時，立即向 foobar2000 C++ 宿主查詢真實背景播放秒數並校準 seekhead
    // 造成原錯誤的原因：先前將 playlist 與 allTracks 列入此 useEffect 依賴陣列，導致播放中每次編輯畫布（如抽離/移除曲目 B）改變 playlist 時，
    // 都會立即觸發 syncMasterTimelineWithHostPosition，並拿宿主尚未重寫的舊播放清單列索引覆蓋前端剛重算好的時間軸位置。
    // 本次修改的目的：改透過 getState() 讀取最新佇列，僅在初次啟動與視窗從最小化/背景恢復焦點時向宿主對時。
    useEffect(() => {
        const initialQueue = useWorkflowStore.getState().playlist;
        const initialLib = usePlaylistStore.getState().allTracks;
        if (initialQueue.length > 0) {
            void syncMasterTimelineWithHostPosition(initialQueue, initialLib);
        }

        let lastRestoreSyncAtMs = 0;
        const triggerRestoreSync = (fromHiddenRestore: boolean) => {
            const now = Date.now();
            lastTickWallMsRef.current = now;
            // 造成原錯誤的原因：開啟最小化視窗時，瀏覽器會同時觸發 visibilitychange 與 window.focus，且背景計時器 runTick 會在 IPC 快照回傳前先用累積時間差盲推一次，造成 seekhead 先跳再拉回。
            // 本次修改的目的：通知 Store 短暫凍結盲推 (notifyWindowRestoredFromHidden)，並對 180ms 內的重複喚醒事件去重。
            if (fromHiddenRestore) {
                notifyWindowRestoredFromHidden();
            }
            if (now - lastRestoreSyncAtMs < 180) {
                return;
            }
            lastRestoreSyncAtMs = now;
            const currentQueue = useWorkflowStore.getState().playlist;
            const currentLib = usePlaylistStore.getState().allTracks;
            if (currentQueue.length > 0) {
                void syncMasterTimelineWithHostPosition(
                    currentQueue,
                    currentLib
                );
            }
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                persistPlaybackProgressNow();
            } else if (document.visibilityState === 'visible') {
                triggerRestoreSync(true);
            }
        };

        const handleWindowFocus = () => {
            triggerRestoreSync(false);
        };

        const handleBeforeUnload = () => {
            persistPlaybackProgressNow();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('pagehide', handleBeforeUnload);
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            document.removeEventListener(
                'visibilitychange',
                handleVisibilityChange
            );
            window.removeEventListener('focus', handleWindowFocus);
            window.removeEventListener('pagehide', handleBeforeUnload);
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [persistPlaybackProgressNow, syncMasterTimelineWithHostPosition]);

    // [生命週期 2] 僅在尚未載入 currentTrack 且總時間軸佇列 (playlist) 有排程曲目時預載時間軸第一首；若已從快取還原則補齊封面與分析數據
    useEffect(() => {
        if (!currentTrack && playlist.length > 0) {
            const firstQueueItem = playlist[0];
            const matchedTrack = allTracks.find(
                (t) =>
                    t.id === firstQueueItem.trackId ||
                    (Boolean(firstQueueItem.path) &&
                        t.path === firstQueueItem.path)
            );
            const initialTrack = matchedTrack ?? {
                id: firstQueueItem.trackId,
                title: firstQueueItem.title,
                artist: firstQueueItem.artist,
                album: firstQueueItem.album,
                albumId: firstQueueItem.sourceNodeId || firstQueueItem.album,
                duration: firstQueueItem.duration,
                bpm: firstQueueItem.bpm,
                key: firstQueueItem.key,
                coverUrl: firstQueueItem.coverUrl ?? '',
                path: firstQueueItem.path,
                cuePoints: {
                    mixIn: 0,
                    mixOut: firstQueueItem.duration,
                },
            };
            preloadTrack(initialTrack, firstQueueItem.order);
            return;
        }
        if (currentTrack && allTracks.length > 0) {
            const matchedInLib = allTracks.find(
                (t) =>
                    t.id === currentTrack.id ||
                    (Boolean(currentTrack.path) && t.path === currentTrack.path)
            );
            if (matchedInLib) {
                const needCover =
                    !currentTrack.coverUrl && Boolean(matchedInLib.coverUrl);
                const needKey =
                    Boolean(matchedInLib.key) &&
                    matchedInLib.key !== currentTrack.key;
                const needBpm =
                    Boolean(matchedInLib.bpm) &&
                    matchedInLib.bpm !== currentTrack.bpm;
                if (needCover || needKey || needBpm) {
                    updateCurrentTrackComputedMeta(
                        currentTrack.id,
                        currentTrack.path,
                        {
                            ...(needCover
                                ? { coverUrl: matchedInLib.coverUrl }
                                : {}),
                            ...(needKey ? { key: matchedInLib.key } : {}),
                            ...(needBpm ? { bpm: matchedInLib.bpm } : {}),
                        }
                    );
                }
            }
        }
    }, [
        currentTrack,
        allTracks,
        playlist,
        preloadTrack,
        updateCurrentTrackComputedMeta,
    ]);

    // [生命週期 3] 背景常駐高精度計時器 (Web Worker 驅動 + 真實經過時間差 deltaSeconds 補償)
    // [修復最小化期間自然進入下一首歌後回溯的問題]
    // 造成錯誤的原因：原先寫了 `Math.min(2.5, rawDeltaSec)`，當視窗最小化被作業系統休眠/節流數十秒再喚醒時，
    // 實際經過的數十秒被硬生生截斷成只前進 2.5 秒，導致 `masterTimeSeconds` 與 `currentTrack` 停留在前一首歌的尾部，並覆寫了 localStorage。
    // 修改的目的：移除 2.5 秒上限截斷（允許真實時鐘差值推進），並在 WebView2 環境下每 2 秒定期與 C++ 宿主校準真實播放曲目與秒數，確保背景切歌 100% 視聽同步。
    useEffect(() => {
        if (!isPlaying && !isPreviewPlaying) return;

        lastTickWallMsRef.current = Date.now();
        let hostSyncCounter = 0;

        const runTick = () => {
            const nowWallMs = Date.now();
            const prevWallMs =
                lastTickWallMsRef.current > 0
                    ? lastTickWallMsRef.current
                    : nowWallMs - 100;
            const rawDeltaSec = (nowWallMs - prevWallMs) / 1000;
            lastTickWallMsRef.current = nowWallMs;
            // 允許真實經過時間完整推進（例如背景休眠後喚醒），不再截斷為 2.5 秒
            const clampedDelta = Math.max(0.02, Math.min(3600, rawDeltaSec));
            const latestQueue = useWorkflowStore.getState().playlist;
            const latestTracks = usePlaylistStore.getState().allTracks;
            advancePlaybackTick(clampedDelta, latestQueue, latestTracks);

            // 在 foobar2000 WebView2 環境播放總時間軸時，每 2 秒 (20 ticks) 輕量級與宿主校準一次當前曲目與秒數
            if (isFoobarWebView() && isPlaying && !isPreviewPlaying) {
                hostSyncCounter += 1;
                if (hostSyncCounter >= 20 && latestQueue.length > 0) {
                    hostSyncCounter = 0;
                    void syncMasterTimelineWithHostPosition(
                        latestQueue,
                        latestTracks
                    );
                }
            }
        };

        let worker: Worker | null = null;
        let workerBlobUrl: string | null = null;
        let fallbackTimer: ReturnType<typeof setInterval> | null = null;

        try {
            const workerCode = `
                let timer = null;
                self.onmessage = function(e) {
                    if (e.data === 'start') {
                        if (timer) clearInterval(timer);
                        timer = setInterval(function() {
                            self.postMessage('tick');
                        }, 100);
                    } else if (e.data === 'stop') {
                        if (timer) clearInterval(timer);
                        timer = null;
                    }
                };
            `;
            const blob = new Blob([workerCode], {
                type: 'application/javascript',
            });
            workerBlobUrl = URL.createObjectURL(blob);
            worker = new Worker(workerBlobUrl);
            worker.onmessage = () => {
                runTick();
            };
            worker.postMessage('start');
        } catch {
            fallbackTimer = setInterval(runTick, 100);
        }

        return () => {
            if (worker) {
                worker.postMessage('stop');
                worker.terminate();
            }
            if (workerBlobUrl) {
                URL.revokeObjectURL(workerBlobUrl);
            }
            if (fallbackTimer) {
                clearInterval(fallbackTimer);
            }
        };
    }, [
        isPlaying,
        isPreviewPlaying,
        advancePlaybackTick,
        syncMasterTimelineWithHostPosition,
    ]);

    // [生命週期 4 - 方向 C] 全局 DJ 現場鍵盤快捷鍵監聽 (自動忽略文字輸入框焦點，但允許滑桿 range / 按鈕觸發後直接使用快捷鍵)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target) {
                const isTextInput =
                    target.tagName === 'INPUT' &&
                    !['range', 'button', 'checkbox', 'radio'].includes(
                        (target as HTMLInputElement).type
                    );
                if (
                    isTextInput ||
                    target.tagName === 'TEXTAREA' ||
                    target.tagName === 'SELECT' ||
                    target.isContentEditable
                ) {
                    return;
                }
            }

            if (e.ctrlKey || e.metaKey || e.altKey) return;

            if (e.code === 'Space') {
                e.preventDefault();
                if (target && typeof target.blur === 'function') target.blur();
                togglePlay(playlist, allTracks);
            } else if (e.code === 'ArrowLeft') {
                e.preventDefault();
                if (target && typeof target.blur === 'function') target.blur();
                nudgeMasterTimeline(-5, playlist, allTracks);
            } else if (e.code === 'ArrowRight') {
                e.preventDefault();
                if (target && typeof target.blur === 'function') target.blur();
                nudgeMasterTimeline(5, playlist, allTracks);
            } else if (e.key === '[') {
                e.preventDefault();
                if (target && typeof target.blur === 'function') target.blur();
                skipToPreviousTrack(playlist, allTracks);
            } else if (e.key === ']') {
                e.preventDefault();
                if (target && typeof target.blur === 'function') target.blur();
                skipToNextTrack(playlist, allTracks);
            } else if (e.code === 'KeyL') {
                e.preventDefault();
                if (target && typeof target.blur === 'function') target.blur();
                toggleLiveLock();
            }
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () =>
            window.removeEventListener('keydown', handleKeyDown, {
                capture: true,
            });
    }, [
        playlist,
        allTracks,
        togglePlay,
        nudgeMasterTimeline,
        skipToPreviousTrack,
        skipToNextTrack,
        toggleLiveLock,
    ]);

    // [生命週期 5 - Phase 7 & 方向 A] 訂閱來自 foo_ui_webview2 C++ 宿主的即時推播事件
    useEffect(() => {
        const unsubscribe = subscribeToHostEvents((message) => {
            if (message.event === 'HOST_HANDSHAKE_ACK') {
                updateHostStatus({
                    isConnectedToBridge: true,
                    audioDevice: `${message.payload.audioDevice} (foobar2000 ${message.payload.foobarVersion})`,
                });
                if (message.payload.wsEndpoint) {
                    audioStreamSocket.connect(
                        message.payload.wsEndpoint,
                        updateAudioMeters
                    );
                }
            } else if (message.event === 'HOST_AUDIO_METERS') {
                updateAudioMeters(
                    message.payload.vuLevels,
                    message.payload.spectrumBins
                );
            } else if (message.event === 'HOST_PLAYBACK_STATE') {
                // 使用被動狀態同步，不回傳 SET_PLAYBACK_STATE 或 SEEK_TRACK，徹底防止播放迴授斷音
                syncPlaybackFromHost(
                    message.payload.isPlaying,
                    message.payload.trackTimeSeconds,
                    message.payload.hostState
                );
            } else if (message.event === 'HOST_TRACK_CHANGED') {
                // [修復最小化背景自然切歌] 當 foobar2000 在背景自然播完前一首歌進入下一首歌時，
                // 立即同步總時間軸 seekhead、當前曲目、專輯封面與主色調，並主動拉取一次完整宿主位置快照
                lastTickWallMsRef.current = Date.now();
                const currentQueue = useWorkflowStore.getState().playlist;
                const currentLib = usePlaylistStore.getState().allTracks;
                syncTrackChangeFromHost(
                    message.payload,
                    currentQueue,
                    currentLib
                );
                // [修復問題 1.1] 若 syncTrackChangeFromHost 已攔截並進入 Silence 靜音過渡，不拉取宿主位置快照以避免將時間軸拉往下一首曲目起點
                const latestCueLabel =
                    usePlayerStore.getState().activeCueLabel ?? '';
                if (
                    currentQueue.length > 0 &&
                    !latestCueLabel.startsWith('Silence 靜音過渡中')
                ) {
                    void syncMasterTimelineWithHostPosition(
                        currentQueue,
                        currentLib
                    );
                }
            } else if (message.event === 'HOST_WINDOW_STATE_CHANGED') {
                // 依據官方 window:stateChanged 事件：最小化瞬間保存時間軸錨點，從最小化還原瞬間立即重設 tick 基準並向宿主同步最新進度
                if (message.payload.isMinimized) {
                    wasHostWindowMinimizedRef.current = true;
                    persistPlaybackProgressNow();
                } else if (wasHostWindowMinimizedRef.current) {
                    wasHostWindowMinimizedRef.current = false;
                    lastTickWallMsRef.current = Date.now();
                    notifyWindowRestoredFromHidden();
                    const currentQueue = useWorkflowStore.getState().playlist;
                    const currentLib = usePlaylistStore.getState().allTracks;
                    if (currentQueue.length > 0) {
                        void syncMasterTimelineWithHostPosition(
                            currentQueue,
                            currentLib
                        );
                    }
                }
            } else if (message.event === 'HOST_LIBRARY_UPDATED') {
                const { selectedPlaylistValue, hasInitializedLibrary } =
                    usePlaylistStore.getState();
                // 僅在尚未初始化或使用者正處於「全部媒體庫」檢視時才接收宿主媒體庫推送，避免視窗還原時洗掉當前 Playlist
                if (
                    !hasInitializedLibrary ||
                    selectedPlaylistValue === '__ALL_LIBRARY__' ||
                    selectedPlaylistValue === '__AUTO_INIT__'
                ) {
                    if (
                        Array.isArray(message.payload.tracks) &&
                        message.payload.tracks.length > 0
                    ) {
                        setLibraryTracksFromHost(message.payload.tracks);
                    }
                }
            }
        });
        return unsubscribe;
    }, [
        updateAudioMeters,
        updateHostStatus,
        syncPlaybackFromHost,
        syncTrackChangeFromHost,
        syncMasterTimelineWithHostPosition,
        persistPlaybackProgressNow,
        loadMediaLibrary,
        setLibraryTracksFromHost,
    ]);

    const themeId = useThemeStore((s) => s.themeId);
    const language = useThemeStore((s) => s.language);
    const initThemeOnMount = useThemeStore((s) => s.initThemeOnMount);
    const activeThemeMeta = getThemePresetMeta(themeId);
    const appRootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        initThemeOnMount();
    }, [initThemeOnMount]);

    // [多國語言即時同步] 監聽語言切換與局部 DOM 變化，零侵入式轉換繁中 / 簡中 / 英文介面文字
    useEffect(() => {
        const rootEl = appRootRef.current;
        if (!rootEl) return;

        applyLanguageToDomTree(rootEl, language);

        let rafId = 0;
        const observer = new MutationObserver(() => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                if (appRootRef.current) {
                    applyLanguageToDomTree(appRootRef.current, language);
                }
            });
        });

        observer.observe(rootEl, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            observer.disconnect();
        };
    }, [language]);

    return (
        <div
            ref={appRootRef}
            data-theme={themeId}
            className={`dj-app-root h-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col select-none transition-colors duration-200 ${activeThemeMeta.layoutSpec.appPaddingClass}`}
        >
            {/* [區塊 1] 頂端控制與歌單管理列 */}
            <div className="shrink-0 relative z-40">
                <HeaderBar />
            </div>

            {/* [中央主工作區] 採用彈性 Flex 佈局並自動延展填滿剩餘垂直與水平空間，消除畫布下方多餘留白 */}
            <div
                className={`flex flex-col lg:flex-row flex-1 min-h-0 min-w-0 ${activeThemeMeta.layoutSpec.workspaceGapClass}`}
            >
                {/* [區塊 2] 左側：虛擬滾動與多重過濾智慧媒體庫 (支援向左收折/展開) */}
                <MediaLibrary
                    isCollapsed={isLibraryCollapsed}
                    onToggleCollapse={() =>
                        setIsLibraryCollapsed((prev) => !prev)
                    }
                />

                {/* [區塊 3] 中間：React Flow 節點式工作流畫布 (自動延展填滿剩餘寬度與高度) */}
                <DJCanvas />

                {/* [區塊 4] 右側：主視覺、L/R VU Meter、頻譜與線性播放佇列 (支援向右收折/展開) */}
                <VisualizerPanel
                    isCollapsed={isVisualizerCollapsed}
                    onToggleCollapse={() =>
                        setIsVisualizerCollapsed((prev) => !prev)
                    }
                />
            </div>

            {/* [區塊 5] 底部 Master 總時間軸 (彩色曲目區塊 + Instant Scrubbing + 右上角音量控制) */}
            <div className="shrink-0">
                <MasterTimeline />
            </div>
        </div>
    );
}