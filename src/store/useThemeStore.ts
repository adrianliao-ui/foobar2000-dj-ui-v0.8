import { create } from 'zustand';

// ============================================================================
// [主題狀態管理] useThemeStore：管理面板設計主題方案（預設第 1 個方案：Material 3 深色主題）
// 負責持久化至 localStorage ('foobar_dj_theme_v1') 並同步更新 document.documentElement[data-theme]
// ============================================================================
export type ThemeId =
    | 'm3-dark'
    | 'm3-cafe-mica'
    | 'classic-neon'
    | 'amoled-stage';

/**
 * 判斷是否採用 Material 3 的面板排版與畫布最大化設計（包含方案 1 M3 深色 與 方案 2 午後咖啡館 Mica）
 */
export const isM3LayoutTheme = (themeId: ThemeId): boolean =>
    themeId === 'm3-dark' || themeId === 'm3-cafe-mica';

export interface ThemePresetMeta {
    id: ThemeId;
    orderLabel: string;
    name: string;
    subtitle: string;
    description: string;
    swatches: [string, string, string, string];
    badges: string[];
    layoutSpec: {
        appPaddingClass: string;
        workspaceGapClass: string;
        libWidthClass: string;
        visWidthClass: string;
    };
}

export const THEME_PRESETS: ThemePresetMeta[] = [
    {
        id: 'm3-dark',
        orderLabel: '方案 1 • 預設',
        name: 'Material 3 深色主題 (M3 Expressive Dark)',
        subtitle: '畫布視野最大化 • 懸浮毛玻璃工具塢與 M3 Tonal 膠囊控制項',
        description:
            '採用 M3 Dark Surface 階層配色 (#0F131A / #191E29)、單行流線 Header、畫布內嵌懸浮膠囊工具塢、緊湊型側欄與精悍時間軸，將中央節點畫布可視面積最大化。',
        swatches: ['#0F131A', '#191E29', '#8AB4F8', '#80CBC4'],
        badges: ['畫布視野最大化', '懸浮膠囊工具塢', 'M3 Tonal 按鈕'],
        layoutSpec: {
            appPaddingClass: 'p-2 gap-2',
            workspaceGapClass: 'gap-2',
            libWidthClass: 'w-full lg:w-[292px] xl:w-[316px]',
            visWidthClass: 'w-full lg:w-[286px] xl:w-[308px]',
        },
    },
    {
        id: 'm3-cafe-mica',
        orderLabel: '方案 2 • 下午茶淺色雲母',
        name: '北歐晨光 • 燕麥奶雲母 (M3 Nordic Oat Mica)',
        subtitle: 'M3 面板設計 + 淺色燕麥奶 Mica 雲母半透明材質 + Segoe UI Variable 字體',
        description:
            '承襲方案 1 的 M3 畫布最大化排版，以溫暖明亮的北歐晨光燕麥奶 (#F5EFE8)、柔霧杏仁白與焦糖肉桂 (#C87D4B)、鼠尾草抹茶 (#4E8763) 打造輕鬆下午茶氛圍。',
        swatches: ['#F5EFE8', '#FFFDF9', '#C87D4B', '#4E8763'],
        badges: ['燕麥奶淺色雲母', 'Segoe UI Variable', '焦糖肉桂 & 鼠尾草綠'],
        layoutSpec: {
            appPaddingClass: 'p-2 gap-2',
            workspaceGapClass: 'gap-2',
            libWidthClass: 'w-full lg:w-[292px] xl:w-[316px]',
            visWidthClass: 'w-full lg:w-[286px] xl:w-[308px]',
        },
    },
    {
        id: 'classic-neon',
        orderLabel: '方案 3',
        name: '經典暗黑霓虹 (Classic Slate Neon)',
        subtitle: '原始 Slate-950 專業 DJ 控台與高彩度霓虹邊框',
        description:
            '保留專案原生的深灰藍底色 (#020617 / #0F172A)、Cyan/Emerald 霓虹發光強調邊框、標準 12px 圓角與原始面板尺寸比例。',
        swatches: ['#020617', '#0F172A', '#22D3EE', '#10B981'],
        badges: ['經典霓虹邊框', '12px 標準圓角', '原始標準排版'],
        layoutSpec: {
            appPaddingClass: 'p-3 gap-2.5',
            workspaceGapClass: 'gap-2.5',
            libWidthClass: 'w-full lg:w-[320px] xl:w-[350px]',
            visWidthClass: 'w-full lg:w-[310px] xl:w-[340px]',
        },
    },
    {
        id: 'amoled-stage',
        orderLabel: '方案 4',
        name: '純黑舞台高對比 (AMOLED Stage Black)',
        subtitle: '專為低光源 Live 演出打造的零眩光純黑緊湊面板',
        description:
            '採用 #040507 純黑背景降低舞台眩光，搭配暖琥珀與冰青高對比邊框，並微幅收窄左右側欄以最大化中央工作流畫布空間。',
        swatches: ['#040507', '#0C0E14', '#F59E0B', '#38BDF8'],
        badges: ['純黑零眩光', '緊湊俐落按鈕', '畫布最大化排版'],
        layoutSpec: {
            appPaddingClass: 'p-2.5 gap-2',
            workspaceGapClass: 'gap-2',
            libWidthClass: 'w-full lg:w-[300px] xl:w-[328px]',
            visWidthClass: 'w-full lg:w-[296px] xl:w-[320px]',
        },
    },
];

