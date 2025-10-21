// js/fastbook-all.js - FastBook Viewer 메인 페이지 통합 버전 (개선됨)
console.log('[FastBook] 통합 버전 시작');

// FastBook 전역 객체 확인
if (!window.FastBook) {
    console.error('[FastBook] CONFIG가 로드되지 않았습니다!');
    alert('config.js를 먼저 로드해주세요.');
}

// ============================================
// 책 목록 캐싱 시스템
// ============================================
const BooksCache = (() => {
    const CACHE_KEY = 'books_cache';
    const CACHE_TIMESTAMP_KEY = 'books_cache_timestamp';
    const CACHE_DURATION = 5 * 60 * 1000; // 5분
    
    function saveToCache(books) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify(books));
            sessionStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
            log.info('책 목록 캐시 저장 완료:', books.length + '권');
        } catch (error) {
            log.error('캐시 저장 실패:', error);
            if (error.name === 'QuotaExceededError') {
                clearOldCache();
            }
        }
    }
    
    function getFromCache() {
        try {
            const cached = sessionStorage.getItem(CACHE_KEY);
            const timestamp = sessionStorage.getItem(CACHE_TIMESTAMP_KEY);
            
            if (!cached || !timestamp) {
                return null;
            }
            
            // 🔧 개선 #6: 타임스탬프 유효성 검증 추가
            const parsedTimestamp = parseInt(timestamp);
            if (isNaN(parsedTimestamp) || parsedTimestamp > Date.now()) {
                log.warn('잘못된 캐시 타임스탬프');
                clearCache();
                return null;
            }
            
            const age = Date.now() - parsedTimestamp;
            if (age > CACHE_DURATION) {
                log.info('캐시 만료됨');
                clearCache();
                return null;
            }
            
            const books = JSON.parse(cached);
            
            // 🔧 개선 #6: 캐시 데이터 유효성 검증
            if (!Array.isArray(books)) {
                log.warn('잘못된 캐시 데이터 형식');
                clearCache();
                return null;
            }
            
            log.info('캐시에서 책 목록 로드:', books.length + '권');
            return books;
        } catch (error) {
            log.error('캐시 로드 실패:', error);
            clearCache();
            return null;
        }
    }
    
    function clearCache() {
        sessionStorage.removeItem(CACHE_KEY);
        sessionStorage.removeItem(CACHE_TIMESTAMP_KEY);
    }
    
    function clearOldCache() {
        const keysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key && key.startsWith('book_progress_')) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => sessionStorage.removeItem(key));
    }
    
    function invalidateCache() {
        clearCache();
        log.info('캐시 무효화됨');
    }
    
    return {
        save: saveToCache,
        get: getFromCache,
        clear: clearCache,
        invalidate: invalidateCache
    };
})();

