import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ReactFlow,
    ReactFlowProvider,
    Background,
    Controls,
    MiniMap,
    useReactFlow,
    type Edge,
    type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';
import type { TransitionEdgeData } from '../../types/workflow';
import { AlbumNodeComponent } from './AlbumNode';
import { TransitionEdgeComponent } from './TransitionEdge';
import { CamelotWheelOverlay } from './CamelotWheelOverlay';

const CANVAS_VIEWPORT_STORAGE_KEY = 'foobar_dj_canvas_viewport_v1';

/**
 * [修復問題 4：畫布從最小化重新開啟時會 zoom-in 到最大並對準第一張卡片的問題]
 * 造成錯誤的原因：
 * 1. 先前 `<ReactFlow>` 掛載了無條件的 `fitView` 屬性，且未保存與還原使用者的畫布視角 (`Viewport: { x, y, zoom }`)。
 * 2. 當視窗最小化再開啟時，WebView 容器尺寸在 `0x0` 與正常尺寸間切換，觸發 React Flow 內部的 `fitView` 重算（預設 `maxZoom: 2`），導致畫面被放大到最大並鎖定在第一張卡片。
 * 修改的目的：
 * 移除無條件的 `fitView`，改為持久化保存使用者的縮放與平移視角 (`Viewport`)，並在最小化期間阻擋尺寸為 0 的異常視角覆寫，於視窗還原時精準恢復最小化前的視角狀態。
 */
const loadSavedCanvasViewport = (): Viewport | null => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(
                CANVAS_VIEWPORT_STORAGE_KEY
            );
            if (!raw) return null;
            const parsed = JSON.parse(raw) as Partial<Viewport>;
            if (
                parsed &&
                typeof parsed.x === 'number' &&
                Number.isFinite(parsed.x) &&
                typeof parsed.y === 'number' &&
                Number.isFinite(parsed.y) &&
                typeof parsed.zoom === 'number' &&
                Number.isFinite(parsed.zoom) &&
                parsed.zoom >= 0.15 &&
                parsed.zoom <= 2.5
            ) {
                return {
                    x: parsed.x,
                    y: parsed.y,
                    zoom: parsed.zoom,
                };
            }
        }
    } catch {
        // ignore storage errors
    }
    return null;
};

const saveCanvasViewport = (vp: Viewport): void => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(
                CANVAS_VIEWPORT_STORAGE_KEY,
                JSON.stringify({
                    x: Number(vp.x.toFixed(2)),
                    y: Number(vp.y.toFixed(2)),
                    zoom: Number(vp.zoom.toFixed(4)),
                })
            );
        }
    } catch {
        // ignore storage errors
    }
};

