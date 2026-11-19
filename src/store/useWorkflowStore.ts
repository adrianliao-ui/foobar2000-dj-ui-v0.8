import { create } from 'zustand';
import {
    type Connection,
    type Edge,
    type EdgeChange,
    type Node,
    type NodeChange,
    applyNodeChanges,
    applyEdgeChanges,
} from '@xyflow/react';
import type { AlbumGroup, CuePoints, Track } from '../types/track';
import type {
    AlbumNodeData,
    FlatPlayQueueItem,
    TransitionAnalysis,
    TransitionConfig,
    TransitionEdgeData,
    WorkflowProjectFile,
} from '../types/workflow';
import {
    bridgeApi,
    fetchSingleTrackRealCover,
    normalizeAudioPathForMatch,
    queryTracksExactFloorDurations,
} from '../api/mockBridge';
import { floorDurationToTenth } from '../utils/formatTime';
import {
    autoReconcileAdjacentAlbumNodes,
    createAlbumGroupFromTracks,
    extractSingleTrackToNewGroup,
    groupLibraryTracksByAlbum,
    mergeTwoAlbumGroups,
} from '../algorithms/autoGrouping';
import {
    analyzeAlbumGroupTransition,
    buildOptimalHarmonicTrackSequence,
} from '../algorithms/harmonicMixing';
import {
    buildFlatPlayQueue,
    validateConnectionRule,
} from '../algorithms/topologicalSort';
import { serializeWorkflowProject } from '../utils/projectExporter';
import {
    clearAutoSaveProject,
    loadAutoSaveProject,
    loadPresetSlot,
    saveAutoSaveProject,
    savePresetSlot,
    type QuickSlotId,
} from '../utils/localStorageCache';
import {
    enqueueTracksForRealBpmKeyAnalysis,
    getCachedRealAudioAnalysis,
} from '../utils/audioAnalyzer';
import {
    ensureArtworkCacheLoaded,
    getCachedCoverSync,
} from '../utils/artworkCache';
import { usePlaylistStore } from './usePlaylistStore';
import { usePlayerStore } from './usePlayerStore';

export interface TrackComputedMetaBatchItem {
    trackId: string;
    path: string;
    patch: {
        bpm?: number;
        key?: string;
        duration?: number;
        coverUrl?: string;
    };
}

interface WorkflowState {
    libraryTracks: Track[];
    albumGroups: AlbumGroup[];
    isLoadingLibrary: boolean;
    hasInitializedWorkflow: boolean;
    fetchLibrary: () => Promise<void>;

    nodes: Node<AlbumNodeData>[];
    edges: Edge<TransitionEdgeData>[];
    activeEdgeId: string | null;
    setActiveEdgeId: (edgeId: string | null) => void;

    onNodesChange: (changes: NodeChange<Node<AlbumNodeData>>[]) => void;
    onEdgesChange: (changes: EdgeChange[]) => void;
    onConnect: (connection: Connection) => void;
    onReconnect: (
        oldEdge: Edge<TransitionEdgeData>,
        newConnection: Connection
    ) => boolean;
    deleteEdgeById: (edgeId: string) => void;
    deleteNodeById: (nodeId: string) => void;

    addAlbumGroupToCanvas: (
        group: AlbumGroup,
        position?: { x: number; y: number }
    ) => void;
    addTracksToCanvas: (
        tracks: Track[],
        dropPosition?: { x: number; y: number }
    ) => void;
    extractTrackFromNode: (nodeId: string, trackId: string) => void;
    toggleTrackExpandInNode: (nodeId: string, trackId: string) => void;
    reorderTracksInNode: (
        nodeId: string,
        fromIndex: number,
        toIndex: number
    ) => void;
    mergeNodesOnOverlap: (draggedNodeId: string, targetNodeId: string) => void;
    updateTrackCuePointsInWorkflow: (
        nodeId: string,
        trackId: string,
        cuePoints: CuePoints
    ) => void;
    updateTrackComputedMetaInWorkflow: (
        trackId: string,
        path: string,
        patch: {
            bpm?: number;
            key?: string;
            duration?: number;
            coverUrl?: string;
        }
    ) => void;
    batchUpdateTrackComputedMetaInWorkflow: (
        items: TrackComputedMetaBatchItem[]
    ) => void;
    updateTrackInternalTransitionInWorkflow: (
        nodeId: string,
        trackId: string,
        transition: TransitionConfig
    ) => void;
    updateEdgeTransition: (edgeId: string, transition: TransitionConfig) => void;

    // 專案匯出入、一鍵自動排版、直式/橫式方向切換、圖層與自動合併開關狀態持久化、手動同步與本地快取槽 (Phase 6 & 方向 B & 3a)
    canvasOrientation: 'horizontal' | 'vertical';
    toggleCanvasOrientation: () => void;
    showMiniMap: boolean;
    showCamelotWheel: boolean;
    autoMergeSameAlbum: boolean;
    toggleMiniMap: () => void;
    toggleCamelotWheel: (forceVal?: boolean) => void;
    toggleAutoMergeSameAlbum: () => void;
    exportProjectData: () => WorkflowProjectFile;
    importProjectData: (project: WorkflowProjectFile) => void;
    autoLayoutNodes: () => void;
    autoRecommendArrangeWorkflow: () => void;
    syncCurrentQueueToFoobar: () => void;
    saveToQuickSlot: (slotId: QuickSlotId) => boolean;
    loadFromQuickSlot: (slotId: QuickSlotId) => boolean;
    resetCanvasToDefault: () => void;
    clearCanvas: () => void;

    playlist: FlatPlayQueueItem[];
    orderedNodeIds: string[];
    excludedNodeIds: string[];
    totalTimelineDuration: number;
    hasCycle: boolean;
}

const createAlbumNode = (
    group: AlbumGroup,
    position: { x: number; y: number },
    customIdSuffix?: string
): Node<AlbumNodeData> => {
    const suffix = customIdSuffix ? `-${customIdSuffix}` : '';
    return {
        id: `node-${group.albumId}${suffix}`,
        type: 'albumNode',
        position,
        data: {
            label: `${group.album} - ${group.artist}`,
            albumGroup: group,
            expandedTrackIds: [],
        },
    };
};

const buildEdgePresentation = (
    transition: TransitionConfig,
    analysis?: TransitionAnalysis
): {
    label: string;
    style: Record<string, string | number>;
    animated: boolean;
} => {
    const edgeColor = analysis?.suggestedEdgeColor ?? '#64748b';
    const transText =
        transition.type === 'CROSSFADE'
            ? `Crossfade ${transition.duration}s`
            : transition.type === 'SILENCE'
                ? `Silence ${transition.duration}s`
                : 'Cut 0s';

    const label = analysis
        ? `${transText} • ${analysis.score}分 (${analysis.suggestedPitchText})`
        : transText;

    const strokeWidth = transition.type === 'CROSSFADE' ? 3.5 : 2.2;
    const strokeDasharray =
        transition.type === 'SILENCE' ? '6 4' : undefined;

    return {
        label,
        animated: analysis?.status === 'harmonic' && transition.type !== 'SILENCE',
        style: {
            stroke: edgeColor,
            strokeWidth,
            ...(strokeDasharray ? { strokeDasharray } : {}),
        },
    };
};

const refreshEdgesAnalysis = (
    nodes: Node<AlbumNodeData>[],
    edges: Edge<TransitionEdgeData>[]
): Edge<TransitionEdgeData>[] => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
        const sourceNode = nodeMap.get(e.source);
        const targetNode = nodeMap.get(e.target);
        if (!sourceNode || !targetNode) return e;

        const analysis = analyzeAlbumGroupTransition(
            sourceNode.data.albumGroup,
            targetNode.data.albumGroup
        );
        const transition: TransitionConfig = e.data?.transition ?? {
            type: 'CROSSFADE',
            duration: 5.0,
        };
        const presentation = buildEdgePresentation(transition, analysis);

        return {
            ...e,
            type: 'transitionEdge',
            reconnectable: true,
            interactionWidth: 28,
            animated: presentation.animated,
            label: presentation.label,
            style: presentation.style,
            labelStyle: { fill: '#f8fafc', fontWeight: 600, fontSize: 11 },
            labelBgStyle: { fill: '#0f172a', fillOpacity: 0.88 },
            data: {
                transition,
                analysis,
            },
        };
    });
};

const CANVAS_OVERLAYS_STORAGE_KEY = 'foobar_dj_canvas_overlays_v1';