// ============================================
// Token Manager 모듈 (개선 #1: 무한 루프 방지)
// ============================================
const TokenManager = (() => {
    let tokenClient = null;
    let accessToken = null;
    let tokenExpiryTime = null;
    let refreshTimer = null;
    
    function calculateExpiryTime() {
        return Date.now() + (55 * 60 * 1000);
    }
    
    function isTokenValid() {
        return accessToken && tokenExpiryTime && Date.now() < tokenExpiryTime;
    }
    
    function saveToken(token) {
        accessToken = token;
        tokenExpiryTime = calculateExpiryTime();
        
        localStorage.setItem('access_token', token);
        localStorage.setItem('token_expiry', tokenExpiryTime.toString());
        
        if (window.gapi && window.gapi.client) {
            gapi.client.setToken({ access_token: token });
        }
        
        scheduleTokenRefresh();
        
        log.info('토큰 저장 완료, 만료 시간:', new Date(tokenExpiryTime).toLocaleString());
    }
    
    function scheduleTokenRefresh() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        
        if (!tokenExpiryTime) return;
        
        const refreshTime = tokenExpiryTime - Date.now() - (5 * 60 * 1000);
        
        if (refreshTime > 0) {
            refreshTimer = setTimeout(() => {
                log.info('토큰 자동 갱신 시작');
                refreshToken();
            }, refreshTime);
            
            log.info('토큰 갱신 예약:', new Date(Date.now() + refreshTime).toLocaleString());
        }
    }
    
    async function refreshToken() {
        try {
            if (!tokenClient) {
                log.error('토큰 클라이언트가 초기화되지 않았습니다');
                return false;
            }
            
            log.info('토큰 갱신 요청');
            
            return new Promise((resolve) => {
                tokenClient.requestAccessToken({ 
                    prompt: '',
                    callback: (response) => {
                        if (response.error) {
                            log.error('토큰 갱신 실패:', response.error);
                            
                            if (response.error === 'immediate_failed' || 
                                response.error === 'user_logged_out') {
                                handleTokenExpired();
                            }
                            resolve(false);
                        } else {
                            log.info('토큰 갱신 성공');
                            saveToken(response.access_token);
                            resolve(true);
                        }
                    }
                });
            });
        } catch (error) {
            log.error('토큰 갱신 중 오류:', error);
            return false;
        }
    }
    
    function handleTokenExpired() {
        log.warn('토큰이 만료되었습니다. 재로그인이 필요합니다.');
        
        clearToken();
        
        if (confirm('세션이 만료되었습니다. 다시 로그인하시겠습니까?')) {
            Auth.signIn();
        } else {
            window.location.href = 'index.html';
        }
    }
    
    function clearToken() {
        accessToken = null;
        tokenExpiryTime = null;
        
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
        
        localStorage.removeItem('access_token');
        localStorage.removeItem('token_expiry');
    }
    
    function restoreToken() {
        const savedToken = localStorage.getItem('access_token');
        const savedExpiry = localStorage.getItem('token_expiry');
        
        if (savedToken && savedExpiry) {
            const expiry = parseInt(savedExpiry, 10);
            
            if (Date.now() < expiry) {
                accessToken = savedToken;
                tokenExpiryTime = expiry;
                
                if (window.gapi && window.gapi.client) {
                    gapi.client.setToken({ access_token: savedToken });
                }
                
                scheduleTokenRefresh();
                
                log.info('저장된 토큰 복구 완료');
                return true;
            } else {
                log.info('저장된 토큰이 만료됨');
                clearToken();
            }
        }
        
        return false;
    }
    
    // 🔧 개선 #1: 무한 루프 방지를 위한 재시도 카운트 추가
    async function makeAuthenticatedRequest(requestFn, retryCount = 0) {
        // 최대 1번까지만 재시도 (무한 루프 방지)
        if (retryCount > 1) {
            throw new Error('토큰 갱신 재시도 횟수 초과');
        }
        
        if (!isTokenValid()) {
            log.info('토큰이 유효하지 않음, 갱신 시도');
            const refreshed = await refreshToken();
            
            if (!refreshed) {
                throw new Error('토큰 갱신 실패');
            }
        }
        
        try {
            return await requestFn();
        } catch (error) {
            // 401 에러이고 첫 시도인 경우에만 재시도
            if ((error.status === 401 || error.message.includes('401')) && retryCount === 0) {
                log.info('401 에러 감지, 토큰 갱신 후 재시도 (시도 횟수: ' + (retryCount + 1) + ')');
                
                const refreshed = await refreshToken();
                if (refreshed) {
                    // 재귀 호출 시 retryCount 증가
                    return await makeAuthenticatedRequest(requestFn, retryCount + 1);
                }
            }
            
            throw error;
        }
    }
    
    return {
        saveToken,
        refreshToken,
        clearToken,
        restoreToken,
        isTokenValid,
        makeAuthenticatedRequest,
        setTokenClient: (client) => { tokenClient = client; },
        getAccessToken: () => accessToken
    };
})();

