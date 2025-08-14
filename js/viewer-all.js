// js/viewer-all.js - FastBook Viewer 뷰어 페이지 통합 버전 (완전 최적화)
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
// LRU 캐시 구현
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
// Storage 모듈 (IndexedDB)
// ============================================
const ViewerStorage = (() => {
    let db = null;
    
    async function initialize() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
            
            request.onerror = () => {
                log.error('IndexedDB 열기 실패:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                db = request.result;
                log.info('IndexedDB 초기화 완료');
                resolve(db);
            };
            
            request.onupgradeneeded = (event) => {
                db = event.target.result;
                
                if (!db.objectStoreNames.contains('reading_progress')) {
                    db.createObjectStore('reading_progress', { keyPath: 'bookId' });
                }
                
                log.info('IndexedDB 스키마 생성 완료');
            };
        });
    }
    
    async function saveProgress(bookId, currentPage, totalPages) {
        if (!db) return;
        
        const transaction = db.transaction(['reading_progress'], 'readwrite');
        const store = transaction.objectStore('reading_progress');
        
        const progressData = {
            bookId,
            currentPage,
            totalPages,
            percentage: Math.round((currentPage / totalPages) * 100),
            lastRead: new Date().toISOString()
        };
        
        return new Promise((resolve, reject) => {
            const request = store.put(progressData);
            request.onsuccess = () => {
                // SessionStorage에도 저장 (목록 페이지에서 즉시 반영용)
                sessionStorage.setItem(`book_progress_${bookId}`, JSON.stringify(progressData));
                log.debug('진행률 저장됨:', progressData);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    async function getProgress(bookId) {
        if (!db) return null;
        
        const transaction = db.transaction(['reading_progress'], 'readonly');
        const store = transaction.objectStore('reading_progress');
        
        return new Promise((resolve, reject) => {
            const request = store.get(bookId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    return { initialize, saveProgress, getProgress };
})();

// ============================================
// 최적화된 Image Loader 모듈
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
                const blobUrl = URL.createObjectURL(blob);
                
                await validateImage(blobUrl);
                
                return blobUrl;
                
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
            
            // 진행률 저장 (디바운스)
            if (ViewerState.saveProgressTimeout) {
                clearTimeout(ViewerState.saveProgressTimeout);
            }
            ViewerState.saveProgressTimeout = setTimeout(() => {
                ViewerStorage.saveProgress(
                    ViewerState.currentBook.id,
                    ViewerState.currentPage,
                    ViewerState.totalPages
                ).catch(err => log.error('진행률 저장 실패:', err));
            }, 1000);
            
            // 비동기 프리로딩
            requestAnimationFrame(() => {
                ImageLoader.preloadImages(
                    pageNumber,
                    ViewerState.totalPages,
                    ViewerState.images
                ).catch(err => log.warn('프리로드 실패:', err));
            });
            
            // 주기적 캐시 정리
            if (pageNumber % 20 === 0) {
                requestIdleCallback(() => {
                    ImageLoader.cleanupCache(pageNumber);
                    log.debug('캐시 정리 완료');
                });
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
        // 뒤로가기 버튼 - 최적화된 버전
        elements.backBtn.addEventListener('click', (e) => {
            e.preventDefault();
            
            // 현재 진행률 저장
            if (ViewerState.currentBook) {
                ViewerStorage.saveProgress(
                    ViewerState.currentBook.id,
                    ViewerState.currentPage,
                    ViewerState.totalPages
                ).then(() => {
                    // 진행률을 SessionStorage에도 저장 (즉시 반영용)
                    const progressData = {
                        currentPage: ViewerState.currentPage,
                        totalPages: ViewerState.totalPages,
                        percentage: Math.round((ViewerState.currentPage / ViewerState.totalPages) * 100),
                        lastRead: new Date().toISOString()
                    };
                    sessionStorage.setItem(
                        `book_progress_${ViewerState.currentBook.id}`, 
                        JSON.stringify(progressData)
                    );
                    
                    // 마지막 읽은 책 표시
                    sessionStorage.setItem('lastOpenedBook', ViewerState.currentBook.id);
                    
                    // 목록 페이지로 이동
                    window.location.href = 'index.html';
                }).catch(err => {
                    log.error('진행률 저장 실패:', err);
                    // 실패해도 목록으로 이동
                    window.location.href = 'index.html';
                });
            } else {
                window.location.href = 'index.html';
            }
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
window.addEventListener('popstate', (e) => {
    // 진행률 저장
    if (ViewerState.currentBook) {
        const progressData = {
            currentPage: ViewerState.currentPage,
            totalPages: ViewerState.totalPages,
            percentage: Math.round((ViewerState.currentPage / ViewerState.totalPages) * 100),
            lastRead: new Date().toISOString()
        };
        sessionStorage.setItem(
            `book_progress_${ViewerState.currentBook.id}`, 
            JSON.stringify(progressData)
        );
        sessionStorage.setItem('lastOpenedBook', ViewerState.currentBook.id);
    }
});

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
        
        // 저장된 진행률 불러오기
        const savedProgress = await ViewerStorage.getProgress(ViewerState.currentBook.id);
        if (savedProgress && savedProgress.currentPage) {
            ViewerState.currentPage = Math.min(savedProgress.currentPage, ViewerState.totalPages);
            log.info('저장된 진행률 로드:', savedProgress);
            
            // 진행률이 있으면 해당 위치 주변부터 프리로드
            if (savedProgress.currentPage > 1) {
                requestIdleCallback(() => {
                    ImageLoader.preloadImages(
                        savedProgress.currentPage,
                        ViewerState.totalPages,
                        ViewerState.images
                    );
                });
            }
        }
        
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
// 페이지 언로드 시 정리
// ============================================
window.addEventListener('beforeunload', () => {
    // 현재 진행률 저장
    if (ViewerState.currentBook) {
        const progressData = {
            currentPage: ViewerState.currentPage,
            totalPages: ViewerState.totalPages,
            percentage: Math.round((ViewerState.currentPage / ViewerState.totalPages) * 100),
            lastRead: new Date().toISOString()
        };
        
        // SessionStorage에 즉시 저장 (동기)
        sessionStorage.setItem(
            `book_progress_${ViewerState.currentBook.id}`, 
            JSON.stringify(progressData)
        );
        
        // IndexedDB에도 저장 시도 (비동기)
        ViewerStorage.saveProgress(
            ViewerState.currentBook.id,
            ViewerState.currentPage,
            ViewerState.totalPages
        );
    }
    
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