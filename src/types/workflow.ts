import type { AlbumGroup, CuePoints, Track } from './track';

/**
 * 節點連線轉場類型 (規格書 4.2 & 6.1)
 * - CROSSFADE: 交叉淡入淡出 (可設定 overlap 秒數，例如 2s ~ 10s)
 * - CUT: 硬切無縫接軌 (0 秒交疊)
 * - SILENCE: 留白靜音停頓 (可設定停頓秒數，例如 1s ~ 5s)
 */
export type TransitionType = 'CROSSFADE' | 'CUT' | 'SILENCE';

/**
 * 轉場控制屬性設定
 */
export interface TransitionConfig {
    type: TransitionType;
    duration: number; // 秒數 (CUT 固定為 0)
}

/**
 * 樂理與拍速檢測三級警示狀態 (規格書 4.3)
 * - harmonic: 諧和 (綠色連線)
 * - noticeable: 強行相銜 (黃色連線，提示建議 Pitch 調整幅度)
 * - clash: 不協調/撞調 (紅色警示連線)
 */
export type HarmonicStatus = 'harmonic' | 'noticeable' | 'clash';

/**
 * 兩張卡片之間的樂理與拍速評估結果
 */
export interface TransitionAnalysis {
    score: number;              // 綜合契合度分數 (0 ~ 100)
    status: HarmonicStatus;     // 三級警示狀態
    keyRelationMessage: string; // 調性關係說明 (例如 "8A → 9A 五度圈相鄰諧波")
    bpmDiff: number;            // BPM 絕對差值
    pitchPercent: number;       // 帶正負號的 Pitch 調整幅度數值 (例如 +1.5 或 -2.1)
    suggestedPitchText: string; // 格式化提示字串 (例如 "Pitch +1.5%")
    suggestedEdgeColor: string; // 連線顏色色碼 (#10b981 綠 / #f59e0b 黃 / #ef4444 紅)
}

/**
 * React Flow 專輯卡片節點的 data 結構 (規格書 3.1)
 * 繼承 Record<string, unknown> 以完全相容 @xyflow/react 的泛型約束
 */
export interface AlbumNodeData extends Record<string, unknown> {
    label: string;              // 節點顯示標題
    albumGroup: AlbumGroup;     // 專輯群組與內部有序曲目清單
    expandedTrackIds: string[]; // 目前在卡片內原地下拉展開 Mini Waveform 的曲目 ID 清單
}

/**
 * React Flow 過渡連線 (TransitionEdge) 的 data 結構 (規格書 4.2 & 4.3)
 */
export interface TransitionEdgeData extends Record<string, unknown> {
    transition: TransitionConfig;  // 轉場類型與秒數設定 (預設 CROSSFADE 5.0s)
    analysis?: TransitionAnalysis; // 樂理與 BPM 碰撞檢測結果
}

/**
 * 線性播放佇列單一項目結構 (規格書 6.1 Flat Play Queue Schema)
 */
export interface FlatPlayQueueItem {
    order: number;                      // 播放順序 (1, 2, 3...)
    trackId: string;                    // 歌曲 ID
    albumId: string;                    // 專輯 ID
    title: string;                      // 曲名
    artist: string;                     // 演出者
    album: string;                      // 專輯名稱
    bpm: number;                        // BPM
    key: string;                        // 調性代碼 (如 "8A")
    duration: number;                   // 單曲原始總長度（秒）
    coverUrl?: string;                  // 專輯封面縮圖
    path: string;                       // 音樂檔案路徑
    format?: string;                    // 音訊格式 (如 "FLAC / 24-bit / 96kHz")
    waveform?: number[];                // 波形數據（供 Master Timeline 渲染）
    cuePoints: CuePoints;               // 雙向同步的 Mix-In / Mix-Out / Hot Loop
    transitionToNext: TransitionConfig; // 往下一首歌的過渡方式
    sourceNodeId: string;               // 來源畫布節點 ID（供 Master 時間軸反查節點）
    timelineStartSec: number;           // 在底部 Master 總時間軸上的起始秒數
    timelineEndSec: number;             // 在底部 Master 總時間軸上的結束秒數
}

/**
 * DJ 工作流專案檔匯出/匯入格式 (.json 專案檔，規格書 2.1)
 */
export interface WorkflowProjectFile {
    version: string;
    exportedAt: string;
    canvasOrientation?: 'horizontal' | 'vertical';
    showCamelotWheel?: boolean;
    showMiniMap?: boolean;
    nodes: Array<{
        id: string;
        position: { x: number; y: number };
        tracks: Track[];
        expandedTrackIds?: string[];
    }>;
    edges: Array<{
        id: string;
        source: string;
        target: string;
        transition: TransitionConfig;
    }>;
}