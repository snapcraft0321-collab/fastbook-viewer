// js/config.js
// Google API 설정
const CONFIG = {
    // Google OAuth 2.0 설정
    CLIENT_ID: '764151662596-meoq1vat80abhsdo2haedqs0q01anrq4.apps.googleusercontent.com', // Google Cloud Console에서 발급받은 Client ID
    API_KEY: 'AIzaSyA7ToL4aacBs0pxwF6d_osdi-aSHHuLSRM', // Google Cloud Console에서 발급받은 API Key
    
    // API 스코프
    SCOPES: 'https://www.googleapis.com/auth/drive.readonly',
    
    // Google API Discovery Docs
    DISCOVERY_DOCS: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
    
    // 앱 설정
    APP_NAME: 'FastBook Viewer',
    BOOKS_FOLDER_NAME: 'Books', // Google Drive의 책 폴더 이름
    
    // 이미지 로딩 설정
    PRELOAD_PAGES: 5, // 미리 로드할 페이지 수
    MAX_CACHED_IMAGES: 20, // 메모리에 캐시할 최대 이미지 수
    IMAGE_LOAD_TIMEOUT: 30000, // 이미지 로드 타임아웃 (30초)
    
    // API 요청 설정
    MAX_RESULTS_PER_PAGE: 100, // 한 번에 가져올 최대 파일 수
    FOLDER_SCAN_INTERVAL: 300000, // 폴더 자동 스캔 간격 (5분)
    API_RETRY_ATTEMPTS: 3, // API 요청 실패 시 재시도 횟수
    API_RETRY_DELAY: 1000, // 재시도 지연 시간 (ms)
    
    // 캐시 설정
    CACHE_VERSION: 'v1.0.0',
    METADATA_CACHE_DURATION: 3600000, // 메타데이터 캐시 유효 시간 (1시간)
    
    // UI 설정
    ANIMATION_DURATION: 300, // 애니메이션 지속 시간 (ms)
    DEBOUNCE_DELAY: 250, // 디바운스 지연 시간 (ms)
    
    // 줌 설정
    MIN_ZOOM: 0.5, // 최소 줌 레벨 (50%)
    MAX_ZOOM: 3, // 최대 줌 레벨 (300%)
    ZOOM_STEP: 0.25, // 줌 단계 (25%)
    
    // 터치 제스처 설정
    SWIPE_THRESHOLD: 50, // 스와이프 인식 최소 거리 (px)
    PINCH_ZOOM_SENSITIVITY: 0.01, // 핀치 줌 민감도
    
    // IndexedDB 설정
    DB_NAME: 'FastBookViewer',
    DB_VERSION: 1,
    
    // Service Worker 설정
    ENABLE_SERVICE_WORKER: false, // 일단 비활성화
    SW_CACHE_NAME: 'fastbook-cache-v1',
    
    // 디버그 설정
    DEBUG: true, // 개발 중에는 true, 배포 시 false
    
    // 지원 파일 형식
    SUPPORTED_FORMATS: ['webp', 'jpg', 'jpeg', 'png', 'gif'],
    
    // 에러 메시지
    ERRORS: {
        AUTH_FAILED: '인증에 실패했습니다. 다시 로그인해주세요.',
        FOLDER_NOT_FOUND: 'Books 폴더를 찾을 수 없습니다.',
        NO_BOOKS: '책을 찾을 수 없습니다.',
        LOAD_FAILED: '책 목록을 불러오는데 실패했습니다.',
        IMAGE_LOAD_FAILED: '이미지를 불러올 수 없습니다.',
        NETWORK_ERROR: '네트워크 연결을 확인해주세요.',
        PERMISSION_DENIED: 'Google Drive 접근 권한이 필요합니다.',
        QUOTA_EXCEEDED: 'API 할당량을 초과했습니다. 잠시 후 다시 시도해주세요.'
    }
};

