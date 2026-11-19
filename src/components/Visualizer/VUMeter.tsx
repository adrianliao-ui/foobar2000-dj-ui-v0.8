import { usePlayerStore } from '../../store/usePlayerStore';

// ============================================================================
// [組件] VUMeter：雙聲道立體聲 L/R Peak & RMS 音量電平計 (規格書 2.3 & Phase 7)
// 同時顯示均方根值 (RMS 實心漸層條) 與瞬間峰值 (Peak 亮白游標與百分比讀數)
// ============================================================================
export function VUMeter() {
    const vuLevels = usePlayerStore((s) => s.vuLevels);

    const leftPeakPct = Math.min(100, Math.round(vuLevels.leftPeak * 100));
    const leftRmsPct = Math.min(100, Math.round(vuLevels.leftRms * 100));
    const rightPeakPct = Math.min(100, Math.round(vuLevels.rightPeak * 100));
    const rightRmsPct = Math.min(100, Math.round(vuLevels.rightRms * 100));

    return (
        <div className="flex flex-col gap-1.5">
            {/* 左聲道 (L) RMS + Peak */}
            <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className="w-3 text-slate-400 font-bold">L</span>
                <div className="flex-1 h-2.5 bg-slate-900 rounded overflow-hidden relative border border-slate-800/80">
                    {/* 背景 Peak 半透明帶 */}
                    <div
                        style={{ width: `${leftPeakPct}%` }}
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500/35 via-yellow-400/35 to-rose-500/45 transition-all duration-75"
                    />
                    {/* 前景 RMS 實心能量條 */}
                    <div
                        style={{ width: `${leftRmsPct}%` }}
                        className="h-full bg-gradient-to-r from-emerald-500 via-yellow-400 to-rose-500 transition-all duration-75"
                    />
                    {/* Peak 瞬間峰值游標線 */}
                    {leftPeakPct > 2 && (
                        <div
                            style={{ left: `${Math.min(99, leftPeakPct)}%` }}
                            className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_4px_#fff]"
                        />
                    )}
                </div>
                <span className="w-8 text-right text-[9px] text-slate-400">
                    {leftPeakPct}%
                </span>
            </div>

            {/* 右聲道 (R) RMS + Peak */}
            <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className="w-3 text-slate-400 font-bold">R</span>
                <div className="flex-1 h-2.5 bg-slate-900 rounded overflow-hidden relative border border-slate-800/80">
                    {/* 背景 Peak 半透明帶 */}
                    <div
                        style={{ width: `${rightPeakPct}%` }}
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500/35 via-yellow-400/35 to-rose-500/45 transition-all duration-75"
                    />
                    {/* 前景 RMS 實心能量條 */}
                    <div
                        style={{ width: `${rightRmsPct}%` }}
                        className="h-full bg-gradient-to-r from-emerald-500 via-yellow-400 to-rose-500 transition-all duration-75"
                    />
                    {/* Peak 瞬間峰值游標線 */}
                    {rightPeakPct > 2 && (
                        <div
                            style={{ left: `${Math.min(99, rightPeakPct)}%` }}
                            className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_4px_#fff]"
                        />
                    )}
                </div>
                <span className="w-8 text-right text-[9px] text-slate-400">
                    {rightPeakPct}%
                </span>
            </div>
        </div>
    );
}
