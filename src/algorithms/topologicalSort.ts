import type { Connection, Edge, Node } from '@xyflow/react';
import type { TimelineSeekTarget } from '../types/player';
import type {
    AlbumNodeData,
    FlatPlayQueueItem,
    TransitionConfig,
    TransitionEdgeData,
} from '../types/workflow';

export interface ConnectionValidationResult {
    valid: boolean;
    reason?: string;
}

export interface TopologicalSortResult {
    flatQueue: FlatPlayQueueItem[];
    orderedNodeIds: string[];
    excludedNodeIds: string[];
    totalTimelineDuration: number;
    hasCycle: boolean;
}

// [修復問題 1：徹底移除節點垂直/水平座標對播放佇列順序的影響]
// 造成錯誤的原因：先前殘留了 `compareNodesByPosition` 依節點 x/y 座標排序起始節點，且在拖曳節點座標變動時觸發拓撲重算。
// 修改的目的：播放佇列順序完全只按照「專輯卡片內曲目的順序」與「節點連線 (Edges) 的順序」決定，不隨節點在畫布上的座標變動而改變。


export const wouldCreateCycle = (
    sourceId: string,
    targetId: string,
    edges: Edge<TransitionEdgeData>[]
): boolean => {
    if (sourceId === targetId) {
        return true;
    }

    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
        const list = adjacency.get(edge.source) ?? [];
        list.push(edge.target);
        adjacency.set(edge.source, list);
    }

    const visited = new Set<string>();
    const stack: string[] = [targetId];

    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === sourceId) {
            return true;
        }
        if (!visited.has(current)) {
            visited.add(current);
            const neighbors = adjacency.get(current) ?? [];
            for (const next of neighbors) {
                stack.push(next);
            }
        }
    }

    return false;
};

/**
 * 驗證連線規則：允許拉新線覆蓋既有單一端口連線，僅阻擋自我連接與 Cycle 循環
 */
export const validateConnectionRule = (
    connection: Connection,
    edges: Edge<TransitionEdgeData>[]
): ConnectionValidationResult => {
    const { source, target } = connection;

    if (!source || !target) {
        return { valid: false, reason: '連線端點無效' };
    }

    if (source === target) {
        return { valid: false, reason: '同一張卡片不可自我連接' };
    }

    // 模擬移除將被覆蓋的舊連線後，檢查是否會形成 Cycle
    const edgesAfterReplace = edges.filter(
        (e) => e.source !== source && e.target !== target
    );

    if (wouldCreateCycle(source, target, edgesAfterReplace)) {
        return {
            valid: false,
            reason: '此連線會造成循環依賴 (Cycle)，違反播放佇列規則',
        };
    }

    return { valid: true };
};

