// js/viewer-all.js - FastBook Viewer 뷰어 페이지 통합 버전 (개선됨)
console.log('[FastBook Viewer] 뷰어 시작');

if (!window.FastBook) {
    console.error('[FastBook Viewer] CONFIG가 로드되지 않았습니다!');
    alert('설정 파일을 로드할 수 없습니다.');
}

// ============================================
// 뷰어 상태 관리
// ============================================
const ViewerState = {
    currentBook: null,
    currentPage: 1,
    totalPages: 0,
    images: [],
    zoomLevel: 1,
    isFullscreen: false,
    isLoading: false,
    uiHideTimeout: null,
    touchStartX: null,
    touchStartY: null,
    lastTapTime: 0,
    pinchDistance: 0,
    saveProgressTimeout: null,
    lastLoadTime: Date.now()
};

// ============================================
// LRU 캐시 구현 (개선 #4: 메모리 누수 방지)
// ============================================
class LRUCache {
    constructor(maxSize = 50) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.accessOrder = [];
    }
    
    get(key) {
        if (!this.cache.has(key)) return null;
        
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
        this.accessOrder.push(key);
        
        return this.cache.get(key);
    }
    
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.set(key, value);
            this.get(key);
            return;
        }
        
        if (this.cache.size >= this.maxSize) {
            const lru = this.accessOrder.shift();
            const oldValue = this.cache.get(lru);
            
            // 🔧 개선 #4: 메모리 누수 방지
            if (oldValue && oldValue.blobUrl) {
                URL.revokeObjectURL(oldValue.blobUrl);
            }
            
            this.cache.delete(lru);
            log.debug(`[LRU] 캐시에서 제거: ${lru}`);
        }
        
        this.cache.set(key, value);
        this.accessOrder.push(key);
    }
    
    has(key) {
        return this.cache.has(key);
    }
    
    clear() {
        // 🔧 개선 #4: 모든 blob URL 정리
        this.cache.forEach((value) => {
            if (value && value.blobUrl) {
                URL.revokeObjectURL(value.blobUrl);
            }
        });
        
        this.cache.clear();
        this.accessOrder = [];
    }
    
    size() {
        return this.cache.size;
    }
}

// ============================================
// 적응형 프리로딩 관리자
// ============================================
class AdaptivePreloader {
    constructor() {
        this.readingSpeed = [];
        this.lastPageTime = Date.now();
        this.preloadCount = 3;
        this.minPreload = 2;
        this.maxPreload = 10;
    }
    
    recordPageTransition() {
        const now = Date.now();
        const duration = now - this.lastPageTime;
        this.lastPageTime = now;
        
        this.readingSpeed.push(duration);
        if (this.readingSpeed.length > 10) {
            this.readingSpeed.shift();
        }
        
        this.adjustPreloadCount();
    }
    
    adjustPreloadCount() {
        if (this.readingSpeed.length < 3) return;
        
        const avgSpeed = this.readingSpeed.reduce((a, b) => a + b) / this.readingSpeed.length;
        
        if (avgSpeed < 3000) {
            this.preloadCount = Math.min(this.preloadCount + 1, this.maxPreload);
        } else if (avgSpeed > 10000) {
            this.preloadCount = Math.max(this.preloadCount - 1, this.minPreload);
        }
        
        log.debug(`[적응형 프리로딩] 평균 읽기 시간: ${(avgSpeed/1000).toFixed(1)}초, 프리로드 개수: ${this.preloadCount}`);
    }
    
    getPreloadCount() {
        return this.preloadCount;
    }
}

