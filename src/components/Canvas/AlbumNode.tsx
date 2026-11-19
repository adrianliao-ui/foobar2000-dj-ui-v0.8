import { useEffect, useMemo, useState } from 'react';
import {
    Handle,
    Position,
    useUpdateNodeInternals,
    type Node,
    type NodeProps,
} from '@xyflow/react';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';
import {
    fetchSingleTrackRealCover,
    normalizeAudioPathForMatch,
} from '../../api/mockBridge';
import { getCachedCoverSync } from '../../utils/artworkCache';
import { detectTrackNonSilentBounds } from '../../utils/waveformService';
import type { AlbumNodeData, TransitionConfig } from '../../types/workflow';
import { MiniWaveformSeekEditor } from './MiniWaveform';
import { TransitionSettingsBox } from './TransitionSettingsBox';

// ============================================================================
// [組件] AlbumNodeComponent：React Flow 畫布上的自訂專輯卡片節點
// 包含：專輯封面標題、可排序曲目列表、原地展開微觀波形/Loop/內部過渡、以及右側對齊的外部連線設定彈窗
// ============================================================================
export function AlbumNodeComponent({
    id,
    data,
    dragging,
}: NodeProps<Node<AlbumNodeData>>) {
    const updateNodeInternals = useUpdateNodeInternals();
    // [修復問題 1：解決節點卡片拖曳時略有卡頓感、不跟手的問題]
    // 造成錯誤的原因：先前使用 `const { ... } = useWorkflowStore()` 訂閱了整個 WorkflowStore（包含 `state.nodes`），
    // 導致當使用者在畫布上拖曳任一張卡片時，畫布上所有其他未移動的卡片也會在每一個 mousemove 幀（每秒 60~120 次）全部重新渲染。
    // 修改的目的：改用精細的 selector 僅訂閱本卡片所需的 `canvasOrientation`、本卡片連出的 `activeOutgoingEdge` 以及固定的 action 函式，
    // 讓拖曳單一卡片時其他卡片 0 重繪，並於拖曳期間 (`dragging === true`) 停用外框 transition 動畫，達成 60fps 零延遲跟手體驗。
    const canvasOrientation = useWorkflowStore((s) => s.canvasOrientation);
    const activeOutgoingEdge = useWorkflowStore((s) =>
        s.activeEdgeId
            ? s.edges.find((e) => e.id === s.activeEdgeId && e.source === id)
            : undefined
    );
    const setActiveEdgeId = useWorkflowStore((s) => s.setActiveEdgeId);
    const extractTrackFromNode = useWorkflowStore(
        (s) => s.extractTrackFromNode
    );
    const toggleTrackExpandInNode = useWorkflowStore(
        (s) => s.toggleTrackExpandInNode
    );
    const reorderTracksInNode = useWorkflowStore((s) => s.reorderTracksInNode);
    const updateTrackCuePointsInWorkflow = useWorkflowStore(
        (s) => s.updateTrackCuePointsInWorkflow
    );
    const updateTrackComputedMetaInWorkflow = useWorkflowStore(
        (s) => s.updateTrackComputedMetaInWorkflow
    );
    const updateTrackInternalTransitionInWorkflow = useWorkflowStore(
        (s) => s.updateTrackInternalTransitionInWorkflow
    );
    const updateEdgeTransition = useWorkflowStore(
        (s) => s.updateEdgeTransition
    );
    const deleteEdgeById = useWorkflowStore((s) => s.deleteEdgeById);
    const deleteNodeById = useWorkflowStore((s) => s.deleteNodeById);
    const isLiveLocked = usePlayerStore((s) => s.isLiveLocked);
    const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
    const updateCurrentTrackComputedMeta = usePlayerStore(
        (s) => s.updateCurrentTrackComputedMeta
    );
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const focusTrackInLibrary = usePlaylistStore((s) => s.focusTrackInLibrary);
    const updateTrackComputedMeta = usePlaylistStore(
        (s) => s.updateTrackComputedMeta
    );

    // [狀態管理] 記錄目前正在被拖曳排序的曲目索引與目標放置索引
    const [draggedTrackIdx, setDraggedTrackIdx] = useState<number | null>(null);
    const [dragOverTrackIdx, setDragOverTrackIdx] = useState<number | null>(null);

    const { albumGroup, expandedTrackIds } = data;
    const isVertical = canvasOrientation === 'vertical';

    // [修復問題 1：避免左側媒體庫多選曲目時觸發畫布所有節點卡片同步重繪]
    // 造成錯誤的原因：先前每張 AlbumNode 皆直接訂閱整個 `selectedTrackIds` 陣列，導致在左側媒體庫多選任一不在畫布上的曲目時，所有畫布節點都會因陣列參考改變而同步重繪。
    // 修改的目的：僅篩選屬於本節點曲目的已選 ID 並組合成純字串 Key (`nodeSelectedKey`)，利用 Zustand 的純值相等性比對，讓未受影響的畫布節點完全不重繪。
    const nodeSelectedKey = usePlaylistStore((s) =>
        albumGroup.tracks
            .filter((t) => s.selectedTrackIds.includes(t.id))
            .map((t) => t.id)
            .join('|')
    );
    const nodeSelectedSet = useMemo(
        () => new Set(nodeSelectedKey ? nodeSelectedKey.split('|') : []),
        [nodeSelectedKey]
    );

    // [修正 1：強化專輯封面解析與跨組件快取共享]
    // 造成錯誤的原因：先前 AlbumNode 提取封面時未傳入 artist 與 album 參數，導致 artworkCache 僅以第一首歌的單曲 path 建立快取，
    // 同專輯的其他曲目在成為 currentTrack 時無法透過 `album::artist::album` 命中快取。
    // 修改的目的：支援正規化路徑與雙層封面快取查詢，並在提取封面時一併寫入專輯級快取、畫布節點與播放器狀態。
    const resolvedCoverUrl = useMemo(() => {
        if (albumGroup.coverUrl) return albumGroup.coverUrl;
        const fromNodeTrack = albumGroup.tracks.find((t) =>
            Boolean(t.coverUrl)
        )?.coverUrl;
        if (fromNodeTrack) return fromNodeTrack;

        for (const nt of albumGroup.tracks) {
            const normNtPath = normalizeAudioPathForMatch(nt.path);
            const matchedInLib = allTracks.find(
                (lt) =>
                    (lt.id === nt.id ||
                        (Boolean(normNtPath) &&
                            normalizeAudioPathForMatch(lt.path) ===
                                normNtPath)) &&
                    Boolean(lt.coverUrl)
            );
            if (matchedInLib?.coverUrl) {
                return matchedInLib.coverUrl;
            }
            const cached = getCachedCoverSync(nt.path, nt.artist, nt.album);
            if (cached) {
                return cached;
            }
        }
        return undefined;
    }, [albumGroup.coverUrl, albumGroup.tracks, allTracks]);

    // 當節點曲目尚未載入真實封面（例如從快取還原或剛拖入畫布）時，主動對實體音訊檔提取真實封面並同步寫回節點、媒體庫與播放器
    useEffect(() => {
        if (resolvedCoverUrl) return;
        const trackWithRealPath = albumGroup.tracks.find(
            (t) =>
                Boolean(t.path) && !t.path.startsWith('C:\\Music\\DJ_Set\\')
        );
        if (!trackWithRealPath) return;

        let cancelled = false;
        void fetchSingleTrackRealCover(
            trackWithRealPath.path,
            trackWithRealPath.artist,
            trackWithRealPath.album
        ).then((realCover) => {
            if (cancelled || !realCover) return;
            for (const tr of albumGroup.tracks) {
                updateTrackComputedMeta(tr.id, tr.path, {
                    coverUrl: realCover,
                });
                updateTrackComputedMetaInWorkflow(tr.id, tr.path, {
                    coverUrl: realCover,
                });
                updateCurrentTrackComputedMeta(tr.id, tr.path, {
                    coverUrl: realCover,
                });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [
        resolvedCoverUrl,
        albumGroup.tracks,
        updateTrackComputedMeta,
        updateTrackComputedMetaInWorkflow,
        updateCurrentTrackComputedMeta,
    ]);

    // 當切換直式/橫式方向時，通知 React Flow 重新計算該節點之 Handle 座標以即時重繪連線
    useEffect(() => {
        updateNodeInternals(id);
    }, [id, canvasOrientation, updateNodeInternals]);

    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';
    const hasSelectedTrackInNode = nodeSelectedSet.size > 0;

    return (
        <div
            className={`relative w-[340px] text-slate-100 ${
                dragging ? '' : 'transition-colors'
            } ${
                isCafeMica
                    ? `bg-[#fffaf4]/88 backdrop-blur-2xl border rounded-2xl shadow-[0_12px_28px_rgba(92,62,42,0.16)] ${
                          hasSelectedTrackInNode
                              ? 'border-[#c87d4b] ring-2 ring-[#c87d4b]/45'
                              : 'border-[#c49874]/42 hover:border-[#c87d4b]/75'
                      }`
                    : isM3Style
                      ? `bg-[#1b202c]/98 border rounded-2xl shadow-[0_12px_32px_rgba(0,0,0,0.55)] ${
                            hasSelectedTrackInNode
                                ? 'border-[#8ab4f8] ring-2 ring-[#8ab4f8]/35'
                                : 'border-[#a8c7fa]/20 hover:border-[#8ab4f8]/60'
                        }`
                      : `bg-slate-900/95 border-2 rounded-xl shadow-2xl ${
                            hasSelectedTrackInNode
                                ? 'border-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.22)]'
                                : 'border-slate-700 hover:border-cyan-500/70'
                        }`
            }`}
        >
            {/* [連線埠] In-Port (橫式在左邊 Left、直式在頂部 Top) */}
            <Handle
                type="target"
                position={isVertical ? Position.Top : Position.Left}
                className={
                    isCafeMica
                        ? '!w-3.5 !h-3.5 !bg-[#c87d4b] !border-2 !border-[#fffaf4]'
                        : isM3Style
                          ? '!w-3.5 !h-3.5 !bg-[#8ab4f8] !border-2 !border-[#0f131a]'
                          : '!w-3.5 !h-3.5 !bg-cyan-400 !border-2 !border-slate-950'
                }
            />

            {/* [浮動彈窗] 固定在 Out-Port 所屬卡片右方、對齊卡片上方邊緣的外部連線 Transition 設定面板 */}
            {/* 造成原錯誤的原因：React Flow 為每個 .react-flow__node 建立獨立的 transform + z-index: 0 堆疊上下文，導致彈窗雖有 z-50 仍會被右側 DOM 順序較後或已選取 (z-index: 1000) 的卡片遮擋。 */}
            {/* 本次修改的目的：標記 dj-edge-transition-popover 供外層 ReactFlow 以 :has() 將宿主節點提升至 !z-[2000]，確保彈窗顯示於所有節點卡片上層。 */}
            {activeOutgoingEdge && !isLiveLocked && (
                <div
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={`dj-edge-transition-popover nodrag nowheel absolute left-full top-0 ml-3.5 z-50 w-72 p-3 shadow-2xl backdrop-blur-xl ${
                        isCafeMica
                            ? 'bg-[#fffaf4]/95 border border-[#c87d4b]/65 rounded-2xl'
                            : isM3Style
                              ? 'bg-[#191e29]/98 border border-[#8ab4f8]/60 rounded-2xl'
                              : 'bg-slate-900/95 border-2 border-cyan-500 rounded-xl'
                    }`}
                >
                    <div className="flex items-center justify-between mb-2">
                        <span
                            className={`text-xs font-bold ${
                                isCafeMica
                                    ? 'text-[#7a3e18]'
                                    : isM3Style
                                      ? 'text-[#a8c7fa]'
                                      : 'text-cyan-300'
                            }`}
                        >
                            🎛️ 外部連線過渡設定 (Out-Port)
                        </span>
                        <button
                            onClick={() => setActiveEdgeId(null)}
                            className="text-xs text-slate-400 hover:text-white cursor-pointer"
                        >
                            ✕
                        </button>
                    </div>

                    {activeOutgoingEdge.data?.analysis && (
                        <div
                            className={`mb-2 p-2 text-[11px] border ${
                                isCafeMica
                                    ? 'rounded-xl bg-[#f5ebe0] border-[#c49874]/35'
                                    : isM3Style
                                      ? 'rounded-xl bg-[#121620] border-[#a8c7fa]/15'
                                      : 'rounded bg-slate-950 border-slate-800'
                            }`}
                        >
                            <div className="font-semibold text-slate-200">
                                {activeOutgoingEdge.data.analysis.keyRelationMessage}
                            </div>
                            <div
                                className={`font-mono mt-0.5 ${
                                    isCafeMica
                                        ? 'text-[#a85d2e]'
                                        : isM3Style
                                          ? 'text-[#8ab4f8]'
                                          : 'text-cyan-400'
                                }`}
                            >
                                評分: {activeOutgoingEdge.data.analysis.score}分 •{' '}
                                {activeOutgoingEdge.data.analysis.suggestedPitchText}
                            </div>
                        </div>
                    )}

                    <TransitionSettingsBox
                        transition={
                            activeOutgoingEdge.data?.transition ?? {
                                type: 'CUT',
                                duration: 0,
                            }
                        }
                        onChange={(nextTrans) =>
                            updateEdgeTransition(activeOutgoingEdge.id, nextTrans)
                        }
                    />

                    <button
                        onClick={() => {
                            deleteEdgeById(activeOutgoingEdge.id);
                            setActiveEdgeId(null);
                        }}
                        className={`mt-2.5 w-full py-1.5 text-xs font-semibold bg-rose-950/80 hover:bg-rose-800 text-rose-300 border border-rose-700/70 transition cursor-pointer ${
                            isM3Style ? 'rounded-full' : 'rounded-lg'
                        }`}
                    >
                        🗑 刪除此條連線
                    </button>
                </div>
            )}

            {/* [卡片區塊 1] 專輯封面縮圖、專輯名稱、出入口 BPM/Key 摘要與刪除卡片按鈕 */}
            <div
                className={`px-3 py-2.5 border-b flex items-center gap-3 ${
                    isCafeMica
                        ? 'bg-[#f4e8dc]/85 border-[#c49874]/30 rounded-t-2xl'
                        : isM3Style
                          ? 'bg-[#131722] border-[#a8c7fa]/12 rounded-t-2xl'
                          : 'bg-slate-950/90 border-slate-800 rounded-t-xl'
                }`}
            >
                {resolvedCoverUrl ? (
                    <img
                        src={resolvedCoverUrl}
                        alt={albumGroup.album}
                        referrerPolicy="no-referrer"
                        className={`w-11 h-11 object-cover border shrink-0 ${
                            isCafeMica
                                ? 'rounded-xl border-[#c49874]/45'
                                : isM3Style
                                  ? 'rounded-xl border-[#a8c7fa]/20'
                                  : 'rounded-lg border-slate-700'
                        }`}
                    />
                ) : (
                    <div
                        className={`w-11 h-11 flex items-center justify-center text-xs text-slate-400 shrink-0 ${
                            isCafeMica
                                ? 'rounded-xl bg-[#e8d6c4]'
                                : isM3Style
                                  ? 'rounded-xl bg-[#252c3d]'
                                  : 'rounded-lg bg-slate-800'
                        }`}
                    >
                        💿
                    </div>
                )}

                <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-xs font-bold text-slate-100 truncate">
                        {albumGroup.album}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate mt-0.5">
                        {albumGroup.artist}
                    </div>
                    <div
                        className={`text-[10px] font-mono mt-0.5 ${
                            isCafeMica
                                ? 'text-[#a85d2e]'
                                : isM3Style
                                  ? 'text-[#8ab4f8]'
                                  : 'text-cyan-400'
                        }`}
                    >
                        {albumGroup.tracks.length} 首 • {albumGroup.entryBpm}BPM/
                        {albumGroup.entryKey} → {albumGroup.exitBpm}BPM/
                        {albumGroup.exitKey}
                    </div>
                </div>

                {!isLiveLocked && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            deleteNodeById(id);
                        }}
                        className={`nodrag w-6 h-6 flex items-center justify-center text-xs text-slate-400 hover:text-red-300 transition cursor-pointer ${
                            isCafeMica
                                ? 'rounded-full bg-[#eadbce] hover:bg-rose-200'
                                : isM3Style
                                  ? 'rounded-full bg-[#252c3d]/70 hover:bg-rose-900/60'
                                  : 'rounded hover:bg-slate-800'
                        }`}
                        title="刪除此卡片"
                    >
                        ✕
                    </button>
                )}
            </div>

            {/* [卡片區塊 2] 專輯內曲目方塊列表 */}
            <div className="p-2.5 flex flex-col gap-1.5">
                {albumGroup.tracks.map((track, idx) => {
                    const isExpanded = expandedTrackIds.includes(track.id);
                    const isPlayingThis = currentTrackId === track.id;
                    const isHighlightedInLibrary = nodeSelectedSet.has(
                        track.id
                    );
                    const isLastTrack = idx === albumGroup.tracks.length - 1;
                    const loopCount = Math.max(1, track.cuePoints.loopCount ?? 1);
                    const internalTrans: TransitionConfig = track.internalTransition ?? {
                        type: 'CUT',
                        duration: 0,
                    };

                    // [畫布節點曲目統一套用 M3 深色 & 北歐晨光燕麥奶淺色雲母狀態規範]
                    const cafeMicaNodeTrackStateClass =
                        dragOverTrackIdx === idx
                            ? 'border-amber-500 bg-amber-100/80'
                            : isHighlightedInLibrary
                              ? 'bg-[#f4dec8]/95 border-[#c87d4b] ring-1 ring-[#c87d4b]/55 shadow-sm'
                              : isPlayingThis
                                ? 'bg-[#d9efe0]/95 border-[#4e8763] ring-1 ring-[#4e8763]/45 shadow-sm'
                                : 'bg-[#fdf8f2]/88 border-[#c49874]/30 hover:bg-[#f6eadc] hover:border-[#c87d4b]/55';

                    const m3DarkNodeTrackStateClass =
                        dragOverTrackIdx === idx
                            ? 'border-amber-400 bg-amber-950/35'
                            : isHighlightedInLibrary
                              ? 'bg-[#1e3252] border-[#8ab4f8] ring-1 ring-[#8ab4f8]/60 shadow-sm'
                              : isPlayingThis
                                ? 'bg-[#143534] border-[#4db6ac] ring-1 ring-[#4db6ac]/45 shadow-sm'
                                : 'bg-[#131722] border-[#a8c7fa]/12 hover:bg-[#212838] hover:border-[#a8c7fa]/30';

                    const classicNodeTrackStateClass =
                        dragOverTrackIdx === idx
                            ? 'border-amber-400 bg-amber-950/30'
                            : isHighlightedInLibrary
                              ? 'bg-cyan-950/50 border-cyan-400 ring-1 ring-cyan-400/70 shadow-[0_0_12px_rgba(34,211,238,0.28)]'
                              : isPlayingThis
                                ? 'bg-emerald-950/50 border-emerald-500/80'
                                : 'bg-slate-950/80 border-slate-800 hover:border-slate-700';

                    return (
                        <div
                            key={track.id}
                            onDragOver={(e) => {
                                if (draggedTrackIdx === null) return;
                                e.preventDefault();
                                e.stopPropagation();
                                if (dragOverTrackIdx !== idx) {
                                    setDragOverTrackIdx(idx);
                                }
                            }}
                            onDrop={(e) => {
                                if (draggedTrackIdx === null) return;
                                e.preventDefault();
                                e.stopPropagation();
                                if (draggedTrackIdx !== idx) {
                                    reorderTracksInNode(id, draggedTrackIdx, idx);
                                }
                                setDraggedTrackIdx(null);
                                setDragOverTrackIdx(null);
                            }}
                            className={`nodrag ${
                                isM3Style ? 'rounded-xl' : 'rounded-lg'
                            } border transition ${
                                isCafeMica
                                    ? cafeMicaNodeTrackStateClass
                                    : isM3Style
                                      ? m3DarkNodeTrackStateClass
                                      : classicNodeTrackStateClass
                            }`}
                        >
                            {/* [曲目方塊標題列] */}
                            <div
                                draggable={!isLiveLocked && albumGroup.tracks.length > 1}
                                onClick={() => {
                                    focusTrackInLibrary(track.id, track);
                                    toggleTrackExpandInNode(id, track.id);
                                }}
                                onDragStart={(e) => {
                                    if (isLiveLocked || albumGroup.tracks.length <= 1) {
                                        e.preventDefault();
                                        return;
                                    }
                                    e.stopPropagation();
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setData('text/plain', String(idx));
                                    setDraggedTrackIdx(idx);
                                }}
                                onDragEnd={(e) => {
                                    e.stopPropagation();
                                    setDraggedTrackIdx(null);
                                    setDragOverTrackIdx(null);
                                }}
                                className={`px-2.5 py-1.5 flex items-center justify-between gap-2 ${
                                    !isLiveLocked && albumGroup.tracks.length > 1
                                        ? 'cursor-grab active:cursor-grabbing'
                                        : 'cursor-pointer'
                                }`}
                                title="點擊設為選取曲目 (selectedTrack) 並展開/收合波形（不影響當前播放曲目）；按住曲名上下拖曳可調整播放次序"
                            >
                                <div className="flex items-center gap-1.5 min-w-0">
                                    {!isLiveLocked && albumGroup.tracks.length > 1 && (
                                        <span className="px-0.5 text-slate-400 text-xs select-none">
                                            ⋮⋮
                                        </span>
                                    )}
                                    <span className="text-[10px] font-mono text-slate-400">
                                        {idx + 1}.
                                    </span>
                                    <span
                                        className={`text-xs font-semibold truncate ${
                                            isHighlightedInLibrary
                                                ? isCafeMica
                                                    ? 'text-[#3d1f0d]'
                                                    : 'text-[#d3e3fd]'
                                                : isPlayingThis
                                                  ? isCafeMica
                                                      ? 'text-[#163824]'
                                                      : 'text-[#a7f3d0]'
                                                  : 'text-slate-100'
                                        }`}
                                    >
                                        {track.title}
                                    </span>
                                    {isPlayingThis && (
                                        <span
                                            className={`px-1.5 py-0.2 text-[9px] font-mono font-bold shrink-0 ${
                                                isCafeMica
                                                    ? 'rounded-full bg-[#4e8763]/20 text-[#1b4a2e] border border-[#4e8763]/50'
                                                    : isM3Style
                                                      ? 'rounded-full bg-[#4db6ac]/25 text-[#80cbc4] border border-[#4db6ac]/50'
                                                      : 'rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                            }`}
                                        >
                                            PLAYING
                                        </span>
                                    )}
                                    {loopCount > 1 && (
                                        <span className="px-1.5 py-0.2 text-[9px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full shrink-0">
                                            🔁x{loopCount}
                                        </span>
                                    )}
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                    <span
                                        className={`text-[10px] font-mono px-2 py-0.5 ${
                                            isCafeMica
                                                ? 'rounded-full bg-[#ede0d2] text-[#7a3e18]'
                                                : isM3Style
                                                  ? 'rounded-full bg-[#252c3d] text-[#a8c7fa]'
                                                  : 'rounded bg-slate-800 text-cyan-300'
                                        }`}
                                    >
                                        {track.bpm} | {track.key}
                                    </span>
                                    <span className="text-[10px] text-slate-400">
                                        {isExpanded ? '▼' : '▶'}
                                    </span>
                                    {!isLiveLocked && albumGroup.tracks.length > 1 && (
                                        <button
                                            draggable={false}
                                            onDragStart={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                extractTrackFromNode(id, track.id);
                                            }}
                                            className={`text-[10px] px-2 py-0.5 bg-amber-950/80 hover:bg-amber-800 text-amber-300 border border-amber-700/60 cursor-pointer ${
                                                isM3Style ? 'rounded-full' : 'rounded'
                                            }`}
                                            title="抽離為獨立單曲卡片"
                                        >
                                            抽離↗
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* [曲目展開面板] */}
                            {isExpanded && (
                                <div
                                    draggable={false}
                                    onDragStart={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    className={`nodrag nowheel px-2.5 pb-2.5 pt-1.5 border-t flex flex-col gap-2 cursor-default ${
                                        isCafeMica
                                            ? 'border-[#c49874]/30 bg-[#f6ebe0]/90 rounded-b-xl'
                                            : isM3Style
                                              ? 'border-[#a8c7fa]/15 bg-[#161b26]/90 rounded-b-xl'
                                              : 'border-slate-800/80 bg-slate-900/60'
                                    }`}
                                >
                                    <MiniWaveformSeekEditor
                                        track={track}
                                        disabled={isLiveLocked}
                                        onChangeCue={(nextCue) =>
                                            updateTrackCuePointsInWorkflow(
                                                id,
                                                track.id,
                                                nextCue
                                            )
                                        }
                                        onCalibrateDuration={(realFloorDur) => {
                                            updateTrackComputedMetaInWorkflow(
                                                track.id,
                                                track.path,
                                                { duration: realFloorDur }
                                            );
                                            updateTrackComputedMeta(
                                                track.id,
                                                track.path,
                                                { duration: realFloorDur }
                                            );
                                        }}
                                    />

                                    {/* 造成原錯誤的原因：原先 Loop 區間循環播放次數區塊佔滿整行寬度，且缺乏自動跳過首尾靜音區間的快捷按鈕。 */}
                                    {/* 本次修改的目的：縮短 Loop 設定區塊寬度並於右側並排新增「✂️ 跳過靜音」按鈕，自動將本節點該曲目的 mixIn 設於實際發聲處、mixOut 設於尾端剛進入靜音處。 */}
                                    <div className="flex items-center gap-1.5">
                                        <div
                                            className={`flex-1 min-w-0 flex items-center justify-between border px-2 py-1.5 text-[11px] ${
                                                isCafeMica
                                                    ? 'bg-[#fffaf4] border-[#c49874]/35 rounded-xl'
                                                    : isM3Style
                                                      ? 'bg-[#121620] border-[#a8c7fa]/15 rounded-xl'
                                                      : 'bg-slate-950/80 border-slate-800 rounded'
                                            }`}
                                        >
                                            <span
                                                className={`font-semibold truncate ${
                                                    isCafeMica
                                                        ? 'text-[#8c461c]'
                                                        : 'text-amber-300'
                                                }`}
                                                title="🔁 Loop 區間循環播放次數"
                                            >
                                                🔁 Loop 次數
                                            </span>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    disabled={
                                                        isLiveLocked ||
                                                        loopCount <= 1
                                                    }
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        updateTrackCuePointsInWorkflow(
                                                            id,
                                                            track.id,
                                                            {
                                                                ...track.cuePoints,
                                                                loopCount:
                                                                    Math.max(
                                                                        1,
                                                                        loopCount -
                                                                            1
                                                                    ),
                                                            }
                                                        );
                                                    }}
                                                    className="w-5 h-5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold flex items-center justify-center disabled:opacity-40 cursor-pointer"
                                                >
                                                    -
                                                </button>
                                                <span
                                                    className={`font-mono font-bold w-7 text-center ${
                                                        isCafeMica
                                                            ? 'text-[#2b1e17]'
                                                            : 'text-white'
                                                    }`}
                                                >
                                                    {loopCount} 次
                                                </span>
                                                <button
                                                    disabled={
                                                        isLiveLocked ||
                                                        loopCount >= 8
                                                    }
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        updateTrackCuePointsInWorkflow(
                                                            id,
                                                            track.id,
                                                            {
                                                                ...track.cuePoints,
                                                                loopCount:
                                                                    Math.min(
                                                                        8,
                                                                        loopCount +
                                                                            1
                                                                    ),
                                                            }
                                                        );
                                                    }}
                                                    className="w-5 h-5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold flex items-center justify-center disabled:opacity-40 cursor-pointer"
                                                >
                                                    +
                                                </button>
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            disabled={isLiveLocked}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void detectTrackNonSilentBounds(
                                                    track
                                                ).then(({ mixIn, mixOut }) => {
                                                    updateTrackCuePointsInWorkflow(
                                                        id,
                                                        track.id,
                                                        {
                                                            ...track.cuePoints,
                                                            mixIn,
                                                            mixOut,
                                                        }
                                                    );
                                                });
                                            }}
                                            className={`shrink-0 px-2.5 py-1.5 text-[11px] font-semibold border transition cursor-pointer disabled:opacity-40 ${
                                                isCafeMica
                                                    ? 'bg-[#efe0d0] hover:bg-[#c87d4b] text-[#6e3815] hover:text-white border-[#c49874]/55 rounded-xl'
                                                    : isM3Style
                                                      ? 'bg-[#1e2f4d] hover:bg-[#8ab4f8] text-[#c2dbff] hover:text-[#081c36] border-[#a8c7fa]/35 rounded-xl'
                                                      : 'bg-slate-800 hover:bg-cyan-600 text-cyan-300 hover:text-white border-slate-700 hover:border-cyan-500 rounded'
                                            }`}
                                            title="自動將 Mix-In 設在實際開始發聲的位置，並將 Mix-Out 設在尾端剛進入靜音的位置"
                                        >
                                            ✂️ 跳過靜音
                                        </button>
                                    </div>

                                    {!isLastTrack && (
                                        <TransitionSettingsBox
                                            title={`⇊ 往下一首 (${albumGroup.tracks[idx + 1].title
                                                }) 的過渡模式`}
                                            transition={internalTrans}
                                            disabled={isLiveLocked}
                                            onChange={(nextTrans) =>
                                                updateTrackInternalTransitionInWorkflow(
                                                    id,
                                                    track.id,
                                                    nextTrans
                                                )
                                            }
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* [連線埠] Out-Port (橫式在右邊 Right、直式在底部 Bottom) */}
            <Handle
                type="source"
                position={isVertical ? Position.Bottom : Position.Right}
                className={
                    isCafeMica
                        ? '!w-3.5 !h-3.5 !bg-[#4e8763] !border-2 !border-[#fffaf4]'
                        : isM3Style
                          ? '!w-3.5 !h-3.5 !bg-[#fbbf24] !border-2 !border-[#0f131a]'
                          : '!w-3.5 !h-3.5 !bg-amber-400 !border-2 !border-slate-950'
                }
            />
        </div>
    );
}