// ============================================
// Storage 모듈 (IndexedDB)
// ============================================
const Storage = (() => {
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
                
                if (!db.objectStoreNames.contains('books')) {
                    db.createObjectStore('books', { keyPath: 'id' });
                }
                
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
                // SessionStorage에도 저장 (즉시 반영용)
                sessionStorage.setItem(`book_progress_${bookId}`, JSON.stringify(progressData));
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    async function getProgress(bookId) {
        // SessionStorage에서 먼저 확인
        const cached = sessionStorage.getItem(`book_progress_${bookId}`);
        if (cached) {
            return JSON.parse(cached);
        }
        
        if (!db) return null;
        
        const transaction = db.transaction(['reading_progress'], 'readonly');
        const store = transaction.objectStore('reading_progress');
        
        return new Promise((resolve, reject) => {
            const request = store.get(bookId);
            request.onsuccess = () => {
                const progress = request.result;
                if (progress) {
                    sessionStorage.setItem(`book_progress_${bookId}`, JSON.stringify(progress));
                }
                resolve(progress);
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    return { 
        initialize, 
        saveProgress, 
        getProgress,
        getDB: () => db
    };
})();

// ============================================
// Auth 모듈 (개선 #3: 사용자 정보 캐싱)
// ============================================
const Auth = (() => {
    let tokenClient = null;
    
    async function initialize() {
        log.info('Auth 모듈 초기화');
        
        return new Promise((resolve) => {
            if (typeof gapi !== 'undefined') {
                gapi.load('client', async () => {
                    try {
                        await gapi.client.init({
                            apiKey: CONFIG.API_KEY,
                            discoveryDocs: CONFIG.DISCOVERY_DOCS
                        });
                        log.info('Google API 초기화 완료');
                        
                        if (typeof google !== 'undefined' && google.accounts) {
                            tokenClient = google.accounts.oauth2.initTokenClient({
                                client_id: CONFIG.CLIENT_ID,
                                scope: CONFIG.SCOPES,
                                callback: handleAuthResponse
                            });
                            
                            TokenManager.setTokenClient(tokenClient);
                            
                            log.info('Google Identity Services 초기화 완료');
                        }
                        
                        resolve();
                    } catch (error) {
                        log.error('Google API 초기화 실패:', error);
                        resolve();
                    }
                });
            } else {
                log.warn('Google API가 아직 로드되지 않음');
                resolve();
            }
        });
    }
    
    function handleAuthResponse(response) {
        if (response.error) {
            log.error('인증 실패:', response);
            alert('로그인에 실패했습니다: ' + response.error);
            return;
        }
        
        log.info('인증 성공');
        
        TokenManager.saveToken(response.access_token);
        
        onAuthSuccess();
    }
    
    function signIn() {
        if (!tokenClient) {
            alert('Google 로그인이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
            return;
        }
        
        tokenClient.requestAccessToken({ prompt: 'consent' });
    }
    
    function signOut() {
        const accessToken = TokenManager.getAccessToken();
        
        if (accessToken) {
            google.accounts.oauth2.revoke(accessToken, () => {
                log.info('로그아웃 완료');
            });
        }
        
        TokenManager.clearToken();
        BooksCache.clear();
        
        // 🔧 개선 #3: 사용자 정보 캐시도 삭제
        sessionStorage.removeItem('user_info');
        
        updateAuthUI(false);
    }
    
    function checkAuth() {
        return TokenManager.restoreToken();
    }
    
    return { initialize, signIn, signOut, checkAuth };
})();

// ============================================
// DriveAPI 모듈
// ============================================
const DriveAPI = (() => {
    
    async function findBooksFolder() {
        return TokenManager.makeAuthenticatedRequest(async () => {
            const response = await gapi.client.drive.files.list({
                q: `name='${CONFIG.BOOKS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id, name)',
                spaces: 'drive'
            });
            
            if (response.result.files && response.result.files.length > 0) {
                log.info('Books 폴더 찾음:', response.result.files[0]);
                return response.result.files[0].id;
            }
            
            log.warn('Books 폴더를 찾을 수 없습니다');
            return null;
        });
    }
    
    async function getBookFolders(booksFolderId) {
        return TokenManager.makeAuthenticatedRequest(async () => {
            const response = await gapi.client.drive.files.list({
                q: `'${booksFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id, name, modifiedTime)',
                orderBy: 'name',
                pageSize: 300
            });
            
            log.info(`${response.result.files.length}개의 책 폴더 발견`);
            return response.result.files;
        });
    }
    
    async function getBookImages(bookFolderId) {
        return TokenManager.makeAuthenticatedRequest(async () => {
            const response = await gapi.client.drive.files.list({
                q: `'${bookFolderId}' in parents and trashed=false and (name contains '.webp' or name contains '.jpg' or name contains '.png')`,
                fields: 'files(id, name)',
                orderBy: 'name',
                pageSize: 1000
            });
            
            const files = response.result.files.sort((a, b) => {
                const numA = parseInt(a.name.match(/\d+/)?.[0] || '0');
                const numB = parseInt(b.name.match(/\d+/)?.[0] || '0');
                return numA - numB;
            });
            
            log.info(`${files.length}개의 이미지 파일 발견`);
            return files;
        });
    }
    
    function getImageUrl(fileId) {
        return `https://drive.google.com/uc?export=view&id=${fileId}`;
    }
    
    function getThumbnailUrl(fileId) {
        return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
    }
    
    return {
        findBooksFolder,
        getBookFolders,
        getBookImages,
        getImageUrl,
        getThumbnailUrl
    };
})();

// ============================================
// UI 관련 함수들
// ============================================
let elements = {};
let allBooks = []; // 전체 책 목록 저장
let filteredBooks = []; // 필터링된 책 목록
let currentSort = 'recent'; // 현재 정렬 방식

function initializeElements() {
    elements = {
        authSection: document.getElementById('authSection'),
        booksSection: document.getElementById('booksSection'),
        signInBtn: document.getElementById('signInBtn'),
        signOutBtn: document.getElementById('signOutBtn'),
        refreshBtn: document.getElementById('refreshBtn'),
        userEmail: document.getElementById('userEmail'),
        userInfo: document.getElementById('userInfo'),
        loadingState: document.getElementById('loadingState'),
        booksGrid: document.getElementById('booksGrid'),
        emptyState: document.getElementById('emptyState'),
        errorState: document.getElementById('errorState'),
        errorMessage: document.getElementById('errorMessage'),
        retryBtn: document.getElementById('retryBtn'),
        errorRetryBtn: document.getElementById('errorRetryBtn'),
        // 검색 관련 요소
        searchInput: document.getElementById('searchInput'),
        searchClear: document.getElementById('searchClear'),
        searchStats: document.getElementById('searchStats'),
        searchStatsText: document.getElementById('searchStatsText'),
        noSearchResults: document.getElementById('noSearchResults'),
        noSearchResultsText: document.getElementById('noSearchResultsText'),
        clearSearchBtn: document.getElementById('clearSearchBtn')
    };
}

function updateAuthUI(isAuthenticated) {
    if (isAuthenticated) {
        elements.authSection.style.display = 'none';
        elements.booksSection.style.display = 'block';
        if (elements.userInfo) elements.userInfo.style.display = 'flex';
        if (elements.refreshBtn) elements.refreshBtn.style.display = 'flex';
    } else {
        elements.authSection.style.display = 'flex';
        elements.booksSection.style.display = 'none';
        if (elements.userInfo) elements.userInfo.style.display = 'none';
        if (elements.refreshBtn) elements.refreshBtn.style.display = 'none';
    }
}

function updateUIState(state) {
    elements.loadingState.style.display = 'none';
    elements.booksGrid.style.display = 'none';
    elements.emptyState.style.display = 'none';
    elements.errorState.style.display = 'none';
    elements.noSearchResults.style.display = 'none';
    
    switch (state) {
        case 'loading':
            elements.loadingState.style.display = 'flex';
            break;
        case 'books':
            elements.booksGrid.style.display = 'grid';
            showCacheIndicator();
            break;
        case 'empty':
            elements.emptyState.style.display = 'flex';
            break;
        case 'error':
            elements.errorState.style.display = 'flex';
            break;
        case 'no-search-results':
            elements.noSearchResults.style.display = 'flex';
            break;
    }
}

// ============================================
// 검색 기능
// ============================================
function highlightText(text, query) {
    if (!query) return text;
    
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

function searchBooks(query) {
    if (!query || query.trim() === '') {
        filteredBooks = allBooks;
        updateSearchStats(false);
        return filteredBooks;
    }
    
    const searchTerm = query.toLowerCase().trim();
    filteredBooks = allBooks.filter(book => 
        book.title.toLowerCase().includes(searchTerm)
    );
    
    updateSearchStats(true, query);
    return filteredBooks;
}

function updateSearchStats(isSearching, query = '') {
    if (!isSearching) {
        elements.searchStats.style.display = 'none';
        elements.noSearchResultsText.textContent = '다른 검색어를 입력해보세요.';
        return;
    }
    
    const count = filteredBooks.length;
    elements.searchStats.style.display = 'flex';
    elements.searchStatsText.innerHTML = `"<span class="search-stats-number">${query}</span>" 검색 결과: <span class="search-stats-number">${count}</span>권`;
    
    if (count === 0) {
        elements.noSearchResultsText.textContent = `"${query}"에 대한 검색 결과가 없습니다.`;
    }
}

function clearSearch() {
    elements.searchInput.value = '';
    elements.searchClear.classList.remove('visible');
    filteredBooks = allBooks;
    displayBooks(filteredBooks);
    updateSearchStats(false);
    
    if (filteredBooks.length > 0) {
        updateUIState('books');
    }
}

// ============================================
// 책 관련 함수들
// ============================================
async function loadBooks(forceRefresh = false) {
    try {
        // 강제 새로고침이 아니면 캐시 확인
        if (!forceRefresh) {
            const cachedBooks = BooksCache.get();
            if (cachedBooks && cachedBooks.length > 0) {
                displayBooks(cachedBooks);
                updateUIState('books');
                
                // 백그라운드에서 업데이트 확인
                checkForUpdatesInBackground();
                return;
            }
        }
        
        updateUIState('loading');
        
        const booksFolderId = await DriveAPI.findBooksFolder();
        if (!booksFolderId) {
            updateUIState('empty');
            elements.emptyState.innerHTML = `
                <h3>Books 폴더를 찾을 수 없습니다</h3>
                <p>Google Drive에 'Books' 폴더를 만들고 책을 추가해주세요.</p>
            `;
            return;
        }
        
        const bookFolders = await DriveAPI.getBookFolders(booksFolderId);
        
        if (bookFolders.length === 0) {
            updateUIState('empty');
            return;
        }
        
        // 책 데이터 수집 (병렬 처리)
        const bookPromises = bookFolders.map(async (folder) => {
            const images = await DriveAPI.getBookImages(folder.id);
            
            if (images.length > 0) {
                const progress = await Storage.getProgress(folder.id);
                
                return {
                    id: folder.id,
                    title: folder.name,
                    pageCount: images.length,
                    coverImage: DriveAPI.getThumbnailUrl(images[0].id),
                    images: images.map(img => ({
                        id: img.id,
                        name: img.name,
                        url: DriveAPI.getImageUrl(img.id)
                    })),
                    progress: progress,
                    modifiedTime: folder.modifiedTime
                };
            }
            return null;
        });
        
        const books = (await Promise.all(bookPromises)).filter(book => book !== null);
        
        // 전역 변수에 저장
        allBooks = books;
        filteredBooks = books;
        
        // 캐시에 저장
        BooksCache.save(books);
        
        // 화면에 표시
        displayBooks(books);
        
    } catch (error) {
        log.error('책 목록 로드 실패:', error);
        
        if (error.message && error.message.includes('토큰')) {
            TokenManager.handleTokenExpired();
        } else {
            elements.errorMessage.textContent = error.message || '책 목록을 불러올 수 없습니다.';
            updateUIState('error');
        }
    }
}

function displayBooks(books) {
    elements.booksGrid.innerHTML = '';
    
    if (books.length === 0) {
        const query = elements.searchInput.value.trim();
        if (query) {
            updateUIState('no-search-results');
        } else {
            updateUIState('empty');
        }
        return;
    }
    
    const sortedBooks = sortBooks(books);
    const searchQuery = elements.searchInput.value.trim();
    
    for (const book of sortedBooks) {
        const bookCard = createBookCard(book, searchQuery);
        elements.booksGrid.appendChild(bookCard);
    }
    
    updateUIState('books');
    
    log.info(`${books.length}권의 책 표시 완료`);
    
    // 마지막 읽은 책 하이라이트
    const lastOpenedBook = sessionStorage.getItem('lastOpenedBook');
    if (lastOpenedBook) {
        updateBookProgress(lastOpenedBook);
        sessionStorage.removeItem('lastOpenedBook');
    }
}

function createBookCard(book, searchQuery = '') {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.dataset.bookId = book.id;
    
    const progressPercentage = book.progress ? 
        Math.round((book.progress.currentPage / book.progress.totalPages) * 100) : 0;
    
    // 검색어 하이라이트
    const highlightedTitle = searchQuery ? highlightText(book.title, searchQuery) : book.title;
    
    card.innerHTML = `
        <div class="book-cover">
            <img src="${book.coverImage}" alt="${book.title}" loading="lazy">
            ${progressPercentage > 0 ? `
                <div class="progress-badge">${progressPercentage}%</div>
            ` : ''}
        </div>
        <div class="book-info">
            <div class="book-title">${highlightedTitle}</div>
            <div class="book-meta">
                <div class="book-pages">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 001.5 17v-11A2.5 2.5 0 014 3.5h16A2.5 2.5 0 0122.5 6v11a2.5 2.5 0 01-2.5 2.5M4 19.5h16"/>
                    </svg>
                    ${book.pageCount} 페이지
                </div>
                ${book.progress ? `
                    <div class="book-date">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </svg>
                        ${formatDate(book.progress.lastRead)}
                    </div>
                ` : ''}
            </div>
            ${progressPercentage > 0 ? `
                <div class="book-progress">
                    <div class="book-progress-bar" style="width: ${progressPercentage}%"></div>
                </div>
            ` : ''}
        </div>
    `;
    
    card.addEventListener('click', () => {
        sessionStorage.setItem('currentBook', JSON.stringify(book));
        sessionStorage.setItem('lastOpenedBook', book.id);
        window.location.href = 'viewer.html';
    });
    
    return card;
}

function sortBooks(books) {
    const sortOption = currentSort;
    
    switch (sortOption) {
        case 'recent':
            return books.sort((a, b) => {
                const aTime = a.progress?.lastRead || '0';
                const bTime = b.progress?.lastRead || '0';
                return bTime.localeCompare(aTime);
            });
            
        case 'name':
            return books.sort((a, b) => a.title.localeCompare(b.title));
            
        case 'progress':
            return books.sort((a, b) => {
                const aProgress = a.progress ? 
                    (a.progress.currentPage / a.progress.totalPages) : 0;
                const bProgress = b.progress ? 
                    (b.progress.currentPage / b.progress.totalPages) : 0;
                return bProgress - aProgress;
            });
            
        default:
            return books;
    }
}

function formatDate(dateString) {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return minutes === 0 ? '방금 전' : `${minutes}분 전`;
    } else if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}시간 전`;
    } else if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days}일 전`;
    } else {
        return date.toLocaleDateString('ko-KR');
    }
}

async function updateBookProgress(bookId) {
    try {
        const progress = await Storage.getProgress(bookId);
        if (progress) {
            const card = document.querySelector(`[data-book-id="${bookId}"]`);
            if (card) {
                const progressBar = card.querySelector('.book-progress-bar');
                if (progressBar) {
                    const percentage = Math.round((progress.currentPage / progress.totalPages) * 100);
                    progressBar.style.width = `${percentage}%`;
                }
                
                const dateElement = card.querySelector('.book-date');
                if (dateElement) {
                    dateElement.innerHTML = `
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </svg>
                        ${formatDate(progress.lastRead)}
                    `;
                }
                
                // 하이라이트 효과
                card.style.animation = 'highlight 0.5s ease';
                setTimeout(() => {
                    card.style.animation = '';
                }, 500);
            }
        }
    } catch (error) {
        log.error('진행률 업데이트 실패:', error);
    }
}

async function checkForUpdatesInBackground() {
    try {
        setTimeout(async () => {
            log.info('백그라운드 업데이트 확인 시작');
            
            const booksFolderId = await DriveAPI.findBooksFolder();
            if (!booksFolderId) return;
            
            const bookFolders = await DriveAPI.getBookFolders(booksFolderId);
            
            const cachedBooks = BooksCache.get();
            if (!cachedBooks) return;
            
            const hasChanges = bookFolders.length !== cachedBooks.length ||
                bookFolders.some(folder => {
                    const cached = cachedBooks.find(b => b.id === folder.id);
                    return !cached || cached.modifiedTime !== folder.modifiedTime;
                });
            
            if (hasChanges) {
                log.info('책 목록에 변경사항 발견');
                showUpdateNotification();
            }
        }, 5000);
    } catch (error) {
        log.error('백그라운드 업데이트 확인 실패:', error);
    }
}

function showUpdateNotification() {
    const notification = document.createElement('div');
    notification.className = 'update-notification';
    notification.innerHTML = `
        <span>책 목록이 업데이트되었습니다</span>
        <button onclick="location.reload()">새로고침</button>
    `;
    notification.style.cssText = `
        position: fixed;
        top: 70px;
        right: 20px;
        background: #4285f4;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        gap: 10px;
        animation: slideIn 0.3s ease;
        z-index: 1000;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 10000);
}

function showCacheIndicator() {
    const isFromCache = sessionStorage.getItem(BooksCache.CACHE_KEY) !== null;
    
    if (isFromCache) {
        const indicator = document.createElement('div');
        indicator.className = 'cached-indicator';
        indicator.textContent = '캐시된 목록';
        indicator.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.75rem;
            animation: fadeIn 0.3s ease;
            z-index: 100;
        `;
        
        document.body.appendChild(indicator);
        
        setTimeout(() => {
            indicator.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => indicator.remove(), 300);
        }, 2000);
    }
}

// ============================================
// 인증 성공 후 처리 (개선 #3: 사용자 정보 캐싱)
// ============================================
async function onAuthSuccess() {
    updateAuthUI(true);
    
    // 🔧 개선 #3: 캐시 확인 후 필요시에만 API 호출
    const cachedUser = sessionStorage.getItem('user_info');
    if (cachedUser) {
        try {
            const userInfo = JSON.parse(cachedUser);
            if (elements.userEmail && userInfo.emailAddress) {
                elements.userEmail.textContent = userInfo.emailAddress;
                log.info('캐시된 사용자 정보 사용:', userInfo.emailAddress);
            }
        } catch (error) {
            log.error('캐시된 사용자 정보 파싱 실패:', error);
            sessionStorage.removeItem('user_info');
        }
    }
    
    // 캐시가 없거나 유효하지 않은 경우에만 API 호출
    if (!cachedUser) {
        try {
            const response = await TokenManager.makeAuthenticatedRequest(async () => {
                return await gapi.client.drive.about.get({
                    fields: 'user(displayName,emailAddress)'
                });
            });
            
            if (response.result.user) {
                // 캐시에 저장
                sessionStorage.setItem('user_info', JSON.stringify(response.result.user));
                
                if (elements.userEmail) {
                    elements.userEmail.textContent = response.result.user.emailAddress;
                }
                log.info('사용자 정보 API 호출 및 캐시 저장 완료');
            }
        } catch (error) {
            log.error('사용자 정보 가져오기 실패:', error);
        }
    }
    
    await loadBooks(false);
}

// ============================================
// 이벤트 리스너 설정
// ============================================
function setupEventListeners() {
    if (elements.signInBtn) {
        elements.signInBtn.addEventListener('click', () => Auth.signIn());
    }
    
    if (elements.signOutBtn) {
        elements.signOutBtn.addEventListener('click', () => Auth.signOut());
    }
    
    if (elements.refreshBtn) {
        elements.refreshBtn.addEventListener('click', () => {
            BooksCache.invalidate();
            loadBooks(true);
        });
    }
    
    if (elements.retryBtn) {
        elements.retryBtn.addEventListener('click', () => loadBooks(true));
    }
    
    if (elements.errorRetryBtn) {
        elements.errorRetryBtn.addEventListener('click', () => loadBooks(true));
    }
    
    // 검색 이벤트
    if (elements.searchInput) {
        elements.searchInput.addEventListener('input', (e) => {
            const query = e.target.value;
            
            // X 버튼 표시/숨김
            if (query) {
                elements.searchClear.classList.add('visible');
            } else {
                elements.searchClear.classList.remove('visible');
            }
            
            // 디바운싱된 검색 실행
            clearTimeout(window.searchTimeout);
            window.searchTimeout = setTimeout(() => {
                const results = searchBooks(query);
                displayBooks(results);
            }, 300);
        });
    }
    
    if (elements.searchClear) {
        elements.searchClear.addEventListener('click', clearSearch);
    }
    
    if (elements.clearSearchBtn) {
        elements.clearSearchBtn.addEventListener('click', clearSearch);
    }
    
    // 정렬 필터 이벤트 설정
    setupSortFilters();
    
    // 페이지 포커스 시 진행률 업데이트
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            const lastOpenedBook = sessionStorage.getItem('lastOpenedBook');
            if (lastOpenedBook) {
                updateBookProgress(lastOpenedBook);
                sessionStorage.removeItem('lastOpenedBook');
            }
        }
    });
}

