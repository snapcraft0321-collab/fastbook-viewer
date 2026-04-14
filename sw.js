// sw.js - FastBook Viewer Service Worker
const CACHE_NAME = 'fastbook-cache-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/viewer.html',
    '/css/styles.css',
    '/css/viewer.css',
    '/js/config.js',
    '/js/fastbook-all.js',
    '/js/viewer-all.js',
    '/manifest.json'
];

// 설치: 정적 자산 캐싱
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

// 활성화: 오래된 캐시 정리
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// fetch 인터셉트
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Google Drive API 요청은 캐싱하지 않음 (인증 토큰 필요)
    if (url.hostname.includes('googleapis.com') ||
        url.hostname.includes('accounts.google.com') ||
        url.hostname.includes('apis.google.com')) {
        return;
    }

    // Google Drive 썸네일/파일은 네트워크 우선, 실패 시 캐시
    if (url.hostname.includes('drive.google.com')) {
        event.respondWith(
            fetch(request).catch(() => caches.match(request))
        );
        return;
    }

    // 정적 자산: 캐시 우선
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return response;
                }
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(request, responseClone);
                });
                return response;
            });
        })
    );
});
