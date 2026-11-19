import { useEffect, useRef, useState } from 'react';
import { Settings, Check, Sparkles, Globe } from 'lucide-react';
import {
    LANGUAGE_OPTIONS,
    THEME_PRESETS,
    useThemeStore,
    type LanguageId,
    type ThemeId,
} from '../../store/useThemeStore';

// ============================================================================
// [組件] ThemePreferencesMenu：Header 偏好齒輪按鈕與浮動式主題及多國語言選擇視窗
// 採用外層 relative + 浮層 absolute top-full right-0 mt-2 z-50 懸浮定位，
// 確保彈出時 100% 不會推擠 Header 高度或影響下方畫布排版。
// ============================================================================
export function ThemePreferencesMenu() {
    const [isOpen, setIsOpen] = useState(false);
    const [confirmClearCache, setConfirmClearCache] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const themeId = useThemeStore((s) => s.themeId);
    const setThemeId = useThemeStore((s) => s.setThemeId);
    const language = useThemeStore((s) => s.language);
    const setLanguage = useThemeStore((s) => s.setLanguage);

    // [新增功能 4] 一鍵清除 localStorage 暫存資料（保留當前的「主題配色與語言設定」，其餘快取全部清空並重整頁面）
    const handleClearLocalStorageCache = () => {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                const currentTheme = themeId;
                const currentLang = language;
                window.localStorage.clear();
                window.localStorage.setItem('foobar_dj_theme_v1', currentTheme);
                window.localStorage.setItem('foobar_dj_lang_v1', currentLang);
            }
        } catch {
            // ignore storage errors
        }
        if (typeof window !== 'undefined') {
            window.location.reload();
        }
    };

    // 點擊浮動視窗外部或按下 Escape 時自動關閉浮動面板
    useEffect(() => {
        if (!isOpen) return;

        const handlePointerDownOutside = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDownOutside);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDownOutside);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen]);

    const handleSelectTheme = (nextId: ThemeId) => {
        setThemeId(nextId);
    };

    const activePreset =
        THEME_PRESETS.find((p) => p.id === themeId) ?? THEME_PRESETS[0];
    const isCafeMica = themeId === 'm3-cafe-mica';

    return (
        <div ref={containerRef} className="relative flex items-center">
            {/* Header 偏好齒輪按鈕 (不會推擠 Header) */}
            <button
                type="button"
                onClick={() => setIsOpen((prev) => !prev)}
                className={`h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-xs font-semibold transition cursor-pointer ${
                    isOpen
                        ? 'bg-cyan-600/90 border-cyan-400 text-white shadow-md'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                }`}
                title={`偏好設定：切換面板設計主題（目前：${activePreset.name}）`}
                aria-label="開啟面板設計主題偏好設定"
                aria-expanded={isOpen}
            >
                <Settings
                    className={`w-3.5 h-3.5 transition-transform duration-300 ${
                        isOpen ? 'rotate-90 text-white' : 'text-cyan-300'
                    }`}
                />
                <span className="hidden xl:inline whitespace-nowrap">
                    主題偏好
                </span>
            </button>

            {/* 浮動主題選擇視窗：absolute top-full right-0 z-50 零推擠定位 */}
            {isOpen && (
                <div
                    onClick={(e) => e.stopPropagation()}
                    className="theme-popover-surface absolute top-full right-0 mt-2.5 w-[360px] sm:w-[400px] z-50 bg-slate-900/98 backdrop-blur-xl border border-slate-700/90 rounded-2xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.85)] flex flex-col gap-3 select-none"
                >
                    {/* 浮動視窗頂部標題列 */}
                    <div
                        className={`flex items-start justify-between gap-2 pb-2.5 border-b ${
                            isCafeMica
                                ? 'border-[#c49874]/35'
                                : 'border-slate-800'
                        }`}
                    >
                        <div className="flex items-center gap-2">
                            <div
                                className={`w-7 h-7 rounded-xl border flex items-center justify-center shrink-0 ${
                                    isCafeMica
                                        ? 'bg-[#f4dec8] border-[#c87d4b]/45 text-[#8c461c]'
                                        : 'bg-cyan-500/15 border-cyan-400/30 text-cyan-300'
                                }`}
                            >
                                <Sparkles className="w-4 h-4" />
                            </div>
                            <div>
                                <h3 className="text-xs font-bold text-slate-100">
                                    面板設計主題方案 (UI Theme Presets)
                                </h3>
                                <p className="text-[11px] text-slate-400">
                                    即時套用按鈕樣式、面板圓角排版、側欄寬度與色彩階層
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition cursor-pointer shrink-0 ${
                                isCafeMica
                                    ? 'bg-[#eadbce] hover:bg-[#dec7b4] text-[#463227]'
                                    : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white'
                            }`}
                            title="關閉偏好視窗 (Esc)"
                        >
                            ✕
                        </button>
                    </div>

                    {/* [新增功能] 多國語言切換列 (繁體中文 / 簡體中文 / English) */}
                    <div
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border ${
                            isCafeMica
                                ? 'bg-[#f6ece0]/90 border-[#c49874]/40'
                                : 'bg-slate-950/80 border-slate-800'
                        }`}
                    >
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200 shrink-0">
                            <Globe
                                className={`w-3.5 h-3.5 ${
                                    isCafeMica
                                        ? 'text-[#8c461c]'
                                        : 'text-cyan-300'
                                }`}
                            />
                            <span>介面語言 (Language)</span>
                        </div>
                        <div
                            data-no-i18n="true"
                            className="flex items-center gap-1"
                        >
                            {LANGUAGE_OPTIONS.map((opt: { id: LanguageId; label: string }) => {
                                const isActiveLang = language === opt.id;
                                return (
                                    <button
                                        key={opt.id}
                                        type="button"
                                        onClick={() => setLanguage(opt.id)}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${
                                            isActiveLang
                                                ? isCafeMica
                                                    ? 'bg-[#c87d4b] border-[#b56b3a] text-white shadow-sm'
                                                    : 'bg-cyan-500 border-cyan-400 text-slate-950 shadow-sm'
                                                : isCafeMica
                                                  ? 'bg-[#fffaf4] border-[#c49874]/40 text-[#463227] hover:bg-[#efe2d3]'
                                                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 主題方案清單 */}
                    <div className="flex flex-col gap-2.5 max-h-[68vh] overflow-y-auto pr-0.5">
                        {THEME_PRESETS.map((preset) => {
                            const isSelected = preset.id === themeId;
                            return (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => handleSelectTheme(preset.id)}
                                    className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer flex flex-col gap-2 ${
                                        isSelected
                                            ? isCafeMica
                                                ? 'bg-[#f4dec8]/95 border-[#c87d4b] ring-1 ring-[#c87d4b]/45 shadow-md'
                                                : 'bg-cyan-950/45 border-cyan-400/90 ring-1 ring-cyan-400/40 shadow-lg'
                                            : isCafeMica
                                              ? 'bg-[#fffaf4]/90 border-[#c49874]/35 hover:border-[#c87d4b]/65 hover:bg-[#f6eadc]'
                                              : 'bg-slate-950/75 border-slate-800 hover:border-slate-600 hover:bg-slate-900/90'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {/* [修正問題 3：主題選單內各方案的名稱序號標籤在淺色主題下同步改為焦糖/烤杏仁淺色膠囊] */}
                                            <span
                                                className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold shrink-0 ${
                                                    isSelected
                                                        ? isCafeMica
                                                            ? 'bg-[#c87d4b] text-white'
                                                            : 'bg-cyan-400 text-slate-950'
                                                        : isCafeMica
                                                          ? 'bg-[#eadbce] text-[#463227] border border-[#c49874]/40'
                                                          : 'bg-slate-800 text-slate-300'
                                                }`}
                                            >
                                                {preset.orderLabel}
                                            </span>
                                            <span className="text-xs font-bold text-slate-100 truncate">
                                                {preset.name}
                                            </span>
                                        </div>

                                        {/* 色票預覽圓點與勾選狀態 */}
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            <div className="flex items-center -space-x-1">
                                                {preset.swatches.map(
                                                    (hex, idx) => (
                                                        <span
                                                            key={idx}
                                                            style={{
                                                                backgroundColor:
                                                                    hex,
                                                            }}
                                                            className={`w-3.5 h-3.5 rounded-full border shadow-sm ${
                                                                isCafeMica
                                                                    ? 'border-[#8c6244]/40'
                                                                    : 'border-white/25'
                                                            }`}
                                                        />
                                                    )
                                                )}
                                            </div>
                                            {isSelected && (
                                                <span
                                                    className={`w-5 h-5 rounded-full flex items-center justify-center shadow ${
                                                        isCafeMica
                                                            ? 'bg-[#4e8763] text-white'
                                                            : 'bg-emerald-500 text-slate-950'
                                                    }`}
                                                >
                                                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="text-[11px] font-medium text-cyan-300/90">
                                        {preset.subtitle}
                                    </div>

                                    <p className="text-[11px] text-slate-400 leading-relaxed">
                                        {preset.description}
                                    </p>

                                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                        {preset.badges.map((badge) => (
                                            <span
                                                key={badge}
                                                className={`px-2.5 py-0.5 rounded-full border text-[10px] ${
                                                    isCafeMica
                                                        ? 'bg-[#f5ebe0] border-[#c49874]/45 text-[#463227]'
                                                        : 'bg-slate-900/90 border-slate-700/80 text-slate-300'
                                                }`}
                                            >
                                                {badge}
                                            </span>
                                        ))}
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* [新增功能 4] 一鍵清除 localStorage 暫存資料（保留當前主題與語言設定並重整） */}
                    <div
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border ${
                            isCafeMica
                                ? 'bg-[#f6ece0]/90 border-[#c49874]/40'
                                : 'bg-slate-950/80 border-slate-800'
                        }`}
                    >
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-slate-200 truncate">
                                🧹 清除本地暫存資料
                            </div>
                            <div className="text-[10px] text-slate-400 truncate">
                                清空舊版畫布、曲目與分析暫存（保留當前主題與語言設定）
                            </div>
                        </div>
                        {!confirmClearCache ? (
                            <button
                                type="button"
                                onClick={() => setConfirmClearCache(true)}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer shrink-0 ${
                                    isCafeMica
                                        ? 'bg-[#fffaf4] hover:bg-rose-100 border-[#c49874]/50 hover:border-rose-400 text-rose-700'
                                        : 'bg-slate-900 hover:bg-rose-950/80 border-slate-700 hover:border-rose-600/80 text-rose-300'
                                }`}
                                title="清空舊版代碼產生的 localStorage 暫存資料並重新載入"
                            >
                                🧹 清除暫存
                            </button>
                        ) : (
                            <div className="flex items-center gap-1 shrink-0">
                                <button
                                    type="button"
                                    onClick={handleClearLocalStorageCache}
                                    className="px-2 py-1 rounded-lg text-[11px] font-bold bg-rose-600 hover:bg-rose-500 text-white border border-rose-400 transition cursor-pointer"
                                    title="⚠️ 確定清空並重整？"
                                >
                                    確定清除
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmClearCache(false)}
                                    className={`px-2 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${
                                        isCafeMica
                                            ? 'bg-[#eadbce] hover:bg-[#dec7b4] border-[#c49874]/45 text-[#463227]'
                                            : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                                    }`}
                                >
                                    取消
                                </button>
                            </div>
                        )}
                    </div>

                    {/* 底部持久化狀態說明 */}
                    <div
                        className={`flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t ${
                            isCafeMica
                                ? 'border-[#c49874]/35'
                                : 'border-slate-800/80'
                        }`}
                    >
                        <span>✨ 選擇後立即套用並自動記憶於本機</span>
                        <span className="font-mono text-cyan-300">
                            Active: {activePreset.id}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
