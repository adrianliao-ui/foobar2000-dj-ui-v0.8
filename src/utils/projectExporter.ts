import type { Edge, Node } from '@xyflow/react';
import type {
    AlbumNodeData,
    FlatPlayQueueItem,
    TransitionConfig,
    TransitionEdgeData,
    WorkflowProjectFile,
} from '../types/workflow';
import { bridgeApi } from '../api/mockBridge';

// ============================================================================
// [工具模組] projectExporter：DJ 工作流專案檔 (.json) 與歌單 (.m3u8) 匯出入引擎 (規格書 2.1 & 7.1)
// ============================================================================

/**
 * 將當前畫布上的節點與連線序列化為標準 WorkflowProjectFile 物件
 * [修復功能 4：大幅縮減匯出 (.json) 檔案體積]
 * 造成檔案過大的原因：
 * 先前直接以 `{ ...track }` 展開曲目物件，將每首歌內嵌的 Base64 專輯封面快取 (`coverUrl`，單張可達數十至數百 KB)、動態歌詞 (`lrc`) 與波形陣列 (`waveform`) 一併寫入 JSON。
 * 修改的目的：
 * 僅記錄還原畫布節點座標、曲目識別與路徑、BPM/調性、Cue 點 (`mixIn`/`mixOut`/`loopCount`)、內部轉場 (`internalTransition`) 與卡片連線 (`edges`) 所需的必要欄位，
 * 不記錄封面快取圖片與當前播放進度/選取狀態，使匯出的 `.json` 輕量化且易於攜帶；匯入時會自動根據音訊路徑從快取或檔案讀取封面。
 */
export const serializeWorkflowProject = (
    nodes: Node<AlbumNodeData>[],
    edges: Edge<TransitionEdgeData>[],
    canvasOrientation?: 'horizontal' | 'vertical',
    overlays?: { showCamelotWheel?: boolean; showMiniMap?: boolean }
): WorkflowProjectFile => {
    return {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        ...(canvasOrientation ? { canvasOrientation } : {}),
        ...(typeof overlays?.showCamelotWheel === 'boolean'
            ? { showCamelotWheel: overlays.showCamelotWheel }
            : {}),
        ...(typeof overlays?.showMiniMap === 'boolean'
            ? { showMiniMap: overlays.showMiniMap }
            : {}),
        nodes: nodes.map((node) => ({
            id: node.id,
            position: {
                x: Math.round(node.position.x),
                y: Math.round(node.position.y),
            },
            expandedTrackIds: Array.isArray(node.data.expandedTrackIds)
                ? [...node.data.expandedTrackIds]
                : [],
            tracks: node.data.albumGroup.tracks.map((track) => ({
                id: track.id,
                albumId: track.albumId,
                title: track.title,
                artist: track.artist,
                album: track.album,
                duration: track.duration,
                bpm: track.bpm,
                key: track.key,
                genre: track.genre,
                rating: track.rating,
                path: track.path,
                format: track.format,
                cuePoints: {
                    mixIn: track.cuePoints.mixIn,
                    mixOut: track.cuePoints.mixOut,
                    loopCount: track.cuePoints.loopCount ?? 1,
                },
                ...(track.internalTransition
                    ? { internalTransition: { ...track.internalTransition } }
                    : {}),
            })),
        })),
        edges: edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            transition: edge.data?.transition ?? {
                type: 'CUT',
                duration: 0,
            },
        })),
    };
};

/**
 * 驗證並解析匯入的 JSON 字串是否為合法的 WorkflowProjectFile
 */
