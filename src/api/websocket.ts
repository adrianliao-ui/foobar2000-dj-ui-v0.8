import fb from 'foo-webview-sdk';
import type { StereoVULevels } from '../types/player';
import { appendBridgeLog, isFoobarWebView } from './mockBridge';

// ============================================================================
// [通訊模組] websocket.ts：串流 60FPS 高幀率頻譜與 L/R 音量電平數據介面
// 支援：1. NereaFantasia/foo_ui_webview2 原生 C++ IPC 60FPS 串流 (fb2k://audio.subscribeSpectrum)
//       2. 自訂外部 WebSocket 端點 (ws://127.0.0.1:8788/audio-stream)，若未開啟自動退回原生 fb2k 通道
// ============================================================================

export type WebSocketConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error';

export interface AudioStreamPacket {
    type: 'AUDIO_METERS';
    vuLevels: StereoVULevels;
    spectrumBins: number[];
}

export class FoobarAudioWebSocket {
    private ws: WebSocket | null = null;
    private unsubNativeSpectrum: (() => void) | null = null;
    private simTimer: ReturnType<typeof setInterval> | null = null;
    private endpointUrl = 'fb2k://audio.subscribeSpectrum?fps=60&bands=64';
    private status: WebSocketConnectionStatus = isFoobarWebView()
        ? 'connected'
        : 'disconnected';
    private onMetersCallback:
        | ((vuLevels: StereoVULevels, spectrumBins: number[]) => void)
        | null = null;
    private statusListeners = new Set<
        (status: WebSocketConnectionStatus, endpoint: string) => void
    >();

    public getStatus(): WebSocketConnectionStatus {
        return this.status;
    }

    public getEndpointUrl(): string {
        return this.endpointUrl;
    }