const loadSavedOverlayPrefs = (): {
    miniMap: boolean;
    camelotWheel: boolean;
    autoMergeSameAlbum: boolean;
} => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(
                CANVAS_OVERLAYS_STORAGE_KEY
            );
            if (raw) {
                const parsed = JSON.parse(raw) as {
                    miniMap?: boolean;
                    camelotWheel?: boolean;
                    autoMergeSameAlbum?: boolean;
                };
                return {
                    miniMap:
                        typeof parsed.miniMap === 'boolean'
                            ? parsed.miniMap
                            : true,
                    camelotWheel:
                        typeof parsed.camelotWheel === 'boolean'
                            ? parsed.camelotWheel
                            : true,
                    autoMergeSameAlbum:
                        typeof parsed.autoMergeSameAlbum === 'boolean'
                            ? parsed.autoMergeSameAlbum
                            : true,
                };
            }
        }
    } catch {
        // ignore
    }
    return { miniMap: true, camelotWheel: true, autoMergeSameAlbum: true };
};

const saveOverlayPrefsToStorage = (prefs: {
    miniMap: boolean;
    camelotWheel: boolean;
    autoMergeSameAlbum?: boolean;
}): void => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const existing = loadSavedOverlayPrefs();
            window.localStorage.setItem(
                CANVAS_OVERLAYS_STORAGE_KEY,
                JSON.stringify({
                    miniMap: prefs.miniMap,
                    camelotWheel: prefs.camelotWheel,
                    autoMergeSameAlbum:
                        typeof prefs.autoMergeSameAlbum === 'boolean'
                            ? prefs.autoMergeSameAlbum
                            : existing.autoMergeSameAlbum,
                })
            );
        }
    } catch {
        // ignore
    }
};

let autoSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 同步將當前畫布狀態（包含直式/橫式方向、駱駝色輪與縮略圖開關狀態）寫入本地 Auto-Save
 */
const persistAutoSave = (
    nodes: Node<AlbumNodeData>[],
    edges: Edge<TransitionEdgeData>[],
    canvasOrientation?: 'horizontal' | 'vertical',
    overlays?: { showCamelotWheel?: boolean; showMiniMap?: boolean }
): void => {
    if (autoSaveDebounceTimer) {
        clearTimeout(autoSaveDebounceTimer);
        autoSaveDebounceTimer = null;
    }
    const savedPrefs = loadSavedOverlayPrefs();
    const resolvedOrientation = canvasOrientation;
    const resolvedOverlays = {
        showCamelotWheel:
            overlays?.showCamelotWheel ?? savedPrefs.camelotWheel,
        showMiniMap: overlays?.showMiniMap ?? savedPrefs.miniMap,
    };
    saveAutoSaveProject(
        serializeWorkflowProject(
            nodes,
            edges,
            resolvedOrientation,
            resolvedOverlays
        )
    );
};

/**
 * 防抖 (Debounced) 寫入 Auto-Save：供節點拖曳結束放開滑鼠時使用，避免阻塞主執行緒動畫
 */
const persistAutoSaveDebounced = (
    nodes: Node<AlbumNodeData>[],
    edges: Edge<TransitionEdgeData>[]
): void => {
    if (autoSaveDebounceTimer) {
        clearTimeout(autoSaveDebounceTimer);
    }
    autoSaveDebounceTimer = setTimeout(() => {
        autoSaveDebounceTimer = null;
        persistAutoSave(nodes, edges);
    }, 250);
};

/**
 * 將專案結構還原為畫布節點與連線，並自動對齊最新媒體庫封面、LRC、展開曲目狀態與真實計算出的 BPM / 駱駝色輪色號
 */
const hydrateProjectToNodesAndEdges = (
    project: WorkflowProjectFile,
    libraryTracks: Track[]
): {
    nodes: Node<AlbumNodeData>[];
    edges: Edge<TransitionEdgeData>[];
    canvasOrientation?: 'horizontal' | 'vertical';
    showCamelotWheel?: boolean;
    showMiniMap?: boolean;
} => {
    const trackLookup = new Map(libraryTracks.map((t) => [t.id, t]));
    const hasRealLibraryTracks = libraryTracks.some(
        (t) => !t.path.startsWith('C:\\Music\\DJ_Set\\')
    );

    const restoredNodes: Node<AlbumNodeData>[] = project.nodes
        .map((n): Node<AlbumNodeData> | null => {
            // 若目前環境已載入真實 foobar2000 媒體庫，自動過濾掉舊快取中的模擬測試曲目 (C:\Music\DJ_Set\...)
            const validSavedTracks = hasRealLibraryTracks
                ? n.tracks.filter(
                      (t) => !t.path.startsWith('C:\\Music\\DJ_Set\\')
                  )
                : n.tracks;

            if (!Array.isArray(validSavedTracks) || validSavedTracks.length === 0) {
                return null;
            }

            const enrichedTracks = validSavedTracks.map((savedTrack) => {
                const latestLibTrack = trackLookup.get(savedTrack.id);
                const cachedRealAnalysis = getCachedRealAudioAnalysis(
                    savedTrack.path || savedTrack.id
                );
                const cachedIdbCover = getCachedCoverSync(
                    savedTrack.path || latestLibTrack?.path,
                    savedTrack.artist || latestLibTrack?.artist,
                    savedTrack.album || latestLibTrack?.album
                );
                if (!latestLibTrack) {
                    // 造成原錯誤的原因：整數秒 Math.floor 會捨去高達 0.99 秒的小數時長，累積後造成佇列總時間偏短。
                    // 本次修改的目的：改為 floorDurationToTenth 保留 0.1s 精度向下取整。
                    const nextDur =
                        cachedRealAnalysis?.duration &&
                        cachedRealAnalysis.duration > 0 &&
                        Math.abs(
                            cachedRealAnalysis.duration - savedTrack.duration
                        ) <= 2
                            ? Math.min(
                                  savedTrack.duration,
                                  floorDurationToTenth(
                                      cachedRealAnalysis.duration
                                  )
                              )
                            : floorDurationToTenth(savedTrack.duration);
                    const wasDefaultMixOut =
                        Math.abs(
                            (savedTrack.cuePoints.mixOut ??
                                savedTrack.duration) - savedTrack.duration
                        ) <= 1;
                    return {
                        ...savedTrack,
                        duration: nextDur,
                        cuePoints: {
                            ...savedTrack.cuePoints,
                            mixOut: wasDefaultMixOut
                                ? nextDur
                                : Math.min(
                                      savedTrack.cuePoints.mixOut,
                                      nextDur
                                  ),
                        },
                        ...(cachedRealAnalysis
                            ? {
                                  bpm: cachedRealAnalysis.bpm,
                                  key: cachedRealAnalysis.key,
                              }
                            : {}),
                        ...(cachedIdbCover && !savedTrack.coverUrl
                            ? { coverUrl: cachedIdbCover }
                            : {}),
                    };
                }
                const effectiveDuration =
                    latestLibTrack.duration > 0
                        ? floorDurationToTenth(latestLibTrack.duration)
                        : floorDurationToTenth(savedTrack.duration);
                const wasDefaultMixOut =
                    Math.abs(
                        (savedTrack.cuePoints.mixOut ?? savedTrack.duration) -
                            savedTrack.duration
                    ) <= 1;
                return {
                    ...latestLibTrack,
                    ...savedTrack,
                    duration: effectiveDuration,
                    cuePoints: {
                        ...savedTrack.cuePoints,
                        mixOut: wasDefaultMixOut
                            ? effectiveDuration
                            : Math.min(
                                  savedTrack.cuePoints.mixOut,
                                  effectiveDuration
                              ),
                    },
                    bpm:
                        cachedRealAnalysis?.bpm ??
                        savedTrack.bpm ??
                        latestLibTrack.bpm,
                    key:
                        cachedRealAnalysis?.key ??
                        savedTrack.key ??
                        latestLibTrack.key,
                    path: latestLibTrack.path || savedTrack.path,
                    coverUrl:
                        cachedIdbCover ||
                        latestLibTrack.coverUrl ||
                        savedTrack.coverUrl,
                    lrc: latestLibTrack.lrc ?? savedTrack.lrc,
                };
            });
            const group = createAlbumGroupFromTracks(enrichedTracks);
            const validTrackIdSet = new Set(enrichedTracks.map((t) => t.id));
            const restoredExpandedIds = Array.isArray(n.expandedTrackIds)
                ? n.expandedTrackIds.filter((id) => validTrackIdSet.has(id))
                : [];

            return {
                id: n.id,
                type: 'albumNode',
                position: {
                    x: Number(n.position.x) || 60,
                    y: Number(n.position.y) || 60,
                },
                data: {
                    label: `${group.album} - ${group.artist}`,
                    albumGroup: group,
                    expandedTrackIds: restoredExpandedIds,
                },
            };
        })
        .filter((n): n is Node<AlbumNodeData> => n !== null);

    const validNodeIds = new Set(restoredNodes.map((n) => n.id));
    const rawEdges: Edge<TransitionEdgeData>[] = project.edges
        .filter((e) => validNodeIds.has(e.source) && validNodeIds.has(e.target))
        .map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'transitionEdge',
            reconnectable: true,
            interactionWidth: 28,
            data: {
                transition: e.transition,
            },
        }));

    return {
        nodes: restoredNodes,
        edges: refreshEdgesAnalysis(restoredNodes, rawEdges),
        canvasOrientation: project.canvasOrientation,
        showCamelotWheel: project.showCamelotWheel,
        showMiniMap: project.showMiniMap,
    };
};