export const parseWorkflowProjectJson = (
    rawJson: string
): { valid: boolean; project?: WorkflowProjectFile; error?: string } => {
    try {
        const parsed = JSON.parse(rawJson) as Partial<WorkflowProjectFile>;
        if (!parsed || typeof parsed !== 'object') {
            return { valid: false, error: '專案檔格式無效（非 JSON 物件）' };
        }
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
            return {
                valid: false,
                error: '專案檔缺少必要的 nodes 或 edges 陣列結構',
            };
        }

        // 檢查每個節點是否包含有效座標與至少 1 首曲目
        for (const n of parsed.nodes) {
            if (
                !n ||
                typeof n.id !== 'string' ||
                !n.position ||
                typeof n.position.x !== 'number' ||
                typeof n.position.y !== 'number' ||
                !Array.isArray(n.tracks) ||
                n.tracks.length === 0
            ) {
                return {
                    valid: false,
                    error: '專案檔內含無效的節點資料或空曲目卡片',
                };
            }
        }

        // 正規化每條連線的轉場設定
        const normalizedEdges = parsed.edges
            .filter(
                (e) =>
                    e &&
                    typeof e.source === 'string' &&
                    typeof e.target === 'string' &&
                    e.source !== e.target
            )
            .map((e, idx) => {
                const rawTrans = e.transition as TransitionConfig | undefined;
                const validType =
                    rawTrans?.type === 'CROSSFADE' ||
                    rawTrans?.type === 'CUT' ||
                    rawTrans?.type === 'SILENCE'
                        ? rawTrans.type
                        : 'CUT';
                const validDuration =
                    validType === 'CUT'
                        ? 0
                        : typeof rawTrans?.duration === 'number' && rawTrans.duration > 0
                            ? rawTrans.duration
                            : 5.0;

                return {
                    id: e.id || `edge-${e.source}-${e.target}-${idx}`,
                    source: e.source,
                    target: e.target,
                    transition: {
                        type: validType,
                        duration: validDuration,
                    },
                };
            });

        return {
            valid: true,
            project: {
                version: typeof parsed.version === 'string' ? parsed.version : '2.0.0',
                exportedAt:
                    typeof parsed.exportedAt === 'string'
                        ? parsed.exportedAt
                        : new Date().toISOString(),
                ...(parsed.canvasOrientation === 'horizontal' ||
                parsed.canvasOrientation === 'vertical'
                    ? { canvasOrientation: parsed.canvasOrientation }
                    : {}),
                ...(typeof parsed.showCamelotWheel === 'boolean'
                    ? { showCamelotWheel: parsed.showCamelotWheel }
                    : {}),
                ...(typeof parsed.showMiniMap === 'boolean'
                    ? { showMiniMap: parsed.showMiniMap }
                    : {}),
                nodes: parsed.nodes.map((n) => ({
                    ...n,
                    expandedTrackIds: Array.isArray(n.expandedTrackIds)
                        ? n.expandedTrackIds.filter(
                              (id): id is string => typeof id === 'string'
                          )
                        : [],
                    tracks: n.tracks.map((t) => ({
                        ...t,
                        waveform:
                            Array.isArray(t.waveform) && t.waveform.length > 0
                                ? t.waveform
                                : [0.3, 0.6, 0.8, 0.7, 0.5],
                    })),
                })),
                edges: normalizedEdges,
            },
        };
    } catch (err) {
        return {
            valid: false,
            error:
                err instanceof Error
                    ? `JSON 解析錯誤: ${err.message}`
                    : '無法解析 JSON 檔案',
        };
    }
};

/**
 * 將拓撲排序後的 FlatPlayQueueItem[] 轉換為標準擴充 M3U8 歌單內容
 * 內含標準 #EXTINF 以及可供 foobar2000 擴充讀取的 #EXT-FOOBAR-DJ 參數註記
 */
