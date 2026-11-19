import type { LanguageId } from '../store/useThemeStore';

// ============================================================================
// [多國語言輕量級 DOM 翻譯引擎]
// 造成原錯誤的原因：
// 1. 先前在 originalTextNodeMap 中以 /[\u4e00-\u9fff]/.test(currentVal) 判斷是否為新文字，因簡體字同樣符合該正則，導致從簡體切回繁體時把簡體字誤覆寫進 baseZh 原始繁體基準值。
// 2. 先前簡體字使用單一長字串索引對照，字數偏差導致字元錯位（如「橫」變「模」、「佇」變「行」）；且英文模式遺漏部分元件詞條與動態句型。
// 本次修改的目的：
// 1. 改以 { baseZh, lastApplied } 雙欄位紀錄原始繁體字串與上次套用結果，僅當 DOM 內容不等於 lastApplied（即 React 實際更新狀態）時才更新 baseZh，確保繁/簡/英任意雙向切換皆能 100% 還原。
// 2. 簡體中文與英文統一採用「完整詞條字典對照 + 動態句型正則替換」，徹底杜絕字元平移錯位並完整覆蓋全站介面。
// ============================================================================

interface I18nEntry {
    zhCN: string;
    en: string;
}

const I18N_PHRASE_DICT: Record<string, I18nEntry> = {
    // --- HeaderBar / WindowControls / ThemePreferencesMenu ---
    'foobar2000 視覺化 DJ 工作流播放器': {
        zhCN: 'foobar2000 可视化 DJ 工作流播放器',
        en: 'foobar2000 Visual DJ Workflow Player',
    },
    '連線中 (Bridge Connected)': {
        zhCN: '已连接 (Bridge Connected)',
        en: 'Bridge Connected',
    },
    '預覽 / 診斷': {
        zhCN: '预览 / 诊断',
        en: 'Preview / Diag',
    },
    '🔌 預覽 / 診斷': {
        zhCN: '🔌 预览 / 诊断',
        en: '🔌 Preview / Diag',
    },
    '🔌 已連線宿主': {
        zhCN: '🔌 已连接宿主',
        en: '🔌 Host Connected',
    },
    '🔌 WebView2 指南 / 診斷': {
        zhCN: '🔌 WebView2 指南 / 诊断',
        en: '🔌 WebView2 Guide / Diag',
    },
    '點擊查看 C++ WebView2 Host Bridge 連線診斷與規格': {
        zhCN: '点击查看 C++ WebView2 Host Bridge 连接诊断与规格',
        en: 'View C++ WebView2 Host Bridge diagnostics & specs',
    },
    '雙擊切換最大化 / 按住可拖移原生視窗': {
        zhCN: '双击切换最大化 / 按住可拖移原生窗口',
        en: 'Double-click to maximize / Drag to move native window',
    },
    '雙擊切換最大化 / 還原視窗': {
        zhCN: '双击切换最大化 / 还原窗口',
        en: 'Double-click to maximize / restore window',
    },
    '最小化視窗': {
        zhCN: '最小化窗口',
        en: 'Minimize Window',
    },
    '最小化視窗 (window.minimize)': {
        zhCN: '最小化窗口 (window.minimize)',
        en: 'Minimize Window (window.minimize)',
    },
    '最大化視窗': {
        zhCN: '最大化窗口',
        en: 'Maximize Window',
    },
    '最大化視窗 (window.toggleMaximize)': {
        zhCN: '最大化窗口 (window.toggleMaximize)',
        en: 'Maximize Window (window.toggleMaximize)',
    },
    '還原視窗': {
        zhCN: '还原窗口',
        en: 'Restore Window',
    },
    '還原視窗大小': {
        zhCN: '还原窗口大小',
        en: 'Restore Window',
    },
    '還原視窗大小 (window.toggleMaximize)': {
        zhCN: '还原窗口大小 (window.toggleMaximize)',
        en: 'Restore Window (window.toggleMaximize)',
    },
    '關閉視窗': {
        zhCN: '关闭窗口',
        en: 'Close Window',
    },
    '關閉視窗 (window.close)': {
        zhCN: '关闭窗口 (window.close)',
        en: 'Close Window (window.close)',
    },
    '開啟面板設計主題偏好設定': {
        zhCN: '开启面板设计主题偏好设置',
        en: 'Open panel theme & preferences menu',
    },
    '關閉偏好視窗 (Esc)': {
        zhCN: '关闭偏好窗口 (Esc)',
        en: 'Close preferences (Esc)',
    },
    '主題偏好': {
        zhCN: '主题偏好',
        en: 'Preferences',
    },
    '切換面板主題與檢視字體方案 (Theme & Typography Preferences)': {
        zhCN: '切换面板主题与字体方案 (Theme & Typography Preferences)',
        en: 'Switch panel theme, language & typography preferences',
    },
    '面板主題與無障礙字體偏好': {
        zhCN: '面板主题与无障碍字体偏好',
        en: 'Panel Theme & Accessibility Preferences',
    },
    '即時切換 M3 畫布最大化主題與 4 段無障礙字級，自動記憶於本機': {
        zhCN: '即时切换 M3 画布最大化主题与 4 段无障碍字号，自动记忆于本机',
        en: 'Switch M3 themes & 4-level font scaling, auto-saved locally',
    },
    '🌐 介面顯示語言 (Display Language)': {
        zhCN: '🌐 界面显示语言 (Display Language)',
        en: '🌐 Display Language',
    },
    '即時切換繁體、簡體與英文介面': {
        zhCN: '即时切换繁体、简体与英文界面',
        en: 'Switch between Traditional Chinese, Simplified Chinese & English',
    },
    '🧹 清除本地暫存資料': {
        zhCN: '🧹 清除本地缓存数据',
        en: '🧹 Clear LocalStorage Cache',
    },
    '清空舊版畫布、曲目與分析暫存（保留當前主題與語言設定）': {
        zhCN: '清空旧版画布、曲目与分析缓存（保留当前主题与语言设置）',
        en: 'Clear cached canvas, track & DSP data (keeps theme & language)',
    },
    '清空舊版代碼產生的 localStorage 暫存資料並重新載入': {
        zhCN: '清空旧版代码产生的 localStorage 缓存数据并重新加载',
        en: 'Clear legacy localStorage cache and reload application',
    },
    '🧹 清除暫存': {
        zhCN: '🧹 清除缓存',
        en: '🧹 Clear Cache',
    },
    '⚠️ 確定清空並重整？': {
        zhCN: '⚠️ 确定清空并刷新？',
        en: '⚠️ Confirm & Reload?',
    },
    '確定清除': {
        zhCN: '确定清除',
        en: 'Confirm',
    },
    '🪄 推薦排列': {
        zhCN: '🪄 推荐排列',
        en: '🪄 Auto Harmonic',
    },
    '🪄 推薦排列節點': {
        zhCN: '🪄 推荐排列节点',
        en: '🪄 Auto Harmonic Arrange',
    },
    '依駱駝色輪調性與 BPM 自動推薦最佳接歌順序、建立連線並整齊排列': {
        zhCN: '依骆驼色轮调性与 BPM 自动推荐最佳接歌顺序、建立连线并整齐排列',
        en: 'Auto-sort tracks by Camelot Key & BPM with optimal harmonic connections and layout',
    },
    '🔤 檢視字體大小 (Accessibility Font Scale)': {
        zhCN: '🔤 界面字体大小 (Accessibility Font Scale)',
        en: '🔤 Accessibility Font Scale',
    },
    '改善長輩與高解析度螢幕閱讀清晰度': {
        zhCN: '改善长辈与高分辨率屏幕阅读清晰度',
        en: 'Enhance readability on high-DPI displays',
    },
    '標準 (100%)': {
        zhCN: '标准 (100%)',
        en: 'Standard (100%)',
    },
    '適中放大 (110%)': {
        zhCN: '适中放大 (110%)',
        en: 'Medium (110%)',
    },
    '舒適大字 (120%)': {
        zhCN: '舒适大字 (120%)',
        en: 'Large (120%)',
    },
    '特大清晰 (130%)': {
        zhCN: '特大清晰 (130%)',
        en: 'Extra Large (130%)',
    },
    '預設字級': {
        zhCN: '默认字号',
        en: 'Default',
    },
    '長輩友善推薦': {
        zhCN: '清晰阅读推荐',
        en: 'Recommended',
    },
    '高對比大字': {
        zhCN: '高对比大字',
        en: 'High Contrast',
    },
    '最大字級': {
        zhCN: '最大字号',
        en: 'Max Scale',
    },
    '方案 1 • 預設': {
        zhCN: '方案 1 • 默认',
        en: 'Preset 1 • Default',
    },
    'Material 3 深色主題 (M3 Expressive Dark)': {
        zhCN: 'Material 3 深色主题 (M3 Expressive Dark)',
        en: 'Material 3 Expressive Dark',
    },
    '畫布視野最大化 • 懸浮毛玻璃工具塢與 M3 Tonal 膠囊控制項': {
        zhCN: '画布视野最大化 • 悬浮毛玻璃工具坞与 M3 Tonal 胶囊控件',
        en: 'Maximized Canvas • Floating Glass Dock & M3 Tonal Controls',
    },
    '採用 M3 Dark Surface 階層配色 (#0F131A / #191E29)、單行流線 Header、畫布內嵌懸浮膠囊工具塢、緊湊型側欄與精悍時間軸，將中央節點畫布可視面積最大化。': {
        zhCN: '采用 M3 Dark Surface 层级配色 (#0F131A / #191E29)、单行流线 Header、画布内嵌悬浮胶囊工具坞、紧凑型侧栏与精悍时间轴，将中央节点画布可视面积最大化。',
        en: 'Uses M3 Dark Surface hierarchy (#0F131A / #191E29), single-row header, floating canvas dock, and compact sidebars to maximize workflow canvas space.',
    },
    '畫布視野最大化': {
        zhCN: '画布视野最大化',
        en: 'Maximized Canvas',
    },
    '懸浮膠囊工具塢': {
        zhCN: '悬浮胶囊工具坞',
        en: 'Floating Pill Dock',
    },
    'M3 Tonal 按鈕': {
        zhCN: 'M3 Tonal 按钮',
        en: 'M3 Tonal Buttons',
    },
    '方案 2 • 下午茶淺色雲母': {
        zhCN: '方案 2 • 下午茶浅色云母',
        en: 'Preset 2 • Light Oat Mica',
    },
    '北歐晨光 • 燕麥奶雲母 (M3 Nordic Oat Mica)': {
        zhCN: '北欧晨光 • 燕麦奶云母 (M3 Nordic Oat Mica)',
        en: 'M3 Nordic Oat Mica (Light)',
    },
    'M3 面板設計 + 淺色燕麥奶 Mica 雲母半透明材質 + Segoe UI Variable 字體': {
        zhCN: 'M3 面板设计 + 浅色燕麦奶 Mica 云母半透明材质 + Segoe UI Variable 字体',
        en: 'M3 Layout + Warm Nordic Oat Mica Translucent Surface + Segoe UI Variable',
    },
    '承襲方案 1 的 M3 畫布最大化排版，以溫暖明亮的北歐晨光燕麥奶 (#F5EFE8)、柔霧杏仁白與焦糖肉桂 (#C87D4B)、鼠尾草抹茶 (#4E8763) 打造輕鬆下午茶氛圍。': {
        zhCN: '承袭方案 1 的 M3 画布最大化排版，以温暖明亮的北欧晨光燕麦奶 (#F5EFE8)、柔雾杏仁白与焦糖肉桂 (#C87D4B)、鼠尾草抹茶 (#4E8763) 打造轻松下午茶氛围。',
        en: 'Inherits M3 maximized canvas layout with warm Nordic Oat (#F5EFE8), Almond White, Caramel Cinnamon (#C87D4B) and Sage Matcha (#4E8763) palette.',
    },
    '燕麥奶淺色雲母': {
        zhCN: '燕麦奶浅色云母',
        en: 'Light Oat Mica',
    },
    '焦糖肉桂 & 鼠尾草綠': {
        zhCN: '焦糖肉桂 & 鼠尾草绿',
        en: 'Caramel & Sage',
    },
    '方案 3': {
        zhCN: '方案 3',
        en: 'Preset 3',
    },
    '經典暗黑霓虹 (Classic Slate Neon)': {
        zhCN: '经典暗黑霓虹 (Classic Slate Neon)',
        en: 'Classic Slate Neon',
    },
    '原始 Slate-950 專業 DJ 控台與高彩度霓虹邊框': {
        zhCN: '原始 Slate-950 专业 DJ 控台与高彩度霓虹边框',
        en: 'Original Slate-950 Pro DJ Console & High-Chroma Neon Borders',
    },
    '保留專案原生的深灰藍底色 (#020617 / #0F172A)、Cyan/Emerald 霓虹發光強調邊框、標準 12px 圓角與原始面板尺寸比例。': {
        zhCN: '保留项目原生的深灰蓝底色 (#020617 / #0F172A)、Cyan/Emerald 霓虹发光强调边框、标准 12px 圆角与原始面板尺寸比例。',
        en: 'Preserves original Slate-950 dark background (#020617 / #0F172A), Cyan/Emerald neon accents, standard 12px radius, and classic panel proportions.',
    },
    '經典霓虹邊框': {
        zhCN: '经典霓虹边框',
        en: 'Classic Neon Border',
    },
    '12px 標準圓角': {
        zhCN: '12px 标准圆角',
        en: '12px Radius',
    },
    '原始標準排版': {
        zhCN: '原始标准排版',
        en: 'Classic Layout',
    },
    '方案 4': {
        zhCN: '方案 4',
        en: 'Preset 4',
    },
    '純黑舞台高對比 (AMOLED Stage Black)': {
        zhCN: '纯黑舞台高对比 (AMOLED Stage Black)',
        en: 'AMOLED Stage Black',
    },
    '專為低光源 Live 演出打造的零眩光純黑緊湊面板': {
        zhCN: '专为低光源 Live 演出打造的零眩光纯黑紧凑面板',
        en: 'Zero-Glare True Black Compact Console for Live Stage Sets',
    },
    '採用 #040507 純黑背景降低舞台眩光，搭配暖琥珀與冰青高對比邊框，並微幅收窄左右側欄以最大化中央工作流畫布空間。': {
        zhCN: '采用 #040507 纯黑背景降低舞台眩光，搭配暖琥珀与冰青高对比边框，并微幅收窄左右侧栏以最大化中央工作流画布空间。',
        en: 'True black #040507 surface for low-light stages with high-contrast Amber/Ice-Cyan borders and slimmer sidebars.',
    },
    '純黑零眩光': {
        zhCN: '纯黑零眩光',
        en: 'Zero-Glare Black',
    },
    '緊湊俐落按鈕': {
        zhCN: '紧凑利落按钮',
        en: 'Compact Controls',
    },
    '畫布最大化排版': {
        zhCN: '画布最大化排版',
        en: 'Maximized Canvas',
    },
    '套用中': {
        zhCN: '使用中',
        en: 'Active',
    },

    // --- PresetManager & LiveLockToggle ---
    '記憶槽': {
        zhCN: '记忆槽',
        en: 'Slots',
    },
    '↺重置': {
        zhCN: '↺重置',
        en: '↺ Reset',
    },
    '重置': {
        zhCN: '重置',
        en: 'Reset',
    },
    '重置畫布至初始預設狀態': {
        zhCN: '重置画布至初始默认状态',
        en: 'Reset workflow canvas to initial default state',
    },
    '回復預設展示畫布': {
        zhCN: '恢复默认演示画布',
        en: 'Restore default demo workflow canvas',
    },
    '📝 寫入新的播放清單': {
        zhCN: '📝 写入新的播放列表',
        en: '📝 Write New Playlist',
    },
    '將當前計算好的 Flat Play Queue 寫入 foobar2000 新建立的播放清單': {
        zhCN: '将当前计算好的 Flat Play Queue 写入 foobar2000 新创建的播放列表',
        en: 'Write calculated Flat Play Queue into a new foobar2000 playlist',
    },
    '將畫布排程順序直接寫入 foobar2000 成為新的實體播放清單': {
        zhCN: '将画布排程顺序直接写入 foobar2000 成为新的实体播放列表',
        en: 'Write canvas queue order directly into foobar2000 as a new playlist',
    },
    '名稱:': {
        zhCN: '名称:',
        en: 'Name:',
    },
    '輸入新播放清單名稱...': {
        zhCN: '输入新播放列表名称...',
        en: 'Enter new playlist name...',
    },
    '寫入中...': {
        zhCN: '写入中...',
        en: 'Writing...',
    },
    '確認寫入': {
        zhCN: '确认写入',
        en: 'Confirm Write',
    },
    '📂 匯入 (.json)': {
        zhCN: '📂 导入 (.json)',
        en: '📂 Import (.json)',
    },
    '匯入先前儲存的 .json DJ 工作流專案檔': {
        zhCN: '导入先前保存的 .json DJ 工作流项目文件',
        en: 'Import a previously saved .json DJ workflow project file',
    },
    '從電腦載入先前匯出的 .foobar-dj.json 工作流檔案': {
        zhCN: '从电脑加载先前导出的 .foobar-dj.json 工作流文件',
        en: 'Import a saved .foobar-dj.json workflow project file',
    },
    '💾 匯出 (.json)': {
        zhCN: '💾 导出 (.json)',
        en: '💾 Export (.json)',
    },
    '將當前畫布節點座標、Cue 點、Loop 與轉場設定匯出為 .json 專案檔': {
        zhCN: '将当前画布节点坐标、Cue 点、Loop 与转场设置导出为 .json 项目文件',
        en: 'Export canvas node positions, Cue points, Loops & transitions as .json project',
    },
    '將當前畫布節點、連線與 Cue 點匯出為 .foobar-dj.json 專案檔': {
        zhCN: '将当前画布节点、连线与 Cue 点导出为 .foobar-dj.json 项目文件',
        en: 'Export canvas nodes, edges & Cue points as .foobar-dj.json',
    },
    '🎵 匯出 (.m3u8)': {
        zhCN: '🎵 导出 (.m3u8)',
        en: '🎵 Export (.m3u8)',
    },
    '將當前線性播放佇列匯出為標準 .m3u8 歌單檔': {
        zhCN: '将当前线性播放队列导出为标准 .m3u8 歌单文件',
        en: 'Export current linear play queue as a standard .m3u8 playlist file',
    },
    '依當前畫布拓撲排序匯出標準 .m3u8 播放清單 (供 foobar2000 直接載入)': {
        zhCN: '依当前画布拓扑排序导出标准 .m3u8 播放列表 (供 foobar2000 直接加载)',
        en: 'Export topological queue as standard .m3u8 playlist for foobar2000',
    },
    '🔒 演出鎖定中 (Live Lock)': {
        zhCN: '🔒 演出锁定中 (Live Lock)',
        en: '🔒 Live Locked',
    },
    '🔓 自由編輯模式': {
        zhCN: '🔓 自由编辑模式',
        en: '🔓 Free Edit Mode',
    },
    '防誤觸鎖定中：禁止拖曳、刪除節點或修改連線（點擊或按 L 解鎖）': {
        zhCN: '防误触锁定中：禁止拖曳、删除节点或修改连线（点击或按 L 解锁）',
        en: 'Live Lock active: Node dragging, deletion & wiring locked (Click or press L to unlock)',
    },
    '自由編輯模式：允許拖放、連線與調整 Cue 點（點擊或按 L 鎖定）': {
        zhCN: '自由编辑模式：允许拖放、连线与调整 Cue 点（点击或按 L 锁定）',
        en: 'Free Edit Mode: Drag, connect & adjust Cue points freely (Click or press L to lock)',
    },

    // --- HostBridgeModal (完整三語對照) ---
    '🔌 foobar2000 WebView2 (foo_ui_webview2) 宿主橋接中心與安裝指南': {
        zhCN: '🔌 foobar2000 WebView2 (foo_ui_webview2) 宿主桥接中心与安装指南',
        en: '🔌 foobar2000 WebView2 (foo_ui_webview2) Host Bridge & Setup Guide',
    },
    '容器偵測：': {
        zhCN: '容器检测：',
        en: 'Container: ',
    },
    '✅ 已偵測到 window.fb2k (BridgeCore) 原生容器': {
        zhCN: '✅ 已检测到 window.fb2k (BridgeCore) 原生容器',
        en: '✅ Native window.fb2k (BridgeCore) container detected',
    },
    '🌐 瀏覽器預覽環境（支援模擬握手與離線打包匯出）': {
        zhCN: '🌐 浏览器预览环境（支持模拟握手与离线打包导出）',
        en: '🌐 Browser Preview Environment (Supports mock handshake & offline build)',
    },
    '• 音訊輸出：': {
        zhCN: '• 音频输出：',
        en: '• Audio Out: ',
    },
    '✕ 關閉': {
        zhCN: '✕ 关闭',
        en: '✕ Close',
    },
    '📦 1. 本地 foobar2000 安裝與掛載步驟': {
        zhCN: '📦 1. 本地 foobar2000 安装与挂载步骤',
        en: '📦 1. Local foobar2000 Setup & Mounting Steps',
    },
    '🔌 2. Bridge 連線診斷與訊號模擬器': {
        zhCN: '🔌 2. Bridge 连接诊断与信号模拟器',
        en: '🔌 2. Bridge Diagnostics & Signal Simulator',
    },
    '📡 3. foo_ui_webview2 (fb2k) 通訊協定規格': {
        zhCN: '📡 3. foo_ui_webview2 (fb2k) 通信协议规格',
        en: '📡 3. foo_ui_webview2 (fb2k) IPC Protocol Spec',
    },
    '核心概念說明：': {
        zhCN: '核心概念说明：',
        en: 'Core Concept: ',
    },
    '本專案已配置': {
        zhCN: '本项目已配置',
        en: 'Configured with',
    },
    '相對路徑打包與雙向': {
        zhCN: '相对路径打包与双向',
        en: 'relative path bundling and bidirectional',
    },
    '橋接器。您可選擇在 foobar2000 內直接載入開發伺服器網址，或載入': {
        zhCN: '桥接器。您可选择在 foobar2000 内直接加载开发服务器网址，或加载',
        en: 'bridge. Load either the dev server URL directly in foobar2000 or the offline',
    },
    '離線靜態檔案。': {
        zhCN: '离线静态文件。',
        en: 'static build.',
    },
    '步驟 1：確認環境與下載 foo_ui_webview2': {
        zhCN: '步骤 1：确认环境与下载 foo_ui_webview2',
        en: 'Step 1: Requirements & Download foo_ui_webview2',
    },
    '確認安裝': {
        zhCN: '确认安装',
        en: 'Ensure',
    },
    'foobar2000 v2.0 以上版本': {
        zhCN: 'foobar2000 v2.0 以上版本',
        en: 'foobar2000 v2.0+ (64-bit recommended)',
    },
    '（推薦 64-bit）以及 Windows 10/11 內建的': {
        zhCN: '（推荐 64-bit）以及 Windows 10/11 内置的',
        en: 'and Windows 10/11 built-in',
    },
    '前往 GitHub (': {
        zhCN: '前往 GitHub (',
        en: 'Visit GitHub (',
    },
    ') 下載最新': {
        zhCN: ') 下载最新',
        en: ') to download the latest',
    },
    '步驟 2：在 foobar2000 安裝元件': {
        zhCN: '步骤 2：在 foobar2000 安装组件',
        en: 'Step 2: Install Component in foobar2000',
    },
    '打開 foobar2000，按快捷鍵': {
        zhCN: '打开 foobar2000，按快捷键',
        en: 'Open foobar2000 and press',
    },
    '開啟': {
        zhCN: '开启',
        en: 'to open',
    },
    'Preferences (偏好設定)': {
        zhCN: 'Preferences (偏好设置)',
        en: 'Preferences',
    },
    '點選左側最上方的': {
        zhCN: '点选左侧最上方的',
        en: 'Select',
    },
    '，點擊右下角': {
        zhCN: '，点击右下角',
        en: 'on the top-left, then click',
    },
    '按鈕（或直接將': {
        zhCN: '按钮（或直接将',
        en: 'at the bottom-right (or drag',
    },
    '拖曳進清單中）。': {
        zhCN: '拖曳进列表中）。',
        en: 'into the list).',
    },
    '點擊': {
        zhCN: '点击',
        en: 'Click',
    },
    '並重新啟動 foobar2000。': {
        zhCN: '并重新启动 foobar2000。',
        en: 'and restart foobar2000.',
    },
    '步驟 3：將 WebView2 面板嵌入 foobar2000 版面': {
        zhCN: '步骤 3：将 WebView2 面板嵌入 foobar2000 布局',
        en: 'Step 3: Embed WebView2 Panel in foobar2000 Layout',
    },
    '獨立主介面模式': {
        zhCN: '独立主界面模式',
        en: 'Standalone Main UI Mode',
    },
    '：於': {
        zhCN: '：于',
        en: ': In',
    },
    '選擇': {
        zhCN: '选择',
        en: 'select',
    },
    'DUI / CUI 面板模式': {
        zhCN: 'DUI / CUI 面板模式',
        en: 'DUI / CUI Panel Mode',
    },
    '：於版面編輯模式插入': {
        zhCN: '：于布局编辑模式插入',
        en: ': Insert into layout via Layout Editing Mode:',
    },
    '步驟 4：指定本播放器載入路徑 (兩種模式任選)': {
        zhCN: '步骤 4：指定本播放器加载路径 (两种模式任选)',
        en: 'Step 4: Set Player Entry URL / Path (Choose Either)',
    },
    '模式 A（開發熱更新）：': {
        zhCN: '模式 A（开发热更新）：',
        en: 'Mode A (Dev Server): ',
    },
    '在本地執行': {
        zhCN: '在本地执行',
        en: 'Run',
    },
    '，於 foobar2000 的 WebView2 設定將 URL 設為': {
        zhCN: '，于 foobar2000 的 WebView2 设置将 URL 设为',
        en: 'locally, and set WebView2 URL in foobar2000 to',
    },
    '（或自訂埠號）。': {
        zhCN: '（或自定义端口）。',
        en: ' (or custom port).',
    },
    '模式 B（離線獨立運行）：': {
        zhCN: '模式 B（离线独立运行）：',
        en: 'Mode B (Offline Standalone): ',
    },
    '，將 WebView2 來源指向編譯後的': {
        zhCN: '，将 WebView2 来源指向编译后的',
        en: ', and point WebView2 source to compiled',
    },
    '即可免開 Node.js 獨立運作！': {
        zhCN: '即可免开 Node.js 独立运作！',
        en: 'to run standalone without Node.js!',
    },
    '🖥️ fb2k Native Bridge 握手測試': {
        zhCN: '🖥️ fb2k Native Bridge 握手测试',
        en: '🖥️ fb2k Native Bridge Handshake Test',
    },
    'CONNECTED (已連線宿主)': {
        zhCN: 'CONNECTED (已连接宿主)',
        en: 'CONNECTED (Host Active)',
    },
    'DEV PREVIEW (瀏覽器模擬)': {
        zhCN: 'DEV PREVIEW (浏览器模拟)',
        en: 'DEV PREVIEW (Browser Mock)',
    },
    '點擊下方按鈕可主動向': {
        zhCN: '点击下方按钮可主动向',
        en: 'Click below to query version & audio device via',
    },
    '發送版本與音訊裝置查詢，或模擬握手回應：': {
        zhCN: '发送版本与音频设备查询，或模拟握手回应：',
        en: ', or simulate a host handshake ACK:',
    },
    '偵測到的 HostObjects：': {
        zhCN: '检测到的 HostObjects：',
        en: 'Detected HostObjects:',
    },
    '無 (瀏覽器預覽環境)': {
        zhCN: '无 (浏览器预览环境)',
        en: 'None (Browser Preview)',
    },
    '支援的原生方法：': {
        zhCN: '支持的原生方法：',
        en: 'Supported Native Methods:',
    },
    '未偵測到': {
        zhCN: '未检测到',
        en: 'None detected',
    },
    '📤 發送 CLIENT_HANDSHAKE_READY': {
        zhCN: '📤 发送 CLIENT_HANDSHAKE_READY',
        en: '📤 Send CLIENT_HANDSHAKE_READY',
    },
    '📥 模擬 C++ 宿主握手回應 (ACK)': {
        zhCN: '📥 模拟 C++ 宿主握手回应 (ACK)',
        en: '📥 Simulate C++ Host ACK',
    },
    '🌊 本地 60FPS 音訊頻譜與電平串流': {
        zhCN: '🌊 本地 60FPS 音频频谱与电平串流',
        en: '🌊 Local 60FPS Spectrum & Meter Stream',
    },
    '連線': {
        zhCN: '连接',
        en: 'Connect',
    },
    '中斷': {
        zhCN: '断开',
        en: 'Disconnect',
    },
    '診斷說明：': {
        zhCN: '诊断说明：',
        en: 'Diagnostics Note: ',
    },
    '採用原生 C++ IPC 共享記憶體通道 (': {
        zhCN: '采用原生 C++ IPC 共享内存通道 (',
        en: 'uses native C++ IPC shared memory (',
    },
    '與': {
        zhCN: '与',
        en: 'and',
    },
    ') 推播 60FPS 音訊數據，而非開啟獨立的 TCP 8788 WebSocket 伺服器。點擊「連線」將直接掛載原生 60FPS IPC 串流。': {
        zhCN: ') 推播 60FPS 音频数据，而非开启独立的 TCP 8788 WebSocket 服务器。点击「连接」将直接挂载原生 60FPS IPC 串流。',
        en: ') to stream 60FPS audio data instead of a TCP 8788 WebSocket server. Click "Connect" to mount the native 60FPS IPC stream.',
    },
    '📜 Bridge IPC 雙向訊息監控日誌 (最近': {
        zhCN: '📜 Bridge IPC 双向消息监控日志 (最近',
        en: '📜 Bridge IPC Message Log (Last',
    },
    '筆)': {
        zhCN: '笔)',
        en: 'entries)',
    },
    '清除日誌': {
        zhCN: '清除日志',
        en: 'Clear Logs',
    },
    '尚無 Bridge 通訊紀錄（操作播放、拖曳時間軸或點擊上方握手測試即可觀察即時封包）': {
        zhCN: '尚无 Bridge 通信记录（操作播放、拖曳时间轴或点击上方握手测试即可观察实时封包）',
        en: 'No Bridge IPC logs yet (Play audio, scrub timeline, or click Handshake Test above to inspect packets)',
    },
    '前端透過': {
        zhCN: '前端通过',
        en: 'Frontend uses',
    },
    '與底層': {
        zhCN: '与底层',
        en: 'and low-level',
    },
    '呼叫': {
        zhCN: '调用',
        en: 'to invoke',
    },
    'C++ 宿主服務，並透過': {
        zhCN: 'C++ 宿主服务，并通过',
        en: 'C++ host services, and subscribes to async events via',
    },
    '接收非同步事件：': {
        zhCN: '接收异步事件：',
        en: ':',
    },
    '🔌 C++ WebView2 Host Bridge 診斷與部署指南': {
        zhCN: '🔌 C++ WebView2 Host Bridge 诊断与部署指南',
        en: '🔌 C++ WebView2 Host Bridge Diagnostics & Guide',
    },
    '目前環境：瀏覽器獨立預覽模式 (Mock Bridge Active)': {
        zhCN: '当前环境：浏览器独立预览模式 (Mock Bridge Active)',
        en: 'Environment: Browser Standalone Preview (Mock Bridge Active)',
    },
    '已連線至 foobar2000 C++ Host Bridge (Native WebView2 Active)': {
        zhCN: '已连接至 foobar2000 C++ Host Bridge (Native WebView2 Active)',
        en: 'Connected to foobar2000 C++ Host Bridge (Native WebView2 Active)',
    },
    '目前已內建 6 首電音測試曲目、合成音訊引擎與雙轉盤混音模擬器，所有功能皆可直接互動測試。': {
        zhCN: '目前已内置 6 首电音测试曲目、合成音频引擎与双转盘混音模拟器，所有功能皆可直接互动测试。',
        en: '6 built-in electronic demo tracks, WebAudio synth engine & dual-deck mixer simulator are active for interactive testing.',
    },
    '已成功掛載原生 window.chrome.webview 與 window.foobarBridge 介面，音訊控制與 FFT 頻譜皆由 foobar2000 主程式驅動。': {
        zhCN: '已成功挂载原生 window.chrome.webview 与 window.foobarBridge 接口，音频控制与 FFT 频谱皆由 foobar2000 主程序驱动。',
        en: 'Native window.chrome.webview and window.foobarBridge mounted. Audio playback and FFT spectrum are driven by foobar2000.',
    },
    '偵測狀態': {
        zhCN: '检测状态',
        en: 'Status',
    },
    '關閉': {
        zhCN: '关闭',
        en: 'Close',
    },

    // --- MediaLibrary / InstantSearch / VirtualTrackList ---
    '展開左側智慧媒體庫': {
        zhCN: '展开左侧智能媒体库',
        en: 'Expand Smart Media Library',
    },
    '展開左側智慧媒體庫面板': {
        zhCN: '展开左侧智能媒体库面板',
        en: 'Expand Smart Media Library panel',
    },
    '點擊展開智慧媒體庫': {
        zhCN: '点击展开智能媒体库',
        en: 'Click to expand Smart Media Library',
    },
    '◀ 收折': {
        zhCN: '◀ 收起',
        en: '◀ Collapse',
    },
    '向左收折智慧媒體庫以擴大畫布空間': {
        zhCN: '向左收起智能媒体库以扩大画布空间',
        en: 'Collapse Smart Media Library to expand canvas space',
    },
    '向左收折媒體庫面板以擴大畫布空間': {
        zhCN: '向左收起媒体库面板以扩大画布空间',
        en: 'Collapse Media Library to expand canvas space',
    },
    '🗂️ 智慧媒體庫 (支援拖放與多選)': {
        zhCN: '🗂️ 智能媒体库 (支持拖放与多选)',
        en: '🗂️ Smart Media Library',
    },
    '➕ 新建 Playlist...': {
        zhCN: '➕ 新建 Playlist...',
        en: '➕ New Playlist...',
    },
    '在 foobar2000 內建立新的空白 Playlist 並同步更新歌單下拉選單': {
        zhCN: '在 foobar2000 内创建新的空白 Playlist 并同步更新歌单下拉菜单',
        en: 'Create a new empty Playlist in foobar2000 and sync playlist dropdown',
    },
    '在 foobar2000 中建立一個新的空白播放清單並切換過去': {
        zhCN: '在 foobar2000 中创建一个新的空白播放列表并切换过去',
        en: 'Create a new empty playlist in foobar2000 and switch to it',
    },
    '➕ 加入本地檔案': {
        zhCN: '➕ 添加本地文件',
        en: '➕ Add Local Files',
    },
    '選擇本機多個音訊檔案或整個資料夾，追加入當前的智慧媒體庫清單': {
        zhCN: '选择本机多个音频文件或整个文件夹，追加入当前的智能媒体库列表',
        en: 'Select local audio files or a folder to append into current Media Library list',
    },
    '從電腦選取音訊檔案或資料夾，直接追加至當前媒體庫列表（不會清空現有曲目）': {
        zhCN: '从电脑选取音频文件或文件夹，直接追加至当前媒体库列表（不会清空现有曲目）',
        en: 'Add audio files or folders from disk into current list without clearing existing tracks',
    },
    '📥 從歌單導入': {
        zhCN: '📥 从歌单导入',
        en: '📥 Import Playlist',
    },
    '從已建立的 foobar2000 Playlist 中導入全部曲目或勾選的多首曲目，追加至當前清單': {
        zhCN: '从已创建的 foobar2000 Playlist 中导入全部曲目或勾选的多首曲目，追加至当前列表',
        en: 'Import all or selected tracks from an existing foobar2000 Playlist into current list',
    },
    '從已建立的 foobar2000 播放清單中選擇全部或多首曲目，追加導入至當前列表': {
        zhCN: '从已创建的 foobar2000 播放列表中选择全部或多首曲目，追加导入至当前列表',
        en: 'Import all or selected tracks from an existing foobar2000 playlist into current list',
    },
    '💾 保存當前歌單': {
        zhCN: '💾 保存当前歌单',
        en: '💾 Save Playlist',
    },
    'foobar2000 Media Library 為唯讀曲庫，不可覆寫；請先於下方切換或新建 Playlist': {
        zhCN: 'foobar2000 Media Library 为只读曲库，不可覆盖；请先于下方切换或新建 Playlist',
        en: 'foobar2000 Media Library is read-only; switch to or create a Playlist below first',
    },
    '目前無可用歌單，請先點擊「➕ 新建 Playlist...」': {
        zhCN: '当前无可用歌单，请先点击「➕ 新建 Playlist...」',
        en: 'No playlist available; click "➕ New Playlist..." first',
    },
    '此歌單為鎖定或自動播放清單 (Autoplaylist)，不可覆寫': {
        zhCN: '此歌单为锁定或自动播放列表 (Autoplaylist)，不可覆盖',
        en: 'This playlist is locked or an Autoplaylist and cannot be overwritten',
    },
    '將當前智慧媒體庫內的曲目覆寫保存回目前選中的 foobar2000 播放清單': {
        zhCN: '将当前智能媒体库内的曲目覆盖保存回当前选中的 foobar2000 播放列表',
        en: 'Overwrite and save current tracks back to the selected foobar2000 playlist',
    },
    '將當前智慧媒體庫內的曲目另存為新的 foobar2000 播放清單': {
        zhCN: '将当前智能媒体库内的曲目另存为新的 foobar2000 播放列表',
        en: 'Save current tracks as a new foobar2000 playlist',
    },
    '📋 歌單:': {
        zhCN: '📋 歌单:',
        en: '📋 Playlist:',
    },
    '選擇並導入 foobar2000 本機媒體庫或已建立的播放清單 (Playlist)': {
        zhCN: '选择并导入 foobar2000 本机媒体库或已创建的播放列表 (Playlist)',
        en: 'Select and load foobar2000 Media Library or an existing Playlist',
    },
    '切換要載入的 foobar2000 播放清單或全部媒體庫': {
        zhCN: '切换要加载的 foobar2000 播放列表或全部媒体库',
        en: 'Switch foobar2000 playlist or full Media Library',
    },
    '請先選擇一個可編輯的 foobar2000 播放清單': {
        zhCN: '请先选择一个可编辑的 foobar2000 播放列表',
        en: 'Please select an editable foobar2000 playlist first',
    },
    '請先選擇一個可刪除的 foobar2000 播放清單': {
        zhCN: '请先选择一个可删除的 foobar2000 播放列表',
        en: 'Please select a deletable foobar2000 playlist first',
    },
    '重新整理 foobar2000 播放清單與媒體庫狀態': {
        zhCN: '刷新 foobar2000 播放列表与媒体库状态',
        en: 'Refresh foobar2000 playlists & Media Library status',
    },
    '重新命名目前選取的 foobar2000 播放清單': {
        zhCN: '重命名当前选取的 foobar2000 播放列表',
        en: 'Rename selected foobar2000 playlist',
    },
    '從 foobar2000 刪除此播放清單': {
        zhCN: '从 foobar2000 删除此播放列表',
        en: 'Delete this playlist from foobar2000',
    },
    '重新整理 foobar2000 播放清單列表並重新載入當前歌單': {
        zhCN: '刷新 foobar2000 播放列表并重新加载当前歌单',
        en: 'Refresh foobar2000 playlists and reload current list',
    },
    '單曲檢視模式': {
        zhCN: '单曲视图模式',
        en: 'Single Tracks View',
    },
    '專輯分組檢視模式': {
        zhCN: '专辑分组视图模式',
        en: 'Album Groups View',
    },
    '清除所有篩選條件': {
        zhCN: '清除所有筛选条件',
        en: 'Clear all filter criteria',
    },
    '左右拖動設定 Mix-In 進歌點（按住自動開啟 512 點局部放大鏡）': {
        zhCN: '左右拖动设置 Mix-In 进歌点（按住自动开启 512 点局部放大镜）',
        en: 'Drag horizontally to set Mix-In point (Hold to open 512pt Zoom Loupe)',
    },
    '左右拖動設定 Mix-Out 切歌點（按住自動開啟 512 點局部放大鏡）': {
        zhCN: '左右拖动设置 Mix-Out 切歌点（按住自动开启 512 点局部放大镜）',
        en: 'Drag horizontally to set Mix-Out point (Hold to open 512pt Zoom Loupe)',
    },
    '➕ 在 foobar2000 建立新的空白 Playlist': {
        zhCN: '➕ 在 foobar2000 创建新的空白 Playlist',
        en: '➕ Create New Empty Playlist in foobar2000',
    },
    '建立': {
        zhCN: '创建',
        en: 'Create',
    },
    '取消': {
        zhCN: '取消',
        en: 'Cancel',
    },
    '➕ 選擇追加至當前清單的方式（不清空現有曲目）': {
        zhCN: '➕ 选择追加至当前列表的方式（不清空现有曲目）',
        en: '➕ Append Local Audio to Current List',
    },
    '📄 選取音訊檔案 (可多選)': {
        zhCN: '📄 选取音频文件 (可多选)',
        en: '📄 Select Audio Files',
    },
    '📁 選取整個資料夾': {
        zhCN: '📁 选取整个文件夹',
        en: '📁 Select Folder',
    },
    '📥 從已建立的歌單導入曲目（追加至當前清單）': {
        zhCN: '📥 从已创建的歌单导入曲目（追加至当前列表）',
        en: '📥 Import Tracks from Existing Playlist',
    },
    '來源歌單:': {
        zhCN: '来源歌单:',
        en: 'Source:',
    },
    '⚠️ 尚無可導入的歌單': {
        zhCN: '⚠️ 尚无可导入的歌单',
        en: '⚠️ No playlists available',
    },
    '🔍 搜尋來源歌單曲名 / 演出者...': {
        zhCN: '🔍 搜索来源歌单曲名 / 演出者...',
        en: '🔍 Filter source tracks / artist...',
    },
    '取消全選': {
        zhCN: '取消全选',
        en: 'Deselect All',
    },
    '全選': {
        zhCN: '全选',
        en: 'Select All',
    },
    '正在讀取歌單曲目...': {
        zhCN: '正在读取歌单曲目...',
        en: 'Loading playlist tracks...',
    },
    '此歌單目前沒有符合的曲目': {
        zhCN: '此歌单目前没有符合的曲目',
        en: 'No matching tracks in this playlist',
    },
    '保存中...': {
        zhCN: '保存中...',
        en: 'Saving...',
    },
    '確認覆蓋保存': {
        zhCN: '确认覆盖保存',
        en: 'Confirm Overwrite',
    },
    '輸入新的播放清單名稱...': {
        zhCN: '输入新的播放列表名称...',
        en: 'Enter new playlist name...',
    },
    '確認改名': {
        zhCN: '确认改名',
        en: 'Rename',
    },
    '刪除中...': {
        zhCN: '删除中...',
        en: 'Deleting...',
    },
    '確認刪除': {
        zhCN: '确认删除',
        en: 'Confirm Delete',
    },
    '搜尋曲名、演出者、專輯...': {
        zhCN: '搜索曲名、演出者、专辑...',
        en: 'Search title, artist, album...',
    },
    '單曲列表模式 (支援 Ctrl/Shift 多選拖曳)': {
        zhCN: '单曲列表模式 (支持 Ctrl/Shift 多选拖曳)',
        en: 'Tracks View (Ctrl/Shift multi-select & drag)',
    },
    '單曲': {
        zhCN: '单曲',
        en: 'Tracks',
    },
    '整張專輯分組模式 (一鍵拖入整張專輯節點)': {
        zhCN: '整张专辑分组模式 (一键拖入整张专辑节点)',
        en: 'Albums View (Drag entire album into canvas)',
    },
    '專輯': {
        zhCN: '专辑',
        en: 'Albums',
    },
    '所有調性 (Key)': {
        zhCN: '所有调性 (Key)',
        en: 'All Keys',
    },
    '所有曲風 (Genre)': {
        zhCN: '所有曲风 (Genre)',
        en: 'All Genres',
    },
    '清除所有過濾條件': {
        zhCN: '清除所有过滤条件',
        en: 'Clear all filters',
    },
    '清除': {
        zhCN: '清除',
        en: 'Clear',
    },
    '無符合過濾條件的曲目': {
        zhCN: '无符合过滤条件的曲目',
        en: 'No tracks match your filter criteria',
    },
    '將整張專輯所有曲目建立為畫布節點': {
        zhCN: '将整张专辑所有曲目创建为画布节点',
        en: 'Create canvas node from entire album',
    },
    '+整張專輯': {
        zhCN: '+整张专辑',
        en: '+Album',
    },
    '雙擊立即從頭試聽此曲目（支援 Ctrl / Shift 多選拖曳至畫布）': {
        zhCN: '双击立即从头试听此曲目（支持 Ctrl / Shift 多选拖曳至画布）',
        en: 'Double-click to audition track (Ctrl / Shift multi-select to drag)',
    },
    '正在試聽此曲目（雙擊可重新從頭播放）': {
        zhCN: '正在试听此曲目（双击可重新从头播放）',
        en: 'Auditioning track (Double-click to restart)',
    },
    '雙擊立即從頭試聽此曲目': {
        zhCN: '双击立即从头试听此曲目',
        en: 'Double-click to audition track from start',
    },
    '直接送入畫布建立節點': {
        zhCN: '直接送入画布创建节点',
        en: 'Send track to workflow canvas',
    },
    '+畫布': {
        zhCN: '+画布',
        en: '+Canvas',
    },
    '批次生成專輯節點': {
        zhCN: '批量生成专辑节点',
        en: 'Batch Create Nodes',
    },

    // --- DJCanvas / AlbumNode / MiniWaveform / TransitionEdge / TransitionSettingsBox / CamelotWheelOverlay ---
    '☕ 工作流畫布': {
        zhCN: '☕ 工作流画布',
        en: '☕ Workflow Canvas',
    },
    '⚡ 工作流畫布': {
        zhCN: '⚡ 工作流画布',
        en: '⚡ Workflow Canvas',
    },
    '⚡ 視覺化節點工作流畫布': {
        zhCN: '⚡ 可视化节点工作流画布',
        en: '⚡ Visual Node Workflow Canvas',
    },
    '⚡ 節點式工作流畫布 (Workflow Canvas • 已啟用本地自動存檔)': {
        zhCN: '⚡ 节点式工作流画布 (Workflow Canvas • 已启用本地自动存档)',
        en: '⚡ Node Workflow Canvas (Auto-Save Enabled)',
    },
    '支援媒體庫拖放進畫布；拉新線覆蓋舊線；同專輯重疊放開自動合併。': {
        zhCN: '支持媒体库拖放进画布；拉新线覆盖旧线；同专辑重叠放开自动合并。',
        en: 'Drag tracks from library; rewire edges; overlap same-album nodes to merge.',
    },
    '支援媒體庫拖放進畫布；拉新線覆蓋舊線；同專輯重疊放開自動合併': {
        zhCN: '支持媒体库拖放进画布；拉新线覆盖旧线；同专辑重叠放开自动合并',
        en: 'Drag tracks from library; rewire edges; overlap same-album nodes to merge',
    },
    '⚠️ 迴圈警示': {
        zhCN: '⚠️ 循环警示',
        en: '⚠️ Cycle Warning',
    },
    '↔ 橫式排列': {
        zhCN: '↔ 横向排列',
        en: '↔ Horizontal',
    },
    '↕ 直式排列': {
        zhCN: '↕ 纵向排列',
        en: '↕ Vertical',
    },
    '↕ 直式 / ↔ 橫式 (當前: 直式)': {
        zhCN: '↕ 纵向 / ↔ 横向 (当前: 纵向)',
        en: '↕ Vert / ↔ Horiz (Current: Vert)',
    },
    '↕ 直式 / ↔ 橫式 (當前: 橫式)': {
        zhCN: '↕ 纵向 / ↔ 横向 (当前: 横向)',
        en: '↕ Vert / ↔ Horiz (Current: Horiz)',
    },
    '目前為「直式」：In-Port 在上、Out-Port 在下，自動排列時卡片垂直排列（點擊切換為橫式）': {
        zhCN: '当前为「纵向」：In-Port 在上、Out-Port 在下，自动排列时卡片垂直排列（点击切换为横向）',
        en: 'Current: Vertical (In-Port top, Out-Port bottom; click to switch to Horizontal)',
    },
    '目前為「橫式」：In-Port 在左、Out-Port 在右，自動排列時卡片水平排列（點擊切換為直式）': {
        zhCN: '当前为「横向」：In-Port 在左、Out-Port 在右，自动排列时卡片水平排列（点击切换为纵向）',
        en: 'Current: Horizontal (In-Port left, Out-Port right; click to switch to Vertical)',
    },
    '依播放順序將畫布節點自動整理為橫向 (左至右) 排列': {
        zhCN: '依播放顺序将画布节点自动整理为横向 (左至右) 排列',
        en: 'Arrange canvas nodes horizontally (Left to Right)',
    },
    '依播放順序將畫布節點自動整理為縱向 (上至下) 排列': {
        zhCN: '依播放顺序将画布节点自动整理为纵向 (上至下) 排列',
        en: 'Arrange canvas nodes vertically (Top to Bottom)',
    },
    '🔗 自動合併: 開': {
        zhCN: '🔗 自动合并: 开',
        en: '🔗 Auto-Merge: ON',
    },
    '🔗 自動合併: 關': {
        zhCN: '🔗 自动合并: 关',
        en: '🔗 Auto-Merge: OFF',
    },
    '🔗 自動合併:開': {
        zhCN: '🔗 自动合并:开',
        en: '🔗 Auto-Merge: ON',
    },
    '🔗 自動合併:關': {
        zhCN: '🔗 自动合并:关',
        en: '🔗 Auto-Merge: OFF',
    },
    '🔗 同專輯連線合併: 開': {
        zhCN: '🔗 同专辑连线合并: 开',
        en: '🔗 Merge Same Album: ON',
    },
    '🔗 同專輯連線合併: 關': {
        zhCN: '🔗 同专辑连线合并: 关',
        en: '🔗 Merge Same Album: OFF',
    },
    '🔗 同專輯自動合併: 開啟': {
        zhCN: '🔗 同专辑自动合并: 开启',
        en: '🔗 Auto-Merge Same Album: ON',
    },
    '🔗 同專輯自動合併: 關閉': {
        zhCN: '🔗 同专辑自动合并: 关闭',
        en: '🔗 Auto-Merge Same Album: OFF',
    },
    '目前已開啟「連線自動合併」：同專輯節點拉線連接時將自動合併為同一張卡片（點擊可關閉）': {
        zhCN: '目前已开启「连线自动合并」：同专辑节点拉线连接时将自动合并为同一张卡片（点击可关闭）',
        en: 'Auto-Merge ON: Connecting nodes of the same album merges them into one card (Click to disable)',
    },
    '目前已關閉「連線自動合併」：同專輯節點拉線連接時保持獨立卡片不合併（點擊可開啟）': {
        zhCN: '目前已关闭「连线自动合并」：同专辑节点拉线连接时保持独立卡片不合并（点击可开启）',
        en: 'Auto-Merge OFF: Connecting nodes of the same album keeps them as separate cards (Click to enable)',
    },
    '開啟中：當兩張同專輯卡片連線時，自動合併為單一專輯容器（點擊關閉）': {
        zhCN: '开启中：当两张同专辑卡片连线时，自动合并为单一专辑容器（点击关闭）',
        en: 'ON: Connecting two nodes of the same album automatically merges them (Click to disable)',
    },
    '關閉中：同專輯卡片連線時保持獨立節點，不自動合併（點擊開啟）': {
        zhCN: '关闭中：同专辑卡片连线时保持独立节点，不自动合并（点击开启）',
        en: 'OFF: Connecting nodes of the same album keeps them separate (Click to enable)',
    },
    '🗺️ 縮略圖': {
        zhCN: '🗺️ 缩略图',
        en: '🗺️ MiniMap',
    },
    '顯示或隱藏右下角畫布導覽縮略圖 (MiniMap)': {
        zhCN: '显示或隐藏右下角画布导览缩略图 (MiniMap)',
        en: 'Toggle bottom-right canvas MiniMap',
    },
    '顯示或隱藏右下角畫布縮略導覽圖 (MiniMap)': {
        zhCN: '显示或隐藏右下角画布缩略导览图 (MiniMap)',
        en: 'Toggle bottom-right canvas MiniMap',
    },
    '🎡 駱駝色輪': {
        zhCN: '🎡 骆驼色轮',
        en: '🎡 Camelot Wheel',
    },
    '顯示或隱藏右上角視覺化駱駝色輪圖層 (Camelot Wheel)': {
        zhCN: '显示或隐藏右上角可视化骆驼色轮图层 (Camelot Wheel)',
        en: 'Toggle visual Camelot Wheel overlay',
    },
    '顯示或隱藏右上角 24 格視覺化駱駝色輪 (Camelot Wheel)': {
        zhCN: '显示或隐藏右上角 24 格可视化骆驼色轮 (Camelot Wheel)',
        en: 'Toggle 24-sector visual Camelot Wheel overlay',
    },
    '顯示或隱藏右上角 24 格視覺化駱駝色輪 (Camelot Wheel) 調性導覽圖': {
        zhCN: '显示或隐藏右上角 24 格可视化骆驼色轮 (Camelot Wheel) 调性导览图',
        en: 'Toggle 24-sector visual Camelot Wheel harmonic overlay',
    },
    '✨ 自動排列': {
        zhCN: '✨ 自动排列',
        en: '✨ Auto Layout',
    },
    '✨ 自動排列節點': {
        zhCN: '✨ 自动排列节点',
        en: '✨ Auto Layout Nodes',
    },
    '依拓撲播放順序由上往下垂直自動排列卡片': {
        zhCN: '依拓扑播放顺序由上往下垂直自动排列卡片',
        en: 'Auto-arrange cards vertically by topological play order',
    },
    '依拓撲播放順序由左往右水平自動排列卡片': {
        zhCN: '依拓扑播放顺序由左往右水平自动排列卡片',
        en: 'Auto-arrange cards horizontally by topological play order',
    },
    '🗑️ 清除': {
        zhCN: '🗑️ 清除',
        en: '🗑️ Clear',
    },
    '🗑️ 清除畫布': {
        zhCN: '🗑️ 清除画布',
        en: '🗑️ Clear Canvas',
    },
    '一鍵清空畫布上的所有節點卡片與連線': {
        zhCN: '一键清空画布上的所有节点卡片与连线',
        en: 'Clear all node cards and connections on the canvas',
    },
    '🟢 諧和': {
        zhCN: '🟢 谐和',
        en: '🟢 Harmonic',
    },
    '🟢 調性諧和': {
        zhCN: '🟢 调性谐和',
        en: '🟢 Harmonic',
    },
    '🟡 跨調/差速': {
        zhCN: '🟡 跨调/差速',
        en: '🟡 Noticeable',
    },
    '🔴 衝突': {
        zhCN: '🔴 冲突',
        en: '🔴 Clash',
    },
    '🔴 嚴重衝突': {
        zhCN: '🔴 严重冲突',
        en: '🔴 Key Clash',
    },
    '隱藏圖例': {
        zhCN: '隐藏图例',
        en: 'Hide Legend',
    },
    '顯示連線顏色圖例說明': {
        zhCN: '显示连线颜色图例说明',
        en: 'Show transition edge color legend',
    },
    '圖例': {
        zhCN: '图例',
        en: 'Legend',
    },
    '選取中': {
        zhCN: '选取中',
        en: 'SELECTED',
    },
    '🎛️ 外部連線過渡設定 (Out-Port)': {
        zhCN: '🎛️ 外部连线过渡设置 (Out-Port)',
        en: '🎛️ Out-Port Transition Settings',
    },
    '🗑 刪除此條連線': {
        zhCN: '🗑 删除此条连线',
        en: '🗑 Delete Connection',
    },
    '刪除此卡片': {
        zhCN: '删除此卡片',
        en: 'Delete card',
    },
    '刪除此專輯節點卡片': {
        zhCN: '删除此专辑节点卡片',
        en: 'Delete this album node card',
    },
    '點擊設為選取曲目 (selectedTrack) 並展開/收合波形（不影響當前播放曲目）；按住曲名上下拖曳可調整播放次序': {
        zhCN: '点击设为选取曲目 (selectedTrack) 并展开/收起波形（不影响当前播放曲目）；按住曲名上下拖曳可调整播放次序',
        en: 'Click to select track & toggle waveform; drag up/down to reorder tracks',
    },
    '雙擊立即從頭試聽此曲目（單擊選取）': {
        zhCN: '双击立即从头试听此曲目（单击选取）',
        en: 'Double-click to audition track from start (Click to select)',
    },
    '抽離為獨立單曲卡片': {
        zhCN: '抽离为独立单曲卡片',
        en: 'Extract as standalone track card',
    },
    '抽離為獨立畫布卡片': {
        zhCN: '抽离为独立画布卡片',
        en: 'Extract as standalone canvas card',
    },
    '抽離↗': {
        zhCN: '抽离↗',
        en: 'Extract↗',
    },
    '移除此單曲': {
        zhCN: '移除此单曲',
        en: 'Remove track',
    },
    '收折波形與轉場設定': {
        zhCN: '收起波形与转场设置',
        en: 'Collapse waveform & transition settings',
    },
    '展開波形 (In/Out/Loop) 與轉場設定': {
        zhCN: '展开波形 (In/Out/Loop) 与转场设置',
        en: 'Expand waveform (In/Out/Loop) & transition settings',
    },
    '解析真實音訊波形中...': {
        zhCN: '解析真实音频波形中...',
        en: 'Analyzing real audio waveform...',
    },
    '🔍 512pt 局部放大鏡 (': {
        zhCN: '🔍 512pt 局部放大镜 (',
        en: '🔍 512pt Zoom Loupe (',
    },
    '• 峰值': {
        zhCN: '• 峰值',
        en: '• Peak',
    },
    '🔁 Loop 區間循環播放次數': {
        zhCN: '🔁 Loop 区间循环播放次数',
        en: '🔁 Loop Section Repeat Count',
    },
    '🔁 Loop 次數': {
        zhCN: '🔁 Loop 次数',
        en: '🔁 Loop Count',
    },
    '✂️ 跳過靜音': {
        zhCN: '✂️ 跳过静音',
        en: '✂️ Trim Silence',
    },
    '自動將 Mix-In 設在實際開始發聲的位置，並將 Mix-Out 設在尾端剛進入靜音的位置': {
        zhCN: '自动将 Mix-In 设在实际开始发声的位置，并将 Mix-Out 设在尾端刚进入静音的位置',
        en: 'Auto-set Mix-In at actual sound start and Mix-Out where tail enters silence',
    },
    '淡出淡入時間 (Crossfade)': {
        zhCN: '淡出淡入时间 (Crossfade)',
        en: 'Crossfade Duration',
    },
    '留白停頓秒數 (Silence)': {
        zhCN: '留白停顿秒数 (Silence)',
        en: 'Silence Gap Duration',
    },
    '點擊開啟此連線的過渡模式與秒數設定': {
        zhCN: '点击开启此连线的过渡模式与秒数设置',
        en: 'Click to configure transition mode & duration',
    },
    '點擊切換過渡模式 (Cut -> Crossfade -> Silence) • 右鍵刪除此連線': {
        zhCN: '点击切换过渡模式 (Cut -> Crossfade -> Silence) • 右键删除此连线',
        en: 'Click to cycle transition mode (Cut -> Crossfade -> Silence) • Right-click to delete',
    },
    '刪除此轉場連線': {
        zhCN: '删除此转场连线',
        en: 'Delete this transition connection',
    },
    '🎡 駱駝色輪 (Camelot Wheel)': {
        zhCN: '🎡 骆驼色轮 (Camelot Wheel)',
        en: '🎡 Camelot Wheel',
    },
    '駱駝色輪 (Camelot Wheel)': {
        zhCN: '骆驼色轮 (Camelot Wheel)',
        en: 'Camelot Wheel',
    },
    '隱藏右上角駱駝色輪圖層': {
        zhCN: '隐藏右上角骆驼色轮图层',
        en: 'Hide Camelot Wheel overlay',
    },
    '選取:': {
        zhCN: '选取:',
        en: 'SEL:',
    },
    '當前:': {
        zhCN: '当前:',
        en: 'NOW:',
    },
    '當前：': {
        zhCN: '当前：',
        en: 'NOW:',
    },
    '下首:': {
        zhCN: '下首:',
        en: 'NEXT:',
    },
    '尚未選取曲目': {
        zhCN: '尚未选取曲目',
        en: 'No track selected',
    },
    '尚未載入曲目': {
        zhCN: '尚未加载曲目',
        en: 'No track loaded',
    },
    '佇列無下一首曲目': {
        zhCN: '队列无下一首曲目',
        en: 'No next track in queue',
    },
    '等待排程下一首曲目以分析色輪動線': {
        zhCN: '等待排程下一首曲目以分析色轮动线',
        en: 'Schedule next track to analyze harmonic path',
    },

    // --- MediaLibrary / VirtualTrackList Split & Button Tokens ---
    '🎧 試聽': {
        zhCN: '🎧 试听',
        en: '🎧 Audition',
    },
    '⏹ 停止': {
        zhCN: '⏹ 停止',
        en: '⏹ Stop',
    },
    '🎧 試聽中': {
        zhCN: '🎧 试听中',
        en: '🎧 Auditioning',
    },
    '點擊選取此曲目 (selectedTrack，支援 Ctrl 多選 / Shift 範圍選，不改變當前播放曲目)；可直接拖曳至右側畫布': {
        zhCN: '点击选取此曲目 (selectedTrack，支持 Ctrl 多选 / Shift 范围选，不改变当前播放曲目)；可直接拖曳至右侧画布',
        en: 'Click to select track (Ctrl/Shift multi-select supported); drag into canvas',
    },
    '點擊停止試聽此曲目（自動切回總時間軸當前曲目畫面）': {
        zhCN: '点击停止试听此曲目（自动切回总时间轴当前曲目画面）',
        en: 'Click to stop auditioning (Return to Master Timeline track)',
    },
    '點擊開始試聽此曲目（右側封面與波形同步顯示試聽曲目，不影響駱駝色輪的時間軸當前曲目）': {
        zhCN: '点击开始试听此曲目（右侧封面与波形同步显示试听曲目，不影响骆驼色轮的时间轴当前曲目）',
        en: 'Click to audition track (Previews cover & waveform without interrupting Master Timeline)',
    },
    '從當前智慧媒體庫清單中移除此曲目（點擊上方「💾 保存當前歌單」可將變更寫回 foobar2000 播放清單）': {
        zhCN: '从当前智能媒体库列表中移除此曲目（点击上方「💾 保存当前歌单」可将变更写回 foobar2000 播放列表）',
        en: 'Remove track from current list (Click "💾 Save Playlist" above to write back to foobar2000)',
    },
    '點擊選取專輯代表曲目 (selectedTrack)；可直接將整張專輯拖曳至右側畫布座標': {
        zhCN: '点击选取专辑代表曲目 (selectedTrack)；可直接将整张专辑拖曳至右侧画布坐标',
        en: 'Click to select album; drag entire album into canvas',
    },
    '🎯 推薦混音下一首 (依': {
        zhCN: '🎯 推荐混音下一首 (依',
        en: '🎯 Suggested Next Mix (',
    },
    '🌟 推薦混音下一首 (依': {
        zhCN: '🌟 推荐混音下一首 (依',
        en: '🌟 Suggested Next Mix (',
    },
    '📚 全部媒體庫 (Media Library •': {
        zhCN: '📚 全部媒体库 (Media Library •',
        en: '📚 All Media Library (',
    },
    '📚 全部媒體庫 (未設定 / 0 首)': {
        zhCN: '📚 全部媒体库 (未设置 / 0 首)',
        en: '📚 All Media Library (Not set / 0 Tracks)',
    },
    '⚠️ 無可用歌單（媒體庫未設定）': {
        zhCN: '⚠️ 无可用歌单（媒体库未设置）',
        en: '⚠️ No playlist available (Library not configured)',
    },
    '📥 導入全部 (': {
        zhCN: '📥 导入全部 (',
        en: '📥 Import All (',
    },
    '➕ 導入已選 (': {
        zhCN: '➕ 导入已选 (',
        en: '➕ Import Selected (',
    },
    '已選': {
        zhCN: '已选',
        en: 'Selected:',
    },
    '首 • 總長': {
        zhCN: '首 • 总长',
        en: 'Tracks • Total',
    },
    '首 •': {
        zhCN: '首 •',
        en: 'Tracks •',
    },
    '首曲目': {
        zhCN: '首曲目',
        en: 'Tracks',
    },
    '首)': {
        zhCN: '首)',
        en: 'Tracks)',
    },
    '首': {
        zhCN: '首',
        en: 'Track(s)',
    },
    '次': {
        zhCN: '次',
        en: 'x',
    },
    '評分:': {
        zhCN: '评分:',
        en: 'Score:',
    },
    '分 •': {
        zhCN: '分 •',
        en: ' pts •',
    },
    '分 (': {
        zhCN: '分 (',
        en: ' pts (',
    },
    '分': {
        zhCN: '分',
        en: ' pts',
    },
    '節點 •': {
        zhCN: '节点 •',
        en: 'Nodes •',
    },

    // --- VisualizerPanel / VinylDisc / NowPlayingInfo / VUMeter / SpectrumCanvas ---
    '展開右側主視覺與動態監控面板': {
        zhCN: '展开右侧主视觉与动态监控面板',
        en: 'Expand Visualizer & Monitor panel',
    },
    '點擊展開主視覺與動態監控': {
        zhCN: '点击展开主视觉与动态监控',
        en: 'Click to expand Visualizer & Monitor',
    },
    '播放中': {
        zhCN: '播放中',
        en: 'Playing',
    },
    '待機中': {
        zhCN: '待机中',
        en: 'Standby',
    },
    '尚未播放曲目': {
        zhCN: '尚未播放曲目',
        en: 'No track playing',
    },
    '請點擊播放或時間軸': {
        zhCN: '请点击播放或时间轴',
        en: 'Click Play or Timeline to start',
    },
    '單曲進度': {
        zhCN: '单曲进度',
        en: 'Track Pos',
    },
    '試聽進度': {
        zhCN: '试听进度',
        en: 'Preview Pos',
    },
    '↕ 封面高度': {
        zhCN: '↕ 封面高度',
        en: '↕ Cover Height',
    },
    '↕ 畫布高度': {
        zhCN: '↕ 画布高度',
        en: '↕ Canvas Height',
    },
    '🎛️ 主視覺與動態監控 (Visualizer & Queue)': {
        zhCN: '🎛️ 主视觉与动态监控 (Visualizer & Queue)',
        en: '🎛️ Visualizer & Play Queue',
    },
    '收折 ▶': {
        zhCN: '收起 ▶',
        en: 'Collapse ▶',
    },
    '向右收折主視覺與動態監控面板以擴大畫布空間': {
        zhCN: '向右收起主视觉与动态监控面板以扩大画布空间',
        en: 'Collapse Visualizer panel to expand canvas space',
    },
    '🎨 視覺與監控': {
        zhCN: '🎨 视觉与监控',
        en: '🎨 Visualizer',
    },
    '📜 播放佇列': {
        zhCN: '📜 播放队列',
        en: '📜 Play Queue',
    },
    '線性播放佇列 (Flat Play Queue)': {
        zhCN: '线性播放队列 (Flat Play Queue)',
        en: 'Flat Play Queue',
    },
    '畫布尚無排程曲目，請從左側媒體庫拖曳專輯或單曲至工作流畫布': {
        zhCN: '画布尚无排程曲目，请从左侧媒体库拖曳专辑或单曲至工作流画布',
        en: 'No tracks scheduled. Drag albums or tracks from Media Library into the canvas.',
    },
    '上下拖曳調整專輯封面高度（上限 1:1 正方形，雙擊恢復預設高度）': {
        zhCN: '上下拖曳调整专辑封面高度（上限 1:1 正方形，双击恢复默认高度）',
        en: 'Drag to resize album cover height (Max 1:1 square, double-click to reset)',
    },
    '上下拖曳可調整專輯封面區塊高度（上限為長寬比 1:1，專輯圖片等比例縮放；雙擊恢復預設高度）': {
        zhCN: '上下拖曳可调整专辑封面区块高度（上限为长宽比 1:1，专辑图片等比例缩放；双击恢复默认高度）',
        en: 'Drag vertically to resize album artwork height (Max 1:1 aspect ratio, proportional scaling; double-click to reset)',
    },
    '上下拖曳可單獨調整 60FPS 視覺化引擎 Canvas 的 Y 軸高度（雙擊恢復預設高度，絕不影響上方專輯封面與曲目資訊）': {
        zhCN: '上下拖曳可单独调整 60FPS 可视化引擎 Canvas 的 Y 轴高度（双击恢复默认高度，绝不影响上方专辑封面与曲目信息）',
        en: 'Drag vertically to resize 60FPS Visualizer Canvas height (Double-click to reset)',
    },
    '無專輯封面': {
        zhCN: '无专辑封面',
        en: 'No Artwork',
    },
    '雙擊恢復預設高度': {
        zhCN: '双击恢复默认高度',
        en: 'Double-click to reset height',
    },
    '60FPS 視覺化引擎': {
        zhCN: '60FPS 可视化引擎',
        en: '60FPS Visualizer',
    },
    '頻譜': {
        zhCN: '频谱',
        en: 'Spectrum',
    },
    '示波器': {
        zhCN: '示波器',
        en: 'Oscilloscope',
    },
    '環狀示波器': {
        zhCN: '环状示波器',
        en: 'Circular',
    },
    '上下拖曳調整視覺化畫布高度（雙擊恢復預設高度）': {
        zhCN: '上下拖曳调整可视化画布高度（双击恢复默认高度）',
        en: 'Drag vertically to resize visualizer height (Double-click to reset)',
    },

    // --- MasterTimeline & Player Cue Status ---
    '⏮ 上一首': {
        zhCN: '⏮ 上一首',
        en: '⏮ Prev',
    },
    '跳至上一首曲目起點 (快捷鍵: [ )': {
        zhCN: '跳至上一首曲目起点 (快捷键: [ )',
        en: 'Jump to previous track start (Shortcut: [ )',
    },
    '跳至播放佇列上一首 (快捷鍵 [)': {
        zhCN: '跳至播放队列上一首 (快捷键 [)',
        en: 'Previous track in queue (Shortcut [)',
    },
    '⏸ 暫停': {
        zhCN: '⏸ 暂停',
        en: '⏸ Pause',
    },
    '▶ 播放': {
        zhCN: '▶ 播放',
        en: '▶ Play',
    },
    '播放 / 暫停 (快捷鍵: Space)': {
        zhCN: '播放 / 暂停 (快捷键: Space)',
        en: 'Play / Pause (Shortcut: Space)',
    },
    '播放 / 暫停 (快捷鍵 Space)': {
        zhCN: '播放 / 暂停 (快捷键 Space)',
        en: 'Play / Pause (Shortcut Space)',
    },
    '⏭ 下一首': {
        zhCN: '⏭ 下一首',
        en: '⏭ Next',
    },
    '跳至下一首曲目起點 (快捷鍵: ] )': {
        zhCN: '跳至下一首曲目起点 (快捷键: ] )',
        en: 'Jump to next track start (Shortcut: ] )',
    },
    '跳至播放佇列下一首 (快捷鍵 ])': {
        zhCN: '跳至播放队列下一首 (快捷键 ])',
        en: 'Next track in queue (Shortcut ])',
    },
    '🔁 循環: 開啟': {
        zhCN: '🔁 循环: 开启',
        en: '🔁 Loop: ON',
    },
    '🔁 循環: 關閉': {
        zhCN: '🔁 循环: 关闭',
        en: '🔁 Loop: OFF',
    },
    '循環: 開啟': {
        zhCN: '循环: 开启',
        en: 'Loop: ON',
    },
    '循環: 關閉': {
        zhCN: '循环: 关闭',
        en: 'Loop: OFF',
    },
    '開啟或關閉整條 Master 總時間軸循環播放': {
        zhCN: '开启或关闭整条 Master 总时间轴循环播放',
        en: 'Toggle Master Timeline loop playback',
    },
    '當播放至總時間軸末尾時，自動回到第一首循環播放': {
        zhCN: '当播放至总时间轴末尾时，自动回到第一首循环播放',
        en: 'Loop back to the first track when reaching the end of Master Timeline',
    },
    'Master 時間軸：': {
        zhCN: 'Master 时间轴：',
        en: 'Master Timeline:',
    },
    '⌨️ 快捷鍵:': {
        zhCN: '⌨️ 快捷键:',
        en: '⌨️ Shortcuts:',
    },
    'Space 播放': {
        zhCN: 'Space 播放',
        en: 'Space Play',
    },
    '[/] 切歌': {
        zhCN: '[/] 切歌',
        en: '[/] Prev/Next',
    },
    'L 鎖定': {
        zhCN: 'L 锁定',
        en: 'L Lock',
    },
    '音量': {
        zhCN: '音量',
        en: 'Vol',
    },
    '時間軸尚無排程曲目 — 請在上方畫布連線節點以自動生成拓撲播放佇列': {
        zhCN: '时间轴尚无排程曲目 — 请在上方画布连线节点以自动生成拓扑播放队列',
        en: 'No tracks on timeline — Connect nodes on canvas to build topological queue',
    },
    'Mix-In 進歌點': {
        zhCN: 'Mix-In 进歌点',
        en: 'Mix-In Point',
    },
    'Mix-Out 轉場區間': {
        zhCN: 'Mix-Out 转场区间',
        en: 'Mix-Out Zone',
    },
    '總時間軸循環重播中': {
        zhCN: '总时间轴循环重播中',
        en: 'Master Timeline Looping',
    },
    'Silence 靜音過渡中': {
        zhCN: 'Silence 静音过渡中',
        en: 'Silence Gap Active',
    },
    '未標記有效 Camelot 調性': {
        zhCN: '未标记有效 Camelot 调性',
        en: 'No valid Camelot key tagged',
    },
};

