import { useEffect, useState } from 'react';
import { bridgeApi, isFoobarWebView } from '../../api/mockBridge';

// ============================================================================
// [組件] WindowControls：右上角視窗控制項（最小化、最大化/還原、關閉視窗）
// 透過 NereaFantasia/foo_ui_webview2 的 window.minimize / window.toggleMaximize / window.close 執行
// ============================================================================
export function WindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        if (!isFoobarWebView() || !window.fb2k?.invoke) return;
        void (async () => {
            try {
                const res = (await window.fb2k!.invoke(
                    'window.isMaximized',
                    {}
                )) as { maximized?: boolean };
                if (typeof res?.maximized === 'boolean') {
                    setIsMaximized(res.maximized);
                }
            } catch {
                // 忽略面板模式下查詢例外
            }
        })();
    }, []);

    const handleMinimize = () => {
        bridgeApi.minimizeWindow();
    };

    const handleToggleMaximize = () => {
        bridgeApi.toggleMaximizeWindow();
        setIsMaximized((prev) => !prev);
    };

    const handleClose = () => {
        bridgeApi.closeWindow();
    };

    return (
        <div className="flex items-center gap-1.5">
            <button
                type="button"
                onClick={handleMinimize}
                className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 flex items-center justify-center text-xs font-bold transition cursor-pointer"
                title="最小化視窗 (window.minimize)"
                aria-label="最小化視窗"
            >
                ─
            </button>

            <button
                type="button"
                onClick={handleToggleMaximize}
                className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-cyan-600/80 text-slate-300 hover:text-white border border-slate-700 hover:border-cyan-500 flex items-center justify-center text-xs font-bold transition cursor-pointer"
                title={
                    isMaximized
                        ? '還原視窗大小 (window.toggleMaximize)'
                        : '最大化視窗 (window.toggleMaximize)'
                }
                aria-label={isMaximized ? '還原視窗' : '最大化視窗'}
            >
                {isMaximized ? '❐' : '□'}
            </button>

            <button
                type="button"
                onClick={handleClose}
                className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-white border border-slate-700 hover:border-rose-500 flex items-center justify-center text-xs font-bold transition cursor-pointer"
                title="關閉視窗 (window.close)"
                aria-label="關閉視窗"
            >
                ✕
            </button>
        </div>
    );
}