const THEME_STORAGE_KEY = 'foobar_dj_theme_v1';
const LANGUAGE_STORAGE_KEY = 'foobar_dj_lang_v1';

export type LanguageId = 'zh-TW' | 'zh-CN' | 'en';

export const LANGUAGE_OPTIONS: ReadonlyArray<{
    id: LanguageId;
    label: string;
    shortLabel: string;
}> = [
    { id: 'zh-TW', label: '繁體中文', shortLabel: '繁中' },
    { id: 'zh-CN', label: '简体中文', shortLabel: '简中' },
    { id: 'en', label: 'English', shortLabel: 'EN' },
];

const isValidThemeId = (val: unknown): val is ThemeId =>
    val === 'm3-dark' ||
    val === 'm3-cafe-mica' ||
    val === 'classic-neon' ||
    val === 'amoled-stage';

const isValidLanguageId = (val: unknown): val is LanguageId =>
    val === 'zh-TW' || val === 'zh-CN' || val === 'en';

const loadSavedThemeId = (): ThemeId => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
            if (isValidThemeId(raw)) {
                return raw;
            }
        }
    } catch {
        // ignore storage errors
    }
    // 預設使用第 1 個可選擇的主題方案：Material 3 深色主題
    return 'm3-dark';
};

const loadSavedLanguageId = (): LanguageId => {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
            if (isValidLanguageId(raw)) {
                return raw;
            }
        }
    } catch {
        // ignore storage errors
    }
    return 'zh-TW';
};

const applyThemeAttributeToDocument = (themeId: ThemeId) => {
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-theme', themeId);
    }
};

interface ThemeStoreState {
    themeId: ThemeId;
    language: LanguageId;
    setThemeId: (nextTheme: ThemeId) => void;
    setLanguage: (nextLang: LanguageId) => void;
    initThemeOnMount: () => void;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
    themeId: loadSavedThemeId(),
    language: loadSavedLanguageId(),

    setThemeId: (nextTheme: ThemeId) => {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
            }
        } catch {
            // ignore storage errors
        }
        applyThemeAttributeToDocument(nextTheme);
        set({ themeId: nextTheme });
    },

    setLanguage: (nextLang: LanguageId) => {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
            }
        } catch {
            // ignore storage errors
        }
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.setAttribute('lang', nextLang);
        }
        set({ language: nextLang });
    },

    initThemeOnMount: () => {
        const current = get().themeId;
        applyThemeAttributeToDocument(current);
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.setAttribute('lang', get().language);
        }
    },
}));

export const getThemePresetMeta = (themeId: ThemeId): ThemePresetMeta =>
    THEME_PRESETS.find((t) => t.id === themeId) ?? THEME_PRESETS[0];

