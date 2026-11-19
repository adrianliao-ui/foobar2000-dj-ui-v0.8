import type { Edge, Node } from '@xyflow/react';
import type { AlbumGroup, Track } from '../types/track';
import type { AlbumNodeData, TransitionEdgeData } from '../types/workflow';

/**
 * 單曲從專輯卡片抽出後的回傳結果 (規格書 3.1.2)
 */
export interface ExtractTrackResult {
    remainingGroup: AlbumGroup | null; // 原卡片剩餘曲目組成的 AlbumGroup (若已無剩餘曲目則為 null)
    extractedGroup: AlbumGroup | null; // 被抽出的單曲所獨立形成的 AlbumGroup 卡片
}

/**
 * 計算並建構 AlbumGroup 專輯卡片的邊界數據與統計指標
 * 無論包含 1 首或多首曲目，皆統一封裝為 AlbumGroup 供 AlbumNode 渲染
 */
export const createAlbumGroupFromTracks = (tracks: Track[]): AlbumGroup => {
    if (tracks.length === 0) {
        throw new Error('無法使用空曲目陣列建立 AlbumGroup');
    }

    const firstTrack = tracks[0];
    const lastTrack = tracks[tracks.length - 1];

    let totalDuration = 0;
    let minBpm = firstTrack.bpm;
    let maxBpm = firstTrack.bpm;
    const artistSet = new Set<string>();

    for (const track of tracks) {
        totalDuration += track.duration;
        if (track.bpm < minBpm) minBpm = track.bpm;
        if (track.bpm > maxBpm) maxBpm = track.bpm;
        artistSet.add(track.artist);
    }

    const artistDisplay =
        artistSet.size === 1 ? firstTrack.artist : 'Various Artists';

    return {
        albumId: firstTrack.albumId,
        album: firstTrack.album,
        artist: artistDisplay,
        coverUrl: tracks.find((t) => Boolean(t.coverUrl))?.coverUrl,
        tracks: [...tracks],
        totalDuration,
        minBpm,
        maxBpm,
        entryBpm: firstTrack.bpm,
        exitBpm: lastTrack.bpm,
        entryKey: firstTrack.key,
        exitKey: lastTrack.key,
    };
};

/**
 * 將媒體庫曲目依 albumId 分組為專輯清單（供媒體庫「整張專輯拖入畫布」或初始載入使用）
 */
export const groupLibraryTracksByAlbum = (tracks: Track[]): AlbumGroup[] => {
    const map = new Map<string, Track[]>();

    for (const track of tracks) {
        const list = map.get(track.albumId);
        if (list) {
            list.push(track);
        } else {
            map.set(track.albumId, [track]);
        }
    }

    const groups: AlbumGroup[] = [];
    for (const albumTracks of map.values()) {
        groups.push(createAlbumGroupFromTracks(albumTracks));
    }

    return groups;
};

/**
 * 單曲抽出機制 (規格書 3.1.2)：
 * 按住卡片內的「單一曲目」拖出至畫布空白處，自動拆分為獨立的專輯卡片
 */
export const extractSingleTrackToNewGroup = (
    sourceGroup: AlbumGroup,
    trackIdToExtract: string
): ExtractTrackResult => {
    const targetTrack = sourceGroup.tracks.find((t) => t.id === trackIdToExtract);

    if (!targetTrack) {
        return {
            remainingGroup: sourceGroup,
            extractedGroup: null,
        };
    }

    const remainingTracks = sourceGroup.tracks.filter(
        (t) => t.id !== trackIdToExtract
    );

    const remainingGroup =
        remainingTracks.length > 0
            ? createAlbumGroupFromTracks(remainingTracks)
            : null;

    const extractedGroup = createAlbumGroupFromTracks([targetTrack]);

    return {
        remainingGroup,
        extractedGroup,
    };
};

/**
 * 自動拆分機制 (規格書 3.1.5)：
 * 掃描有序曲目序列，若同專輯曲目在播放順序上不相連（中間隔了其他專輯的歌曲），
 * 自動依連續區段將其拆分為多個獨立的 AlbumGroup 卡片
 */
export const splitContiguousTracksByAlbum = (tracks: Track[]): AlbumGroup[] => {
    if (tracks.length === 0) {
        return [];
    }

    const contiguousGroups: AlbumGroup[] = [];
    let currentBatch: Track[] = [tracks[0]];

    for (let i = 1; i < tracks.length; i++) {
        const currentTrack = tracks[i];
        const prevTrack = currentBatch[currentBatch.length - 1];

        if (currentTrack.albumId === prevTrack.albumId) {
            currentBatch.push(currentTrack);
        } else {
            contiguousGroups.push(createAlbumGroupFromTracks(currentBatch));
            currentBatch = [currentTrack];
        }
    }

    if (currentBatch.length > 0) {
        contiguousGroups.push(createAlbumGroupFromTracks(currentBatch));
    }

    return contiguousGroups;
};