// 정렬 필터 초기화 및 이벤트 설정
function setupSortFilters() {
    // 저장된 정렬 옵션 불러오기
    const savedSort = localStorage.getItem('bookSortOption') || 'recent';
    currentSort = savedSort;
    
    const filterChips = document.querySelectorAll('.filter-chip');
    
    // 초기 활성 상태 설정
    filterChips.forEach(chip => {
        if (chip.dataset.sort === currentSort) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
        
        // 클릭 이벤트 등록
        chip.addEventListener('click', () => {
            // 활성 상태 변경
            filterChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            
            // 정렬 옵션 변경
            currentSort = chip.dataset.sort;
            localStorage.setItem('bookSortOption', currentSort);
            
            log.info(`정렬 방식 변경: ${currentSort}`);
            
            // 현재 표시된 책 목록 재정렬
            displayBooks(filteredBooks);
        });
    });
}

// ============================================
// Google API 스크립트 로드
// ============================================
function loadGoogleAPIScripts() {
    return new Promise((resolve) => {
        const gapiScript = document.createElement('script');
        gapiScript.src = 'https://apis.google.com/js/api.js';
        gapiScript.async = true;
        gapiScript.defer = true;
        gapiScript.onload = () => {
            log.info('Google API 스크립트 로드 완료');
        };
        document.head.appendChild(gapiScript);
        
        const gisScript = document.createElement('script');
        gisScript.src = 'https://accounts.google.com/gsi/client';
        gisScript.async = true;
        gisScript.defer = true;
        gisScript.onload = () => {
            log.info('Google Identity Services 스크립트 로드 완료');
            resolve();
        };
        document.head.appendChild(gisScript);
    });
}