// ============================================
// Storage 모듈 (IndexedDB) - 마지막 읽은 시간만 저장
// ============================================
const ViewerStorage = (() => {
    let db = null;

    async function initialize(isRetry = false) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

            request.onerror = () => {
                log.error('IndexedDB 열기 실패:', request.error);

                // 에러 발생 시 DB 삭제 후 재시도
                if (!isRetry) {
                    log.warn('IndexedDB 재생성 시도 중...');
                    deleteDatabase().then(() => {
                        initialize(true).then(resolve).catch(reject);
                    }).catch(reject);
                } else {
                    reject(request.error);
                }
            };

            request.onsuccess = () => {
                db = request.result;

                // DB가 열렸지만 필요한 objectStore가 없는 경우 처리
                if (!db.objectStoreNames.contains('last_read')) {
                    log.warn('필요한 objectStore가 없습니다. DB 재생성 중...');
                    db.close();

                    if (!isRetry) {
                        deleteDatabase().then(() => {
                            initialize(true).then(resolve).catch(reject);
                        }).catch(reject);
                    } else {
                        reject(new Error('ObjectStore 생성 실패'));
                    }
                    return;
                }

                log.info('IndexedDB 초기화 완료');
                resolve(db);
            };

            request.onupgradeneeded = (event) => {
                db = event.target.result;
                const oldVersion = event.oldVersion;

                // v1→v2: books, last_read 생성
                if (oldVersion < 2) {
                    if (!db.objectStoreNames.contains('books')) {
                        db.createObjectStore('books', { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains('last_read')) {
                        db.createObjectStore('last_read', { keyPath: 'bookId' });
                    }
                }

                // v2→v3: bookmarks, reading_stats 추가
                if (oldVersion < 3) {
                    if (!db.objectStoreNames.contains('bookmarks')) {
                        db.createObjectStore('bookmarks', { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains('reading_stats')) {
                        db.createObjectStore('reading_stats', { keyPath: 'bookId' });
                    }
                }

                log.info('IndexedDB 스키마 업그레이드 완료 (v' + oldVersion + '→' + CONFIG.DB_VERSION + ')');
            };
        });
    }

    async function deleteDatabase() {
        return new Promise((resolve, reject) => {
            log.warn('기존 IndexedDB 삭제 중...');
            const deleteRequest = indexedDB.deleteDatabase(CONFIG.DB_NAME);

            deleteRequest.onsuccess = () => {
                log.info('IndexedDB 삭제 완료');
                resolve();
            };

            deleteRequest.onerror = () => {
                log.error('IndexedDB 삭제 실패:', deleteRequest.error);
                reject(deleteRequest.error);
            };

            deleteRequest.onblocked = () => {
                log.warn('IndexedDB 삭제가 차단되었습니다. 다른 탭을 닫아주세요.');
                // 차단되어도 계속 진행
                resolve();
            };
        });
    }

    async function saveLastRead(bookId) {
        try {
            if (!db) return;

            // objectStore 존재 여부 확인
            if (!db.objectStoreNames.contains('last_read')) {
                log.warn('last_read objectStore가 없습니다.');
                return;
            }

            const transaction = db.transaction(['last_read'], 'readwrite');
            const store = transaction.objectStore('last_read');

            const lastReadData = {
                bookId,
                lastRead: new Date().toISOString()
            };

            return new Promise((resolve, reject) => {
                const request = store.put(lastReadData);
                request.onsuccess = () => {
                    sessionStorage.setItem(`book_lastread_${bookId}`, JSON.stringify(lastReadData));
                    log.debug('마지막 읽은 시간 저장됨:', lastReadData);
                    resolve();
                };
                request.onerror = () => {
                    log.error('saveLastRead 실패:', request.error);
                    resolve(); // 에러 시 그냥 계속 진행
                };
            });
        } catch (error) {
            log.error('saveLastRead 예외:', error);
        }
    }

    async function getLastRead(bookId) {
        try {
            if (!db) return null;

            // objectStore 존재 여부 확인
            if (!db.objectStoreNames.contains('last_read')) {
                log.warn('last_read objectStore가 없습니다.');
                return null;
            }

            const transaction = db.transaction(['last_read'], 'readonly');
            const store = transaction.objectStore('last_read');

            return new Promise((resolve, reject) => {
                const request = store.get(bookId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    log.error('getLastRead 실패:', request.error);
                    resolve(null);
                };
            });
        } catch (error) {
            log.error('getLastRead 예외:', error);
            return null;
        }
    }

    return { initialize, saveLastRead, getLastRead, deleteDatabase, getDB: () => db };
})();

// ============================================
// 최적화된 Image Loader 모듈 (개선 #4: 메모리 누수 방지)
// ============================================
const ImageLoader = (() => {
    const imageCache = new LRUCache(50);
    const loadingQueue = new Map();
    const preloader = new AdaptivePreloader();
    let concurrentLoads = 0;
    let MAX_CONCURRENT = 3;
    
    function getNetworkQuality() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!connection) return 'unknown';
        
        if (connection.saveData) return 'low';
        if (connection.effectiveType === '4g') return 'high';
        if (connection.effectiveType === '3g') return 'medium';
        return 'low';
    }
    
    // 🔧 개선 #4: 에러 발생 시에도 blob URL 정리
    async function fetchImageAsBlob(fileId) {
        const token = localStorage.getItem('access_token');
        
        if (!token) {
            throw new Error('인증 토큰이 없습니다.');
        }
        
        if (loadingQueue.has(fileId)) {
            log.debug(`[로더] 이미 로딩 중: ${fileId}`);
            return await loadingQueue.get(fileId);
        }
        
        while (concurrentLoads >= MAX_CONCURRENT) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        concurrentLoads++;
        
        const loadPromise = (async () => {
            let blobUrl = null; // 🔧 추적을 위해 외부에 선언
            
            try {
                const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
                
                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'image/webp,image/*'
                    },
                    cache: 'force-cache',
                    mode: 'cors'
                });
                
                if (!response.ok) {
                    if (response.status === 401) {
                        throw new Error('AUTH_EXPIRED');
                    }
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const blob = await response.blob();
                blobUrl = URL.createObjectURL(blob);
                
                await validateImage(blobUrl);
                
                return blobUrl;
                
            } catch (error) {
                // 🔧 개선 #4: 에러 발생 시 생성된 blobUrl 정리
                if (blobUrl) {
                    URL.revokeObjectURL(blobUrl);
                    log.debug(`[메모리 정리] 에러로 인한 blob URL 해제: ${fileId}`);
                }
                throw error;
            } finally {
                concurrentLoads--;
                loadingQueue.delete(fileId);
            }
        })();
        
        loadingQueue.set(fileId, loadPromise);
        return await loadPromise;
    }
    
    async function validateImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => {
                reject(new Error('이미지 로드 타임아웃'));
            }, 15000);
            
            img.onload = () => {
                clearTimeout(timeout);
                resolve(img);
            };
            
            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('이미지 로드 실패'));
            };
            
            img.src = url;
        });
    }
    
    async function loadImage(imageData, priority = 'normal') {
        const cacheKey = imageData.id;
        
        const cached = imageCache.get(cacheKey);
        if (cached) {
            log.debug(`[캐시 히트] ${imageData.name}`);
            return cached.blobUrl;
        }
        
        try {
            log.info(`[로더] 다운로드 시작: ${imageData.name}`);
            
            const blobUrl = await fetchImageAsBlob(imageData.id);
            
            imageCache.set(cacheKey, {
                blobUrl,
                timestamp: Date.now(),
                size: imageData.size || 0
            });
            
            log.debug(`[로더] 완료: ${imageData.name} (캐시 크기: ${imageCache.size()})`);
            return blobUrl;
            
        } catch (error) {
            log.error(`[로더 오류] ${imageData.name}:`, error);
            
            if (error.message === 'AUTH_EXPIRED') {
                if (window.FastBook && window.FastBook.TokenManager) {
                    await window.FastBook.TokenManager.refreshToken();
                    return loadImage(imageData, priority);
                }
            }
            
            throw error;
        }
    }
    
    async function preloadImages(currentPage, totalPages, images) {
        const preloadCount = preloader.getPreloadCount();
        const startPage = Math.max(1, currentPage - 1);
        const endPage = Math.min(totalPages, currentPage + preloadCount);
        
        const promises = [];
        const pages = [];
        
        for (let i = currentPage + 1; i <= Math.min(currentPage + 2, endPage); i++) {
            pages.push({ page: i, priority: 'high' });
        }
        
        for (let i = currentPage + 3; i <= endPage; i++) {
            pages.push({ page: i, priority: 'normal' });
        }
        
        if (currentPage > 1 && !imageCache.has(images[currentPage - 2].id)) {
            pages.push({ page: currentPage - 1, priority: 'low' });
        }
        
        for (const { page, priority } of pages) {
            const imageData = images[page - 1];
            if (imageData && !imageCache.has(imageData.id) && !loadingQueue.has(imageData.id)) {
                promises.push(
                    loadImage(imageData, priority)
                        .catch(err => log.warn(`[프리로드 실패] 페이지 ${page}:`, err))
                );
                
                if (promises.length >= MAX_CONCURRENT) {
                    await Promise.race(promises);
                }
            }
        }
        
        await Promise.allSettled(promises);
        
        log.debug(`[프리로딩 완료] ${startPage}-${endPage} 페이지 (캐시: ${imageCache.size()}개)`);
    }
    
    function cleanupCache(currentPage, windowSize = 10) {
        const keepStart = Math.max(1, currentPage - windowSize);
        const keepEnd = currentPage + windowSize;
        
        let cleaned = 0;
        imageCache.cache.forEach((value, key) => {
            const pageNum = parseInt(key.split('_')[1]) || 0;
            
            if (pageNum < keepStart || pageNum > keepEnd) {
                if (value.blobUrl) {
                    URL.revokeObjectURL(value.blobUrl);
                }
                imageCache.cache.delete(key);
                cleaned++;
            }
        });
        
        if (cleaned > 0) {
            log.debug(`[캐시 정리] ${cleaned}개 이미지 제거`);
        }
    }
    
    function getMemoryUsage() {
        if (performance.memory) {
            const used = performance.memory.usedJSHeapSize;
            const limit = performance.memory.jsHeapSizeLimit;
            const percentage = (used / limit) * 100;
            
            log.debug(`[메모리] 사용: ${(used / 1024 / 1024).toFixed(1)}MB (${percentage.toFixed(1)}%)`);
            
            if (percentage > 70) {
                const currentSize = imageCache.size();
                imageCache.maxSize = Math.max(20, Math.floor(currentSize * 0.7));
                log.warn('[메모리 경고] 캐시 크기 축소:', imageCache.maxSize);
            }
            
            return percentage;
        }
        return 0;
    }
    
    if (navigator.connection) {
        navigator.connection.addEventListener('change', () => {
            const quality = getNetworkQuality();
            log.info('[네트워크 변경]', quality);
            
            if (quality === 'high') {
                preloader.preloadCount = Math.min(preloader.preloadCount + 2, 10);
            }
        });
    }
    
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            log.debug('[백그라운드] 메모리 정리 시작');
            const originalSize = imageCache.maxSize;
            imageCache.maxSize = Math.max(10, Math.floor(originalSize / 2));
            
            setTimeout(() => {
                if (!document.hidden) {
                    imageCache.maxSize = originalSize;
                    log.debug('[포그라운드] 캐시 크기 복구:', originalSize);
                }
            }, 1000);
        }
    });
    
    function getStats() {
        return {
            cacheSize: imageCache.size(),
            loadingQueue: loadingQueue.size,
            concurrentLoads,
            preloadCount: preloader.getPreloadCount(),
            networkQuality: getNetworkQuality(),
            memoryUsage: getMemoryUsage()
        };
    }
    
    return {
        loadImage,
        preloadImages,
        cleanupCache,
        clearCache: () => imageCache.clear(),
        getStats,
        recordPageTransition: () => preloader.recordPageTransition(),
        setMaxCacheSize: (size) => { imageCache.maxSize = size; },
        setMaxConcurrent: (max) => { MAX_CONCURRENT = max; },
        getCacheSize: () => imageCache.size(),
        hasInCache: (fileId) => imageCache.has(fileId)
    };
})();