/**
 * 合併兩個相鄰的同專輯 AlbumGroup（去重並維持播放先後順序）
 */
export const mergeTwoAlbumGroups = (
    sourceGroup: AlbumGroup,
    targetGroup: AlbumGroup
): AlbumGroup => {
    const seenIds = new Set<string>();
    const combinedTracks: Track[] = [];

    for (const track of [...sourceGroup.tracks, ...targetGroup.tracks]) {
        if (!seenIds.has(track.id)) {
            seenIds.add(track.id);
            combinedTracks.push(track);
        }
    }

    return createAlbumGroupFromTracks(combinedTracks);
};

/**
 * 畫布節點自動合併與拆分結算引擎 (規格書 3.1.4 & 6.2)：
 * 當歌曲 A 與歌曲 B 屬於同一張專輯 (albumId 相同) 且在播放連線順序中相鄰 (Node A -> Node B) 時，
 * 系統自動將兩者併入同一個 AlbumNode 卡片顯示，並自動繼承原本對外的連線
 */
export const autoReconcileAdjacentAlbumNodes = (
    nodes: Node<AlbumNodeData>[],
    edges: Edge<TransitionEdgeData>[]
): {
    nodes: Node<AlbumNodeData>[];
    edges: Edge<TransitionEdgeData>[];
    didMerge: boolean;
} => {
    const nextNodes = nodes.map((n) => ({
        ...n,
        data: {
            ...n.data,
            albumGroup: {
                ...n.data.albumGroup,
                tracks: [...n.data.albumGroup.tracks],
            },
            expandedTrackIds: [...n.data.expandedTrackIds],
        },
    }));
    let nextEdges = [...edges];
    let didMerge = false;

    // 持續掃描直到沒有任何相鄰的同專輯連線可合併為止
    let foundMergeInPass = true;
    while (foundMergeInPass) {
        foundMergeInPass = false;

        for (const edge of nextEdges) {
            const sourceIndex = nextNodes.findIndex((n) => n.id === edge.source);
            const targetIndex = nextNodes.findIndex((n) => n.id === edge.target);

            if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
                continue;
            }

            const sourceNode = nextNodes[sourceIndex];
            const targetNode = nextNodes[targetIndex];

            // 檢查兩張相連卡片是否屬於同一張專輯
            if (
                sourceNode.data.albumGroup.albumId ===
                targetNode.data.albumGroup.albumId
            ) {
                const mergedGroup = mergeTwoAlbumGroups(
                    sourceNode.data.albumGroup,
                    targetNode.data.albumGroup
                );

                const mergedExpandedIds = Array.from(
                    new Set([
                        ...sourceNode.data.expandedTrackIds,
                        ...targetNode.data.expandedTrackIds,
                    ])
                );

                // 更新起點卡片為合併後的完整專輯卡片
                nextNodes[sourceIndex] = {
                    ...sourceNode,
                    data: {
                        ...sourceNode.data,
                        label: `${mergedGroup.album} - ${mergedGroup.artist}`,
                        albumGroup: mergedGroup,
                        expandedTrackIds: mergedExpandedIds,
                    },
                };

                // 移除被併入的 targetNode
                nextNodes.splice(targetIndex, 1);

                // 重新導向連線：移除原本中間的 edge，並將從 targetNode 連出的連線改為由 sourceNode 連出
                nextEdges = nextEdges
                    .filter((e) => e.id !== edge.id)
                    .map((e) => {
                        if (e.source === targetNode.id) {
                            return {
                                ...e,
                                id: `edge-${sourceNode.id}-${e.target}`,
                                source: sourceNode.id,
                            };
                        }
                        if (e.target === targetNode.id) {
                            return {
                                ...e,
                                id: `edge-${e.source}-${sourceNode.id}`,
                                target: sourceNode.id,
                            };
                        }
                        return e;
                    })
                    // 過濾可能產生的自連迴圈
                    .filter((e) => e.source !== e.target);

                didMerge = true;
                foundMergeInPass = true;
                break;
            }
        }
    }

    return {
        nodes: nextNodes,
        edges: nextEdges,
        didMerge,
    };
};