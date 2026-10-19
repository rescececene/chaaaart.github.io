import { createHash } from 'node:crypto'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** 배포용 보안 정책(CSP) — 우리 파일과 정해진 곳의 스크립트만 실행되게 한다.
 *  누가 글·데이터에 스크립트를 섞어 넣어도 실행되지 않는다. 개발 서버(인라인 스크립트를 쓰는 HMR)에는 넣지 않는다. */
function securityPolicy(): Plugin {
  return {
    name: 'market-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // index.html 안의 인라인 스크립트(첫 화면 테마)는 내용 해시로만 허용
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
          .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')} https://static.cloudflareinsights.com`,
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "font-src 'self' data: https://cdn.jsdelivr.net",
          "img-src 'self' data: https:",
          // 시세·중계·뉴스·통계는 https/wss 로만 (설정에서 다른 중계를 넣을 수 있어 호스트를 묶지 않는다). 로컬 개발 중계만 http 허용
          "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
          "frame-src 'none'",
        ].join('; ')
        return html.replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
      },
    },
  }
}

// GitHub Pages 하위 경로(/chaaaart.github.io/)에서도 동작하도록 상대 경로로 빌드한다
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), securityPolicy()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { host: '127.0.0.1', port: 5173 },
  build: { chunkSizeWarningLimit: 900 },
})