// ============================================
// Google API 초기화
// ============================================
async function initializeGoogleAPI() {
    if (window.gapi && window.gapi.client && window.gapi.client.drive) {
        log.info('Google API 이미 초기화됨');
        return;
    }
    
    return new Promise((resolve) => {
        if (!window.gapi) {
            const gapiScript = document.createElement('script');
            gapiScript.src = 'https://apis.google.com/js/api.js';
            gapiScript.async = true;
            gapiScript.defer = true;
            gapiScript.onload = () => {
                log.info('Google API 스크립트 로드 완료');
                initializeGapiClient(resolve);
            };
            document.head.appendChild(gapiScript);
        } else {
            initializeGapiClient(resolve);
        }
    });
}

function initializeGapiClient(callback) {
    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: CONFIG.API_KEY,
                discoveryDocs: CONFIG.DISCOVERY_DOCS
            });
            
            const token = localStorage.getItem('access_token');
            if (token) {
                gapi.client.setToken({ access_token: token });
                log.info('토큰 설정 완료');
            }
            
            log.info('Google API Client 초기화 완료');
            callback();
        } catch (error) {
            log.error('Google API Client 초기화 실패:', error);
            callback();
        }
    });
}

// ============================================
// UI 컨트롤러
// ============================================
const UIController = (() => {
    let elements = {};
    
    function initializeElements() {
        elements = {
            toolbar: document.getElementById('toolbar'),
            backBtn: document.getElementById('backBtn'),
            bookTitle: document.getElementById('bookTitle'),
            fullscreenBtn: document.getElementById('fullscreenBtn'),
            imageContainer: document.getElementById('imageContainer'),
            mainImage: document.getElementById('mainImage'),
            loadingSkeleton: document.getElementById('loadingSkeleton'),
            imageError: document.getElementById('imageError'),
            reloadImageBtn: document.getElementById('reloadImageBtn'),
            navPrev: document.getElementById('navPrev'),
            navNext: document.getElementById('navNext'),
            controls: document.getElementById('controls'),
            prevPageBtn: document.getElementById('prevPageBtn'),
            nextPageBtn: document.getElementById('nextPageBtn'),
            currentPageInput: document.getElementById('currentPageInput'),
            totalPages: document.getElementById('totalPages'),
            progressSlider: document.getElementById('progressSlider'),
            progressFill: document.getElementById('progressFill'),
            zoomInBtn: document.getElementById('zoomInBtn'),
            zoomOutBtn: document.getElementById('zoomOutBtn'),
            zoomResetBtn: document.getElementById('zoomResetBtn'),
            zoomLevel: document.getElementById('zoomLevel'),
            gestureOverlay: document.getElementById('gestureOverlay'),
            viewer: document.getElementById('viewer')
        };
        
        return elements;
    }
    
    function updatePageDisplay() {
        elements.currentPageInput.value = ViewerState.currentPage;
        elements.totalPages.textContent = ViewerState.totalPages;
        elements.progressSlider.value = ViewerState.currentPage;
        elements.progressSlider.max = ViewerState.totalPages;
        
        const percentage = (ViewerState.currentPage / ViewerState.totalPages) * 100;
        elements.progressFill.style.width = `${percentage}%`;
        
        elements.prevPageBtn.disabled = ViewerState.currentPage <= 1;
        elements.nextPageBtn.disabled = ViewerState.currentPage >= ViewerState.totalPages;
        elements.navPrev.style.display = ViewerState.currentPage <= 1 ? 'none' : 'block';
        elements.navNext.style.display = ViewerState.currentPage >= ViewerState.totalPages ? 'none' : 'block';
    }
    
    function showLoading() {
        elements.loadingSkeleton.style.display = 'block';
        elements.mainImage.style.display = 'none';
        elements.imageError.style.display = 'none';
    }
    
    function showImage(url) {
        elements.mainImage.src = url;
        elements.mainImage.style.display = 'block';
        elements.loadingSkeleton.style.display = 'none';
        elements.imageError.style.display = 'none';
        resetZoom();
    }
    
    function showError() {
        elements.imageError.style.display = 'flex';
        elements.loadingSkeleton.style.display = 'none';
        elements.mainImage.style.display = 'none';
    }
    
    function updateZoomDisplay() {
        const percentage = Math.round(ViewerState.zoomLevel * 100);
        elements.zoomLevel.textContent = `${percentage}%`;
        elements.mainImage.style.transform = `scale(${ViewerState.zoomLevel})`;
    }
    
    function resetZoom() {
        ViewerState.zoomLevel = 1;
        updateZoomDisplay();
        elements.mainImage.style.transform = 'scale(1)';
        elements.mainImage.style.transformOrigin = 'center center';
    }
    
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            elements.viewer.requestFullscreen().catch(err => {
                log.error('전체화면 전환 실패:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }
    
    function showUI() {
        elements.toolbar.classList.remove('hidden');
        elements.controls.classList.remove('hidden');
        elements.viewer.classList.remove('ui-hidden');
        
        if (ViewerState.uiHideTimeout) {
            clearTimeout(ViewerState.uiHideTimeout);
        }
        
        ViewerState.uiHideTimeout = setTimeout(() => {
            if (!ViewerState.isLoading) {
                hideUI();
            }
        }, 3000);
    }
    
    function hideUI() {
        elements.toolbar.classList.add('hidden');
        elements.controls.classList.add('hidden');
        elements.viewer.classList.add('ui-hidden');
    }
    
    return {
        initializeElements,
        updatePageDisplay,
        showLoading,
        showImage,
        showError,
        updateZoomDisplay,
        resetZoom,
        toggleFullscreen,
        showUI,
        hideUI
    };
})();

// ============================================
// 페이지 네비게이션
// ============================================
const Navigation = (() => {
    
    async function goToPage(pageNumber) {
        pageNumber = Math.max(1, Math.min(pageNumber, ViewerState.totalPages));
        
        if (pageNumber === ViewerState.currentPage && !ViewerState.isLoading) {
            return;
        }
        
        if (ViewerState.currentPage !== pageNumber) {
            ImageLoader.recordPageTransition();
        }
        
        ViewerState.currentPage = pageNumber;
        ViewerState.isLoading = true;
        
        log.info(`페이지 ${pageNumber}로 이동`);
        
        UIController.updatePageDisplay();
        UIController.showLoading();
        
        try {
            const imageData = ViewerState.images[pageNumber - 1];
            
            if (!imageData) {
                throw new Error(`페이지 ${pageNumber}의 이미지 데이터가 없습니다.`);
            }
            
            const imageUrl = await ImageLoader.loadImage(imageData, 'high');
            
            UIController.showImage(imageUrl);

            // 비동기 프리로딩 (requestIdleCallback 폴리필 사용)
            setTimeout(() => {
                ImageLoader.preloadImages(
                    pageNumber,
                    ViewerState.totalPages,
                    ViewerState.images
                ).catch(err => log.warn('프리로드 실패:', err));
            }, 100);
            
            // 주기적 캐시 정리 (requestIdleCallback 폴리필 사용)
            if (pageNumber % 20 === 0) {
                setTimeout(() => {
                    ImageLoader.cleanupCache(pageNumber);
                    log.debug('캐시 정리 완료');
                }, 1000);
            }
            
            if (CONFIG.DEBUG && pageNumber % 10 === 0) {
                const stats = ImageLoader.getStats();
                console.table(stats);
            }
            
        } catch (error) {
            log.error('페이지 로드 실패:', error);
            
            if (error.message === 'AUTH_EXPIRED' || error.message.includes('인증')) {
                if (confirm('인증이 만료되었습니다. 다시 로그인하시겠습니까?')) {
                    localStorage.removeItem('access_token');
                    window.location.href = 'index.html';
                }
            } else {
                UIController.showError();
                
                const reloadBtn = document.getElementById('reloadImageBtn');
                if (reloadBtn) {
                    reloadBtn.onclick = () => goToPage(pageNumber);
                }
            }
        } finally {
            ViewerState.isLoading = false;
            ViewerState.lastLoadTime = Date.now();
        }
    }
    
    function nextPage() {
        if (ViewerState.currentPage < ViewerState.totalPages) {
            goToPage(ViewerState.currentPage + 1);
        }
    }
    
    function prevPage() {
        if (ViewerState.currentPage > 1) {
            goToPage(ViewerState.currentPage - 1);
        }
    }
    
    function firstPage() {
        goToPage(1);
    }
    
    function lastPage() {
        goToPage(ViewerState.totalPages);
    }
    
    async function jumpToPage(pageNumber) {
        ImageLoader.cleanupCache(pageNumber);
        await goToPage(pageNumber);
    }
    
    return { goToPage, nextPage, prevPage, firstPage, lastPage, jumpToPage };
})();

// ============================================
// 줌 컨트롤
// ============================================
const ZoomControl = (() => {
    
    function zoomIn() {
        ViewerState.zoomLevel = Math.min(ViewerState.zoomLevel + CONFIG.ZOOM_STEP, CONFIG.MAX_ZOOM);
        UIController.updateZoomDisplay();
    }
    
    function zoomOut() {
        ViewerState.zoomLevel = Math.max(ViewerState.zoomLevel - CONFIG.ZOOM_STEP, CONFIG.MIN_ZOOM);
        UIController.updateZoomDisplay();
    }
    
    function resetZoom() {
        ViewerState.zoomLevel = 1;
        UIController.resetZoom();
    }
    
    function setZoom(level) {
        ViewerState.zoomLevel = Math.max(CONFIG.MIN_ZOOM, Math.min(level, CONFIG.MAX_ZOOM));
        UIController.updateZoomDisplay();
    }
    
    return { zoomIn, zoomOut, resetZoom, setZoom };
})();

// ============================================
// 이벤트 핸들러
// ============================================
const EventHandlers = (() => {
    
    function setupKeyboardEvents() {
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    Navigation.prevPage();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    Navigation.nextPage();
                    break;
                case ' ':
                case 'Space':
                    e.preventDefault();
                    Navigation.nextPage();
                    break;
                case 'Home':
                    e.preventDefault();
                    Navigation.firstPage();
                    break;
                case 'End':
                    e.preventDefault();
                    Navigation.lastPage();
                    break;
                case 'f':
                case 'F':
                    UIController.toggleFullscreen();
                    break;
                case '+':
                case '=':
                    ZoomControl.zoomIn();
                    break;
                case '-':
                case '_':
                    ZoomControl.zoomOut();
                    break;
                case '0':
                    ZoomControl.resetZoom();
                    break;
                case 'Escape':
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    }
                    break;
            }
        });
    }
    
    function setupMouseEvents(elements) {
        // 뒤로가기 버튼
        elements.backBtn.addEventListener('click', (e) => {
            e.preventDefault();

            // 마지막 읽은 시간 저장
            if (ViewerState.currentBook) {
                ViewerStorage.saveLastRead(ViewerState.currentBook.id)
                    .catch(err => log.error('마지막 읽은 시간 저장 실패:', err));
                sessionStorage.setItem('lastOpenedBook', ViewerState.currentBook.id);
            }

            window.location.href = 'index.html';
        });
        
        elements.fullscreenBtn.addEventListener('click', UIController.toggleFullscreen);
        
        elements.prevPageBtn.addEventListener('click', Navigation.prevPage);
        elements.nextPageBtn.addEventListener('click', Navigation.nextPage);
        elements.navPrev.addEventListener('click', Navigation.prevPage);
        elements.navNext.addEventListener('click', Navigation.nextPage);
        
        elements.currentPageInput.addEventListener('change', (e) => {
            const page = parseInt(e.target.value);
            if (!isNaN(page)) {
                Navigation.goToPage(page);
            }
        });
        
        elements.progressSlider.addEventListener('input', (e) => {
            const page = parseInt(e.target.value);
            Navigation.goToPage(page);
        });
        
        elements.zoomInBtn.addEventListener('click', ZoomControl.zoomIn);
        elements.zoomOutBtn.addEventListener('click', ZoomControl.zoomOut);
        elements.zoomResetBtn.addEventListener('click', ZoomControl.resetZoom);
        
        elements.reloadImageBtn.addEventListener('click', () => {
            Navigation.goToPage(ViewerState.currentPage);
        });
        
        let mouseTimer = null;
        document.addEventListener('mousemove', () => {
            UIController.showUI();
            
            if (mouseTimer) clearTimeout(mouseTimer);
            mouseTimer = setTimeout(() => {
                if (!ViewerState.isLoading) {
                    UIController.hideUI();
                }
            }, 3000);
        });
        
        elements.mainImage.addEventListener('dblclick', (e) => {
            e.preventDefault();
            if (ViewerState.zoomLevel === 1) {
                ZoomControl.setZoom(2);
            } else {
                ZoomControl.resetZoom();
            }
        });
    }
    
    function setupTouchEvents(elements) {
        let touchStartX = 0;
        let touchStartY = 0;
        let touchEndX = 0;
        let touchEndY = 0;
        
        elements.imageContainer.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            
            const currentTime = new Date().getTime();
            const tapLength = currentTime - ViewerState.lastTapTime;
            if (tapLength < 300 && tapLength > 0) {
                e.preventDefault();
                if (ViewerState.zoomLevel === 1) {
                    ZoomControl.setZoom(2);
                } else {
                    ZoomControl.resetZoom();
                }
            }
            ViewerState.lastTapTime = currentTime;
            
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                ViewerState.pinchDistance = Math.sqrt(dx * dx + dy * dy);
            }
        });
        
        elements.imageContainer.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (ViewerState.pinchDistance > 0) {
                    const scale = distance / ViewerState.pinchDistance;
                    const newZoom = ViewerState.zoomLevel * scale;
                    ZoomControl.setZoom(newZoom);
                    ViewerState.pinchDistance = distance;
                }
            }
        });
        
        elements.imageContainer.addEventListener('touchend', (e) => {
            if (e.changedTouches.length === 1) {
                touchEndX = e.changedTouches[0].clientX;
                touchEndY = e.changedTouches[0].clientY;
                
                const diffX = touchStartX - touchEndX;
                const diffY = touchStartY - touchEndY;
                
                if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > CONFIG.SWIPE_THRESHOLD) {
                    if (diffX > 0) {
                        Navigation.nextPage();
                    } else {
                        Navigation.prevPage();
                    }
                }
            }
            
            ViewerState.pinchDistance = 0;
        });
        
        elements.imageContainer.addEventListener('click', (e) => {
            if (e.target === elements.imageContainer || e.target === elements.mainImage) {
                if (elements.viewer.classList.contains('ui-hidden')) {
                    UIController.showUI();
                } else {
                    UIController.hideUI();
                }
            }
        });
    }
    
    function setupFullscreenEvents() {
        document.addEventListener('fullscreenchange', () => {
            ViewerState.isFullscreen = !!document.fullscreenElement;
            if (ViewerState.isFullscreen) {
                document.getElementById('viewer').classList.add('fullscreen');
            } else {
                document.getElementById('viewer').classList.remove('fullscreen');
            }
        });
    }
    
    return {
        setupKeyboardEvents,
        setupMouseEvents,
        setupTouchEvents,
        setupFullscreenEvents
    };
})();