// ============================================================================
// [內部畫布核心] 封裝 ReactFlow 實例、自訂 TransitionEdge、MiniMap 縮略圖、駱駝色輪圖層、拖放與一鍵排版
// ============================================================================
function DJCanvasInner() {
    const {
        nodes,
        edges,
        orderedNodeIds,
        canvasOrientation,
        toggleCanvasOrientation,
        showMiniMap,
        showCamelotWheel,
        autoMergeSameAlbum,
        toggleMiniMap,
        toggleCamelotWheel,
        toggleAutoMergeSameAlbum,
        activeEdgeId,
        setActiveEdgeId,
        onNodesChange,
        onEdgesChange,
        onConnect,
        onReconnect,
        deleteEdgeById,
        addTracksToCanvas,
        addAlbumGroupToCanvas,
        mergeNodesOnOverlap,
        autoLayoutNodes,
        autoRecommendArrangeWorkflow,
        clearCanvas,
        hasCycle,
    } = useWorkflowStore();

    const isLiveLocked = usePlayerStore((s) => s.isLiveLocked);
    const { allTracks, filteredAlbumGroups, clearSelection } = usePlaylistStore();
    const { screenToFlowPosition, fitView, setViewport, getViewport } =
        useReactFlow();

    // [Ref] 追蹤連線端點拖曳重連是否成功與最小化前的畫布視角快照
    const edgeReconnectSuccessful = useRef(true);
    const canvasContainerRef = useRef<HTMLDivElement | null>(null);
    const [initialViewport] = useState<Viewport>(
        () => loadSavedCanvasViewport() ?? { x: 48, y: 48, zoom: 0.92 }
    );
    const savedViewportRef = useRef<Viewport | null>(loadSavedCanvasViewport());
    const hasPerformedInitialViewportSetup = useRef(false);
    const [isDragOverCanvas, setIsDragOverCanvas] = useState(false);

    // 視窗從最小化還原 (visibilitychange -> visible / focus) 時，強制鎖定並還原最小化前的 Viewport，防止 React Flow 因容器尺寸變化自動 zoom-in
    useEffect(() => {
        const restorePreMinimizeViewport = () => {
            if (document.visibilityState === 'hidden') return;
            const targetVp = savedViewportRef.current;
            if (!targetVp) return;
            void setViewport(targetVp, { duration: 0 });
            requestAnimationFrame(() => {
                if (savedViewportRef.current) {
                    void setViewport(savedViewportRef.current, { duration: 0 });
                }
            });
        };

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                restorePreMinimizeViewport();
            }
        };

        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('focus', restorePreMinimizeViewport);
        return () => {
            document.removeEventListener(
                'visibilitychange',
                onVisibilityChange
            );
            window.removeEventListener('focus', restorePreMinimizeViewport);
        };
    }, [setViewport]);

    const handleToggleMiniMap = () => {
        toggleMiniMap();
    };

    const handleToggleCamelotWheel = (forceVal?: boolean) => {
        toggleCamelotWheel(forceVal);
    };

    const nodeTypes = useMemo(
        () => ({
            albumNode: AlbumNodeComponent,
            default: AlbumNodeComponent,
        }),
        []
    );

    const edgeTypes = useMemo(
        () => ({
            transitionEdge: TransitionEdgeComponent,
            default: TransitionEdgeComponent,
        }),
        []
    );

    // [功能段落 3a] 切換畫布直式 (上下 Port + 垂直排列) / 橫式 (左右 Port + 水平排列)
    const handleToggleOrientation = () => {
        if (isLiveLocked) return;
        toggleCanvasOrientation();
        setTimeout(() => {
            void fitView({ padding: 0.18, maxZoom: 1.0, duration: 300 }).then(
                () => {
                    const vp = getViewport();
                    savedViewportRef.current = vp;
                    saveCanvasViewport(vp);
                }
            );
        }, 80);
    };

    // [功能段落] 一鍵執行拓撲自動排版並自動縮放適應視窗
    const handleAutoLayout = () => {
        if (isLiveLocked || nodes.length === 0) return;
        autoLayoutNodes();
        setTimeout(() => {
            void fitView({ padding: 0.18, maxZoom: 1.0, duration: 300 }).then(
                () => {
                    const vp = getViewport();
                    savedViewportRef.current = vp;
                    saveCanvasViewport(vp);
                }
            );
        }, 50);
    };

    // [新增功能 3] 一鍵按照駱駝色輪調性與 BPM 自動推薦最佳順序、自動連線並整齊排列
    const handleAutoRecommendArrange = () => {
        if (isLiveLocked || nodes.length === 0) return;
        autoRecommendArrangeWorkflow();
        setTimeout(() => {
            void fitView({ padding: 0.18, maxZoom: 1.0, duration: 300 }).then(
                () => {
                    const vp = getViewport();
                    savedViewportRef.current = vp;
                    saveCanvasViewport(vp);
                }
            );
        }, 60);
    };

    // [功能段落] 一鍵清除畫布所有節點與連線
    const handleClearCanvas = () => {
        if (isLiveLocked || (nodes.length === 0 && edges.length === 0)) return;
        clearCanvas();
    };

    // [功能段落] 處理從左側媒體庫直接拖曳單曲、多選曲目或整張專輯進入畫布座標
    const handleCanvasDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (isLiveLocked) return;
        if (
            e.dataTransfer.types.includes('application/x-foobar-dj-tracks') ||
            e.dataTransfer.types.includes('application/x-foobar-dj-album')
        ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!isDragOverCanvas) {
                setIsDragOverCanvas(true);
            }
        }
    };

    const handleCanvasDragLeave = () => {
        setIsDragOverCanvas(false);
    };

    const handleCanvasDrop = (e: React.DragEvent<HTMLDivElement>) => {
        setIsDragOverCanvas(false);
        if (isLiveLocked) return;

        const albumPayload = e.dataTransfer.getData('application/x-foobar-dj-album');
        const tracksPayload = e.dataTransfer.getData('application/x-foobar-dj-tracks');

        if (!albumPayload && !tracksPayload) return;

        e.preventDefault();
        const flowPos = screenToFlowPosition({
            x: e.clientX,
            y: e.clientY,
        });

        // 1. 若拖入的是整張專輯群組
        if (albumPayload) {
            const targetGroup = filteredAlbumGroups.find(
                (g) => g.albumId === albumPayload
            );
            if (targetGroup) {
                addAlbumGroupToCanvas(targetGroup, flowPos);
            }
            return;
        }

        // 2. 若拖入的是單曲或多選曲目 ID 陣列
        if (tracksPayload) {
            try {
                const trackIds = JSON.parse(tracksPayload) as string[];
                const idSet = new Set(trackIds);
                const droppedTracks = allTracks.filter((t) => idSet.has(t.id));
                if (droppedTracks.length > 0) {
                    addTracksToCanvas(droppedTracks, flowPos);
                    clearSelection();
                }
            } catch (err) {
                console.error('解析拖放曲目資料失敗:', err);
            }
        }
    };

    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    // 造成原錯誤的原因：@xyflow/react 會對每個 .react-flow__node 直接寫入行內 style="z-index: 0"（被選取節點則為 1000），僅靠 Tailwind v4 任意選擇器無法可靠覆蓋行內 z-index。
    // 本次修改的目的：當有連線被點選開啟 Transition 設定視窗 (activeEdgeId) 時，直接賦予該連線來源節點原生 zIndex: 2000 與行內 style.zIndex: 2000，確保彈窗高於所有其他節點卡片且位於駱駝色輪 (z-30) 下層。
    const displayNodes = useMemo(() => {
        if (!activeEdgeId) return nodes;
        const activeEdge = edges.find((e) => e.id === activeEdgeId);
        if (!activeEdge) return nodes;
        return nodes.map((node) =>
            node.id === activeEdge.source
                ? {
                      ...node,
                      zIndex: 2000,
                      style: { ...node.style, zIndex: 2000 },
                  }
                : node
        );
    }, [nodes, edges, activeEdgeId]);

    const renderToolbarControls = (compactMode: boolean) => (
        <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto">
            {hasCycle && (
                <span className="px-2 py-0.5 text-[11px] font-bold bg-red-950 text-red-400 border border-red-700 rounded-full">
                    ⚠️ 迴圈警示
                </span>
            )}

            {/* [功能 3a] 直式 / 橫式 節點連接埠與自動排列方向切換按鈕 */}
            <button
                type="button"
                disabled={isLiveLocked}
                onClick={handleToggleOrientation}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition disabled:opacity-40 cursor-pointer ${
                    canvasOrientation === 'vertical'
                        ? 'bg-indigo-950/90 border-indigo-500/80 text-indigo-200 hover:bg-indigo-800'
                        : 'bg-amber-950/70 border-amber-600/70 text-amber-300 hover:bg-amber-800/70'
                }`}
                title={
                    canvasOrientation === 'vertical'
                        ? '目前為「直式」：In-Port 在上、Out-Port 在下，自動排列時卡片垂直排列（點擊切換為橫式）'
                        : '目前為「橫式」：In-Port 在左、Out-Port 在右，自動排列時卡片水平排列（點擊切換為直式）'
                }
            >
                {compactMode
                    ? canvasOrientation === 'vertical'
                        ? '↕ 直式排列'
                        : '↔ 橫式排列'
                    : canvasOrientation === 'vertical'
                      ? '↕ 直式 / ↔ 橫式 (當前: 直式)'
                      : '↕ 直式 / ↔ 橫式 (當前: 橫式)'}
            </button>

            {/* [新增功能] 同專輯節點連線時自動合併開關按鈕 */}
            <button
                type="button"
                disabled={isLiveLocked}
                onClick={toggleAutoMergeSameAlbum}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition disabled:opacity-40 cursor-pointer ${
                    autoMergeSameAlbum
                        ? 'bg-emerald-950/80 border-emerald-500/80 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title={
                    autoMergeSameAlbum
                        ? '目前已開啟「連線自動合併」：同專輯節點拉線連接時將自動合併為同一張卡片（點擊可關閉）'
                        : '目前已關閉「連線自動合併」：同專輯節點拉線連接時保持獨立卡片不合併（點擊可開啟）'
                }
            >
                {compactMode
                    ? autoMergeSameAlbum
                        ? '🔗 自動合併: 開'
                        : '🔗 自動合併: 關'
                    : autoMergeSameAlbum
                      ? '🔗 同專輯連線合併: 開'
                      : '🔗 同專輯連線合併: 關'}
            </button>

            <button
                type="button"
                onClick={handleToggleMiniMap}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition cursor-pointer ${
                    showMiniMap
                        ? 'bg-cyan-950/80 border-cyan-600/80 text-cyan-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title="顯示或隱藏右下角畫布縮略導覽圖 (MiniMap)"
            >
                🗺️ 縮略圖
            </button>

            <button
                type="button"
                onClick={() => handleToggleCamelotWheel()}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition cursor-pointer ${
                    showCamelotWheel
                        ? 'bg-emerald-950/80 border-emerald-500/80 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title="顯示或隱藏右上角視覺化駱駝色輪圖層 (Camelot Wheel)"
            >
                🎡 駱駝色輪
            </button>

            <button
                type="button"
                disabled={isLiveLocked || nodes.length === 0}
                onClick={handleAutoRecommendArrange}
                className="px-2.5 py-1 text-[11px] font-semibold bg-slate-800 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-slate-700 hover:border-emerald-500 rounded-lg transition disabled:opacity-40 cursor-pointer"
                title="依駱駝色輪調性與 BPM 自動推薦最佳接歌順序、建立連線並整齊排列"
            >
                {compactMode ? '🪄 推薦排列' : '🪄 推薦排列節點'}
            </button>

            <button
                type="button"
                disabled={isLiveLocked || nodes.length === 0}
                onClick={handleAutoLayout}
                className="px-2.5 py-1 text-[11px] font-semibold bg-slate-800 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-slate-700 rounded-lg transition disabled:opacity-40 cursor-pointer"
                title={
                    canvasOrientation === 'vertical'
                        ? '依拓撲播放順序由上往下垂直自動排列卡片'
                        : '依拓撲播放順序由左往右水平自動排列卡片'
                }
            >
                {compactMode ? '✨ 自動排列' : '✨ 自動排列節點'}
            </button>

            <button
                type="button"
                disabled={
                    isLiveLocked || (nodes.length === 0 && edges.length === 0)
                }
                onClick={handleClearCanvas}
                className="px-2.5 py-1 text-[11px] font-semibold bg-slate-800 hover:bg-rose-600 text-rose-300 hover:text-white border border-slate-700 hover:border-rose-500 rounded-lg transition disabled:opacity-40 cursor-pointer"
                title="一鍵清空畫布上的所有節點卡片與連線"
            >
                {compactMode ? '🗑️ 清除' : '🗑️ 清除畫布'}
            </button>
        </div>
    );

    return (
        <div
            className={`dj-surface-panel flex-1 min-w-0 min-h-0 h-full bg-slate-900 border border-slate-800 rounded-xl flex flex-col relative transition-all duration-200 ${
                isM3Style ? 'p-1.5' : 'p-3'
            }`}
        >
            {/* 非 M3 主題維持原本頂部雙行標題與按鈕列；M3 主題則隱藏外層頂部列，改為畫布內嵌懸浮毛玻璃工具塢以最大化畫布高度 */}
            {!isM3Style && (
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2 shrink-0">
                    <div>
                        <h2 className="text-xs font-semibold text-yellow-300">
                            ⚡ 節點式工作流畫布 (Workflow Canvas • 已啟用本地自動存檔)
                        </h2>
                        <p className="text-[11px] text-slate-400">
                            支援媒體庫拖放進畫布；拉新線覆蓋舊線；同專輯重疊放開自動合併。
                        </p>
                    </div>
                    {renderToolbarControls(false)}
                </div>
            )}

            <div
                ref={canvasContainerRef}
                onDragOver={handleCanvasDragOver}
                onDragLeave={handleCanvasDragLeave}
                onDrop={handleCanvasDrop}
                className={`flex-1 min-h-[420px] w-full h-full ${
                    isCafeMica ? '!bg-[#f2e8dc]/75' : 'bg-slate-950'
                } rounded-xl border overflow-hidden relative shadow-inner transition-colors ${
                    isDragOverCanvas
                        ? 'border-cyan-400 ring-2 ring-cyan-500/30'
                        : isCafeMica
                          ? 'border-[#c49874]/35'
                          : 'border-slate-800'
                }`}
            >
                {/* [M3 系列主題專屬] 畫布頂部懸浮毛玻璃膠囊控制塢：不佔用畫布額外垂直高度，釋放 100% 節點編排視野 */}
                {isM3Style && (
                    <div className="absolute top-2.5 left-3 right-3 z-20 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
                        <div
                            className={`pointer-events-auto flex items-center gap-2 px-3 py-1 rounded-full backdrop-blur-xl border shadow-lg ${
                                isCafeMica
                                    ? 'bg-[#fffaf4]/88 border-[#c49874]/45 shadow-[0_6px_20px_rgba(92,62,42,0.12)]'
                                    : 'bg-[#191e29]/85 border-[#a8c7fa]/20'
                            }`}
                            title="支援媒體庫拖放進畫布；拉新線覆蓋舊線；同專輯重疊放開自動合併"
                        >
                            <span
                                className={`text-[11px] font-bold ${
                                    isCafeMica
                                        ? 'text-[#8c461c]'
                                        : 'text-[#a8c7fa]'
                                }`}
                            >
                                {isCafeMica ? '☕ 工作流畫布' : '⚡ 工作流畫布'}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400">
                                {nodes.length} 節點 • {edges.length} 連線
                            </span>
                        </div>

                        <div
                            className={`pointer-events-auto px-2 py-1 rounded-full backdrop-blur-xl border shadow-lg ${
                                isCafeMica
                                    ? 'bg-[#fffaf4]/90 border-[#c49874]/45 shadow-[0_6px_20px_rgba(92,62,42,0.12)]'
                                    : 'bg-[#191e29]/88 border-[#a8c7fa]/20'
                            }`}
                        >
                            {renderToolbarControls(true)}
                        </div>
                    </div>
                )}
                <ReactFlow
                    nodes={displayNodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodesChange={onNodesChange}
                    className="relative z-10 [&_.react-flow__node]:!bg-transparent [&_.react-flow__node]:!p-0 [&_.react-flow__node]:!border-none [&_.react-flow__node]:!w-auto [&_.react-flow__node]:!shadow-none"
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    edgesReconnectable={!isLiveLocked}
                    reconnectRadius={28}
                    defaultViewport={initialViewport}
                    minZoom={0.2}
                    maxZoom={1.8}
                    onInit={(instance) => {
                        if (hasPerformedInitialViewportSetup.current) return;
                        hasPerformedInitialViewportSetup.current = true;

                        // 若本地已有保存的畫布視角，直接還原該視角；僅在從未保存過視角（全新初次啟動）時執行一次適度 fitView (限制 maxZoom <= 1.0)
                        if (savedViewportRef.current) {
                            void instance.setViewport(
                                savedViewportRef.current,
                                { duration: 0 }
                            );
                        } else if (nodes.length > 0) {
                            setTimeout(() => {
                                void instance
                                    .fitView({
                                        padding: 0.18,
                                        maxZoom: 1.0,
                                        duration: 0,
                                    })
                                    .then(() => {
                                        const vp = instance.getViewport();
                                        savedViewportRef.current = vp;
                                        saveCanvasViewport(vp);
                                    });
                            }, 30);
                        }
                    }}
                    onMoveEnd={(_, viewport) => {
                        // 當視窗處於最小化/隱藏狀態或容器寬高異常縮小時，忽略 React Flow 觸發的異常視角事件，保護最小化前的真實視角
                        if (document.visibilityState === 'hidden') return;
                        const w = canvasContainerRef.current?.clientWidth ?? 0;
                        const h = canvasContainerRef.current?.clientHeight ?? 0;
                        if (w < 120 || h < 120) return;

                        savedViewportRef.current = viewport;
                        saveCanvasViewport(viewport);
                    }}
                    onReconnectStart={() => {
                        edgeReconnectSuccessful.current = false;
                    }}
                    onReconnect={(oldEdge, newConnection) => {
                        edgeReconnectSuccessful.current = true;
                        onReconnect(
                            oldEdge as Edge<TransitionEdgeData>,
                            newConnection
                        );
                    }}
                    onReconnectEnd={(_, edge) => {
                        if (!edgeReconnectSuccessful.current) {
                            deleteEdgeById(edge.id);
                        }
                        edgeReconnectSuccessful.current = true;
                    }}
                    onNodeDragStop={(_, draggedNode) => {
                        if (isLiveLocked) return;
                        // [功能段落] 偵測拖動放開的卡片是否與另一張同專輯卡片重疊，若是則將曲目合併至目標卡片尾端
                        const target = nodes.find((other) => {
                            if (other.id === draggedNode.id) return false;
                            if (
                                other.data.albumGroup.albumId !==
                                draggedNode.data.albumGroup.albumId
                            ) {
                                return false;
                            }
                            const dx = Math.abs(
                                other.position.x - draggedNode.position.x
                            );
                            const dy = Math.abs(
                                other.position.y - draggedNode.position.y
                            );
                            return dx < 260 && dy < 160;
                        });

                        if (target) {
                            mergeNodesOnOverlap(draggedNode.id, target.id);
                        }
                    }}
                    onEdgeClick={(_, edge) => {
                        setActiveEdgeId(edge.id);
                    }}
                    onPaneClick={() => {
                        setActiveEdgeId(null);
                    }}
                    nodesDraggable={!isLiveLocked}
                    elementsSelectable={!isLiveLocked}
                >
                    <Background
                        color={isCafeMica ? '#bda088' : '#334155'}
                        gap={24}
                        size={1.5}
                    />
                    {/* 造成原錯誤的原因：ReactFlow <Controls> 先前強制寫死 !bg-slate-800 與 !text-white，導致在北歐晨光燕麥奶淺色主題下仍為黑底控制列。 */}
                    {/* 本次修改的目的：當 isCafeMica 為真時改用杏仁白底色 (!bg-[#fffaf4]/95)、暖木邊框與深焙濃縮咖啡色圖示。 */}
                    <Controls
                        className={
                            isCafeMica
                                ? '!bg-[#fffaf4]/95 !border !border-[#c49874]/55 !rounded-xl !overflow-hidden !shadow-md [&>button]:!bg-[#fffaf4] [&>button]:!border-[#c49874]/35 [&>button]:!text-[#3b281e] [&>button:hover]:!bg-[#efe2d3] [&_svg]:!fill-[#3b281e]'
                                : '!bg-slate-800 !border !border-slate-700 !rounded-lg !shadow-lg [&>button]:!bg-slate-800 [&>button]:!border-slate-700 [&>button]:!text-white [&>button:hover]:!bg-slate-700'
                        }
                    />
                    {showMiniMap && (
                        <MiniMap
                            pannable
                            zoomable
                            nodeColor={(node) =>
                                orderedNodeIds.includes(node.id)
                                    ? isCafeMica
                                        ? '#c87d4b'
                                        : '#06b6d4'
                                    : isCafeMica
                                      ? '#b89f8d'
                                      : '#475569'
                            }
                            maskColor={
                                isCafeMica
                                    ? 'rgba(235, 222, 208, 0.68)'
                                    : 'rgba(2, 6, 23, 0.75)'
                            }
                            className={
                                isCafeMica
                                    ? '!bg-[#fffaf4]/95 !border !border-[#c49874]/50 !rounded-lg !shadow-xl'
                                    : '!bg-slate-900/95 !border !border-slate-700 !rounded-lg !shadow-xl'
                            }
                        />
                    )}
                </ReactFlow>

                {/* 右上角可開關的 24 格視覺化駱駝色輪圖層 */}
                {showCamelotWheel && (
                    <CamelotWheelOverlay
                        onClose={() => handleToggleCamelotWheel(false)}
                    />
                )}
            </div>
        </div>
    );
}

// ============================================================================
// [匯出組件] DJCanvas：外層包裹 ReactFlowProvider 以支援座標轉換與視角自適應 Hook
// ============================================================================
export function DJCanvas() {
    return (
        <ReactFlowProvider>
            <DJCanvasInner />
        </ReactFlowProvider>
    );
}
