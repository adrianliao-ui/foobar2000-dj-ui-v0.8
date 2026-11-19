import { useState } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import {
    getThemePresetMeta,
    isM3LayoutTheme,
    useThemeStore,
} from '../../store/useThemeStore';
import { VinylDisc } from './VinylDisc';
import { NowPlayingInfo } from './NowPlayingInfo';
import { VUMeter } from './VUMeter';
import { SpectrumCanvas } from './SpectrumCanvas';
import { formatSmartDuration } from '../../utils/formatTime';

// ============================================================================
// [區塊 4] VisualizerPanel：右側主視覺、獨立專輯封面、曲目資訊、電平頻譜與播放佇列面板 (支援雙分頁切換與向右收折)
// 上方專輯封面 (VinylDisc) 與曲目資訊 (NowPlayingInfo) 保持固定尺寸 (shrink-0)，絕不受 60FPS 視覺化引擎 Canvas 高度調整影響
// ============================================================================
export interface VisualizerPanelProps {
    isCollapsed: boolean;
    onToggleCollapse: () => void;
}

export function VisualizerPanel({
    isCollapsed,
    onToggleCollapse,
}: VisualizerPanelProps) {
    const [activeTab, setActiveTab] = useState<'visualizer' | 'queue'>('visualizer');

    const { currentTrack, isPlaying, seekMasterTimeline } = usePlayerStore();
    const { playlist, totalTimelineDuration } = useWorkflowStore();
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const themeId = useThemeStore((s) => s.themeId);
    const activeThemeMeta = getThemePresetMeta(themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    // [收折狀態] 渲染右側窄型停靠條，釋放空間給中央畫布
    if (isCollapsed) {
        return (
            <div className="dj-surface-panel w-full lg:w-11 shrink-0 bg-slate-900 border border-slate-800 rounded-xl p-2 flex lg:flex-col items-center justify-between gap-3 transition-all duration-200">
                <button
                    onClick={onToggleCollapse}
                    className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-slate-700 flex items-center justify-center text-xs font-bold transition cursor-pointer shrink-0"
                    title="展開右側主視覺與動態監控面板"
                >
                    ◀
                </button>

                <div
                    onClick={onToggleCollapse}
                    className="text-xs font-semibold text-emerald-400 tracking-widest lg:[writing-mode:vertical-rl] cursor-pointer select-none py-2"
                    title="點擊展開主視覺與動態監控"
                >
                    🎛️ 主視覺與動態監控 ({playlist.length})
                </div>

                <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        isPlaying
                            ? 'bg-emerald-400 animate-pulse'
                            : 'bg-slate-600'
                    }`}
                    title={isPlaying ? '播放中' : '待機中'}
                />
            </div>
        );
    }

    // [展開狀態] 完整主視覺與播放佇列雙分頁面板
    return (
        <div
            className={`dj-surface-panel ${activeThemeMeta.layoutSpec.visWidthClass} shrink-0 h-full min-h-0 overflow-hidden bg-slate-900 border border-slate-800 rounded-xl ${
                isM3Style ? 'p-2.5 gap-1.5' : 'p-3 gap-2'
            } flex flex-col transition-all duration-200`}
        >
            {/* 頂部標題與收折按鈕 */}
            <div className="flex items-center justify-between gap-2 shrink-0">
                <h2
                    className={`text-xs font-semibold truncate ${
                        isCafeMica ? 'text-[#366e4b]' : 'text-emerald-400'
                    }`}
                >
                    🎛️ 主視覺與動態監控 (Visualizer & Queue)
                </h2>
                <button
                    onClick={onToggleCollapse}
                    className="px-2 py-0.5 text-[11px] font-semibold bg-slate-800 hover:bg-emerald-600 text-slate-300 hover:text-white border border-slate-700 rounded-md transition cursor-pointer shrink-0"
                    title="向右收折主視覺與動態監控面板以擴大畫布空間"
                >
                    收折 ▶
                </button>
            </div>

            {/* 頂部雙分頁切換標籤：🎨 視覺與監控 / 📜 播放佇列 */}
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg shrink-0">
                <button
                    onClick={() => setActiveTab('visualizer')}
                    className={`py-1.5 px-2 rounded-md text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                        activeTab === 'visualizer'
                            ? 'bg-emerald-600 text-white shadow'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                >
                    <span>🎨 視覺與監控</span>
                </button>
                <button
                    onClick={() => setActiveTab('queue')}
                    className={`py-1.5 px-2 rounded-md text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                        activeTab === 'queue'
                            ? 'bg-emerald-600 text-white shadow'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                >
                    <span>📜 播放佇列</span>
                    <span
                        className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                            activeTab === 'queue'
                                ? 'bg-emerald-800/90 text-emerald-100'
                                : 'bg-slate-800 text-emerald-400'
                        }`}
                    >
                        {playlist.length}
                    </span>
                </button>
            </div>

            {activeTab === 'visualizer' ? (
                <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-0.5">
                    {/* [子區塊 1] 獨立專輯封面 Artwork 區塊 (固定高度 shrink-0，絕不受下方視覺化引擎拖曳影響) */}
                    <div className="shrink-0">
                        <VinylDisc />
                    </div>

                    {/* [子區塊 2] 當前播放曲目資訊、旋轉小 CD、BPM/Key、檔案格式與取樣率 (固定高度 shrink-0) */}
                    <div className="shrink-0">
                        <NowPlayingInfo />
                    </div>

                    {/* [子區塊 3] 雙聲道 L/R VU Meter 與獨立可拉動高度的 60FPS 視覺化引擎 Canvas */}
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex flex-col gap-2 shrink-0">
                        <div className="shrink-0">
                            <VUMeter />
                        </div>
                        <SpectrumCanvas />
                    </div>
                </div>
            ) : (
                /* [分頁 2] 拓撲排序產出的完整高度 Flat Play Queue */
                <div className="flex flex-col gap-2 flex-1 min-h-0">
                    {/* 頂部迷你當前曲目與佇列總覽資訊條 */}
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex flex-col gap-1.5 shrink-0">
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-slate-300">
                                線性播放佇列 (Flat Play Queue)
                            </span>
                            <span
                                className={`font-mono font-semibold ${
                                    isCafeMica
                                        ? 'text-[#366e4b]'
                                        : 'text-emerald-400'
                                }`}
                            >
                                {playlist.length} 首 • 總長{' '}
                                {formatSmartDuration(
                                    totalTimelineDuration,
                                    'int'
                                )}
                            </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80 text-[11px]">
                            <div className="flex items-center gap-1.5 min-w-0">
                                <span
                                    className={`w-2 h-2 rounded-full shrink-0 ${
                                        isPlaying
                                            ? 'bg-emerald-400 animate-pulse'
                                            : 'bg-slate-600'
                                    }`}
                                />
                                <span className="text-slate-400 shrink-0">當前：</span>
                                <span
                                    className={`font-semibold truncate ${
                                        isCafeMica
                                            ? 'text-[#7a3e18]'
                                            : 'text-cyan-300'
                                    }`}
                                >
                                    {currentTrack ? currentTrack.title : '尚未載入曲目'}
                                </span>
                            </div>
                            {currentTrack && (
                                <span className="font-mono text-[10px] text-slate-400 shrink-0">
                                    {currentTrack.bpm} BPM • {currentTrack.key}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* 完整展開的播放佇列滾動區 */}
                    <div className="flex flex-col gap-1.5 overflow-auto flex-1 min-h-0 pr-1">
                        {playlist.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl p-6 text-center">
                                畫布尚無排程曲目，請從左側媒體庫拖曳專輯或單曲至工作流畫布
                            </div>
                        ) : (
                            playlist.map((item) => {
                                const isPlayingThis = currentTrack?.id === item.trackId;
                                const isSelectedInLib = usePlaylistStore
                                    .getState()
                                    .selectedTrackIds.includes(item.trackId);
                                const loops = item.cuePoints.loopCount ?? 1;
                                return (
                                    <div
                                        key={`${item.order}-${item.trackId}`}
                                        onClick={() =>
                                            seekMasterTimeline(
                                                item.timelineStartSec,
                                                playlist,
                                                allTracks
                                            )
                                        }
                                        className={`p-2.5 ${
                                            isM3Style ? 'rounded-xl' : 'rounded-lg'
                                        } border flex items-center justify-between gap-2 cursor-pointer transition ${
                                            isCafeMica
                                                ? isPlayingThis
                                                    ? 'bg-[#d9efe0]/95 border-[#4e8763] ring-1 ring-[#4e8763]/45 shadow-sm'
                                                    : isSelectedInLib
                                                      ? 'bg-[#f4dec8]/95 border-[#c87d4b]'
                                                      : 'bg-[#fffaf4]/85 border-[#c49874]/30 hover:bg-[#f6eadc] hover:border-[#c87d4b]/55'
                                                : isM3Style
                                                  ? isPlayingThis
                                                      ? 'bg-[#143534] border-[#4db6ac] ring-1 ring-[#4db6ac]/45 shadow-sm'
                                                      : isSelectedInLib
                                                        ? 'bg-[#1e3252] border-[#8ab4f8]'
                                                        : 'bg-[#131722] border-[#a8c7fa]/12 hover:bg-[#1d2332] hover:border-[#a8c7fa]/30'
                                                  : isPlayingThis
                                                    ? 'bg-emerald-950/60 border-emerald-500/80 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                                                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2.5 min-w-0">
                                            <span
                                                className={`w-5 h-5 rounded-full text-[10px] font-mono font-bold flex items-center justify-center shrink-0 ${
                                                    isPlayingThis
                                                        ? isCafeMica
                                                            ? 'bg-[#4e8763] text-white'
                                                            : isM3Style
                                                              ? 'bg-[#4db6ac] text-[#041f1e]'
                                                              : 'bg-emerald-500 text-slate-950'
                                                        : isCafeMica
                                                          ? 'bg-[#e8d6c4] text-[#463227]'
                                                          : 'bg-slate-800 text-slate-300'
                                                }`}
                                            >
                                                {item.order}
                                            </span>
                                            <div className="min-w-0 leading-tight">
                                                <div
                                                    className={`text-xs font-semibold truncate ${
                                                        isPlayingThis
                                                            ? isCafeMica
                                                                ? 'text-[#163824]'
                                                                : 'text-[#a7f3d0]'
                                                            : 'text-slate-200'
                                                    }`}
                                                >
                                                    {item.title}{' '}
                                                    {loops > 1 && (
                                                        <span
                                                            className={`font-mono text-[10px] ${
                                                                isCafeMica
                                                                    ? 'text-[#8c461c]'
                                                                    : 'text-amber-300'
                                                            }`}
                                                        >
                                                            (Loop x{loops})
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                                                    {formatSmartDuration(
                                                        item.timelineStartSec,
                                                        'auto'
                                                    )}{' '}
                                                    ~{' '}
                                                    {formatSmartDuration(
                                                        item.timelineEndSec,
                                                        'auto'
                                                    )}{' '}
                                                    •{' '}
                                                    <span
                                                        className={
                                                            isCafeMica
                                                                ? 'text-[#a85d2e]'
                                                                : isM3Style
                                                                  ? 'text-[#8ab4f8]'
                                                                  : 'text-cyan-400'
                                                        }
                                                    >
                                                        {item.transitionToNext.type} (
                                                        {item.transitionToNext.duration}s)
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        {isPlayingThis && (
                                            <span
                                                className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold shrink-0 ${
                                                    isCafeMica
                                                        ? 'bg-[#4e8763]/20 border border-[#4e8763]/50 text-[#1b4a2e]'
                                                        : isM3Style
                                                          ? 'bg-[#4db6ac]/25 border border-[#4db6ac]/50 text-[#80cbc4]'
                                                          : 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                                                }`}
                                            >
                                                ACTIVE
                                            </span>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