// ============================================
// 브라우저 뒤로가기 처리
// ============================================
// 진행률 저장 기능 제거됨

// ============================================
// 초기화 함수
// ============================================
async function initializeViewer() {
    try {
        log.info('뷰어 초기화 시작');
        
        await initializeGoogleAPI();
        
        const bookData = sessionStorage.getItem('currentBook');
        if (!bookData) {
            alert('책 정보를 찾을 수 없습니다.');
            window.location.href = 'index.html';
            return;
        }
        
        ViewerState.currentBook = JSON.parse(bookData);
        ViewerState.images = ViewerState.currentBook.images || [];
        ViewerState.totalPages = ViewerState.images.length;
        
        ViewerState.images.forEach((img, index) => {
            img.pageNumber = index + 1;
        });
        
        log.info('책 정보 로드:', {
            title: ViewerState.currentBook.title,
            totalPages: ViewerState.totalPages
        });
        
        if (ViewerState.totalPages === 0) {
            alert('이 책에는 이미지가 없습니다.');
            window.location.href = 'index.html';
            return;
        }
        
        const token = localStorage.getItem('access_token');
        if (!token) {
            if (confirm('로그인이 필요합니다. 로그인 페이지로 이동하시겠습니까?')) {
                window.location.href = 'index.html';
            }
            return;
        }
        
        // 네트워크 상태에 따른 캐시 크기 조정
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (connection) {
            if (connection.saveData) {
                ImageLoader.setMaxCacheSize(20);
                log.info('데이터 절약 모드: 캐시 크기 축소');
            } else if (connection.effectiveType === '4g') {
                ImageLoader.setMaxCacheSize(100);
                log.info('4G 네트워크: 캐시 크기 확대');
            }
        }
        
        const elements = UIController.initializeElements();
        
        elements.bookTitle.textContent = ViewerState.currentBook.title;
        document.title = `${ViewerState.currentBook.title} - FastBook Viewer`;
        
        await ViewerStorage.initialize();

        // 책을 열었을 때 마지막 읽은 시간 기록
        ViewerStorage.saveLastRead(ViewerState.currentBook.id)
            .catch(err => log.error('마지막 읽은 시간 저장 실패:', err));

        EventHandlers.setupKeyboardEvents();
        EventHandlers.setupMouseEvents(elements);
        EventHandlers.setupTouchEvents(elements);
        EventHandlers.setupFullscreenEvents();
        
        // 성능 모니터링 (개발 모드)
        if (CONFIG.DEBUG) {
            setInterval(() => {
                const stats = ImageLoader.getStats();
                if (stats.memoryUsage > 80) {
                    console.warn('메모리 사용량 높음:', stats);
                }
            }, 30000);
        }
        
        UIController.updatePageDisplay();
        UIController.showUI();
        
        await Navigation.goToPage(ViewerState.currentPage);
        
        log.info('뷰어 초기화 완료');
        
    } catch (error) {
        log.error('뷰어 초기화 실패:', error);
        alert('뷰어를 초기화하는 중 오류가 발생했습니다.\n' + error.message);
    }
}