    public subscribeStatus(
        listener: (status: WebSocketConnectionStatus, endpoint: string) => void
    ): () => void {
        this.statusListeners.add(listener);
        listener(this.status, this.endpointUrl);
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    private notifyStatus(nextStatus: WebSocketConnectionStatus): void {
        this.status = nextStatus;
        for (const listener of this.statusListeners) {
            listener(this.status, this.endpointUrl);
        }
    }

    /**
     * 啟動 NereaFantasia/foo_ui_webview2 原生 60FPS C++ 頻譜串流或瀏覽器 60FPS 模擬串流
     */
    private attachNativeFb2kStream(): void {
        if (fb.isAvailable() || window.fb2k) {
            try {
                this.unsubNativeSpectrum = fb.audio.subscribeSpectrum(
                    (data) => {
                        if (
                            !Array.isArray(data.spectrum) ||
                            data.spectrum.length === 0
                        ) {
                            return;
                        }
                        const bins = data.spectrum
                            .slice(0, 64)
                            .map((v) =>
                                Math.max(0, Math.min(1, Number(v) || 0))
                            );
                        const avg =
                            bins.reduce((acc, v) => acc + v, 0) /
                            Math.max(1, bins.length);
                        const peak = Math.min(1, avg * 1.55);
                        this.onMetersCallback?.(
                            {
                                leftPeak: Number(peak.toFixed(3)),
                                leftRms: Number((avg * 0.88).toFixed(3)),
                                rightPeak: Number(
                                    Math.min(1, peak * 0.97).toFixed(3)
                                ),
                                rightRms: Number((avg * 0.85).toFixed(3)),
                            },
                            bins
                        );
                    },
                    {
                        fftSize: 2048,
                        bands: 64,
                        fps: 60,
                        scale: 'weighted',
                        backgroundThrottle: false,
                    }
                );
                appendBridgeLog(
                    'HOST_TO_CLIENT',
                    'fb.audio.subscribeSpectrum',
                    '已連通 foo_ui_webview2 60FPS 原生音訊頻譜串流 (fftSize: 2048, bands: 64, fps: 60)'
                );
                this.notifyStatus('connected');
                return;
            } catch (err) {
                appendBridgeLog(
                    'HOST_TO_CLIENT',
                    'subscribeSpectrum_ERR',
                    String(err)
                );
            }
        }

        // 瀏覽器開發環境下：啟動 60FPS 本地模擬串流以供診斷測試
        this.simTimer = setInterval(() => {
            const bins = Array.from({ length: 64 }, (_, idx) => {
                const weight = Math.max(0.15, 1 - idx / 75);
                return Number(((0.2 + Math.random() * 0.65) * weight).toFixed(3));
            });
            const avg = bins.reduce((a, b) => a + b, 0) / 64;
            this.onMetersCallback?.(
                {
                    leftPeak: Number(Math.min(1, avg * 1.5).toFixed(3)),
                    leftRms: Number((avg * 0.85).toFixed(3)),
                    rightPeak: Number(Math.min(1, avg * 1.46).toFixed(3)),
                    rightRms: Number((avg * 0.82).toFixed(3)),
                },
                bins
            );
        }, 16);
        appendBridgeLog(
            'HOST_TO_CLIENT',
            'MOCK_60FPS_STREAM',
            '已啟動瀏覽器預覽 60FPS 音訊電平串流通道'
        );
        this.notifyStatus('connected');
    }

    /**
     * 啟動高幀率音訊電平串流（支援 fb2k:// 原生 IPC 與 ws:// 端點，當 ws:// 未監聽時自動切換至 fb2k 原生 60FPS IPC）
     */
    public connect(
        endpointUrl: string,
        onMeters?: (vuLevels: StereoVULevels, spectrumBins: number[]) => void
    ): void {
        if (onMeters) {
            this.onMetersCallback = onMeters;
        }
        if (typeof window === 'undefined' || !endpointUrl) return;

        this.disconnect();
        this.endpointUrl = endpointUrl;
        this.notifyStatus('connecting');

        // 1. 若指定為 fb2k:// 原生 IPC 通道，或當前位於 foo_ui_webview2 環境且要求預設串流，直接掛載 fb.audio.subscribeSpectrum
        if (
            endpointUrl.startsWith('fb2k://') ||
            ((fb.isAvailable() || window.fb2k) &&
                endpointUrl.includes('127.0.0.1:8788'))
        ) {
            this.endpointUrl =
                'fb2k://audio.subscribeSpectrum?fps=60&bands=64';
            this.attachNativeFb2kStream();
            return;
        }

        // 2. 若使用者自訂了外部 ws:// 端點，嘗試連線，若本地未開啟該 TCP Port 則自動切換回 fb2k 原生 IPC 通道
        try {
            this.ws = new WebSocket(endpointUrl);

            this.ws.onopen = () => {
                appendBridgeLog(
                    'HOST_TO_CLIENT',
                    'WS_CONNECTED',
                    `成功連線至 ${endpointUrl}`
                );
                this.notifyStatus('connected');
            };

            this.ws.onmessage = (event) => {
                try {
                    const packet = JSON.parse(
                        String(event.data)
                    ) as Partial<AudioStreamPacket>;
                    if (
                        packet.type === 'AUDIO_METERS' &&
                        packet.vuLevels &&
                        Array.isArray(packet.spectrumBins)
                    ) {
                        this.onMetersCallback?.(
                            packet.vuLevels,
                            packet.spectrumBins
                        );
                    }
                } catch {
                    // 忽略非 JSON 格式之封包
                }
            };

            this.ws.onerror = () => {
                if (this.ws) {
                    this.ws.onclose = null;
                    this.ws.close();
                    this.ws = null;
                }
                // 當外部 TCP WebSocket 未啟動時，自動切換至 fb2k 原生 60FPS 通道
                this.endpointUrl =
                    'fb2k://audio.subscribeSpectrum?fps=60&bands=64';
                this.attachNativeFb2kStream();
            };

            this.ws.onclose = () => {
                if (this.status !== 'connected') {
                    this.endpointUrl =
                        'fb2k://audio.subscribeSpectrum?fps=60&bands=64';
                    this.attachNativeFb2kStream();
                    return;
                }
                this.notifyStatus('disconnected');
                this.ws = null;
            };
        } catch {
            this.ws = null;
            this.endpointUrl =
                'fb2k://audio.subscribeSpectrum?fps=60&bands=64';
            this.attachNativeFb2kStream();
        }
    }

    /**
     * 關閉連線並釋放資源
     */
    public disconnect(): void {
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        if (this.unsubNativeSpectrum) {
            try {
                this.unsubNativeSpectrum();
            } catch {
                // 忽略退訂例外
            }
            this.unsubNativeSpectrum = null;
        }
        if (this.simTimer) {
            clearInterval(this.simTimer);
            this.simTimer = null;
        }
        this.notifyStatus('disconnected');
    }
}

export const audioStreamSocket = new FoobarAudioWebSocket();