// 依字串長度由長到短排序，供子字串替換時優先匹配完整長句
const SORTED_PHRASE_KEYS = Object.keys(I18N_PHRASE_DICT).sort(
    (a, b) => b.length - a.length
);

interface DynamicPatternRule {
    regex: RegExp;
    zhCN: (...matches: string[]) => string;
    en: (...matches: string[]) => string;
}

// 處理含動態數值、曲名、BPM、調性之句型
const DYNAMIC_RULES: readonly DynamicPatternRule[] = [
    {
        // "2 節點 • 1 連線"
        regex: /^(\d+)\s*節點\s*•\s*(\d+)\s*連線$/,
        zhCN: (_m, n, e) => `${n} 节点 • ${e} 连线`,
        en: (_m, n, e) => `${n} Nodes • ${e} Edges`,
    },
    {
        // "↕ 封面高度 184px"
        regex: /^↕\s*封面高度\s*(\d+)px$/,
        zhCN: (_m, h) => `↕ 封面高度 ${h}px`,
        en: (_m, h) => `↕ Cover Height ${h}px`,
    },
    {
        // "↕ 畫布高度 124px"
        regex: /^↕\s*畫布高度\s*(\d+)px$/,
        zhCN: (_m, h) => `↕ 画布高度 ${h}px`,
        en: (_m, h) => `↕ Canvas Height ${h}px`,
    },
    {
        // "🎛️ 主視覺與動態監控 (3)"
        regex: /^🎛️\s*主視覺與動態監控\s*\((\d+)\)$/,
        zhCN: (_m, n) => `🎛️ 主视觉与动态监控 (${n})`,
        en: (_m, n) => `🎛️ Visualizer & Monitor (${n})`,
    },
    {
        // "🗂️ 智慧媒體庫 (6)"
        regex: /^🗂️\s*智慧媒體庫\s*\((\d+)\)$/,
        zhCN: (_m, n) => `🗂️ 智能媒体库 (${n})`,
        en: (_m, n) => `🗂️ Media Library (${n})`,
    },
    {
        // "共 6 首"
        regex: /^共\s*(\d+)\s*首$/,
        zhCN: (_m, n) => `共 ${n} 首`,
        en: (_m, n) => `${n} Tracks`,
    },
    {
        // "6 / 6 首"
        regex: /^(\d+)\s*\/\s*(\d+)\s*首$/,
        zhCN: (_m, a, b) => `${a} / ${b} 首`,
        en: (_m, a, b) => `${a} / ${b} Tracks`,
    },
    {
        // "3 首 • 總長 12m:09s" or "3 首 • 總長 729s"
        // 造成原錯誤的原因：舊正則僅匹配純數字秒數 (\d+)s，升級為 1h:10m:50s 格式後會導致簡中/英文翻譯失效。
        // 本次修改的目的：放寬時間群組匹配格式，相容智慧時分秒字串。
        regex: /^(\d+)\s*首\s*•\s*總長\s*(.+)$/,
        zhCN: (_m, c, d) => `${c} 首 • 总长 ${d.trim()}`,
        en: (_m, c, d) => `${c} Tracks • Total ${d.trim()}`,
    },
    {
        // "📚 全部媒體庫 (Media Library • 6 首)"
        regex: /^📚\s*全部媒體庫\s*\(Media Library\s*•\s*(\d+)\s*首\)$/,
        zhCN: (_m, n) => `📚 全部媒体库 (Media Library • ${n} 首)`,
        en: (_m, n) => `📚 All Media Library (${n} Tracks)`,
    },
    {
        // "🎵 Default (6 首)"
        regex: /^🎵\s*(.+?)\s*\((\d+)\s*首\)(.*)$/,
        zhCN: (_m, name, n, tail) => `🎵 ${name} (${n} 首)${tail}`,
        en: (_m, name, n, tail) => `🎵 ${name} (${n} Tracks)${tail}`,
    },
    {
        // "📥 導入全部 (6 首)"
        regex: /^📥\s*導入全部\s*\((\d+)\s*首\)$/,
        zhCN: (_m, n) => `📥 导入全部 (${n} 首)`,
        en: (_m, n) => `📥 Import All (${n})`,
    },
    {
        // "➕ 導入已選 (0 首)"
        regex: /^➕\s*導入已選\s*\((\d+)\s*首\)$/,
        zhCN: (_m, n) => `➕ 导入已选 (${n} 首)`,
        en: (_m, n) => `➕ Import Selected (${n})`,
    },
    {
        // "已選 2 首"
        regex: /^已選\s*(\d+)\s*首$/,
        zhCN: (_m, n) => `已选 ${n} 首`,
        en: (_m, n) => `${n} Selected`,
    },
    {
        // "🎯 推薦混音下一首 (依 128BPM / 8A)"
        regex: /^(🎯|🌟)\s*推薦混音下一首\s*\(依\s*(.+?)\)$/,
        zhCN: (_m, icon, spec) => `${icon} 推荐混音下一首 (依 ${spec})`,
        en: (_m, icon, spec) => `${icon} Suggested Next Mix (${spec})`,
    },
    {
        // "83分 (Pitch -3.1%)" or "95分 (Pitch 0.0%)"
        regex: /^(\d+)\s*分\s*\((.+?)\)$/,
        zhCN: (_m, score, pitch) => `${score}分 (${pitch})`,
        en: (_m, score, pitch) => `${score} pts (${pitch})`,
    },
    {
        // "• 83分 (Pitch -3.1%)" or "Cut 0s • 83分 (Pitch -3.1%)"
        regex: /^(.+?)\s*•\s*(\d+)\s*分\s*\((.+?)\)$/,
        zhCN: (_m, prefix, score, pitch) => `${prefix} • ${score}分 (${pitch})`,
        en: (_m, prefix, score, pitch) =>
            `${prefix} • ${score} pts (${pitch})`,
    },
    {
        // "128 BPM | Key 8A | 單曲進度 2m:31.1s"
        regex: /^(\d+)\s*BPM\s*\|\s*Key\s*([^|]+?)\s*\|\s*單曲進度\s*(.+)$/,
        zhCN: (_m, bpm, key, sec) =>
            `${bpm} BPM | Key ${key.trim()} | 单曲进度 ${sec.trim()}`,
        en: (_m, bpm, key, sec) =>
            `${bpm} BPM | Key ${key.trim()} | Track Pos ${sec.trim()}`,
    },
    {
        // "128 BPM | Key 8A | 試聽進度 2m:31.1s"
        regex: /^(\d+)\s*BPM\s*\|\s*Key\s*([^|]+?)\s*\|\s*試聽進度\s*(.+)$/,
        zhCN: (_m, bpm, key, sec) =>
            `${bpm} BPM | Key ${key.trim()} | 试听进度 ${sec.trim()}`,
        en: (_m, bpm, key, sec) =>
            `${bpm} BPM | Key ${key.trim()} | Preview Pos ${sec.trim()}`,
    },
    {
        // "Aero Pulse • 3 首曲目"
        regex: /^(.+?)\s*•\s*(\d+)\s*首曲目$/,
        zhCN: (_m, artist, n) => `${artist} • ${n} 首曲目`,
        en: (_m, artist, n) =>
            `${artist} • ${n} Track${Number(n) > 1 ? 's' : ''}`,
    },
    {
        // "3 首" / "1 首"
        regex: /^(\d+)\s*首$/,
        zhCN: (_m, n) => `${n} 首`,
        en: (_m, n) => `${n} Track${Number(n) > 1 ? 's' : ''}`,
    },
    {
        // "1 次" ~ "8 次"
        regex: /^(\d+)\s*次$/,
        zhCN: (_m, n) => `${n} 次`,
        en: (_m, n) => `${n}x`,
    },
    {
        // "設定此曲目在 [Loop In ~ Loop Out] 區間重複播放 2 次後再繼續推進"
        regex: /^設定此曲目在\s*\[Loop In ~ Loop Out\]\s*區間重複播放\s*(\d+)\s*次後再繼續推進$/,
        zhCN: (_m, n) =>
            `设置此曲目在 [Loop In ~ Loop Out] 区间重复播放 ${n} 次后再继续推进`,
        en: (_m, n) =>
            `Repeat [Loop In ~ Loop Out] section ${n} time(s) before advancing`,
    },
    {
        // "⇊ 往下一首 (Solar Flare) 的過渡模式"
        regex: /^⇊\s*往下一首\s*\((.+?)\)\s*的過渡模式$/,
        zhCN: (_m, title) => `⇊ 往下一首 (${title}) 的过渡模式`,
        en: (_m, title) => `⇊ Transition to Next (${title})`,
    },
    {
        // "8A → 7A • 五度圈相鄰諧和 (±1 順暢接歌)"
        regex: /^(.+?)\s*•\s*同調無縫完美鎖定$/,
        zhCN: (_m, keys) => `${keys} • 同调无缝完美锁定`,
        en: (_m, keys) => `${keys} • Exact Key Match (Seamless Mix)`,
    },
    {
        regex: /^(.+?)\s*•\s*關係大小調轉換\s*\(內外圈諧和\)$/,
        zhCN: (_m, keys) => `${keys} • 关系大小调转换 (内外圈谐和)`,
        en: (_m, keys) => `${keys} • Relative Major/Minor (Harmonic)`,
    },
    {
        regex: /^(.+?)\s*•\s*五度圈相鄰諧和\s*\(±1 順暢接歌\)$/,
        zhCN: (_m, keys) => `${keys} • 五度圈相邻谐和 (±1 顺畅接歌)`,
        en: (_m, keys) => `${keys} • Adjacent Fifths (±1 Smooth Mix)`,
    },
    {
        regex: /^(.+?)\s*•\s*全音能量推進\s*\(±2 Energy Boost\)$/,
        zhCN: (_m, keys) => `${keys} • 全音能量推进 (±2 Energy Boost)`,
        en: (_m, keys) => `${keys} • Whole-Tone Energy Boost (±2)`,
    },
    {
        regex: /^(.+?)\s*•\s*跨度轉場\s*\(建議搭配 Cut 或留白\)$/,
        zhCN: (_m, keys) => `${keys} • 跨度转场 (建议搭配 Cut 或留白)`,
        en: (_m, keys) => `${keys} • Key Jump (Use Cut or Silence)`,
    },
    {
        // harmonicMixing messages in tooltips
        regex: /^完全同調\s*\((.+?)\)，可無縫疊歌(.*)$/,
        zhCN: (_m, k, tail) =>
            `完全同调 (${k})，可无缝叠歌${translateTail(tail, 'zh-CN')}`,
        en: (_m, k, tail) =>
            `Exact Key (${k}), seamless blend${translateTail(tail, 'en')}`,
    },
    {
        regex: /^關係大小調轉換\s*\((.+?)\)(.*)$/,
        zhCN: (_m, k, tail) =>
            `关系大小调转换 (${k})${translateTail(tail, 'zh-CN')}`,
        en: (_m, k, tail) =>
            `Relative Major/Minor (${k})${translateTail(tail, 'en')}`,
    },
    {
        regex: /^五度圈相鄰諧波\s*\((.+?)\)(.*)$/,
        zhCN: (_m, k, tail) =>
            `五度圈相邻谐波 (${k})${translateTail(tail, 'zh-CN')}`,
        en: (_m, k, tail) =>
            `Adjacent Camelot Key (${k})${translateTail(tail, 'en')}`,
    },
    {
        regex: /^能量提升轉調\s*\((.+?)\)(.*)$/,
        zhCN: (_m, k, tail) =>
            `能量提升转调 (${k})${translateTail(tail, 'zh-CN')}`,
        en: (_m, k, tail) => `Energy Boost (${k})${translateTail(tail, 'en')}`,
    },
    {
        regex: /^調性衝突\s*\((.+?)\)，建議以 Cut 或 Silence 轉場(.*)$/,
        zhCN: (_m, k, tail) =>
            `调性冲突 (${k})，建议以 Cut 或 Silence 转场${translateTail(tail, 'zh-CN')}`,
        en: (_m, k, tail) =>
            `Key Clash (${k}), Cut or Silence recommended${translateTail(tail, 'en')}`,
    },
    {
        // Preset slot tooltips: "記憶槽 S1 (已存檔: 2 節點)\n• 左鍵：載入此記憶槽\n• 右鍵：將目前畫布覆寫存入 S1"
        regex: /^記憶槽\s*(S\d+)\s*\(已存檔:\s*(\d+)\s*節點\)\n•\s*左鍵：載入此記憶槽\n•\s*右鍵：將目前畫布覆寫存入\s*(S\d+)$/,
        zhCN: (_m, s1, n, s2) =>
            `记忆槽 ${s1} (已存档: ${n} 节点)\n• 左键：加载此记忆槽\n• 右键：将当前画布覆盖存入 ${s2}`,
        en: (_m, s1, n, s2) =>
            `Slot ${s1} (Saved: ${n} nodes)\n• Left-click: Load slot\n• Right-click: Overwrite ${s2} with current canvas`,
    },
    {
        regex: /^記憶槽\s*(S\d+)\s*\(空白\)\n•\s*左鍵\s*\/\s*右鍵：將目前畫布存入\s*(S\d+)$/,
        zhCN: (_m, s1, s2) =>
            `记忆槽 ${s1} (空白)\n• 左键 / 右键：将当前画布存入 ${s2}`,
        en: (_m, s1, s2) =>
            `Slot ${s1} (Empty)\n• Left / Right-click: Save current canvas to ${s2}`,
    },
    {
        // Rename playlist header: ✏️ 重新命名播放清單「...」
        regex: /^✏️\s*重新命名播放清單「(.+?)」$/,
        zhCN: (_m, name) => `✏️ 重命名播放列表「${name}」`,
        en: (_m, name) => `✏️ Rename Playlist "${name}"`,
    },
    {
        regex: /^重新命名播放清單「(.+?)」$/,
        zhCN: (_m, name) => `重命名播放列表「${name}」`,
        en: (_m, name) => `Rename Playlist "${name}"`,
    },
    {
        regex: /^刪除播放清單「(.+?)」$/,
        zhCN: (_m, name) => `删除播放列表「${name}」`,
        en: (_m, name) => `Delete Playlist "${name}"`,
    },
    {
        regex: /^將當前智慧媒體庫清單\s*\((\d+)\s*首\)\s*覆寫保存至「(.+?)」$/,
        zhCN: (_m, n, name) =>
            `将当前智能媒体库列表 (${n} 首) 覆盖保存至「${name}」`,
        en: (_m, n, name) =>
            `Overwrite playlist "${name}" with current list (${n} tracks)`,
    },
    {
        // HeaderBar dynamic tooltips
        regex: /^已連線至 foobar2000 WebView2 宿主\s*•\s*(.+?)\s*\(點擊開啟橋接診斷\)$/,
        zhCN: (_m, dev) =>
            `已连接至 foobar2000 WebView2 宿主 • ${dev} (点击开启桥接诊断)`,
        en: (_m, dev) =>
            `Connected to foobar2000 WebView2 Host • ${dev} (Click for Bridge Diagnostics)`,
    },
    {
        regex: /^開發預覽模式\s*•\s*(.+?)\s*\(點擊開啟實機掛載教學\)$/,
        zhCN: (_m, dev) => `开发预览模式 • ${dev} (点击开启实机挂载教程)`,
        en: (_m, dev) =>
            `Dev Preview Mode • ${dev} (Click for Native Mounting Guide)`,
    },
    {
        regex: /^已連線至 foobar2000 WebView2 宿主\s*•\s*(.+?)$/,
        zhCN: (_m, dev) => `已连接至 foobar2000 WebView2 宿主 • ${dev}`,
        en: (_m, dev) => `Connected to foobar2000 WebView2 Host • ${dev}`,
    },
    {
        regex: /^開發預覽模式\s*•\s*(.+?)\s*\(點擊查看實機掛載教學\)$/,
        zhCN: (_m, dev) => `开发预览模式 • ${dev} (点击查看实机挂载教程)`,
        en: (_m, dev) =>
            `Dev Preview Mode • ${dev} (Click to view setup guide)`,
    },
    {
        // PresetManager slot tooltips
        regex: /^點擊載入 Slot\s*(\d+)；按住 Shift 點擊可覆寫存檔$/,
        zhCN: (_m, id) => `点击加载 Slot ${id}；按住 Shift 点击可覆盖存档`,
        en: (_m, id) =>
            `Click to load Slot ${id}; Hold Shift + Click to overwrite`,
    },
    {
        regex: /^點擊將當前畫布存入 Slot\s*(\d+)$/,
        zhCN: (_m, id) => `点击将当前画布存入 Slot ${id}`,
        en: (_m, id) => `Click to save current canvas into Slot ${id}`,
    },
    {
        // ThemePreferencesMenu gear tooltip
        regex: /^偏好設定：切換面板設計主題（目前：(.+?)）$/,
        zhCN: (_m, name) =>
            `偏好设置：切换面板设计主题（当前：${translateStringByLang(name, 'zh-CN')}）`,
        en: (_m, name) =>
            `Preferences: Switch panel theme (Current: ${translateStringByLang(name, 'en')})`,
    },
    {
        // HostBridgeModal wsStatus badge
        regex: /^狀態:\s*(.+)$/,
        zhCN: (_m, st) => `状态: ${st}`,
        en: (_m, st) => `Status: ${st}`,
    },
    {
        // Cue status labels
        regex: /^Loop\s*區間循環中\s*\(x(\d+)\)$/,
        zhCN: (_m, n) => `Loop 区间循环中 (x${n})`,
        en: (_m, n) => `Looping Section (x${n})`,
    },
    {
        regex: /^Silence\s*靜音過渡中\s*\(([\d.]+)s\)$/,
        zhCN: (_m, s) => `Silence 静音过渡中 (${s}s)`,
        en: (_m, s) => `Silence Gap (${s}s)`,
    },
    {
        regex: /^Crossfade\s*淡出過渡\s*\((\d+)%\)$/,
        zhCN: (_m, p) => `Crossfade 淡出过渡 (${p}%)`,
        en: (_m, p) => `Crossfade Out (${p}%)`,
    },
    {
        regex: /^Crossfade\s*淡入過渡\s*\((\d+)%\)$/,
        zhCN: (_m, p) => `Crossfade 淡入过渡 (${p}%)`,
        en: (_m, p) => `Crossfade In (${p}%)`,
    },
];