// ============================================
// 페이지 언로드 시 정리 (개선 #4)
// ============================================
window.addEventListener('beforeunload', () => {
    // 마지막 읽은 시간 저장
    if (ViewerState.currentBook) {
        const lastReadData = {
            bookId: ViewerState.currentBook.id,
            lastRead: new Date().toISOString()
        };

        sessionStorage.setItem(
            `book_lastread_${ViewerState.currentBook.id}`,
            JSON.stringify(lastReadData)
        );

        ViewerStorage.saveLastRead(ViewerState.currentBook.id);

        log.info('언로드 시 마지막 읽은 시간 저장:', lastReadData);
    }

    // 🔧 개선 #4: 모든 blob URL 정리
    ImageLoader.clearCache();

    if (CONFIG.DEBUG) {
        console.log('최종 로더 통계:', ImageLoader.getStats());
    }
});

// ============================================
// 네트워크 오프라인/온라인 처리
// ============================================
window.addEventListener('online', () => {
    log.info('네트워크 연결 복구');
    Navigation.goToPage(ViewerState.currentPage);
});

window.addEventListener('offline', () => {
    log.warn('네트워크 연결 끊김');
    alert('네트워크 연결이 끊어졌습니다. 캐시된 페이지만 볼 수 있습니다.');
});

// ============================================
// 메모리 부족 처리
// ============================================
if ('storage' in navigator && 'estimate' in navigator.storage) {
    navigator.storage.estimate().then(estimate => {
        const percentUsed = (estimate.usage / estimate.quota) * 100;
        if (percentUsed > 90) {
            log.warn('저장 공간 부족:', percentUsed.toFixed(2) + '%');
            ImageLoader.setMaxCacheSize(20);
        }
    });
}

// ============================================
// 뷰어 시작
// ============================================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeViewer);
} else {
    initializeViewer();
}