// 로그 유틸리티
const log = {
    info: (...args) => CONFIG.DEBUG && console.log('[FastBook]', ...args),
    error: (...args) => console.error('[FastBook Error]', ...args),
    warn: (...args) => CONFIG.DEBUG && console.warn('[FastBook Warning]', ...args),
    debug: (...args) => CONFIG.DEBUG && console.debug('[FastBook Debug]', ...args)
};

// 유틸리티 함수들
const utils = {
    // 디바운스 함수
    debounce: (func, wait) => {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },
    
    // 스로틀 함수
    throttle: (func, limit) => {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },
    
    // 파일명에서 숫자 추출 (페이지 번호용)
    extractPageNumber: (filename) => {
        const match = filename.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    },
    
    // 파일 확장자 확인
    isImageFile: (filename) => {
        const ext = filename.split('.').pop().toLowerCase();
        return CONFIG.SUPPORTED_FORMATS.includes(ext);
    },
    
    // 바이트를 읽기 쉬운 형식으로 변환
    formatBytes: (bytes, decimals = 2) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },
    
    // 날짜 포맷팅
    formatDate: (date) => {
        const d = new Date(date);
        const now = new Date();
        const diff = now - d;
        
        if (diff < 86400000) { // 24시간 이내
            const hours = Math.floor(diff / 3600000);
            if (hours === 0) {
                const minutes = Math.floor(diff / 60000);
                return minutes === 0 ? '방금 전' : `${minutes}분 전`;
            }
            return `${hours}시간 전`;
        } else if (diff < 604800000) { // 7일 이내
            const days = Math.floor(diff / 86400000);
            return `${days}일 전`;
        } else {
            return d.toLocaleDateString('ko-KR');
        }
    },
    
    // Promise 재시도 로직
    retry: async (fn, attempts = CONFIG.API_RETRY_ATTEMPTS, delay = CONFIG.API_RETRY_DELAY) => {
        try {
            return await fn();
        } catch (error) {
            if (attempts <= 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
            return utils.retry(fn, attempts - 1, delay * 2);
        }
    },
    
    // 이미지 프리로드
    preloadImage: (url) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => {
                reject(new Error('Image load timeout'));
            }, CONFIG.IMAGE_LOAD_TIMEOUT);
            
            img.onload = () => {
                clearTimeout(timeout);
                resolve(img);
            };
            
            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Image load failed'));
            };
            
            img.src = url;
        });
    }
};

// 전역 상태 관리
const AppState = {
    user: null,
    books: [],
    currentBook: null,
    currentPage: 1,
    isLoading: false,
    error: null,
    cache: new Map(),
    preloadQueue: [],
    zoomLevel: 1
};

// 이벤트 에미터
class EventEmitter {
    constructor() {
        this.events = {};
    }
    
    on(event, listener) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(listener);
    }
    
    off(event, listenerToRemove) {
        if (!this.events[event]) return;
        this.events[event] = this.events[event].filter(listener => listener !== listenerToRemove);
    }
    
    emit(event, ...args) {
        if (!this.events[event]) return;
        this.events[event].forEach(listener => listener(...args));
    }
}

const eventBus = new EventEmitter();

// requestIdleCallback 폴리필 (Safari 등에서 미지원)
if (!window.requestIdleCallback) {
    window.requestIdleCallback = function(callback, options) {
        const start = Date.now();
        return setTimeout(function() {
            callback({
                didTimeout: false,
                timeRemaining: function() {
                    return Math.max(0, 50 - (Date.now() - start));
                }
            });
        }, 1);
    };
}

if (!window.cancelIdleCallback) {
    window.cancelIdleCallback = function(id) {
        clearTimeout(id);
    };
}

// 전역 객체로 export - window 객체가 없으면 생성
if (typeof window.FastBook === 'undefined') {
    window.FastBook = {};
}

// FastBook 객체에 추가
window.FastBook.CONFIG = CONFIG;
window.FastBook.log = log;
window.FastBook.utils = utils;
window.FastBook.AppState = AppState;
window.FastBook.eventBus = eventBus;