function translateTail(tail: string, lang: 'zh-CN' | 'en'): string {
    if (!tail) return '';
    let out = tail;
    if (lang === 'zh-CN') {
        out = out
            .replace(/跨速混音/g, '跨速混音')
            .replace(
                /（點擊於媒體庫與畫布高亮定位此曲目；可直接拖曳至畫布建立卡片）/g,
                '（点击于媒体库与画布高亮定位此曲目；可直接拖曳至画布创建卡片）'
            );
    } else {
        out = out
            .replace(/\(跨速混音\s*Δ([\d.]+)\s*BPM\)/g, '(Tempo Δ$1 BPM)')
            .replace(
                /（點擊於媒體庫與畫布高亮定位此曲目；可直接拖曳至畫布建立卡片）/g,
                ' (Click to locate in Library & Canvas; drag to create node)'
            );
    }
    return out;
}

// 針對複合句或分段文字中的子詞條對照（確保拆分為多個 TextNode 的片段或 <pre> 程式碼註解也能精準翻譯）
const FRAGMENT_REPLACEMENTS: ReadonlyArray<{
    trad: string;
    zhCN: string;
    en: string;
}> = [
    {
        trad: '（點擊於媒體庫與畫布高亮定位此曲目；可直接拖曳至畫布建立卡片）',
        zhCN: '（点击于媒体库与画布高亮定位此曲目；可直接拖曳至画布创建卡片）',
        en: ' (Click to highlight in Library & Canvas; drag to create node)',
    },
    {
        trad: '// [1] 媒體庫與本機播放清單讀取 (Library & Playlists)',
        zhCN: '// [1] 媒体库与本机播放列表读取 (Library & Playlists)',
        en: '// [1] Media Library & Local Playlists (Library & Playlists)',
    },
    {
        trad: '// [2] 零彈窗曲目切換、微秒級定位與 Crossfade 音量控制 (Playback & Transitions)',
        zhCN: '// [2] 零弹窗曲目切换、微秒级定位与 Crossfade 音量控制 (Playback & Transitions)',
        en: '// [2] Popup-free Track Switching, Seek & Crossfade Volume Control',
    },
    {
        trad: '// 使用 library.addToPlaylist 直接建立記憶體 metadb_handle，避免 process_locations_async 彈出 Processing files 視窗',
        zhCN: '// 使用 library.addToPlaylist 直接建立内存 metadb_handle，避免 process_locations_async 弹出 Processing files 窗口',
        en: '// Use library.addToPlaylist to build in-memory metadb_handle without popup dialogs',
    },
    {
        trad: '// 0..100 支援 Crossfade 動態曲線',
        zhCN: '// 0..100 支持 Crossfade 动态曲线',
        en: '// 0..100 supports dynamic Crossfade curve',
    },
    {
        trad: '// 支援 Silence 靜音過渡區間',
        zhCN: '// 支持 Silence 静音过渡区间',
        en: '// Supports Silence gap transition',
    },
    {
        trad: '// [3] 60FPS 即時頻譜與雙聲道立體聲 VU 電平 (Audio Visualization)',
        zhCN: '// [3] 60FPS 实时频谱与双声道立体声 VU 电平 (Audio Visualization)',
        en: '// [3] 60FPS Real-time Spectrum & Stereo VU Meter (Audio Visualization)',
    },
    {
        trad: '// [4] 宿主視窗控制與事件訂閱 (Window & Events)',
        zhCN: '// [4] 宿主窗口控制与事件订阅 (Window & Events)',
        en: '// [4] Host Window Controls & Event Subscriptions (Window & Events)',
    },
    {
        trad: '/* 自動刷新曲庫 */',
        zhCN: '/* 自动刷新曲库 */',
        en: '/* Auto refresh library */',
    },
    {
        trad: '⚠️ 確定要將當前智慧媒體庫內的',
        zhCN: '⚠️ 确定要将当前智能媒体库内的',
        en: '⚠️ Overwrite foobar2000 playlist with',
    },
    {
        trad: '曲目覆寫入 foobar2000 播放清單「',
        zhCN: '曲目覆盖写入 foobar2000 播放列表「',
        en: 'tracks into "',
    },
    {
        trad: '🗑️ 確定要從 foobar2000 永久刪除播放清單「',
        zhCN: '🗑️ 确定要从 foobar2000 永久删除播放列表「',
        en: '🗑️ Permanently delete foobar2000 playlist "',
    },
    {
        trad: '」（原',
        zhCN: '」（原',
        en: '" (Originally',
    },
    {
        trad: '」（共',
        zhCN: '」（共',
        en: '" (Total',
    },
    {
        trad: '首）嗎？',
        zhCN: '首）吗？',
        en: 'tracks)?',
    },
    {
        trad: '秒',
        zhCN: '秒',
        en: 's',
    },
];