// 전역 노출 (디버깅용)
window.FastBook.ImageLoader = ImageLoader;
window.FastBook.ViewerState = ViewerState;
window.FastBook.Navigation = Navigation;

// ============================================
// ThemeManager (뷰어) - 다크/라이트 토글
// ============================================
const ViewerThemeManager = (() => {
    const STORAGE_KEY = 'fastbook_theme';
    function initialize() {
        const saved = localStorage.getItem(STORAGE_KEY);
        const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', saved || system);
    }
    return { initialize };
})();

// ============================================
// NetworkManager (뷰어) - 네트워크 상태
// ============================================
const ViewerNetworkManager = (() => {
    const banner = document.getElementById('networkBanner');

    function showBanner(message, type) {
        if (!banner) return;
        banner.textContent = '';
        const icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = type === 'offline' ? '⚠️ ' : '✓ ';
        const text = document.createElement('span');
        text.textContent = message;
        banner.appendChild(icon);
        banner.appendChild(text);
        banner.className = `network-banner ${type}`;
        if (type === 'online-restored') {
            setTimeout(() => { if (banner) banner.className = 'network-banner'; }, 3000);
        }
    }

    function initialize() {
        window.addEventListener('offline', () => {
            showBanner('인터넷 연결이 끊어졌습니다', 'offline');
        });
        window.addEventListener('online', () => {
            showBanner('인터넷 연결이 복구되었습니다', 'online-restored');
            // 현재 페이지 재로드 시도
            if (ViewerState.currentPage) {
                Navigation.goToPage(ViewerState.currentPage);
            }
        });
        if (!navigator.onLine) showBanner('인터넷 연결이 없습니다', 'offline');
    }

    return { initialize };
})();

// ============================================
// BookmarkManager - 북마크 기능
// ============================================
const BookmarkManager = (() => {
    function getDB() { return ViewerStorage.getDB(); }

    function makeId(bookId, pageNumber) {
        return `${bookId}_${pageNumber}`;
    }

    async function addBookmark(bookId, bookTitle, pageNumber) {
        const db = getDB();
        if (!db || !db.objectStoreNames.contains('bookmarks')) return;
        const tx = db.transaction(['bookmarks'], 'readwrite');
        const store = tx.objectStore('bookmarks');
        const data = {
            id: makeId(bookId, pageNumber),
            bookId,
            bookTitle,
            pageNumber,
            createdAt: new Date().toISOString()
        };
        store.put(data);
        log.info(`북마크 추가: 페이지 ${pageNumber}`);
    }

    async function removeBookmark(bookId, pageNumber) {
        const db = getDB();
        if (!db || !db.objectStoreNames.contains('bookmarks')) return;
        const tx = db.transaction(['bookmarks'], 'readwrite');
        tx.objectStore('bookmarks').delete(makeId(bookId, pageNumber));
        log.info(`북마크 제거: 페이지 ${pageNumber}`);
    }

    async function getBookmarks(bookId) {
        const db = getDB();
        if (!db || !db.objectStoreNames.contains('bookmarks')) return [];
        const tx = db.transaction(['bookmarks'], 'readonly');
        const store = tx.objectStore('bookmarks');
        return new Promise(resolve => {
            const req = store.getAll();
            req.onsuccess = () => resolve(
                (req.result || []).filter(b => b.bookId === bookId).sort((a, b) => a.pageNumber - b.pageNumber)
            );
            req.onerror = () => resolve([]);
        });
    }

    async function isBookmarked(bookId, pageNumber) {
        const db = getDB();
        if (!db || !db.objectStoreNames.contains('bookmarks')) return false;
        const tx = db.transaction(['bookmarks'], 'readonly');
        return new Promise(resolve => {
            const req = tx.objectStore('bookmarks').get(makeId(bookId, pageNumber));
            req.onsuccess = () => resolve(!!req.result);
            req.onerror = () => resolve(false);
        });
    }

    async function renderPanel(bookId) {
        const list = document.getElementById('bookmarkList');
        if (!list) return;
        const bookmarks = await getBookmarks(bookId);
        list.innerHTML = '';
        bookmarks.forEach(bm => {
            const item = document.createElement('div');
            item.className = 'bookmark-item';
            item.setAttribute('role', 'listitem');
            item.setAttribute('tabindex', '0');
            item.setAttribute('aria-label', `페이지 ${bm.pageNumber}로 이동`);
            const date = new Date(bm.createdAt);
            const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
            item.innerHTML = `
                <span class="bookmark-page-num">p.${bm.pageNumber}</span>
                <div class="bookmark-info">
                    <div style="color:rgba(255,255,255,0.85);font-size:0.8rem;">${bm.pageNumber}페이지</div>
                    <div class="bookmark-date">${dateStr}</div>
                </div>
                <button class="bookmark-delete" data-page="${bm.pageNumber}" aria-label="북마크 삭제" title="삭제">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            `;
            item.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-delete')) return;
                Navigation.goToPage(bm.pageNumber);
                closePanel();
            });
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    Navigation.goToPage(bm.pageNumber);
                    closePanel();
                }
            });
            item.querySelector('.bookmark-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                await removeBookmark(bookId, bm.pageNumber);
                renderPanel(bookId);
                updateProgressMarkers(bookId);
                updateBookmarkButton(bookId, ViewerState.currentPage);
            });
            list.appendChild(item);
        });
    }

    function openPanel() {
        document.getElementById('bookmarkPanel').classList.add('open');
    }
    function closePanel() {
        document.getElementById('bookmarkPanel').classList.remove('open');
    }
    function togglePanel() {
        const panel = document.getElementById('bookmarkPanel');
        panel.classList.toggle('open');
    }

    async function updateProgressMarkers(bookId) {
        // 진행 바에서 기존 마커 제거
        document.querySelectorAll('.progress-bookmark-marker').forEach(el => el.remove());
        const progressContainer = document.querySelector('.progress-container');
        if (!progressContainer) return;

        const bookmarks = await getBookmarks(bookId);
        const total = ViewerState.totalPages;
        bookmarks.forEach(bm => {
            const pct = ((bm.pageNumber - 1) / Math.max(total - 1, 1)) * 100;
            const marker = document.createElement('div');
            marker.className = 'progress-bookmark-marker';
            marker.style.left = `${pct}%`;
            marker.setAttribute('aria-label', `북마크: ${bm.pageNumber}페이지`);
            progressContainer.appendChild(marker);
        });
    }

    async function updateBookmarkButton(bookId, pageNumber) {
        const btn = document.getElementById('bookmarkBtn');
        if (!btn) return;
        const marked = await isBookmarked(bookId, pageNumber);
        btn.classList.toggle('btn-bookmark-active', marked);
        btn.setAttribute('aria-pressed', marked ? 'true' : 'false');
        const svg = btn.querySelector('svg');
        if (svg) svg.setAttribute('fill', marked ? '#f6ad55' : 'none');
    }

    async function toggleBookmark() {
        const book = ViewerState.currentBook;
        if (!book) return;
        const page = ViewerState.currentPage;
        const marked = await isBookmarked(book.id, page);
        if (marked) {
            await removeBookmark(book.id, page);
        } else {
            await addBookmark(book.id, book.title, page);
        }
        await updateBookmarkButton(book.id, page);
        await updateProgressMarkers(book.id);
        await renderPanel(book.id);
    }

    return { toggleBookmark, renderPanel, updateProgressMarkers, updateBookmarkButton, openPanel, closePanel, togglePanel, getBookmarks };
})();

