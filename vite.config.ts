import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
    // 設定相對路徑 base: './'，確保 npm run build 產出的 dist/index.html 可直接由 foobar2000 foo_ui_webview2 離線載入
    base: './',
    server: {
        port: 3000,
        host: '0.0.0.0',
    },
    plugins: [
        react(),
        tailwindcss(),
    ],
})
