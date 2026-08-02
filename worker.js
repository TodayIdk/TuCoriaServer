// TuCoria WebSocket Proxy — Cloudflare Worker
// Проксирует WebSocket на Render чтобы обойти блокировки

const TARGET_HOST = 'tucoriaserver.onrender.com';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS для preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }
            });
        }

        // Проксируем на Render
        const targetUrl = `https://${TARGET_HOST}${url.pathname}${url.search}`;

        // Клонируем заголовки, добавляем IP клиента
        const headers = new Headers(request.headers);
        headers.set('X-Forwarded-Host', url.hostname);
        headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');

        // WebSocket запросы — просто редирект
        const upgrade = request.headers.get('Upgrade');
        if (upgrade && upgrade.toLowerCase() === 'websocket') {
            // Cloudflare сам обрабатывает WebSocket upgrade
            return fetch(targetUrl, {
                headers: request.headers,
                method: request.method,
                body: request.body
            });
        }

        // Обычные HTTP запросы
        try {
            const response = await fetch(targetUrl, {
                method: request.method,
                headers: headers,
                body: request.method !== 'GET' && request.method !== 'HEAD'
                    ? request.body : undefined
            });

            // Добавляем CORS в ответ
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });
        } catch (e) {
            return new Response(`Proxy error: ${e.message}`, { status: 502 });
        }
    }
};