// ============================================
// ReadingTimeTracker - 독서 시간 추적
// ============================================
const ReadingTimeTracker = (() => {
    let sessionStart = null;

    function start() {
        sessionStart = Date.now();
    }

    async function end() {
        if (!sessionStart || !ViewerState.currentBook) return;
        const durationMs = Date.now() - sessionStart;
        sessionStart = null;
        if (durationMs < 5000) return; // 5초 미만 세션은 무시

        const db = ViewerStorage.getDB();
        if (!db || !db.objectStoreNames.contains('reading_stats')) return;

        const bookId = ViewerState.currentBook.id;
        const tx = db.transaction(['reading_stats'], 'readwrite');
        const store = tx.objectStore('reading_stats');

        const existing = await new Promise(resolve => {
            const req = store.get(bookId);
            req.onsuccess = () => resolve(req.result || { bookId, totalMs: 0, sessions: 0 });
            req.onerror = () => resolve({ bookId, totalMs: 0, sessions: 0 });
        });

        store.put({
            ...existing,
            totalMs: (existing.totalMs || 0) + durationMs,
            sessions: (existing.sessions || 0) + 1,
            lastRead: new Date().toISOString()
        });
        log.info(`독서 시간 기록: ${Math.round(durationMs/1000)}초`);
    }

    return { start, end };
})();

// ============================================
// ViewModeController - 연속 스크롤 & 2페이지 보기
// ============================================
const ViewModeController = (() => {
    // 'single' | 'scroll' | 'spread'
    let currentMode = 'single';
    const STORAGE_KEY = 'fastbook_viewmode';

    function getMode() { return currentMode; }

    function setMode(mode) {
        const viewer = document.getElementById('viewer');
        const imageContainer = document.getElementById('imageContainer');
        if (!viewer || !imageContainer) return;

        // 기존 모드 클래스 제거
        viewer.classList.remove('scroll-mode', 'spread-mode');

        // 버튼 상태 초기화
        document.getElementById('scrollModeBtn').classList.remove('active');
        document.getElementById('scrollModeBtn').setAttribute('aria-pressed', 'false');
        document.getElementById('spreadModeBtn').classList.remove('active');
        document.getElementById('spreadModeBtn').setAttribute('aria-pressed', 'false');

        currentMode = mode;
        localStorage.setItem(STORAGE_KEY, mode);

        if (mode === 'scroll') {
            viewer.classList.add('scroll-mode');
            document.getElementById('scrollModeBtn').classList.add('active');
            document.getElementById('scrollModeBtn').setAttribute('aria-pressed', 'true');
            enterScrollMode();
        } else if (mode === 'spread') {
            viewer.classList.add('spread-mode');
            document.getElementById('spreadModeBtn').classList.add('active');
            document.getElementById('spreadModeBtn').setAttribute('aria-pressed', 'true');
            renderSpread(ViewerState.currentPage);
        } else {
            // single mode: 기존 뷰어 복원
            exitSpecialModes();
            Navigation.goToPage(ViewerState.currentPage);
        }
    }

    function restoreMode() {
        const saved = localStorage.getItem(STORAGE_KEY) || 'single';
        setMode(saved);
    }

    // ---- 연속 스크롤 모드 ----
    let scrollObserver = null;
    let scrollLoadedPages = new Set();

    function enterScrollMode() {
        const container = document.getElementById('imageContainer');
        if (!container) return;

        // 기존 내용 정리
        container.innerHTML = '';
        scrollLoadedPages.clear();

        // 단일 이미지 숨기기 (scroll-mode 에서는 직접 관리)
        const mainImage = document.getElementById('mainImage');
        if (mainImage) mainImage.style.display = 'none';

        // 스켈레톤 + IntersectionObserver로 지연 로딩
        for (let i = 1; i <= ViewerState.totalPages; i++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'scroll-page-wrapper';
            wrapper.dataset.page = i;

            const skeleton = document.createElement('div');
            skeleton.className = 'scroll-page-skeleton';
            skeleton.dataset.lazyPage = i;

            const pageNum = document.createElement('div');
            pageNum.className = 'scroll-page-number';
            pageNum.textContent = i;

            wrapper.appendChild(skeleton);
            wrapper.appendChild(pageNum);
            container.appendChild(wrapper);
        }

        // 현재 페이지로 스크롤
        setTimeout(() => {
            const target = container.querySelector(`[data-page="${ViewerState.currentPage}"]`);
            if (target) target.scrollIntoView({ behavior: 'instant' });
        }, 50);

        // IntersectionObserver로 뷰포트 진입 시 로드
        if (scrollObserver) scrollObserver.disconnect();
        scrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const page = parseInt(entry.target.dataset.lazyPage || entry.target.closest('[data-page]')?.dataset.page);
                    if (page && !scrollLoadedPages.has(page)) {
                        loadScrollPage(page, entry.target);
                        // 현재 페이지 업데이트
                        const wrapper = entry.target.closest('[data-page]');
                        if (wrapper) {
                            ViewerState.currentPage = parseInt(wrapper.dataset.page);
                            UIController.updatePageDisplay();
                            if (ViewerState.currentBook) {
                                BookmarkManager.updateBookmarkButton(ViewerState.currentBook.id, ViewerState.currentPage);
                            }
                        }
                    }
                }
            });
        }, { root: container, rootMargin: '200px', threshold: 0.01 });

        container.querySelectorAll('[data-lazy-page]').forEach(el => scrollObserver.observe(el));
    }

    async function loadScrollPage(pageNum, skeletonEl) {
        if (scrollLoadedPages.has(pageNum)) return;
        scrollLoadedPages.add(pageNum);

        const imageData = ViewerState.images[pageNum - 1];
        if (!imageData) return;

        try {
            const url = await ImageLoader.loadImage(imageData, pageNum <= ViewerState.currentPage + 3 ? 'high' : 'normal');
            const wrapper = skeletonEl.closest('[data-page]') || skeletonEl.parentElement;
            if (!wrapper) return;

            const img = document.createElement('img');
            img.className = 'scroll-page-img';
            img.src = url;
            img.alt = `${pageNum}페이지`;
            img.setAttribute('loading', 'lazy');

            skeletonEl.replaceWith(img);
            if (scrollObserver) scrollObserver.observe(img);
        } catch (e) {
            log.warn(`스크롤 페이지 ${pageNum} 로드 실패:`, e);
        }
    }

    // ---- 2페이지 펼침 모드 ----
    async function renderSpread(startPage) {
        // 짝수 시작은 홀수로 조정 (표지=1페이지 예외)
        const leftPage = startPage % 2 === 0 ? startPage - 1 : startPage;
        const rightPage = leftPage + 1;

        const container = document.getElementById('imageContainer');
        if (!container) return;
        container.innerHTML = '';

        // mainImage를 숨김 (spread wrapper가 대체)
        const origMain = document.getElementById('mainImage');
        if (origMain) origMain.style.display = 'none';

        const wrapper = document.createElement('div');
        wrapper.className = 'spread-wrapper';

        const leftEl = document.createElement('div');
        leftEl.className = 'spread-page';
        const rightEl = document.createElement('div');
        rightEl.className = 'spread-page';

        // 왼쪽 페이지
        if (ViewerState.images[leftPage - 1]) {
            try {
                const url = await ImageLoader.loadImage(ViewerState.images[leftPage - 1], 'high');
                const img = document.createElement('img');
                img.src = url; img.alt = `${leftPage}페이지`;
                leftEl.appendChild(img);
            } catch { leftEl.classList.add('spread-page-blank'); leftEl.textContent = `${leftPage}p`; }
        } else {
            leftEl.classList.add('spread-page-blank');
            leftEl.textContent = '';
        }

        // 오른쪽 페이지
        if (rightPage <= ViewerState.totalPages && ViewerState.images[rightPage - 1]) {
            try {
                const url = await ImageLoader.loadImage(ViewerState.images[rightPage - 1], 'high');
                const img = document.createElement('img');
                img.src = url; img.alt = `${rightPage}페이지`;
                rightEl.appendChild(img);
            } catch { rightEl.classList.add('spread-page-blank'); rightEl.textContent = `${rightPage}p`; }
        } else {
            rightEl.classList.add('spread-page-blank');
            rightEl.textContent = '';
        }

        wrapper.appendChild(leftEl);
        wrapper.appendChild(rightEl);
        container.appendChild(wrapper);

        ViewerState.currentPage = leftPage;
        UIController.updatePageDisplay();
    }

    function exitSpecialModes() {
        if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
        scrollLoadedPages.clear();
        const container = document.getElementById('imageContainer');
        if (!container) return;
        container.innerHTML = `
            <div id="loadingSkeleton" class="loading-skeleton"><div class="skeleton-box"></div></div>
            <img id="mainImage" class="main-image" alt="페이지 이미지" style="display:none;">
            <div id="imageError" class="image-error" style="display:none;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                </svg>
                <p>이미지를 불러올 수 없습니다</p>
                <button id="reloadImageBtn" class="btn-secondary">다시 시도</button>
            </div>
            <div class="nav-area nav-prev" id="navPrev"></div>
            <div class="nav-area nav-next" id="navNext"></div>
        `;
        // UIController elements 재초기화
        UIController.initializeElements();
        // 이벤트 재연결 (reloadImageBtn)
        const reloadBtn = document.getElementById('reloadImageBtn');
        if (reloadBtn) reloadBtn.addEventListener('click', () => Navigation.goToPage(ViewerState.currentPage));
        // 클릭 이벤트 재연결
        document.getElementById('navPrev')?.addEventListener('click', Navigation.prevPage);
        document.getElementById('navNext')?.addEventListener('click', Navigation.nextPage);
    }

    // 스프레드 모드에서 페이지 이동
    function spreadPrev() {
        if (currentMode !== 'spread') return;
        const leftPage = ViewerState.currentPage % 2 === 0 ? ViewerState.currentPage - 1 : ViewerState.currentPage;
        if (leftPage > 1) renderSpread(leftPage - 2);
    }
    function spreadNext() {
        if (currentMode !== 'spread') return;
        const leftPage = ViewerState.currentPage % 2 === 0 ? ViewerState.currentPage - 1 : ViewerState.currentPage;
        const nextLeft = leftPage + 2;
        if (nextLeft <= ViewerState.totalPages) renderSpread(nextLeft);
    }

    return { setMode, getMode, restoreMode, spreadPrev, spreadNext, renderSpread };
})();

