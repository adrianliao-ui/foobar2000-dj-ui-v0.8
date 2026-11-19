import type { TransitionConfig, TransitionType } from '../../types/workflow';

// ============================================================================
// [組件] TransitionSettingsBox：過渡模式與秒數設定面板
// 同時供「卡片內相鄰曲目過渡」與「卡片間外部連線過渡」共用
// ============================================================================
export interface TransitionSettingsBoxProps {
    transition: TransitionConfig;
    disabled?: boolean;
    onChange: (next: TransitionConfig) => void;
    title?: string;
}

export function TransitionSettingsBox({
    transition,
    disabled,
    onChange,
    title,
}: TransitionSettingsBoxProps) {
    return (
        <div
            draggable={false}
            onDragStart={(e) => {
                // 防止在面板內拖動秒數滑桿時觸發外層曲目方塊的排序拖曳
                e.preventDefault();
                e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag nowheel bg-slate-950/90 border border-slate-800 rounded-lg p-2 flex flex-col gap-2"
        >
            {title && (
                <div className="text-[10px] font-semibold text-slate-300">{title}</div>
            )}

            {/* [功能段落] 切換 CROSSFADE / CUT / SILENCE 三種轉場模式按鈕 */}
            <div className="grid grid-cols-3 gap-1">
                {(['CROSSFADE', 'CUT', 'SILENCE'] as TransitionType[]).map((tType) => {
                    const isActive = transition.type === tType;
                    return (
                        <button
                            key={tType}
                            disabled={disabled}
                            onClick={(e) => {
                                e.stopPropagation();
                                onChange({
                                    type: tType,
                                    duration:
                                        tType === 'CUT'
                                            ? 0
                                            : transition.duration > 0
                                                ? transition.duration
                                                : 4,
                                });
                            }}
                            className={`py-1 text-[10px] font-bold rounded border transition cursor-pointer ${isActive
                                    ? 'bg-cyan-600 border-cyan-400 text-white'
                                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                                }`}
                        >
                            {tType}
                        </button>
                    );
                })}
            </div>

            {/* [功能段落] 當模式為 CROSSFADE 或 SILENCE 時，顯示秒數調整滑桿 */}
            {/* [修改功能 1.1：延長 Crossfade 可設置的時間上限至 20 秒，並改為 Fade-Out -> Fade-In 說明] */}
            {transition.type !== 'CUT' && (
                <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between text-[10px]">
                        <span className="text-slate-400">
                            {transition.type === 'CROSSFADE'
                                ? '淡出淡入時間 (Crossfade)'
                                : '留白停頓秒數 (Silence)'}
                        </span>
                        <span className="font-mono text-cyan-300 font-bold">
                            {transition.duration} 秒
                        </span>
                    </div>
                    <input
                        type="range"
                        min={1}
                        max={20}
                        step={0.5}
                        disabled={disabled}
                        draggable={false}
                        onDragStart={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        value={transition.duration}
                        onChange={(e) =>
                            onChange({
                                type: transition.type,
                                duration: Number(e.target.value),
                            })
                        }
                        className="nodrag w-full accent-cyan-400 cursor-pointer"
                    />
                </div>
            )}
        </div>
    );
}
