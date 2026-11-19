import type { Track } from './track';

/**
 * 右側主視覺面板的視覺化特效模式 (規格書 2.3)
 * - spectrum: 64/128 軌柱狀/波浪頻譜分析儀
 * - oscilloscope: 向量波形示波器
 * - particles: 星空粒子流特效
 */
export type VisualizerMode = 'spectrum' | 'oscilloscope' | 'particles';

/**
 * 雙聲道立體聲 VU Meter 電平數據 (規格書 2.3)
 * 精準對應左聲道 (L) 與右聲道 (R) 的瞬間峰值 (Peak) 與均方根值 (RMS)，範圍 0.0 ~ 1.0
 */
export interface StereoVULevels {
    leftPeak: number;
    leftRms: number;
    rightPeak: number;
    rightRms: number;
}

/**
 * Master 全局時間軸點擊/拖曳 Seek 的定位轉換結果 (規格書 5.2 Instant Scrubbing)
 * 將全局時間軸秒數換算為具體的「目標曲目 ID」與「單曲內部偏移秒數」
 */
export interface TimelineSeekTarget {
    trackId: string;            // 目標曲目 ID
    queueOrder: number;         // 在 Flat Play Queue 中的順序編號
    trackOffsetSeconds: number; // 該曲目內部的實際播放秒數 (供 Bridge 微秒級 Seek)
    globalTimeSeconds: number;  // 對應的 Master 總時間軸秒數
    isInSilenceGap?: boolean;   // 是否正處於兩首曲目之間的 Silence 靜音過渡區間
    crossfadeGain?: number;     // Crossfade 過渡期間的相對音量增益 (0.0 ~ 1.0，預設 1.0)
    transitionLabel?: string;   // 當前過渡區間的動態提示文字
}

/**
 * 宿主連線與視窗狀態 (規格書 2.1)
 */
export interface HostStatus {
    isConnectedToBridge: boolean; // 是否運行於 foo_ui_webview2 C++ 宿主環境
    audioDevice: string;          // 當前音訊輸出裝置名稱
    isAlwaysOnTop: boolean;       // 視窗是否置頂
}

/**
 * 全局播放器狀態介面 (對應 usePlayerStore)
 */
export interface PlayerState {
    currentTrack: Track | null;      // 當前顯示於主視覺與動態監控的曲目
    currentQueueOrder: number;       // Master 總時間軸當前曲目在 Flat Play Queue 中的順序 (1-based)
    isPlaying: boolean;              // Master 總時間軸是否正在播放（與媒體庫試聽完全獨立）
    isPreviewPlaying: boolean;       // 智慧媒體庫單曲「試聽」是否正在播放（與總時間軸完全獨立）
    previewTrackId: string | null;   // 當前正在媒體庫試聽中的曲目 ID
    previewTrack: Track | null;      // 當前正在媒體庫試聽中的曲目物件
    previewTimeSeconds: number;      // 當前媒體庫試聽曲目的已播放秒數
    volume: number;                  // 主音量 (0.0 ~ 1.0)
    isMuted: boolean;                // 是否靜音
    trackTimeSeconds: number;        // 當前單曲內部播放進度（秒）
    masterTimeSeconds: number;       // 底部 Master 總時間軸全局播放進度（秒）
    masterTotalDuration: number;     // Master 總時間軸的完整 DJ Set 總時長（秒）
    isTimelineLoopEnabled: boolean;  // 是否開啟整條 Master 總時間軸循環播放
    isLiveLocked: boolean;           // 演出鎖定模式 (Performance Mode，鎖定畫布編輯防止誤觸)
    activeCueLabel: string | null;   // 當前觸發中的 Cue 點狀態標籤 (例如 "Mix-In", "Hot Loop", "Crossfading")
    visualizerMode: VisualizerMode;  // 當前選擇的視覺化模式
    vuLevels: StereoVULevels;        // L/R 雙聲道 VU Meter 即時電平
    spectrumBins: number[];          // 64 或 128 軌頻譜分析數據 (0.0 ~ 1.0)
    dominantColor: string;           // 從當前專輯封面萃取的主色調 (供右側霓虹漸層背景使用)
    hostStatus: HostStatus;          // C++ Bridge 連線與音訊裝置狀態
}