// ============================================
// 뷰어 신기능 초기화
// ============================================
function initializeViewerFeatures() {
    ViewerThemeManager.initialize();
    ViewerNetworkManager.initialize();

    // 북마크 버튼
    document.getElementById('bookmarkBtn')?.addEventListener('click', BookmarkManager.toggleBookmark);
    // 북마크 패널 토글
    document.getElementById('bookmarkListBtn')?.addEventListener('click', BookmarkManager.togglePanel);
    document.getElementById('bookmarkPanelClose')?.addEventListener('click', BookmarkManager.closePanel);

    // 스크롤/스프레드 모드 버튼
    document.getElementById('scrollModeBtn')?.addEventListener('click', () => {
        ViewModeController.setMode(ViewModeController.getMode() === 'scroll' ? 'single' : 'scroll');
    });
    document.getElementById('spreadModeBtn')?.addEventListener('click', () => {
        ViewModeController.setMode(ViewModeController.getMode() === 'spread' ? 'single' : 'spread');
    });

    // 키보드: B = 북마크, S = 스크롤모드, D = 2페이지
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        switch (e.key) {
            case 'b': case 'B': BookmarkManager.toggleBookmark(); break;
            case 's': case 'S':
                ViewModeController.setMode(ViewModeController.getMode() === 'scroll' ? 'single' : 'scroll');
                break;
            case 'd': case 'D':
                ViewModeController.setMode(ViewModeController.getMode() === 'spread' ? 'single' : 'spread');
                break;
        }
    });

    // 스프레드 모드에서 좌우 버튼 재정의
    const origNextPage = Navigation.nextPage;
    const origPrevPage = Navigation.prevPage;
    Navigation.nextPage = function() {
        if (ViewModeController.getMode() === 'spread') { ViewModeController.spreadNext(); return; }
        origNextPage();
    };
    Navigation.prevPage = function() {
        if (ViewModeController.getMode() === 'spread') { ViewModeController.spreadPrev(); return; }
        origPrevPage();
    };

    // 독서 시간 추적 시작
    ReadingTimeTracker.start();

    // 페이지 이동 후 북마크 상태 업데이트 (goToPage 훅)
    const origGoToPage = Navigation.goToPage;
    Navigation.goToPage = async function(page) {
        if (ViewModeController.getMode() === 'scroll') return; // 스크롤 모드는 자체 처리
        await origGoToPage(page);
        if (ViewerState.currentBook) {
            BookmarkManager.updateBookmarkButton(ViewerState.currentBook.id, page);
        }
    };
}

// initializeViewer 완료 후 신기능 초기화
// DOMContentLoaded 이후 별도 훅으로 실행 (이벤트 리스너 참조 문제 회피)
async function initializeViewerFeaturesAfterReady() {
    // DB 초기화 완료를 기다림 (ViewerStorage.initialize가 initializeViewer에서 호출됨)
    // 100ms 대기 후 시도
    let retries = 0;
    while (!ViewerState.currentBook && retries < 50) {
        await new Promise(r => setTimeout(r, 100));
        retries++;
    }
    if (!ViewerState.currentBook) return;

    await BookmarkManager.renderPanel(ViewerState.currentBook.id);
    await BookmarkManager.updateProgressMarkers(ViewerState.currentBook.id);
    await BookmarkManager.updateBookmarkButton(ViewerState.currentBook.id, ViewerState.currentPage);
    initializeViewerFeatures();
    ViewModeController.restoreMode();
}

// 페이지 언로드 시 독서 시간 저장
window.addEventListener('beforeunload', () => {
    ReadingTimeTracker.end();
}, { capture: true });

// DOM 준비 후 신기능 초기화 실행
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeViewerFeaturesAfterReady);
} else {
    initializeViewerFeaturesAfterReady();
}