export const buildM3U8Content = (playlist: FlatPlayQueueItem[]): string => {
    const lines: string[] = [
        '#EXTM3U',
        '#EXTENC:UTF-8',
        `#PLAYLIST:foobar2000 DJ Visual Workflow Set (${new Date().toLocaleDateString()})`,
    ];

    for (const item of playlist) {
        const singleSpan = Math.max(
            1,
            item.cuePoints.mixOut - item.cuePoints.mixIn
        );
        const loopCount = Math.max(1, item.cuePoints.loopCount ?? 1);
        const effectiveDuration = Math.round(singleSpan * loopCount);

        lines.push(
            `#EXT-FOOBAR-DJ:order=${item.order},bpm=${item.bpm},key=${item.key},mixIn=${item.cuePoints.mixIn},mixOut=${item.cuePoints.mixOut},loop=${loopCount},transition=${item.transitionToNext.type}:${item.transitionToNext.duration}s`
        );
        lines.push(
            `#EXTINF:${effectiveDuration},${item.artist} - ${item.title}`
        );
        lines.push(item.path);
    }

    return lines.join('\r\n') + '\r\n';
};

/**
 * 在瀏覽器 / WebView2 環境中觸發本地檔案下載（備援方案）
 */
export const triggerBrowserDownload = (
    content: string,
    filename: string,
    mimeType: string
): void => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
};

/**
 * [新增功能 4] 彈出「選擇儲存位置」對話框並儲存匯出檔案 (.json / .m3u8)
 * 1. 優先透過 foobar2000 WebView2 原生 `dialog.saveFile` + `file.write` 彈出系統另存新檔視窗並寫入硬碟
 * 2. 若在現代桌面瀏覽器環境，透過 File System Access API (`window.showSaveFilePicker`) 彈出系統另存新檔視窗
 * 3. 若上述 API 皆不支援，則自動退回 `triggerBrowserDownload` 下載
 */
export const saveExportedFileWithDialog = async (options: {
    title: string;
    defaultFilename: string;
    content: string;
    mimeType: string;
    description: string;
    extension: '.json' | '.m3u8';
}): Promise<{
    saved: boolean;
    canceled?: boolean;
    filePath?: string;
    error?: string;
}> => {
    const extWithoutDot = options.extension.replace(/^\./, '');

    // 1. 優先嘗試 foobar2000 WebView2 原生儲存對話框 (dialog.saveFile + file.write)
    const hostRes = await bridgeApi.saveFileWithDialog({
        title: options.title,
        defaultName: options.defaultFilename,
        content: options.content,
        filters: [
            {
                name: options.description,
                extensions: [extWithoutDot],
            },
        ],
    });

    if (hostRes.handled) {
        return {
            saved: hostRes.saved,
            canceled: hostRes.canceled,
            filePath: hostRes.filePath,
            error: hostRes.error,
        };
    }

    // 2. 次要嘗試標準 File System Access API (window.showSaveFilePicker)
    const winWithPicker = window as Window & {
        showSaveFilePicker?: (pickerOpts?: {
            suggestedName?: string;
            types?: Array<{
                description: string;
                accept: Record<string, string[]>;
            }>;
        }) => Promise<{
            name?: string;
            createWritable: () => Promise<{
                write: (data: string | Blob) => Promise<void>;
                close: () => Promise<void>;
            }>;
        }>;
    };

    if (typeof winWithPicker.showSaveFilePicker === 'function') {
        try {
            const cleanMime = options.mimeType.split(';')[0].trim();
            const handle = await winWithPicker.showSaveFilePicker({
                suggestedName: options.defaultFilename,
                types: [
                    {
                        description: options.description,
                        accept: {
                            [cleanMime]: [options.extension],
                        },
                    },
                ],
            });
            const writable = await handle.createWritable();
            await writable.write(options.content);
            await writable.close();
            return {
                saved: true,
                filePath: handle.name || options.defaultFilename,
            };
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                return { saved: false, canceled: true };
            }
            // 若因 iframe 安全限制無法呼叫 showSaveFilePicker，繼續往下走瀏覽器下載備援
        }
    }

    // 3. 備援：標準瀏覽器 Anchor 下載
    triggerBrowserDownload(
        options.content,
        options.defaultFilename,
        options.mimeType
    );
    return {
        saved: true,
        filePath: options.defaultFilename,
    };
};

