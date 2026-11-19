import { useEffect, useState } from 'react';
import type { BridgeLogEntry } from '../../api/mockBridge';
import {
    bridgeApi,
    clearBridgeLogs,
    isFoobarWebView,
    probeFoobarHostEnvironment,
    simulateHostEvent,
    subscribeToBridgeLogs,
} from '../../api/mockBridge';
import type { WebSocketConnectionStatus } from '../../api/websocket';
import { audioStreamSocket } from '../../api/websocket';
import { usePlayerStore } from '../../store/usePlayerStore';

// ============================================================================
// [方向 A] HostBridgeModal：foobar2000 (foo_ui_webview2) 實機橋接診斷與本地安裝指南視窗
// ============================================================================

interface HostBridgeModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type ModalTab = 'guide' | 'diagnostics' | 'protocol';

export function HostBridgeModal({ isOpen, onClose }: HostBridgeModalProps) {
    const [activeTab, setActiveTab] = useState<ModalTab>('guide');
    const [logs, setLogs] = useState<BridgeLogEntry[]>([]);
    const [wsEndpointInput, setWsEndpointInput] = useState(
        audioStreamSocket.getEndpointUrl()
    );
    const [wsStatus, setWsStatus] = useState<WebSocketConnectionStatus>(
        audioStreamSocket.getStatus()
    );

    const hostStatus = usePlayerStore((s) => s.hostStatus);
    const updateAudioMeters = usePlayerStore((s) => s.updateAudioMeters);

    // 訂閱 Bridge IPC 即時通訊紀錄与 WebSocket 狀態
    useEffect(() => {
        if (!isOpen) return;
        const unsubLogs = subscribeToBridgeLogs((nextLogs) => {
            setLogs([...nextLogs]);
        });
        const unsubWs = audioStreamSocket.subscribeStatus((status, endpoint) => {
            setWsStatus(status);
            setWsEndpointInput(endpoint);
        });
        return () => {
            unsubLogs();
            unsubWs();
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const nativeWebViewDetected = isFoobarWebView();
    const probeInfo = probeFoobarHostEnvironment();

    const handleSimulateHandshake = () => {
        simulateHostEvent({
            event: 'HOST_HANDSHAKE_ACK',
            payload: {
                foobarVersion: 'v2.1.5 (x64)',
                componentVersion: 'foo_ui_webview2 (foo-webview-sdk v2.2)',
                audioDevice: 'ASIO : Pioneer DJ DJM-900NXS2',
            },
        });
    };

    const handleConnectWs = () => {
        audioStreamSocket.connect(wsEndpointInput.trim(), updateAudioMeters);
    };

    const handleDisconnectWs = () => {
        audioStreamSocket.disconnect();
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <div
                className="w-full max-w-4xl max-h-[88vh] flex flex-col bg-slate-900 border border-slate-700/90 rounded-2xl shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* 頂部標題列 */}
                <div className="flex items-center justify-between px-5 py-3.5 bg-slate-950/90 border-b border-slate-800">
                    <div className="flex items-center gap-3">
                        <span
                            className={`w-3 h-3 rounded-full ${
                                hostStatus.isConnectedToBridge
                                    ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]'
                                    : 'bg-cyan-400 animate-pulse'
                            }`}
                        />
                        <div>
                            <h2 className="text-sm font-bold text-slate-100">
                                🔌 foobar2000 WebView2 (foo_ui_webview2) 宿主橋接中心與安裝指南
                            </h2>
                            <p className="text-[11px] text-slate-400">
                                容器偵測：
                                {nativeWebViewDetected
                                    ? '✅ 已偵測到 window.fb2k (BridgeCore) 原生容器'
                                    : '🌐 瀏覽器預覽環境（支援模擬握手與離線打包匯出）'}{' '}
                                • 音訊輸出：{hostStatus.audioDevice}
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition cursor-pointer"
                    >
                        ✕ 關閉
                    </button>
                </div>

                {/* 分頁切換導覽列 */}
                <div className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 border-b border-slate-800 text-xs font-semibold">
                    <button
                        type="button"
                        onClick={() => setActiveTab('guide')}
                        className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${
                            activeTab === 'guide'
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                    >
                        📦 1. 本地 foobar2000 安裝與掛載步驟
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('diagnostics')}
                        className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${
                            activeTab === 'diagnostics'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                    >
                        🔌 2. Bridge 連線診斷與訊號模擬器
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('protocol')}
                        className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${
                            activeTab === 'protocol'
                                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/50'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                    >
                        📡 3. foo_ui_webview2 (fb2k) 通訊協定規格
                    </button>
                </div>

                {/* 內容區 */}
                <div className="p-5 overflow-y-auto space-y-4 text-xs text-slate-300 leading-relaxed">
                    {activeTab === 'guide' && (
                        <div className="space-y-4">
                            <div className="p-3.5 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-cyan-200">
                                💡 <strong>核心概念說明：</strong>
                                本專案已配置 <code className="px-1.5 py-0.5 rounded bg-slate-900 text-cyan-300">base: './'</code> 相對路徑打包與雙向 <code className="px-1.5 py-0.5 rounded bg-slate-900 text-cyan-300">window.fb2k (foo-webview-sdk v2.2)</code> 橋接器。您可選擇在 foobar2000 內直接載入開發伺服器網址，或載入 <code className="px-1.5 py-0.5 rounded bg-slate-900 text-cyan-300">dist/index.html</code> 離線靜態檔案。
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                                {/* 步驟 1 */}
                                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
                                    <div className="text-cyan-400 font-bold text-sm">
                                        步驟 1：確認環境與下載 foo_ui_webview2
                                    </div>
                                    <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                                        <li>
                                            確認安裝 <strong>foobar2000 v2.0 以上版本</strong>（推薦 64-bit）以及 Windows 10/11 內建的 <strong>Microsoft Edge WebView2 Runtime</strong>。
                                        </li>
                                        <li>
                                            前往 GitHub (<code className="text-amber-300">NereaFantasia/foo_ui_webview2</code>) 下載最新 <code className="text-amber-300">foo_ui_webview2.fb2k-component</code>。
                                        </li>
                                    </ol>
                                </div>

                                {/* 步驟 2 */}
                                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
                                    <div className="text-cyan-400 font-bold text-sm">
                                        步驟 2：在 foobar2000 安裝元件
                                    </div>
                                    <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                                        <li>
                                            打開 foobar2000，按快捷鍵 <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200">Ctrl + P</kbd> 開啟 <strong>Preferences (偏好設定)</strong>。
                                        </li>
                                        <li>
                                            點選左側最上方的 <strong>Components</strong>，點擊右下角 <strong>Install...</strong> 按鈕（或直接將 <code className="text-amber-300">.fb2k-component</code> 拖曳進清單中）。
                                        </li>
                                        <li>
                                            點擊 <strong>Apply</strong> 並重新啟動 foobar2000。
                                        </li>
                                    </ol>
                                </div>

                                {/* 步驟 3 */}
                                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
                                    <div className="text-emerald-400 font-bold text-sm">
                                        步驟 3：將 WebView2 面板嵌入 foobar2000 版面
                                    </div>
                                    <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                                        <li>
                                            <strong>獨立主介面模式</strong>：於 <code className="text-emerald-300">Preferences ➔ Display</code> 選擇 <strong>WebView2 UI</strong>。
                                        </li>
                                        <li>
                                            <strong>DUI / CUI 面板模式</strong>：於版面編輯模式插入 <strong>WebView2 Panel</strong>。
                                        </li>
                                    </ol>
                                </div>

                                {/* 步驟 4 */}
                                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
                                    <div className="text-amber-400 font-bold text-sm">
                                        步驟 4：指定本播放器載入路徑 (兩種模式任選)
                                    </div>
                                    <ul className="list-disc list-inside space-y-1.5 text-slate-300">
                                        <li>
                                            <strong>模式 A（開發熱更新）：</strong>在本地執行 <code className="text-cyan-300">npm run dev</code>，於 foobar2000 的 WebView2 設定將 URL 設為 <code className="text-cyan-300">http://localhost:3000</code>（或自訂埠號）。
                                        </li>
                                        <li>
                                            <strong>模式 B（離線獨立運行）：</strong>在本地執行 <code className="text-cyan-300">npm run build</code>，將 WebView2 來源指向編譯後的 <code className="text-cyan-300">C:\...\dist\index.html</code> 即可免開 Node.js 獨立運作！
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'diagnostics' && (
                        <div className="space-y-4">
                            {/* 狀態與快速測試按鈕區 */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                                <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="font-bold text-slate-200">
                                            🖥️ fb2k Native Bridge 握手測試
                                        </span>
                                        <span
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                                hostStatus.isConnectedToBridge
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                            }`}
                                        >
                                            {hostStatus.isConnectedToBridge
                                                ? 'CONNECTED (已連線宿主)'
                                                : 'DEV PREVIEW (瀏覽器模擬)'}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-slate-400">
                                        點擊下方按鈕可主動向 <code className="text-cyan-300">window.fb2k.invoke</code> 發送版本與音訊裝置查詢，或模擬握手回應：
                                    </p>
                                    <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono space-y-1">
                                        <div className="text-slate-300">
                                            偵測到的 HostObjects：{' '}
                                            <span className="text-cyan-300">
                                                {probeInfo.hostObjectNames.length > 0
                                                    ? probeInfo.hostObjectNames.join(', ')
                                                    : '無 (瀏覽器預覽環境)'}
                                            </span>
                                        </div>
                                        <div className="text-slate-300">
                                            支援的原生方法：{' '}
                                            <span className="text-emerald-300">
                                                {probeInfo.detectedMethods.length > 0
                                                    ? probeInfo.detectedMethods.join(', ')
                                                    : '未偵測到'}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                bridgeApi.sendHandshakePing()
                                            }
                                            className="px-2.5 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-[11px] font-semibold transition cursor-pointer"
                                        >
                                            📤 發送 CLIENT_HANDSHAKE_READY
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleSimulateHandshake}
                                            className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold transition cursor-pointer"
                                        >
                                            📥 模擬 C++ 宿主握手回應 (ACK)
                                        </button>
                                    </div>
                                </div>

                                {/* 60FPS 音訊串流端點設定 */}
                                <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="font-bold text-slate-200">
                                            🌊 本地 60FPS 音訊頻譜與電平串流
                                        </span>
                                        <span
                                            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                                                wsStatus === 'connected'
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                                    : 'bg-slate-800 text-slate-300'
                                            }`}
                                        >
                                            狀態: {wsStatus.toUpperCase()}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="text"
                                            value={wsEndpointInput}
                                            onChange={(e) =>
                                                setWsEndpointInput(
                                                    e.target.value
                                                )
                                            }
                                            placeholder="fb2k://audio.subscribeSpectrum?fps=60&bands=64"
                                            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
                                        />
                                        <button
                                            type="button"
                                            onClick={handleConnectWs}
                                            className="px-2.5 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/40 text-indigo-300 text-[11px] font-semibold transition cursor-pointer"
                                        >
                                            連線
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleDisconnectWs}
                                            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold transition cursor-pointer"
                                        >
                                            中斷
                                        </button>
                                    </div>
                                    <p className="text-[11px] text-slate-400">
                                        💡 <strong>診斷說明：</strong>
                                        <code className="text-cyan-300">NereaFantasia/foo_ui_webview2</code> 採用原生 C++ IPC 共享記憶體通道 (<code className="text-emerald-300">fb2k://audio.subscribeSpectrum</code> 與 <code className="text-emerald-300">audio.getWaveform</code>) 推播 60FPS 音訊數據，而非開啟獨立的 TCP 8788 WebSocket 伺服器。點擊「連線」將直接掛載原生 60FPS IPC 串流。
                                    </p>
                                </div>
                            </div>

                            {/* Bridge IPC 即時訊息監控器 */}
                            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
                                <div className="flex items-center justify-between">
                                    <span className="font-bold text-slate-200">
                                        📜 Bridge IPC 雙向訊息監控日誌 (最近 {logs.length} 筆)
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => clearBridgeLogs()}
                                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] transition cursor-pointer"
                                    >
                                        清除日誌
                                    </button>
                                </div>

                                <div className="max-h-52 overflow-y-auto space-y-1.5 font-mono text-[11px]">
                                    {logs.length === 0 ? (
                                        <div className="py-6 text-center text-slate-500">
                                            尚無 Bridge 通訊紀錄（操作播放、拖曳時間軸或點擊上方握手測試即可觀察即時封包）
                                        </div>
                                    ) : (
                                        logs.map((entry) => (
                                            <div
                                                key={entry.id}
                                                className="flex items-start gap-2 px-2.5 py-1.5 rounded bg-slate-900/90 border border-slate-800/80"
                                            >
                                                <span className="text-slate-500 shrink-0">
                                                    [{entry.timestamp}]
                                                </span>
                                                <span
                                                    className={`px-1.5 py-0.2 rounded text-[10px] font-bold shrink-0 ${
                                                        entry.direction ===
                                                        'CLIENT_TO_HOST'
                                                            ? 'bg-cyan-500/20 text-cyan-300'
                                                            : 'bg-emerald-500/20 text-emerald-300'
                                                    }`}
                                                >
                                                    {entry.direction ===
                                                    'CLIENT_TO_HOST'
                                                        ? 'UI ➔ Host'
                                                        : 'Host ➔ UI'}
                                                </span>
                                                <span className="text-amber-300 font-semibold shrink-0">
                                                    {entry.type}
                                                </span>
                                                <span className="text-slate-400 break-all">
                                                    {entry.summary}
                                                </span>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'protocol' && (
                        <div className="space-y-3">
                            <p className="text-slate-300">
                                前端透過 <code className="text-cyan-300">foo-webview-sdk v2.2</code> 與底層 <code className="text-cyan-300">window.fb2k.invoke(method, params)</code> 呼叫 <code className="text-emerald-300">NereaFantasia/foo_ui_webview2</code> C++ 宿主服務，並透過 <code className="text-emerald-300">fb.on(event, handler)</code> 接收非同步事件：
                            </p>
                            <pre className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-200 overflow-x-auto leading-relaxed">
{`// [1] 媒體庫與本機播放清單讀取 (Library & Playlists)
await fb.library.getAll(0, 500);
await fb.playlist.getAll();
await fb.playlist.getTracks(playlistIndex, 0, 500);
await window.fb2k.invoke('titleformat.evalFieldsBatch', {
  paths,
  fields: { bpm: '%bpm%', key: '$if2(%initialkey%,%key%)' }
});
await window.fb2k.invoke('artwork.getFb2kUrlByPathBatch', {
  items: paths.map(path => ({ path, type: 'front', maxSize: 300 }))
});

// [2] 零彈窗曲目切換、微秒級定位與 Crossfade 音量控制 (Playback & Transitions)
// 使用 library.addToPlaylist 直接建立記憶體 metadb_handle，避免 process_locations_async 彈出 Processing files 視窗
await window.fb2k.invoke('library.addToPlaylist', { playlist: djPlIndex, paths: [path] });
await window.fb2k.invoke('playlist.playTrack',    { playlist: djPlIndex, index: rowIndex });
await fb.player.seek(offsetSeconds);
await fb.player.setVolume(Math.round(effectiveVolume * 100)); // 0..100 支援 Crossfade 動態曲線
await fb.player.pause();                                      // 支援 Silence 靜音過渡區間

// [3] 60FPS 即時頻譜與雙聲道立體聲 VU 電平 (Audio Visualization)
const unsubscribe = fb.audio.subscribeSpectrum(
  ({ spectrum }) => updateSpectrum(spectrum),
  { fftSize: 2048, bands: 64, fps: 60, scale: 'weighted', backgroundThrottle: false }
);
const wf = await window.fb2k.invoke('audio.getWaveform', {
  duration: 0.04, signed: false, channels: 'stereo', points: 64
});

// [4] 宿主視窗控制與事件訂閱 (Window & Events)
await window.fb2k.invoke('window.minimize', {});
await window.fb2k.invoke('window.toggleMaximize', {});
await window.fb2k.invoke('window.close', {});
fb.on('playback:stateChanged', ({ state }) => { /* 'playing' | 'paused' | 'stopped' */ });
fb.on('library:initialized',   () => { /* 自動刷新曲庫 */ });`}
                            </pre>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