export const buildFlatPlayQueue = (
    nodes: Node<AlbumNodeData>[],
    edges: Edge<TransitionEdgeData>[]
): TopologicalSortResult => {
    if (nodes.length === 0) {
        return {
            flatQueue: [],
            orderedNodeIds: [],
            excludedNodeIds: [],
            totalTimelineDuration: 0,
            hasCycle: false,
        };
    }

    const nodeMap = new Map<string, Node<AlbumNodeData>>();
    for (const node of nodes) {
        nodeMap.set(node.id, node);
    }

    const validEdges = edges.filter(
        (e) =>
            e.source !== e.target &&
            nodeMap.has(e.source) &&
            nodeMap.has(e.target)
    );

    const connectedNodeIds = new Set<string>();
    const outgoingEdgeMap = new Map<string, Edge<TransitionEdgeData>>();
    const inDegree = new Map<string, number>();

    for (const edge of validEdges) {
        connectedNodeIds.add(edge.source);
        connectedNodeIds.add(edge.target);

        if (!outgoingEdgeMap.has(edge.source)) {
            outgoingEdgeMap.set(edge.source, edge);
            inDegree.set(edge.source, inDegree.get(edge.source) ?? 0);
            inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
        }
    }

    // [修復多節點無連線時佇列被清空的問題]
    // 造成原錯誤的原因：先前寫為 `validEdges.length === 0 && nodes.length === 1`，導致加入或抽離出第 2 個節點 (`nodes.length > 1`) 且尚未連線時，`activeNodes` 變成空陣列而清空佇列。
    // 本次修改的目的：當畫布尚未建立任何連線 (`validEdges.length === 0`) 時，固定保留第一個節點 `[nodes[0]]` 於播放佇列中，未連線的新節點待建立連線後再納入佇列。
    const activeNodes =
        validEdges.length === 0
            ? [nodes[0]]
            : nodes.filter((n) => connectedNodeIds.has(n.id));

    const excludedNodeIds = nodes
        .filter((n) => !activeNodes.some((active) => active.id === n.id))
        .map((n) => n.id);

    for (const node of activeNodes) {
        if (!inDegree.has(node.id)) {
            inDegree.set(node.id, 0);
        }
    }

    const startNodes = activeNodes.filter(
        (n) => (inDegree.get(n.id) ?? 0) === 0
    );

    const orderedNodeIds: string[] = [];
    const visitedNodes = new Set<string>();

    for (const startNode of startNodes) {
        let currentId: string | undefined = startNode.id;
        while (currentId && !visitedNodes.has(currentId)) {
            visitedNodes.add(currentId);
            orderedNodeIds.push(currentId);
            const outEdge = outgoingEdgeMap.get(currentId);
            currentId = outEdge?.target;
        }
    }

    const hasCycle = orderedNodeIds.length < activeNodes.length;

    const flatQueue: FlatPlayQueueItem[] = [];
    let currentTimelineSec = 0;
    let orderCounter = 1;

    for (let nIdx = 0; nIdx < orderedNodeIds.length; nIdx++) {
        const nodeId = orderedNodeIds[nIdx];
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        const tracks = node.data.albumGroup.tracks;
        const outEdge = outgoingEdgeMap.get(nodeId);
        const hasNextConnectedNode =
            Boolean(outEdge) &&
            nIdx < orderedNodeIds.length - 1 &&
            orderedNodeIds[nIdx + 1] === outEdge?.target;

        for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
            const track = tracks[tIdx];
            const isLastTrackInNode = tIdx === tracks.length - 1;

            let transitionToNext: TransitionConfig = {
                type: 'CUT',
                duration: 0,
            };

            if (!isLastTrackInNode) {
                // 讀取卡片內該曲目與下一首之間的過渡設定
                if (track.internalTransition) {
                    transitionToNext = { ...track.internalTransition };
                }
            } else if (hasNextConnectedNode && outEdge?.data?.transition) {
                // 卡片最後一首讀取外部連線 Edge 設定
                transitionToNext = { ...outEdge.data.transition };
            }

            const mixIn = Math.max(0, track.cuePoints?.mixIn ?? 0);
            const rawMixOut = track.cuePoints?.mixOut ?? track.duration;
            const mixOut =
                rawMixOut > mixIn
                    ? Math.min(track.duration, rawMixOut)
                    : track.duration;
            const loopCount = Math.max(1, Math.floor(track.cuePoints?.loopCount ?? 1));

            const singlePassDuration = Math.max(1, mixOut - mixIn);
            const effectivePlayDuration = singlePassDuration * loopCount;

            const timelineStartSec = Number(currentTimelineSec.toFixed(2));
            const timelineEndSec = Number(
                (timelineStartSec + effectivePlayDuration).toFixed(2)
            );

            flatQueue.push({
                order: orderCounter++,
                trackId: track.id,
                albumId: track.albumId,
                title: track.title,
                artist: track.artist,
                album: track.album,
                bpm: track.bpm,
                key: track.key,
                duration: track.duration,
                coverUrl: track.coverUrl,
                path: track.path,
                format: track.format,
                waveform: track.waveform,
                cuePoints: {
                    mixIn,
                    mixOut,
                    loopCount,
                },
                transitionToNext,
                sourceNodeId: nodeId,
                timelineStartSec,
                timelineEndSec,
            });

            const hasFollowingTrack = !isLastTrackInNode || hasNextConnectedNode;
            if (hasFollowingTrack) {
                // [修復功能 1.2：修正 Crossfade 在總時間軸的時間計算錯誤]
                // 造成錯誤的原因：先前將 Crossfade 計算為兩首曲子重疊 `overlap * 0.5`，導致總時間軸長度減少 `crossfade時間 / 2`；
                // 但 foobar2000 單一播放實例無法在同一時間段內獨立解碼並重疊播放兩個音源。
                // 修改的目的：將 Crossfade 設計為兩首曲子交界處的「前曲 Fade-Out (衰減至 0) -> 中點切歌 -> 下曲 Fade-In (由 0 恢復至設定音量)」，
                // 因此 `CROSSFADE` 不會縮減總時間軸長度 (`currentTimelineSec = timelineEndSec`)，僅 `SILENCE` 會加上留白秒數。
                if (transitionToNext.type === 'SILENCE') {
                    currentTimelineSec = Number(
                        (timelineEndSec + transitionToNext.duration).toFixed(2)
                    );
                } else {
                    currentTimelineSec = timelineEndSec;
                }
            } else {
                currentTimelineSec = timelineEndSec;
            }
        }
    }

    const totalTimelineDuration =
        flatQueue.length > 0
            ? flatQueue[flatQueue.length - 1].timelineEndSec
            : 0;

    return {
        flatQueue,
        orderedNodeIds,
        excludedNodeIds,
        totalTimelineDuration,
        hasCycle,
    };
};

