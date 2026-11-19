import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath,
    type Edge,
    type EdgeProps,
} from '@xyflow/react';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';
import type { TransitionEdgeData } from '../../types/workflow';

// ============================================================================
// [組件] TransitionEdgeComponent：自訂過渡連線組件 (規格書 4.2, 4.3 & 7.1)
// 渲染漸層寬帶 (Crossfade)、虛線 (Silence) 或實線 (Cut)，並於連線上提供互動式樂理與轉場標籤
// ============================================================================
export function TransitionEdgeComponent({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    style,
    markerEnd,
}: EdgeProps<Edge<TransitionEdgeData>>) {
    const activeEdgeId = useWorkflowStore((s) => s.activeEdgeId);
    const setActiveEdgeId = useWorkflowStore((s) => s.setActiveEdgeId);
    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });

    const transition = data?.transition ?? {
        type: 'CROSSFADE',
        duration: 5.0,
    };
    const analysis = data?.analysis;
    const isSelected = activeEdgeId === id;

    const strokeColor = analysis?.suggestedEdgeColor ?? '#06b6d4';
    const strokeWidth =
        transition.type === 'CROSSFADE' ? 3.8 : transition.type === 'CUT' ? 2.4 : 2.2;
    const strokeDasharray =
        transition.type === 'SILENCE' ? '6 4' : undefined;

    const transBadgeText =
        transition.type === 'CROSSFADE'
            ? `Crossfade ${transition.duration}s`
            : transition.type === 'SILENCE'
                ? `Silence ${transition.duration}s`
                : 'Cut 0s';

    // 造成原錯誤的原因：EdgeLabelRenderer 轉場標籤脫離 .dj-surface-panel 選擇器範圍，導致在北歐燕麥奶淺色主題下維持 bg-slate-950/90 深黑底色且深色字體難以辨識。
    // 本次修改的目的：直接依 isCafeMica / isM3Style 切換為 rounded-full 膠囊外框與柔霧杏仁白底色，提升淺色畫布上的閱讀清晰度。
    return (
        <>
            {/* 若為 CROSSFADE 或選中狀態，繪製底層霓虹光暈 */}
            {(transition.type === 'CROSSFADE' || isSelected) && (
                <path
                    d={edgePath}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={isSelected ? 10 : 7}
                    strokeOpacity={isSelected ? 0.35 : 0.18}
                    className="pointer-events-none"
                />
            )}

            <BaseEdge
                id={id}
                path={edgePath}
                markerEnd={markerEnd}
                interactionWidth={28}
                style={{
                    ...style,
                    stroke: strokeColor,
                    strokeWidth,
                    ...(strokeDasharray ? { strokeDasharray } : {}),
                }}
            />

            {/* 連線中央的互動式樂理與轉場資訊膠囊 */}
            <EdgeLabelRenderer>
                <div
                    style={{
                        position: 'absolute',
                        transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                        pointerEvents: 'all',
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setActiveEdgeId(id);
                    }}
                    className={`nodrag nopan ${
                        isM3Style ? 'px-2.5 py-0.5 rounded-full' : 'px-2 py-0.5 rounded-md'
                    } border text-[10px] font-mono flex items-center gap-1.5 shadow-lg cursor-pointer transition ${
                        isSelected
                            ? isCafeMica
                                ? 'bg-[#f4dec8] border-[#c87d4b] text-[#2b1e17] ring-2 ring-[#c87d4b]/40 scale-105'
                                : 'bg-slate-900 border-cyan-400 text-white ring-2 ring-cyan-500/40 scale-105'
                            : isCafeMica
                              ? 'bg-[#fffaf4]/95 border-[#c49874]/65 text-[#2b1e17] hover:border-[#c87d4b]'
                              : 'bg-slate-950/90 border-slate-700/90 text-slate-200 hover:border-cyan-400'
                    }`}
                    title="點擊開啟此連線的過渡模式與秒數設定"
                >
                    <span
                        style={{ backgroundColor: strokeColor }}
                        className="w-2 h-2 rounded-full shrink-0"
                    />
                    <span
                        className={`font-semibold ${
                            isCafeMica ? 'text-[#8c461c]' : 'text-cyan-300'
                        }`}
                    >
                        {transBadgeText}
                    </span>
                    {analysis && (
                        <>
                            <span
                                className={
                                    isCafeMica ? 'text-[#9c8270]' : 'text-slate-600'
                                }
                            >
                                •
                            </span>
                            <span
                                className={`font-bold ${
                                    isCafeMica ? 'text-[#2b1e17]' : 'text-slate-100'
                                }`}
                            >
                                {analysis.score}分
                            </span>
                            <span
                                className={
                                    isCafeMica ? 'text-[#6e4f3d]' : 'text-slate-400'
                                }
                            >
                                ({analysis.suggestedPitchText})
                            </span>
                        </>
                    )}
                </div>
            </EdgeLabelRenderer>
        </>
    );
}