const initialOverlayPrefs = loadSavedOverlayPrefs();

// [0ms 瞬時還原引擎] 於 Store 建立當下同步讀取本地 Auto-Save 畫布節點與連線，
// 確保最小化再開啟時，第 0 幀即刻完整呈現畫布卡片與總時間軸，絕不等待左側媒體庫載入！
const buildInitialSynchronouslyRestoredWorkflow = () => {
    const autoSaved = loadAutoSaveProject();
    if (!autoSaved) {
        return null;
    }
    const hydrated = hydrateProjectToNodesAndEdges(autoSaved, []);
    const topoResult = buildFlatPlayQueue(hydrated.nodes, hydrated.edges);
    return {
        nodes: hydrated.nodes,
        edges: hydrated.edges,
        canvasOrientation: hydrated.canvasOrientation ?? 'horizontal',
        showCamelotWheel:
            initialOverlayPrefs.camelotWheel ??
            hydrated.showCamelotWheel ??
            true,
        showMiniMap:
            initialOverlayPrefs.miniMap ?? hydrated.showMiniMap ?? true,
        playlist: topoResult.flatQueue,
        orderedNodeIds: topoResult.orderedNodeIds,
        excludedNodeIds: topoResult.excludedNodeIds,
        totalTimelineDuration: topoResult.totalTimelineDuration,
        hasCycle: topoResult.hasCycle,
    };
};

const initialRestoredWorkflow = buildInitialSynchronouslyRestoredWorkflow();
if (initialRestoredWorkflow && initialRestoredWorkflow.playlist.length > 0) {
    bridgeApi.syncPlaylistToFoobar(
        initialRestoredWorkflow.playlist.map((item) => ({
            trackId: item.trackId,
            path: item.path,
        }))
    );
}

/**
 * [修復問題 2 & 問題 3：當畫布播放佇列 (flatQueue) 變動時，自動同步 foobar2000 的「DJ Workflow Set」與總時間軸 seekhead 位置]
 * 造成錯誤的原因：
 * 1. (問題 2) 先前清空畫布 (`clearCanvas`) 或刪除最後一個節點 (`deleteNodeById` / `onNodesChange`) 使佇列變空時，未重置 `usePlayerStore` 的 `masterTimeSeconds`，
 *    導致重新加入節點後 `seekhead` 仍停留在舊秒數位置，而非退回 0 秒。
 * 2. (問題 3) 先前畫布節點或連線變動時從未自動呼叫 `bridgeApi.syncPlaylistToFoobar`，導致 foobar2000 的「DJ Workflow Set」保留舊殘留曲目，
 *    使視窗最小化背景播放結束時 C++ 引擎跳往下一列的殘留曲目。
 * 修改的目的：
 * 1. 每當 `flatQueue` 變更時立即同步至宿主 `DJ Workflow Set`。
 * 2. 當佇列被清空 (`nextQueue.length === 0`) 時立即呼叫 `resetTimelinePosition()` 將 `seekhead` 歸零。
 * 3. 當從空畫布重新加入節點 (`prevQueue.length === 0 && nextQueue.length > 0`) 時，將 `seekhead` 定位於 `0s` 並預載新的第一首曲目。
 */