// ============================================
// Google API 로드 대기
// ============================================
async function waitForGoogleAPIs(maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
        if (window.gapi && window.google && google.accounts) {
            log.info('Google APIs 로드 확인');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Google API 로드 시간 초과');
}

// ============================================
// 앱 초기화
// ============================================
async function initializeApp() {
    try {
        log.info('FastBook Viewer 초기화 시작');
        
        const startTime = performance.now();
        
        initializeElements();
        
        // 병렬 초기화
        const dbPromise = Storage.initialize();
        const apiPromise = loadGoogleAPIScripts();
        
        await Promise.all([dbPromise, apiPromise]);
        
        try {
            await waitForGoogleAPIs();
        } catch (error) {
            log.error('Google API 로드 실패:', error);
            alert('Google API를 로드할 수 없습니다. 페이지를 새로고침해주세요.');
            return;
        }
        
        await Auth.initialize();
        
        // 이벤트 리스너는 초기화 단계에서 설정
        setupEventListeners();
        
        if (Auth.checkAuth()) {
            log.info('기존 인증 토큰 발견');
            onAuthSuccess();
        } else {
            updateAuthUI(false);
        }
        
        const endTime = performance.now();
        log.info(`FastBook Viewer 초기화 완료: ${(endTime - startTime).toFixed(2)}ms`);
        
    } catch (error) {
        log.error('앱 초기화 실패:', error);
        alert('앱을 초기화하는 중 오류가 발생했습니다.\n' + error.message);
    }
}

// DOM 로드 완료 시 앱 초기화
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// 전역으로 노출 (디버깅용)
window.FastBook.Auth = Auth;
window.FastBook.DriveAPI = DriveAPI;
window.FastBook.Storage = Storage;
window.FastBook.TokenManager = TokenManager;
window.FastBook.BooksCache = BooksCache;