export function translateStringByLang(
    rawText: string,
    lang: LanguageId
): string {
    if (lang === 'zh-TW' || !rawText) return rawText;

    const trimmed = rawText.trim();
    if (!trimmed) return rawText;

    // 1. 優先精準匹配完整字典詞條
    const exactEntry = I18N_PHRASE_DICT[trimmed];
    if (exactEntry) {
        const target = lang === 'zh-CN' ? exactEntry.zhCN : exactEntry.en;
        return rawText.replace(trimmed, target);
    }

    // 2. 匹配含動態數值/曲名之正則句型
    for (const rule of DYNAMIC_RULES) {
        const match = rule.regex.exec(trimmed);
        if (match) {
            const replaced =
                lang === 'zh-CN' ? rule.zhCN(...match) : rule.en(...match);
            return rawText.replace(trimmed, replaced);
        }
    }

    // 3. 若未包含任何中文字元則直接回傳
    if (!/[\u4e00-\u9fff]/.test(rawText)) {
        return rawText;
    }

    // 4. 針對包含多個詞條的複合字串進行字典與片段替換
    let result = rawText;
    for (const key of SORTED_PHRASE_KEYS) {
        if (result.includes(key)) {
            const entry = I18N_PHRASE_DICT[key];
            result = result.split(key).join(lang === 'zh-CN' ? entry.zhCN : entry.en);
        }
    }

    for (const frag of FRAGMENT_REPLACEMENTS) {
        if (result.includes(frag.trad)) {
            result = result
                .split(frag.trad)
                .join(lang === 'zh-CN' ? frag.zhCN : frag.en);
        }
    }

    return result;
}

