import { useEffect, useState } from 'react';
import type React from 'react';
import { bridgeApi, isFoobarWebView } from '../../api/mockBridge';
import { usePlayerStore } from '../../store/usePlayerStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';
import { WindowControls } from './WindowControls';
import { LiveLockToggle } from './LiveLockToggle';
import { PresetManager } from './PresetManager';
import { HostBridgeModal } from './HostBridgeModal';
import { ThemePreferencesMenu } from './ThemePreferencesMenu';

export const WINDOW_POSITION_STORAGE_KEY = 'foobar_dj_window_pos_v1';

// ============================================================================
// [區塊 1] HeaderBar：頂端控制與歌單管理列 (規格書 2.1 & 方向 A)
// 整合宿主連線狀態（點擊開啟 WebView2 橋接與安裝指南）、PresetManager、視窗置頂、主題偏好齒輪、Live Lock 與按住空白處拖移原生視窗並持久化座標
// ============================================================================
export function HeaderBar() {
    const hostStatus = usePlayerStore((s) => s.hostStatus);
    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';
    const [isBridgeModalOpen, setIsBridgeModalOpen] = useState(false);

    // 啟動時若處於 foobar2000 原生視窗環境且有已保存的視窗位置，自動還原視窗座標
    useEffect(() => {
        if (!isFoobarWebView()) return;
        try {
            const raw = localStorage.getItem(WINDOW_POSITION_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { x?: number; y?: number };
            if (
                parsed &&
                typeof parsed.x === 'number' &&
                typeof parsed.y === 'number' &&
                Number.isFinite(parsed.x) &&
                Number.isFinite(parsed.y)
            ) {
                bridgeApi.setWindowPosition(parsed.x, parsed.y);
            }
        } catch {
            // ignore storage errors
        }
    }, []);

    const persistNativeWindowBounds = () => {
        if (!isFoobarWebView()) return;
        void bridgeApi.getWindowBounds().then((bounds) => {
            if (!bounds) return;
            // 排除最小化至工作列外 (-32000) 的異常系統停車座標
            if (bounds.x <= -10000 || bounds.y <= -10000) return;
            try {
                localStorage.setItem(
                    WINDOW_POSITION_STORAGE_KEY,
                    JSON.stringify({ x: bounds.x, y: bounds.y })
                );
            } catch {
                // ignore
            }
        });
    };

    // 按住 Header 非按鈕/輸入框區域時觸發原生視窗拖移，並於拖移結束後持久化儲存最新視窗座標
    const handleHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
        if (e.button !== 0 || !isFoobarWebView()) return;
        const target = e.target as HTMLElement | null;
        if (
            target &&
            target.closest(
                'button, input, select, textarea, a, label, [role="button"], .theme-popover-surface'
            )
        ) {
            return;
        }
        bridgeApi.startWindowDrag();
        // window.startDrag 結束系统移動迴圈或放開滑鼠時讀取最新螢幕座標並持久化
        setTimeout(persistNativeWindowBounds, 120);
        const onWindowMouseUp = () => {
            window.removeEventListener('mouseup', onWindowMouseUp);
            persistNativeWindowBounds();
        };
        window.addEventListener('mouseup', onWindowMouseUp, { once: true });
    };

    return (
        <>
            <header
                onMouseDown={handleHeaderMouseDown}
                className={`dj-surface-header relative flex flex-wrap items-center justify-between bg-slate-900 border border-slate-800 rounded-xl shadow-lg transition-all duration-200 ${
                    isM3Style ? 'gap-2 px-3.5 py-1.5' : 'gap-3 px-4 py-2.5'
                }`}
            >
                {/* 左側：標題與宿主連線狀態（僅「預覽 / 診斷」膠囊為按鈕，點擊開啟 WebView2 安裝指南與 Bridge 診斷；主標題支援按住拖移原生視窗） */}
                {/* 造成原錯誤的原因：先前將外層容器設為 <button> 包住整個主標題與狀態燈，導致點擊或懸停主標題時誤觸診斷彈窗且阻擋原生視窗拖移。 */}
                {/* 本次修改的目的：將外層改為一般 <div>，僅將「🔌 預覽 / 診斷」膠囊設為獨立 <button>。 */}
                <div className="flex items-center gap-2.5 min-w-0">
                    <div
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            hostStatus.isConnectedToBridge
                                ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                                : 'bg-emerald-500 animate-pulse'
                        }`}
                    />
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <h1
                                className={`${
                                    isM3Style ? 'text-sm' : 'text-base'
                                } font-bold truncate select-none ${
                                    isCafeMica
                                        ? 'text-[#4a2511]'
                                        : 'bg-gradient-to-r from-cyan-400 via-indigo-300 to-yellow-400 bg-clip-text text-transparent'
                                }`}
                            >
                                foobar2000 視覺化 DJ 工作流播放器
                            </h1>
                            <button
                                type="button"
                                onClick={() => setIsBridgeModalOpen(true)}
                                title={
                                    hostStatus.isConnectedToBridge
                                        ? `已連線至 foobar2000 WebView2 宿主 • ${hostStatus.audioDevice} (點擊開啟橋接診斷)`
                                        : `開發預覽模式 • ${hostStatus.audioDevice} (點擊開啟實機掛載教學)`
                                }
                                className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold transition shrink-0 cursor-pointer ${
                                    isCafeMica
                                        ? 'bg-[#c87d4b]/15 border-[#c87d4b]/45 text-[#7a3e18] hover:bg-[#c87d4b]/25'
                                        : 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25'
                                }`}
                            >
                                {isM3Style
                                    ? hostStatus.isConnectedToBridge
                                        ? '🔌 已連線宿主'
                                        : '🔌 預覽 / 診斷'
                                    : '🔌 WebView2 指南 / 診斷'}
                            </button>
                        </div>
                        {/* M3 排版主題下隱藏第二行副標題，將垂直空間完全讓給中央節點畫布 */}
                        {!isM3Style && (
                            <p className="text-[11px] text-slate-400 truncate select-none">
                                {hostStatus.isConnectedToBridge
                                    ? `已連線至 foobar2000 WebView2 宿主 • ${hostStatus.audioDevice}`
                                    : `開發預覽模式 • ${hostStatus.audioDevice} (點擊查看實機掛載教學)`}
                            </p>
                        )}
                    </div>
                </div>

                {/* 右側：專案匯出入管理、Live Lock、偏好設定齒輪與右上角視窗控制項 */}
                <div className="flex flex-wrap items-center gap-1.5">
                    <PresetManager />

                    <div className="h-4 w-px bg-slate-800 mx-0.5 hidden sm:block" />

                    <LiveLockToggle />

                    {/* [新增功能] 偏好設定齒輪按鈕與浮動式面板設計主題選擇器（不推擠 Header） */}
                    <ThemePreferencesMenu />

                    <div className="h-4 w-px bg-slate-800 mx-0.5 hidden sm:block" />

                    <WindowControls />
                </div>
            </header>

            <HostBridgeModal
                isOpen={isBridgeModalOpen}
                onClose={() => setIsBridgeModalOpen(false)}
            />
        </>
    );
}