/**
 * 根據項目與經過秒數計算單曲內部實際播放秒數 (支援 Loop 折返)
 */
const computeTrackOffsetForElapsed = (
    item: FlatPlayQueueItem,
    elapsedInItem: number
): number => {
    const clampedElapsed = Math.max(0, elapsedInItem);
    const segmentSpan = Math.max(
        1,
        item.cuePoints.mixOut - item.cuePoints.mixIn
    );
    const offsetInPass =
        clampedElapsed >= segmentSpan && (item.cuePoints.loopCount ?? 1) > 1
            ? clampedElapsed % segmentSpan
            : Math.min(segmentSpan, clampedElapsed);

    return Number((item.cuePoints.mixIn + offsetInPass).toFixed(2));
};

export const resolveMasterTimelineSeek = (
    flatQueue: FlatPlayQueueItem[],
    globalSeconds: number
): TimelineSeekTarget | null => {
    if (flatQueue.length === 0) {
        return null;
    }

    const clampedGlobal = Math.max(0, globalSeconds);

    // 1. 優先檢查是否處於兩首曲目之間的 SILENCE 靜音間隔區間 或 CROSSFADE 淡出淡入區間
    for (let i = 0; i < flatQueue.length - 1; i++) {
        const item = flatQueue[i];
        const nextItem = flatQueue[i + 1];

        // [情況 A] SILENCE 靜音過渡區間：位於當前曲目結束點與下一首開始點之間
        if (
            nextItem.timelineStartSec > item.timelineEndSec &&
            clampedGlobal >= item.timelineEndSec &&
            clampedGlobal < nextItem.timelineStartSec
        ) {
            const remainSec = Math.max(
                0,
                nextItem.timelineStartSec - clampedGlobal
            );
            return {
                trackId: item.trackId,
                queueOrder: item.order,
                trackOffsetSeconds: item.cuePoints.mixOut,
                globalTimeSeconds: clampedGlobal,
                isInSilenceGap: true,
                crossfadeGain: 0,
                transitionLabel: `Silence 靜音過渡中 (${remainSec.toFixed(1)}s)`,
            };
        }

        // [情況 B] CROSSFADE 淡出淡入區間 (修改功能 1.1 & 1.2)：
        // 以兩首曲目交界點 switchSec (= item.timelineEndSec = nextItem.timelineStartSec) 為 Crossfade 設置時間的中點：
        // - 前半段 [switchSec - fadeOutHalf, switchSec)：播放前首曲子，音量由當前設定音量 (gain=1.0) 線性衰減至中點時為 0 (gain=0.0)
        // - 後半段 [switchSec, switchSec + fadeInHalf]：切換播放下首曲子，音量由 0 (gain=0.0) 線性漸增至 Crossfade 結束時恢復為設定音量 (gain=1.0)
        if (
            item.transitionToNext.type === 'CROSSFADE' &&
            item.transitionToNext.duration > 0
        ) {
            const itemDuration = Math.max(
                1,
                item.timelineEndSec - item.timelineStartSec
            );
            const nextItemDuration = Math.max(
                1,
                nextItem.timelineEndSec - nextItem.timelineStartSec
            );
            const fadeOutHalf = Math.min(
                item.transitionToNext.duration * 0.5,
                itemDuration * 0.5
            );
            const fadeInHalf = Math.min(
                item.transitionToNext.duration * 0.5,
                nextItemDuration * 0.5
            );
            const switchSec = nextItem.timelineStartSec;
            const fadeStartSec = switchSec - fadeOutHalf;
            const fadeEndSec = switchSec + fadeInHalf;

            if (
                fadeOutHalf > 0.05 &&
                clampedGlobal >= fadeStartSec &&
                clampedGlobal < switchSec
            ) {
                // Crossfade 前半段：維持播放前首曲子 (item)，音量比例由 100% (1.0) 線性衰減至中點時為 0% (0.0)
                const fadeOutProgress =
                    (clampedGlobal - fadeStartSec) /
                    Math.max(0.05, fadeOutHalf);
                const gain = Number(
                    Math.max(0, 1.0 - fadeOutProgress).toFixed(3)
                );
                const trackOffsetSeconds = computeTrackOffsetForElapsed(
                    item,
                    clampedGlobal - item.timelineStartSec
                );
                return {
                    trackId: item.trackId,
                    queueOrder: item.order,
                    trackOffsetSeconds,
                    globalTimeSeconds: clampedGlobal,
                    isInSilenceGap: false,
                    crossfadeGain: gain,
                    transitionLabel: `Crossfade 淡出過渡 (${Math.round(gain * 100)}%)`,
                };
            }

            if (
                fadeInHalf > 0.05 &&
                clampedGlobal >= switchSec &&
                clampedGlobal <= fadeEndSec
            ) {
                // Crossfade 後半段：於中點 switchSec 切入下首曲子 (nextItem)，音量比例由 0% (0.0) 線性漸增至 100% (1.0)
                const fadeInProgress =
                    (clampedGlobal - switchSec) / Math.max(0.05, fadeInHalf);
                const gain = Number(Math.min(1.0, fadeInProgress).toFixed(3));
                const trackOffsetSeconds = computeTrackOffsetForElapsed(
                    nextItem,
                    clampedGlobal - nextItem.timelineStartSec
                );
                return {
                    trackId: nextItem.trackId,
                    queueOrder: nextItem.order,
                    trackOffsetSeconds,
                    globalTimeSeconds: clampedGlobal,
                    isInSilenceGap: false,
                    crossfadeGain: gain,
                    transitionLabel: `Crossfade 淡入過渡 (${Math.round(gain * 100)}%)`,
                };
            }
        }
    }

    // 2. 一般曲目區段定位
    for (let i = flatQueue.length - 1; i >= 0; i--) {
        const item = flatQueue[i];
        const nextItem = i < flatQueue.length - 1 ? flatQueue[i + 1] : null;
        const effectiveItemEndSec =
            nextItem && nextItem.timelineStartSec < item.timelineEndSec
                ? nextItem.timelineStartSec
                : item.timelineEndSec;

        if (
            clampedGlobal >= item.timelineStartSec &&
            clampedGlobal <= effectiveItemEndSec
        ) {
            const trackOffsetSeconds = computeTrackOffsetForElapsed(
                item,
                clampedGlobal - item.timelineStartSec
            );

            return {
                trackId: item.trackId,
                queueOrder: item.order,
                trackOffsetSeconds,
                globalTimeSeconds: clampedGlobal,
                isInSilenceGap: false,
                crossfadeGain: 1.0,
            };
        }
    }

    const lastItem = flatQueue[flatQueue.length - 1];
    if (clampedGlobal > lastItem.timelineEndSec) {
        return {
            trackId: lastItem.trackId,
            queueOrder: lastItem.order,
            trackOffsetSeconds: lastItem.cuePoints.mixOut,
            globalTimeSeconds: lastItem.timelineEndSec,
            isInSilenceGap: false,
            crossfadeGain: 1.0,
        };
    }

    const firstItem = flatQueue[0];
    return {
        trackId: firstItem.trackId,
        queueOrder: firstItem.order,
        trackOffsetSeconds: firstItem.cuePoints.mixIn,
        globalTimeSeconds: 0,
        isInSilenceGap: false,
        crossfadeGain: 1.0,
    };
};