// 儲存每個 TextNode 與屬性之「原始繁體中文基準值 (baseZh)」與「上次套用之翻譯結果 (lastApplied)」
interface NodeTranslationRecord {
    baseZh: string;
    lastApplied: string;
}

const originalTextNodeMap = new WeakMap<Text, NodeTranslationRecord>();
const originalAttrMap = new WeakMap<
    Element,
    Record<string, NodeTranslationRecord>
>();

const TRANSLATABLE_ATTRS = ['title', 'placeholder', 'aria-label'] as const;

export function applyLanguageToDomTree(
    root: Node,
    lang: LanguageId
): void {
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );

    let current: Node | null = walker.currentNode;
    while (current) {
        if (current.nodeType === Node.TEXT_NODE) {
            const textNode = current as Text;
            const parentTag = textNode.parentElement?.tagName;
            if (parentTag !== 'SCRIPT' && parentTag !== 'STYLE') {
                const currentVal = textNode.nodeValue ?? '';
                let record = originalTextNodeMap.get(textNode);

                // 僅當首次遇見此節點，或 React 因狀態改變而寫入與「上次翻譯結果 (lastApplied)」不同的新文字時，才更新原始繁體基準值 baseZh
                if (!record) {
                    record = {
                        baseZh: currentVal,
                        lastApplied: currentVal,
                    };
                } else if (currentVal !== record.lastApplied) {
                    record.baseZh = currentVal;
                }

                const nextVal = translateStringByLang(record.baseZh, lang);
                record.lastApplied = nextVal;
                originalTextNodeMap.set(textNode, record);

                if (currentVal !== nextVal) {
                    textNode.nodeValue = nextVal;
                }
            }
        } else if (current.nodeType === Node.ELEMENT_NODE) {
            const el = current as Element;
            let attrRecords = originalAttrMap.get(el);
            if (!attrRecords) {
                attrRecords = {};
                originalAttrMap.set(el, attrRecords);
            }

            for (const attr of TRANSLATABLE_ATTRS) {
                if (el.hasAttribute(attr)) {
                    const currentAttr = el.getAttribute(attr) ?? '';
                    let record = attrRecords[attr];

                    if (!record) {
                        record = {
                            baseZh: currentAttr,
                            lastApplied: currentAttr,
                        };
                    } else if (currentAttr !== record.lastApplied) {
                        record.baseZh = currentAttr;
                    }

                    const nextAttr = translateStringByLang(record.baseZh, lang);
                    record.lastApplied = nextAttr;
                    attrRecords[attr] = record;

                    if (currentAttr !== nextAttr) {
                        el.setAttribute(attr, nextAttr);
                    }
                }
            }
        }
        current = walker.nextNode();
    }
}