const syncTimelineAndFoobarAfterQueueChange = (
    prevQueue: FlatPlayQueueItem[],
    nextQueue: FlatPlayQueueItem[],
    libraryTracks: Track[],
    isInitialHydration = false
): void => {
    bridgeApi.syncPlaylistToFoobar(
        nextQueue.map((item) => ({
            trackId: item.trackId,
            path: item.path,
        }))
    );

    if (isInitialHydration) return;

    if (nextQueue.length === 0) {
        if (
            prevQueue.length > 0 ||
            usePlayerStore.getState().masterTimeSeconds > 0
        ) {
            usePlayerStore.getState().resetTimelinePosition();
        }
        return;
    }

    if (prevQueue.length === 0 && nextQueue.length > 0) {
        const allLib =
            libraryTracks.length > 0
                ? libraryTracks
                : usePlaylistStore.getState().allTracks;
        usePlayerStore
            .getState()
            .seekMasterTimeline(0, nextQueue, allLib, {
                commitPersistence: true,
                sendHostSeek: false,
            });
    }
};

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
    libraryTracks: [],
    albumGroups: [],
    isLoadingLibrary: false,
    hasInitializedWorkflow: initialRestoredWorkflow !== null,

    fetchLibrary: async () => {
        // 1. 確保 IndexedDB 封面快取已載入記憶體，並一次性為畫布上已還原的節點補齊快取封面
        await ensureArtworkCacheLoaded();

        const currentNodes = get().nodes;
        if (currentNodes.length > 0) {
            const allPlaylistTracks = usePlaylistStore.getState().allTracks;
            // [修復畫布既有卡片曲目因 localStorage 快取舊四捨五入整數導致提早 1s 切歌]
            // 錯誤原因：從 Auto-Save 還原的節點與媒體庫快取可能皆保存了先前已進位的整數（如 261），單靠比對 allPlaylistTracks 無法發現進位誤差。
            // 修改目的：主動向宿主查詢畫布曲目的 `%length_seconds_fp%` 並無條件捨去 (`Math.floor`)，將進位的 duration 與預設 mixOut 精準下修對齊。
            const canvasPaths = currentNodes.flatMap((n) =>
                n.data.albumGroup.tracks
                    .flatMap((t) =>
                        t.id && t.id.includes('|subsong:')
                            ? [t.id, t.path]
                            : [t.path]
                    )
                    .filter(Boolean)
            );
            const exactFloorMap =
                await queryTracksExactFloorDurations(canvasPaths);

            const coverAndDurPatches: TrackComputedMetaBatchItem[] = [];
            for (const node of currentNodes) {
                for (const tr of node.data.albumGroup.tracks) {
                    const cachedCover = !tr.coverUrl
                        ? getCachedCoverSync(tr.path, tr.artist, tr.album)
                        : undefined;
                    const normPath = normalizeAudioPathForMatch(tr.path);
                    const exactHostDur =
                        exactFloorMap.get(tr.id) ??
                        exactFloorMap.get(tr.path) ??
                        (normPath ? exactFloorMap.get(normPath) : undefined);

                    const matchedLib = allPlaylistTracks.find(
                        (lt) =>
                            lt.id === tr.id ||
                            (Boolean(tr.path) && lt.path === tr.path)
                    );
                    const floorLibDur =
                        exactHostDur ??
                        (matchedLib && matchedLib.duration > 0
                            ? floorDurationToTenth(matchedLib.duration)
                            : undefined);
                    // 造成原錯誤的原因：先前以整數秒比對與下修，忽略了 0.1s 精度差。
                    // 本次修改的目的：將畫布既有卡片曲目的 duration 與預設 mixOut 對齊至 0.1s 精度時長。
                    const currentMixOut = tr.cuePoints?.mixOut ?? tr.duration;
                    const needsDurFix =
                        floorLibDur !== undefined &&
                        ((Math.abs(floorLibDur - tr.duration) >= 0.05 &&
                            Math.abs(floorLibDur - tr.duration) <= 2) ||
                            currentMixOut > floorLibDur);

                    if (cachedCover || needsDurFix) {
                        coverAndDurPatches.push({
                            trackId: tr.id,
                            path: tr.path,
                            patch: {
                                ...(cachedCover
                                    ? { coverUrl: cachedCover }
                                    : {}),
                                ...(needsDurFix
                                    ? { duration: floorLibDur }
                                    : {}),
                            },
                        });
                    }
                }
            }
            if (coverAndDurPatches.length > 0) {
                get().batchUpdateTrackComputedMetaInWorkflow(coverAndDurPatches);
            }
        }

        // [防最小化重置保護] 若工作流畫布已由同步快取或先前初始化完成，直接對齊分析快取即可，不重抓媒體庫！
        if (get().hasInitializedWorkflow) {
            const canvasTracks = get().nodes.flatMap(
                (n) => n.data.albumGroup.tracks
            );
            if (canvasTracks.length > 0) {
                enqueueTracksForRealBpmKeyAnalysis(
                    canvasTracks,
                    (trackId, path, result) => {
                        get().updateTrackComputedMetaInWorkflow(trackId, path, {
                            bpm: result.bpm,
                            key: result.key,
                            duration: result.duration,
                        });
                    },
                    (batch) => {
                        get().batchUpdateTrackComputedMetaInWorkflow(
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
            }
            return;
        }

        set({ isLoadingLibrary: true });
        try {
            const existingLibTracks = usePlaylistStore.getState().allTracks;
            const tracks =
                existingLibTracks.length > 0
                    ? existingLibTracks
                    : await bridgeApi.getLibraryTracks();
            if (get().hasInitializedWorkflow) {
                set({ isLoadingLibrary: false });
                return;
            }
            const groups = groupLibraryTracksByAlbum(tracks);

            let nextNodes = get().nodes;
            let nextEdges = get().edges;
            let nextOrientation = get().canvasOrientation;
            let nextShowCamelotWheel = get().showCamelotWheel;
            let nextShowMiniMap = get().showMiniMap;

            if (nextNodes.length === 0) {
                const autoSaved = loadAutoSaveProject();
                if (autoSaved !== null) {
                    const hydrated = hydrateProjectToNodesAndEdges(
                        autoSaved,
                        tracks
                    );
                    nextNodes = hydrated.nodes;
                    nextEdges = hydrated.edges;
                    if (hydrated.canvasOrientation) {
                        nextOrientation = hydrated.canvasOrientation;
                    }
                    const savedOverlay = loadSavedOverlayPrefs();
                    nextShowCamelotWheel =
                        savedOverlay.camelotWheel ??
                        hydrated.showCamelotWheel ??
                        nextShowCamelotWheel;
                    nextShowMiniMap =
                        savedOverlay.miniMap ??
                        hydrated.showMiniMap ??
                        nextShowMiniMap;
                } else if (groups.length > 0) {
                    // 僅在從未有過任何 Auto-Save 紀錄（全新首次啟動）時建立初始節點並寫入存檔
                    nextNodes = groups.slice(0, 3).map((g, idx) =>
                        createAlbumNode(g, {
                            x: 60 + idx * 360,
                            y: 70 + (idx % 2) * 120,
                        })
                    );
                    persistAutoSave(nextNodes, nextEdges, nextOrientation, {
                        showCamelotWheel: nextShowCamelotWheel,
                        showMiniMap: nextShowMiniMap,
                    });
                }
            }

            const topoResult = buildFlatPlayQueue(nextNodes, nextEdges);

            set({
                libraryTracks: tracks,
                albumGroups: groups,
                nodes: nextNodes,
                edges: nextEdges,
                canvasOrientation: nextOrientation,
                showCamelotWheel: nextShowCamelotWheel,
                showMiniMap: nextShowMiniMap,
                playlist: topoResult.flatQueue,
                orderedNodeIds: topoResult.orderedNodeIds,
                excludedNodeIds: topoResult.excludedNodeIds,
                totalTimelineDuration: topoResult.totalTimelineDuration,
                hasCycle: topoResult.hasCycle,
                hasInitializedWorkflow: true,
                isLoadingLibrary: false,
            });

            syncTimelineAndFoobarAfterQueueChange(
                [],
                topoResult.flatQueue,
                tracks,
                true
            );

            const canvasTracks = nextNodes.flatMap(
                (n) => n.data.albumGroup.tracks
            );
            if (canvasTracks.length > 0) {
                enqueueTracksForRealBpmKeyAnalysis(
                    canvasTracks,
                    (trackId, path, result) => {
                        get().updateTrackComputedMetaInWorkflow(trackId, path, {
                            bpm: result.bpm,
                            key: result.key,
                            duration: result.duration,
                        });
                    },
                    (batch) => {
                        get().batchUpdateTrackComputedMetaInWorkflow(
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
            }
        } catch (error) {
            console.error('載入媒體庫失敗:', error);
            set({ isLoadingLibrary: false });
        }
    },

    nodes: initialRestoredWorkflow?.nodes ?? [],
    edges: initialRestoredWorkflow?.edges ?? [],
    activeEdgeId: null,
    setActiveEdgeId: (edgeId) => set({ activeEdgeId: edgeId }),

    onNodesChange: (changes) => {
        const nextNodes = applyNodeChanges(
            changes,
            get().nodes
        ) as Node<AlbumNodeData>[];

        // [修復問題 1：解決節點卡片拖曳時略有卡頓感、不跟手的問題]
        // 造成錯誤的原因：
        // 1. 先前在 `onNodesChange` 中，每一個滑鼠移動畫面幀（`type === 'position' && dragging === true`，每秒 60~120 次）都會無條件執行
        //    `buildFlatPlayQueue`（產生全新陣列參考並觸發 MasterTimeline、CamelotWheel、MediaLibrary 等組件每秒重繪 60~120 次）
        //    以及 `persistAutoSave`（同步執行 JSON.stringify 與 localStorage.setItem 磁碟 I/O 阻塞主執行緒）。
        // 2. 由於播放佇列順序完全只按照「專輯卡片內曲目的順序」與「連線的順序」決定，節點座標 (`position`)、尺寸 (`dimensions`) 與選取 (`select`) 變動完全不會影響播放佇列。
        // 修改的目的：
        // 當 `changes` 僅為座標移動、尺寸測量或選取狀態切換時，只更新 `nodes` 狀態，完全不重算 `buildFlatPlayQueue`；
        // 且僅在拖曳結束放開滑鼠 (`dragging === false`) 時才以防抖方式儲存座標至 Auto-Save，讓拖曳過程達到 60fps 零延遲跟手體驗。
        const hasStructuralChange = changes.some(
            (c) =>
                c.type === 'remove' ||
                c.type === 'add' ||
                c.type === 'replace'
        );

        if (!hasStructuralChange) {
            set({ nodes: nextNodes });
            const hasDragFinished = changes.some(
                (c) => c.type === 'position' && c.dragging === false
            );
            if (hasDragFinished) {
                persistAutoSaveDebounced(nextNodes, get().edges);
            }
            return;
        }

        const prevQueue = get().playlist;
        const validIds = new Set(nextNodes.map((n) => n.id));
        const nextEdges = get().edges.filter(
            (e) => validIds.has(e.source) && validIds.has(e.target)
        );
        const topoResult = buildFlatPlayQueue(nextNodes, nextEdges);

        set({
            nodes: nextNodes,
            edges: nextEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, nextEdges);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            get().libraryTracks
        );
    },

    onEdgesChange: (changes) => {
        const prevQueue = get().playlist;
        const nextEdges = applyEdgeChanges(
            changes,
            get().edges
        ) as Edge<TransitionEdgeData>[];
        const nodes = get().nodes;
        const topoResult = buildFlatPlayQueue(nodes, nextEdges);

        set({
            edges: nextEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nodes, nextEdges);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            get().libraryTracks
        );
    },

    onConnect: (connection: Connection) => {
        const { nodes, edges } = get();

        const validation = validateConnectionRule(connection, edges);
        if (!validation.valid) {
            console.warn(`[連線拒絕] ${validation.reason}`);
            return;
        }

        // 自動移除與新連線共用 source 或 target 的舊連線（實現拉新線直接覆蓋舊線）
        const filteredEdges = edges.filter(
            (e) => e.source !== connection.source && e.target !== connection.target
        );

        const sourceNode = nodes.find((n) => n.id === connection.source);
        const targetNode = nodes.find((n) => n.id === connection.target);

        let analysis: TransitionAnalysis | undefined;
        if (sourceNode && targetNode) {
            analysis = analyzeAlbumGroupTransition(
                sourceNode.data.albumGroup,
                targetNode.data.albumGroup
            );
        }

        const defaultTransition: TransitionConfig = {
            type: 'CUT',
            duration: 0,
        };

        const presentation = buildEdgePresentation(defaultTransition, analysis);

        const newEdge: Edge<TransitionEdgeData> = {
            ...connection,
            source: connection.source!,
            target: connection.target!,
            id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
            type: 'transitionEdge',
            reconnectable: true,
            interactionWidth: 28,
            animated: presentation.animated,
            label: presentation.label,
            style: presentation.style,
            labelStyle: { fill: '#f8fafc', fontWeight: 600, fontSize: 11 },
            labelBgStyle: { fill: '#0f172a', fillOpacity: 0.88 },
            data: {
                transition: defaultTransition,
                analysis,
            },
        };

        const nextEdges = [...filteredEdges, newEdge];
        // 造成原錯誤的原因：先前同專輯節點連線時無條件執行 autoReconcileAdjacentAlbumNodes 強制合併，使用者無法保留獨立同專輯卡片。
        // 本次修改的目的：僅當 autoMergeSameAlbum 開關為開啟狀態時，才於新建連線時自動合併相鄰同專輯節點。
        const reconcileResult = get().autoMergeSameAlbum
            ? autoReconcileAdjacentAlbumNodes(nodes, nextEdges)
            : { nodes, edges: nextEdges, didMerge: false };
        const syncedEdges = refreshEdgesAnalysis(
            reconcileResult.nodes,
            reconcileResult.edges
        );
        const topoResult = buildFlatPlayQueue(reconcileResult.nodes, syncedEdges);

        set({
            nodes: reconcileResult.nodes,
            edges: syncedEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(reconcileResult.nodes, syncedEdges);
        bridgeApi.syncPlaylistToFoobar(
            topoResult.flatQueue.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );
    },

    onReconnect: (oldEdge, newConnection) => {
        const { nodes, edges } = get();
        const remainingEdges = edges.filter((e) => e.id !== oldEdge.id);

        const validation = validateConnectionRule(newConnection, remainingEdges);
        if (!validation.valid) {
            console.warn(`[重新連線拒絕] ${validation.reason}`);
            return false;
        }

        // 移除目標端點上可能存在的其他舊連線以完成覆蓋
        const cleanEdges = remainingEdges.filter(
            (e) =>
                e.source !== newConnection.source && e.target !== newConnection.target
        );

        const sourceNode = nodes.find((n) => n.id === newConnection.source);
        const targetNode = nodes.find((n) => n.id === newConnection.target);

        let analysis: TransitionAnalysis | undefined;
        if (sourceNode && targetNode) {
            analysis = analyzeAlbumGroupTransition(
                sourceNode.data.albumGroup,
                targetNode.data.albumGroup
            );
        }

        const preservedTransition: TransitionConfig = oldEdge.data?.transition ?? {
            type: 'CUT',
            duration: 0,
        };

        const presentation = buildEdgePresentation(preservedTransition, analysis);

        const reconnectedEdge: Edge<TransitionEdgeData> = {
            ...oldEdge,
            source: newConnection.source!,
            target: newConnection.target!,
            sourceHandle: newConnection.sourceHandle,
            targetHandle: newConnection.targetHandle,
            id: `edge-${newConnection.source}-${newConnection.target}-${Date.now()}`,
            type: 'transitionEdge',
            reconnectable: true,
            interactionWidth: 28,
            animated: presentation.animated,
            label: presentation.label,
            style: presentation.style,
            data: {
                transition: preservedTransition,
                analysis,
            },
        };

        const nextEdges = [...cleanEdges, reconnectedEdge];
        // 僅當 autoMergeSameAlbum 開關為開啟狀態時，才於重新連線時自動合併相鄰同專輯節點
        const reconcileResult = get().autoMergeSameAlbum
            ? autoReconcileAdjacentAlbumNodes(nodes, nextEdges)
            : { nodes, edges: nextEdges, didMerge: false };
        const syncedEdges = refreshEdgesAnalysis(
            reconcileResult.nodes,
            reconcileResult.edges
        );
        const topoResult = buildFlatPlayQueue(reconcileResult.nodes, syncedEdges);

        set({
            nodes: reconcileResult.nodes,
            edges: syncedEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(reconcileResult.nodes, syncedEdges);
        bridgeApi.syncPlaylistToFoobar(
            topoResult.flatQueue.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );

        return true;
    },

    deleteEdgeById: (edgeId) => {
        const { nodes, edges, activeEdgeId } = get();
        const nextEdges = edges.filter((e) => e.id !== edgeId);
        const topoResult = buildFlatPlayQueue(nodes, nextEdges);

        set({
            edges: nextEdges,
            activeEdgeId: activeEdgeId === edgeId ? null : activeEdgeId,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nodes, nextEdges);
        bridgeApi.syncPlaylistToFoobar(
            topoResult.flatQueue.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );
    },

    deleteNodeById: (nodeId) => {
        const { nodes, edges, playlist: prevQueue, libraryTracks } = get();
        const nextNodes = nodes.filter((n) => n.id !== nodeId);
        const nextEdges = edges.filter(
            (e) => e.source !== nodeId && e.target !== nodeId
        );
        const topoResult = buildFlatPlayQueue(nextNodes, nextEdges);

        set({
            nodes: nextNodes,
            edges: nextEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, nextEdges);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            libraryTracks
        );
    },

    addAlbumGroupToCanvas: (group, position) => {
        const { nodes, edges, playlist: prevQueue, libraryTracks } = get();
        const targetPos = position ?? {
            x: 60 + (nodes.length % 3) * 350,
            y: 60 + Math.floor(nodes.length / 3) * 160,
        };

        // [問題 4 & 5] 曲目加入畫布時統一預設從頭播放至尾 (mixIn: 0, mixOut: duration) 且內部過渡預設為 CUT
        const normalizedTracks = group.tracks.map((t) => ({
            ...t,
            cuePoints: {
                ...t.cuePoints,
                mixIn: 0,
                mixOut: t.duration,
            },
            internalTransition: t.internalTransition ?? {
                type: 'CUT' as const,
                duration: 0,
            },
        }));
        const normalizedGroup = createAlbumGroupFromTracks(normalizedTracks);

        const newNode = createAlbumNode(
            normalizedGroup,
            targetPos,
            String(Date.now())
        );
        const nextNodes = [...nodes, newNode];
        const topoResult = buildFlatPlayQueue(nextNodes, edges);

        set({
            nodes: nextNodes,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, edges);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            libraryTracks
        );
    },

    addTracksToCanvas: (tracks, dropPosition) => {
        if (tracks.length === 0) return;

        const { nodes, edges, playlist: prevQueue, libraryTracks } = get();
        const basePosition = dropPosition ?? {
            x: 80 + (nodes.length % 3) * 350,
            y: 80 + Math.floor(nodes.length / 3) * 160,
        };

        // [問題 4 & 5] 曲目加入畫布時統一預設從頭播放至尾 (mixIn: 0, mixOut: duration) 且內部過渡預設為 CUT
        const normalizedTracks = tracks.map((t) => ({
            ...t,
            cuePoints: {
                ...t.cuePoints,
                mixIn: 0,
                mixOut: t.duration,
            },
            internalTransition: t.internalTransition ?? {
                type: 'CUT' as const,
                duration: 0,
            },
        }));

        const targetGroups =
            normalizedTracks.length === 1
                ? [createAlbumGroupFromTracks(normalizedTracks)]
                : groupLibraryTracksByAlbum(normalizedTracks);

        const timestamp = Date.now();
        const createdNodes = targetGroups.map((group, idx) =>
            createAlbumNode(
                group,
                {
                    x: basePosition.x + idx * 340,
                    y: basePosition.y + idx * 40,
                },
                `${timestamp}-${idx}`
            )
        );

        const nextNodes = [...nodes, ...createdNodes];
        const topoResult = buildFlatPlayQueue(nextNodes, edges);

        set({
            nodes: nextNodes,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, edges);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            libraryTracks
        );
    },

    extractTrackFromNode: (nodeId, trackId) => {
        const { nodes, edges } = get();
        const targetNode = nodes.find((n) => n.id === nodeId);
        if (!targetNode) return;

        const splitResult = extractSingleTrackToNewGroup(
            targetNode.data.albumGroup,
            trackId
        );

        const nextNodes: Node<AlbumNodeData>[] = [];

        for (const node of nodes) {
            if (node.id !== nodeId) {
                nextNodes.push(node);
                continue;
            }

            if (splitResult.remainingGroup) {
                nextNodes.push({
                    ...node,
                    data: {
                        ...node.data,
                        label: `${splitResult.remainingGroup.album} - ${splitResult.remainingGroup.artist}`,
                        albumGroup: splitResult.remainingGroup,
                        expandedTrackIds: node.data.expandedTrackIds.filter(
                            (id) => id !== trackId
                        ),
                    },
                });
            }
        }

        if (splitResult.extractedGroup) {
            const newExtractedNode = createAlbumNode(
                splitResult.extractedGroup,
                {
                    x: targetNode.position.x + 360,
                    y: targetNode.position.y + 40,
                },
                String(Date.now())
            );
            nextNodes.push(newExtractedNode);
        }

        const validNodeIds = new Set(nextNodes.map((n) => n.id));
        const nextEdges = refreshEdgesAnalysis(
            nextNodes,
            edges.filter(
                (e) => validNodeIds.has(e.source) && validNodeIds.has(e.target)
            )
        );

        const prevQueue = get().playlist;
        const topoResult = buildFlatPlayQueue(nextNodes, nextEdges);

        set({
            nodes: nextNodes,
            edges: nextEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, nextEdges);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            get().libraryTracks
        );
    },

    toggleTrackExpandInNode: (nodeId, trackId) => {
        const nextNodes = get().nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const exists = node.data.expandedTrackIds.includes(trackId);
            const nextExpanded = exists
                ? node.data.expandedTrackIds.filter((id) => id !== trackId)
                : [...node.data.expandedTrackIds, trackId];

            return {
                ...node,
                data: {
                    ...node.data,
                    expandedTrackIds: nextExpanded,
                },
            };
        });

        set({ nodes: nextNodes });
        persistAutoSave(nextNodes, get().edges, get().canvasOrientation);
    },

    // 1.4 曲目列表拖動調整播放次序
    reorderTracksInNode: (nodeId, fromIndex, toIndex) => {
        if (fromIndex === toIndex) return;
        const { nodes, edges } = get();

        const nextNodes = nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const tracks = [...node.data.albumGroup.tracks];
            if (
                fromIndex < 0 ||
                fromIndex >= tracks.length ||
                toIndex < 0 ||
                toIndex >= tracks.length
            ) {
                return node;
            }

            const [moved] = tracks.splice(fromIndex, 1);
            tracks.splice(toIndex, 0, moved);
            const updatedGroup = createAlbumGroupFromTracks(tracks);

            return {
                ...node,
                data: {
                    ...node.data,
                    albumGroup: updatedGroup,
                },
            };
        });

        const syncedEdges = refreshEdgesAnalysis(nextNodes, edges);
        const topoResult = buildFlatPlayQueue(nextNodes, syncedEdges);

        set({
            nodes: nextNodes,
            edges: syncedEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, syncedEdges);
        bridgeApi.syncPlaylistToFoobar(
            topoResult.flatQueue.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );
    },

    // 5. 相同專輯卡片拖動重疊放開後自動合併（曲目加入原播放次序尾端並繼承設定）
    mergeNodesOnOverlap: (draggedNodeId, targetNodeId) => {
        if (draggedNodeId === targetNodeId) return;
        const { nodes, edges } = get();
        const draggedNode = nodes.find((n) => n.id === draggedNodeId);
        const targetNode = nodes.find((n) => n.id === targetNodeId);

        if (!draggedNode || !targetNode) return;
        if (
            draggedNode.data.albumGroup.albumId !==
            targetNode.data.albumGroup.albumId
        ) {
            return;
        }

        const mergedGroup = mergeTwoAlbumGroups(
            targetNode.data.albumGroup,
            draggedNode.data.albumGroup
        );
        const mergedExpandedIds = Array.from(
            new Set([
                ...targetNode.data.expandedTrackIds,
                ...draggedNode.data.expandedTrackIds,
            ])
        );

        const nextNodes = nodes
            .filter((n) => n.id !== draggedNodeId)
            .map((n) => {
                if (n.id !== targetNodeId) return n;
                return {
                    ...n,
                    data: {
                        ...n.data,
                        label: `${mergedGroup.album} - ${mergedGroup.artist}`,
                        albumGroup: mergedGroup,
                        expandedTrackIds: mergedExpandedIds,
                    },
                };
            });

        // 將連向或連出 draggedNode 的連線重新導向至 targetNode（並過濾重複與自連）
        const remappedEdges = edges
            .map((e) => {
                if (e.source === draggedNodeId) {
                    return { ...e, source: targetNodeId };
                }
                if (e.target === draggedNodeId) {
                    return { ...e, target: targetNodeId };
                }
                return e;
            })
            .filter((e) => e.source !== e.target);

        // 確保單一端口不重複
        const seenSources = new Set<string>();
        const seenTargets = new Set<string>();
        const dedupedEdges: Edge<TransitionEdgeData>[] = [];
        for (const e of remappedEdges) {
            if (!seenSources.has(e.source) && !seenTargets.has(e.target)) {
                seenSources.add(e.source);
                seenTargets.add(e.target);
                dedupedEdges.push(e);
            }
        }

        const syncedEdges = refreshEdgesAnalysis(nextNodes, dedupedEdges);
        const topoResult = buildFlatPlayQueue(nextNodes, syncedEdges);

        set({
            nodes: nextNodes,
            edges: syncedEdges,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(nextNodes, syncedEdges);
        bridgeApi.syncPlaylistToFoobar(
            topoResult.flatQueue.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );
    },

    // 造成原錯誤的原因：先前 updateTrackCuePointsInWorkflow 僅接收 (trackId, cuePoints)，會遍歷畫布所有節點一併覆寫相同 trackId 的 cuePoints，導致無法在不同卡片針對同一首曲目設定不同的 Mix-In/Out 與 Loop。
    // 本次修改的目的：新增 nodeId 參數，僅更新指定卡片節點 (nodeId) 內該首曲目的 cuePoints，實現同曲目跨卡片獨立段落與循環編排。
    updateTrackCuePointsInWorkflow: (nodeId, trackId, cuePoints) => {
        const { nodes, edges } = get();

        const nextNodes = nodes.map((node) => {
            if (node.id !== nodeId) return node;

            const hasTrack = node.data.albumGroup.tracks.some(
                (t) => t.id === trackId
            );
            if (!hasTrack) return node;

            const updatedTracks = node.data.albumGroup.tracks.map((t) =>
                t.id === trackId ? { ...t, cuePoints: { ...cuePoints } } : t
            );
            const updatedGroup = createAlbumGroupFromTracks(updatedTracks);

            return {
                ...node,
                data: {
                    ...node.data,
                    albumGroup: updatedGroup,
                },
            };
        });

        const topoResult = buildFlatPlayQueue(nextNodes, edges);

        set({
            nodes: nextNodes,
            playlist: topoResult.flatQueue,
            totalTimelineDuration: topoResult.totalTimelineDuration,
        });

        persistAutoSave(nextNodes, edges);
    },

    updateTrackComputedMetaInWorkflow: (trackId, path, patch) => {
        get().batchUpdateTrackComputedMetaInWorkflow([
            { trackId, path, patch },
        ]);
    },

    batchUpdateTrackComputedMetaInWorkflow: (items) => {
        if (!Array.isArray(items) || items.length === 0) return;
        const { nodes, edges, libraryTracks } = get();

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

        let libChanged = false;
        const nextLibraryTracks = libraryTracks.map((t) => {
            const patch = findMergedPatch(t);
            if (!patch) return t;
            libChanged = true;
            const nextDur = patch.duration ?? t.duration;
            const shouldExtendMixOut =
                patch.duration !== undefined &&
                Math.abs((t.cuePoints.mixOut ?? t.duration) - t.duration) <= 1;
            return {
                ...t,
                ...(patch.bpm !== undefined ? { bpm: patch.bpm } : {}),
                ...(patch.key !== undefined ? { key: patch.key } : {}),
                ...(patch.duration !== undefined
                    ? { duration: patch.duration }
                    : {}),
                ...(patch.coverUrl !== undefined
                    ? { coverUrl: patch.coverUrl }
                    : {}),
                cuePoints: shouldExtendMixOut
                    ? { ...t.cuePoints, mixOut: nextDur }
                    : t.cuePoints,
            };
        });

        let nodesChanged = false;
        const nextNodes = nodes.map((node) => {
            const hasMatch = node.data.albumGroup.tracks.some((t) =>
                Boolean(findMergedPatch(t))
            );
            if (!hasMatch) return node;
            nodesChanged = true;

            const updatedTracks = node.data.albumGroup.tracks.map((t) => {
                const patch = findMergedPatch(t);
                if (!patch) return t;
                const nextDur =
                    patch.duration !== undefined
                        ? Math.max(1, Math.floor(patch.duration))
                        : t.duration;
                const shouldSyncDefaultMixOut =
                    patch.duration !== undefined &&
                    (Math.abs((t.cuePoints.mixOut ?? t.duration) - t.duration) <=
                        1.5 ||
                        (t.cuePoints.mixOut ?? t.duration) > nextDur);
                return {
                    ...t,
                    ...(patch.bpm !== undefined ? { bpm: patch.bpm } : {}),
                    ...(patch.key !== undefined ? { key: patch.key } : {}),
                    ...(patch.duration !== undefined
                        ? { duration: nextDur }
                        : {}),
                    ...(patch.coverUrl !== undefined
                        ? { coverUrl: patch.coverUrl }
                        : {}),
                    cuePoints: shouldSyncDefaultMixOut
                        ? { ...t.cuePoints, mixOut: nextDur }
                        : t.cuePoints,
                };
            });
            const updatedGroup = createAlbumGroupFromTracks(updatedTracks);
            return {
                ...node,
                data: {
                    ...node.data,
                    albumGroup: updatedGroup,
                },
            };
        });

        if (!libChanged && !nodesChanged) return;

        const syncedEdges = nodesChanged
            ? refreshEdgesAnalysis(nextNodes, edges)
            : edges;
        const topoResult = buildFlatPlayQueue(nextNodes, syncedEdges);

        set({
            ...(libChanged
                ? {
                      libraryTracks: nextLibraryTracks,
                      albumGroups: groupLibraryTracksByAlbum(nextLibraryTracks),
                  }
                : {}),
            ...(nodesChanged
                ? {
                      nodes: nextNodes,
                      edges: syncedEdges,
                      playlist: topoResult.flatQueue,
                      totalTimelineDuration: topoResult.totalTimelineDuration,
                  }
                : {}),
        });

        if (nodesChanged) {
            persistAutoSave(nextNodes, syncedEdges);
        }
    },

    // 1.2 更新卡片內曲目往下一首的過渡模式設定
    updateTrackInternalTransitionInWorkflow: (nodeId, trackId, transition) => {
        const { nodes, edges } = get();

        const nextNodes = nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const updatedTracks = node.data.albumGroup.tracks.map((t) =>
                t.id === trackId ? { ...t, internalTransition: { ...transition } } : t
            );
            const updatedGroup = createAlbumGroupFromTracks(updatedTracks);

            return {
                ...node,
                data: {
                    ...node.data,
                    albumGroup: updatedGroup,
                },
            };
        });

        const topoResult = buildFlatPlayQueue(nextNodes, edges);

        set({
            nodes: nextNodes,
            playlist: topoResult.flatQueue,
            totalTimelineDuration: topoResult.totalTimelineDuration,
        });

        persistAutoSave(nextNodes, edges);
    },

    updateEdgeTransition: (edgeId, transition) => {
        const { nodes, edges } = get();
        const nextEdges = edges.map((e) => {
            if (e.id === edgeId) {
                const analysis = e.data?.analysis;
                const presentation = buildEdgePresentation(transition, analysis);
                return {
                    ...e,
                    type: 'transitionEdge',
                    animated: presentation.animated,
                    label: presentation.label,
                    style: presentation.style,
                    data: {
                        ...e.data,
                        transition,
                        analysis,
                    },
                };
            }
            return e;
        });

        const topoResult = buildFlatPlayQueue(nodes, nextEdges);

        set({
            edges: nextEdges,
            playlist: topoResult.flatQueue,
            totalTimelineDuration: topoResult.totalTimelineDuration,
        });

        persistAutoSave(nodes, nextEdges);
    },

    exportProjectData: () => {
        const {
            nodes,
            edges,
            canvasOrientation,
            showCamelotWheel,
            showMiniMap,
        } = get();
        return serializeWorkflowProject(nodes, edges, canvasOrientation, {
            showCamelotWheel,
            showMiniMap,
        });
    },

    importProjectData: (project) => {
        const { libraryTracks, playlist: prevQueue } = get();
        const hydrated = hydrateProjectToNodesAndEdges(project, libraryTracks);
        const topoResult = buildFlatPlayQueue(hydrated.nodes, hydrated.edges);

        const nextShowCamelotWheel =
            typeof hydrated.showCamelotWheel === 'boolean'
                ? hydrated.showCamelotWheel
                : get().showCamelotWheel;
        const nextShowMiniMap =
            typeof hydrated.showMiniMap === 'boolean'
                ? hydrated.showMiniMap
                : get().showMiniMap;
        const nextOrientation =
            hydrated.canvasOrientation ?? get().canvasOrientation;

        saveOverlayPrefsToStorage({
            miniMap: nextShowMiniMap,
            camelotWheel: nextShowCamelotWheel,
        });

        set({
            nodes: hydrated.nodes,
            edges: hydrated.edges,
            canvasOrientation: nextOrientation,
            showCamelotWheel: nextShowCamelotWheel,
            showMiniMap: nextShowMiniMap,
            activeEdgeId: null,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(hydrated.nodes, hydrated.edges, nextOrientation, {
            showCamelotWheel: nextShowCamelotWheel,
            showMiniMap: nextShowMiniMap,
        });

        // [修復功能 4 關聯影響] 由於輕量化 .json 專案檔不記錄當前播放位置與 Base64 封面快取：
        // 1. 匯入專案後立即將新的 flatQueue 同步至 foobar2000，並將時間軸歸零定位至新佇列起點 (0s)
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            libraryTracks
        );
        if (topoResult.flatQueue.length > 0) {
            usePlayerStore
                .getState()
                .seekMasterTimeline(0, topoResult.flatQueue, libraryTracks, {
                    commitPersistence: true,
                    sendHostSeek: false,
                });
        }

        // 2. 若匯入的節點曲目尚未命中本地快取封面，自動根據音訊路徑向宿主非同步讀取真實封面並回填至畫布卡片
        for (const node of hydrated.nodes) {
            for (const track of node.data.albumGroup.tracks) {
                if (
                    !track.coverUrl &&
                    track.path &&
                    !track.path.startsWith('C:\\Music\\DJ_Set\\')
                ) {
                    void fetchSingleTrackRealCover(
                        track.path,
                        track.artist,
                        track.album
                    ).then((realCover) => {
                        if (!realCover) return;
                        get().updateTrackComputedMetaInWorkflow(
                            track.id,
                            track.path,
                            {
                                coverUrl: realCover,
                            }
                        );
                        usePlayerStore
                            .getState()
                            .updateCurrentTrackComputedMeta(
                                track.id,
                                track.path,
                                { coverUrl: realCover }
                            );
                    });
                }
            }
        }
    },

    canvasOrientation: 'horizontal',
    showMiniMap: initialOverlayPrefs.miniMap,
    showCamelotWheel: initialOverlayPrefs.camelotWheel,
    autoMergeSameAlbum: initialOverlayPrefs.autoMergeSameAlbum,

    toggleMiniMap: () => {
        const nextMiniMap = !get().showMiniMap;
        const currentCamelot = get().showCamelotWheel;
        saveOverlayPrefsToStorage({
            miniMap: nextMiniMap,
            camelotWheel: currentCamelot,
            autoMergeSameAlbum: get().autoMergeSameAlbum,
        });
        set({ showMiniMap: nextMiniMap });
        persistAutoSave(get().nodes, get().edges, get().canvasOrientation, {
            showCamelotWheel: currentCamelot,
            showMiniMap: nextMiniMap,
        });
    },

    toggleCamelotWheel: (forceVal) => {
        const nextCamelot =
            typeof forceVal === 'boolean' ? forceVal : !get().showCamelotWheel;
        const currentMiniMap = get().showMiniMap;
        saveOverlayPrefsToStorage({
            miniMap: currentMiniMap,
            camelotWheel: nextCamelot,
            autoMergeSameAlbum: get().autoMergeSameAlbum,
        });
        set({ showCamelotWheel: nextCamelot });
        persistAutoSave(get().nodes, get().edges, get().canvasOrientation, {
            showCamelotWheel: nextCamelot,
            showMiniMap: currentMiniMap,
        });
    },

    toggleAutoMergeSameAlbum: () => {
        // 僅切換連線時是否自動合併同專輯節點的狀態並持久化，從「關閉 -> 開啟」時不立即合併畫布上既有的同專輯連線節點
        const nextAutoMerge = !get().autoMergeSameAlbum;
        saveOverlayPrefsToStorage({
            miniMap: get().showMiniMap,
            camelotWheel: get().showCamelotWheel,
            autoMergeSameAlbum: nextAutoMerge,
        });
        set({ autoMergeSameAlbum: nextAutoMerge });
    },

    toggleCanvasOrientation: () => {
        const nextOrientation =
            get().canvasOrientation === 'horizontal' ? 'vertical' : 'horizontal';
        set({ canvasOrientation: nextOrientation });
        if (get().nodes.length > 0) {
            get().autoLayoutNodes();
        } else {
            persistAutoSave(
                get().nodes,
                get().edges,
                nextOrientation,
                {
                    showCamelotWheel: get().showCamelotWheel,
                    showMiniMap: get().showMiniMap,
                }
            );
        }
    },

    autoLayoutNodes: () => {
        const { nodes, edges, canvasOrientation } = get();
        if (nodes.length === 0) return;

        const topoResult = buildFlatPlayQueue(nodes, edges);
        const orderedSet = new Set(topoResult.orderedNodeIds);

        const orderedOrderMap = new Map<string, number>();
        topoResult.orderedNodeIds.forEach((id, idx) => {
            orderedOrderMap.set(id, idx);
        });

        const excludedNodes = nodes.filter((n) => !orderedSet.has(n.id));
        const excludedOrderMap = new Map<string, number>();
        excludedNodes.forEach((n, idx) => {
            excludedOrderMap.set(n.id, idx);
        });

        const layoutedNodes = nodes.map((node) => {
            // [直式佈局] 節點卡片由上往下垂直排列 (In-Port 在上、Out-Port 在下)
            if (canvasOrientation === 'vertical') {
                if (orderedOrderMap.has(node.id)) {
                    const idx = orderedOrderMap.get(node.id)!;
                    const trackCount = node.data.albumGroup.tracks.length;
                    const rowSpacing = 250 + Math.max(0, trackCount - 1) * 34;
                    return {
                        ...node,
                        position: {
                            x: 80 + (idx % 2) * 28,
                            y: 50 + idx * rowSpacing,
                        },
                    };
                }

                const exIdx = excludedOrderMap.get(node.id) ?? 0;
                const baseExcludedX =
                    topoResult.orderedNodeIds.length > 0 ? 520 : 80;
                const col = Math.floor(exIdx / 4);
                const row = exIdx % 4;
                return {
                    ...node,
                    position: {
                        x: baseExcludedX + col * 390,
                        y: 50 + row * 280,
                    },
                };
            }

            // [橫式佈局] 節點卡片由左往右水平排列 (In-Port 在左、Out-Port 在右)
            if (orderedOrderMap.has(node.id)) {
                const idx = orderedOrderMap.get(node.id)!;
                return {
                    ...node,
                    position: {
                        x: 60 + idx * 410,
                        y: 60 + (idx % 2) * 28,
                    },
                };
            }

            const exIdx = excludedOrderMap.get(node.id) ?? 0;
            const baseExcludedY =
                topoResult.orderedNodeIds.length > 0 ? 390 : 60;
            return {
                ...node,
                position: {
                    x: 60 + exIdx * 410,
                    y: baseExcludedY,
                },
            };
        });

        const updatedTopo = buildFlatPlayQueue(layoutedNodes, edges);

        set({
            nodes: layoutedNodes,
            playlist: updatedTopo.flatQueue,
            orderedNodeIds: updatedTopo.orderedNodeIds,
            excludedNodeIds: updatedTopo.excludedNodeIds,
            totalTimelineDuration: updatedTopo.totalTimelineDuration,
            hasCycle: updatedTopo.hasCycle,
        });

        persistAutoSave(layoutedNodes, edges);
        // 造成原錯誤的原因：autoLayoutNodes 重新計算 updatedTopo.flatQueue 後未同步更新宿主的 latestOrderedQueuePaths，若佈局調整改變了未連線節點之拓撲順序會導致宿主佇列順序不一致。
        // 本次修改的目的：排版後同步將最新 flatQueue 順序通知宿主。
        bridgeApi.syncPlaylistToFoobar(
            updatedTopo.flatQueue.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );
    },

    // [新增功能 3] 一鍵自動推薦排列：將畫布上所有曲目打散為單曲粒度，找出全局總分最高的起點與最佳駱駝色輪接歌順序，自動連線並排列整齊
    autoRecommendArrangeWorkflow: () => {
        const {
            nodes,
            canvasOrientation,
            autoMergeSameAlbum,
            playlist: prevQueue,
            libraryTracks,
        } = get();
        if (nodes.length === 0) return;

        // 提取畫布所有卡片內的曲目實例（保留各曲目獨立設定的 cuePoints 與展开狀態）
        const allCanvasTracks: Array<{
            track: Track;
            isExpanded: boolean;
        }> = [];

        for (const node of nodes) {
            const expandedSet = new Set(node.data.expandedTrackIds);
            for (const tr of node.data.albumGroup.tracks) {
                allCanvasTracks.push({
                    track: {
                        ...tr,
                        cuePoints: { ...tr.cuePoints },
                    },
                    isExpanded: expandedSet.has(tr.id),
                });
            }
        }

        if (allCanvasTracks.length === 0) return;

        // 計算全局最高總分起點與最佳諧波接歌序列
        const optimalTracks = buildOptimalHarmonicTrackSequence(
            allCanvasTracks.map((item) => item.track)
        );

        // 為排序後的每首單曲建立獨立卡片節點
        const timestamp = Date.now();
        const expandedPool = new Map<Track, boolean>();
        for (const item of allCanvasTracks) {
            expandedPool.set(item.track, item.isExpanded);
        }

        const singleTrackNodes: Node<AlbumNodeData>[] = optimalTracks.map(
            (track, idx) => {
                const group = createAlbumGroupFromTracks([track]);
                const node = createAlbumNode(
                    group,
                    { x: 60 + idx * 410, y: 60 },
                    `rec-${timestamp}-${idx}`
                );
                if (expandedPool.get(track)) {
                    node.data.expandedTrackIds = [track.id];
                }
                return node;
            }
        );

        // 依最佳順序自動建立相鄰有向連線
        const defaultTransition: TransitionConfig = {
            type: 'CUT',
            duration: 0,
        };
        const rawEdges: Edge<TransitionEdgeData>[] = [];
        for (let i = 0; i < singleTrackNodes.length - 1; i++) {
            const sourceNode = singleTrackNodes[i];
            const targetNode = singleTrackNodes[i + 1];
            rawEdges.push({
                id: `edge-${sourceNode.id}-${targetNode.id}-${timestamp}-${i}`,
                source: sourceNode.id,
                target: targetNode.id,
                type: 'transitionEdge',
                reconnectable: true,
                interactionWidth: 28,
                data: {
                    transition: { ...defaultTransition },
                },
            });
        }

        // 若「自動合併」開關為開啟，將排序後相鄰且同專輯的節點自動合併
        const reconcileResult = autoMergeSameAlbum
            ? autoReconcileAdjacentAlbumNodes(singleTrackNodes, rawEdges)
            : {
                  nodes: singleTrackNodes,
                  edges: rawEdges,
                  didMerge: false,
              };

        // 依照當前直式 / 橫式方向排列整齊
        const layoutedNodes = reconcileResult.nodes.map((node, idx) => {
            if (canvasOrientation === 'vertical') {
                const trackCount = node.data.albumGroup.tracks.length;
                const rowSpacing = 250 + Math.max(0, trackCount - 1) * 34;
                return {
                    ...node,
                    position: {
                        x: 80 + (idx % 2) * 28,
                        y: 50 + idx * rowSpacing,
                    },
                };
            }
            return {
                ...node,
                position: {
                    x: 60 + idx * 410,
                    y: 60 + (idx % 2) * 28,
                },
            };
        });

        const syncedEdges = refreshEdgesAnalysis(
            layoutedNodes,
            reconcileResult.edges
        );
        const topoResult = buildFlatPlayQueue(layoutedNodes, syncedEdges);

        set({
            nodes: layoutedNodes,
            edges: syncedEdges,
            activeEdgeId: null,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        persistAutoSave(layoutedNodes, syncedEdges, canvasOrientation);
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            libraryTracks
        );
    },

    syncCurrentQueueToFoobar: () => {
        const { playlist } = get();
        bridgeApi.syncPlaylistToFoobar(
            playlist.map((item) => ({
                trackId: item.trackId,
                path: item.path,
            }))
        );
    },

    // ========================================================================
    // [方向 B] 快速記憶槽儲存 / 讀取 / 重置預設畫布
    // ========================================================================
    saveToQuickSlot: (slotId) => {
        const { nodes, edges } = get();
        if (nodes.length === 0) return false;
        const project = serializeWorkflowProject(nodes, edges);
        savePresetSlot(slotId, project);
        return true;
    },

    loadFromQuickSlot: (slotId) => {
        const project = loadPresetSlot(slotId);
        if (!project || project.nodes.length === 0) return false;
        get().importProjectData(project);
        return true;
    },

    resetCanvasToDefault: () => {
        clearAutoSaveProject();
        const { albumGroups, playlist: prevQueue, libraryTracks } = get();
        const defaultNodes = albumGroups.slice(0, 3).map((g, idx) =>
            createAlbumNode(g, {
                x: 60 + idx * 360,
                y: 70 + (idx % 2) * 120,
            })
        );
        const topoResult = buildFlatPlayQueue(defaultNodes, []);

        set({
            nodes: defaultNodes,
            edges: [],
            activeEdgeId: null,
            playlist: topoResult.flatQueue,
            orderedNodeIds: topoResult.orderedNodeIds,
            excludedNodeIds: topoResult.excludedNodeIds,
            totalTimelineDuration: topoResult.totalTimelineDuration,
            hasCycle: topoResult.hasCycle,
        });

        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            topoResult.flatQueue,
            libraryTracks
        );
    },

    clearCanvas: () => {
        const prevQueue = get().playlist;
        // 明確保存空節點陣列至本地 Auto-Save，確保視窗最小化再打開時維持空白畫布，絕不自動塞入預設節點
        persistAutoSave([], [], get().canvasOrientation);
        set({
            nodes: [],
            edges: [],
            activeEdgeId: null,
            playlist: [],
            orderedNodeIds: [],
            excludedNodeIds: [],
            totalTimelineDuration: 0,
            hasCycle: false,
        });
        // [修復問題 2 & 3] 清空畫布時同步清空宿主 DJ Workflow Set，並將總時間軸 seekhead 重置歸零
        syncTimelineAndFoobarAfterQueueChange(
            prevQueue,
            [],
            get().libraryTracks
        );
    },

    playlist: initialRestoredWorkflow?.playlist ?? [],
    orderedNodeIds: initialRestoredWorkflow?.orderedNodeIds ?? [],
    excludedNodeIds: initialRestoredWorkflow?.excludedNodeIds ?? [],
    totalTimelineDuration: initialRestoredWorkflow?.totalTimelineDuration ?? 0,
    hasCycle: initialRestoredWorkflow?.hasCycle ?? false,
}));