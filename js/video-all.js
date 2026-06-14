// js/video-all.js - 영상 목록 및 재생 모듈

if (!window.FastBook) {
    console.error('[FastBook] config.js가 먼저 로드되어야 합니다.');
}

// ============================================
// Video Drive API 모듈
// ============================================
const VideoAPI = (() => {
    const { CONFIG, log, TokenManager } = window.FastBook;

    async function findVideoFolder() {
        return TokenManager.makeAuthenticatedRequest(async () => {
            const response = await gapi.client.drive.files.list({
                q: `name='${CONFIG.VIDEO_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id, name)',
                spaces: 'drive'
            });

            if (response.result.files && response.result.files.length > 0) {
                log.info('Video 폴더 찾음:', response.result.files[0]);
                return response.result.files[0].id;
            }

            log.warn('Video 폴더를 찾을 수 없습니다');
            return null;
        });
    }

    async function getVideos(videoFolderId) {
        return TokenManager.makeAuthenticatedRequest(async () => {
            const response = await gapi.client.drive.files.list({
                q: `'${videoFolderId}' in parents and trashed=false and mimeType contains 'video/'`,
                fields: 'files(id, name, mimeType, modifiedTime)',
                orderBy: 'name',
                pageSize: 300
            });

            log.info(`${response.result.files.length}개의 영상 파일 발견`);
            return response.result.files;
        });
    }

    function getEmbedUrl(fileId) {
        return `https://drive.google.com/file/d/${fileId}/preview`;
    }

    function getThumbnailUrl(fileId) {
        return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
    }

    return { findVideoFolder, getVideos, getEmbedUrl, getThumbnailUrl };
})();

// ============================================
// 영상 UI 모듈
// ============================================
const VideoUI = (() => {
    const { log } = window.FastBook;
    let allVideos = [];
    let videosLoaded = false;
    let elems = {};

    function initElements() {
        elems = {
            videoLoadingState: document.getElementById('videoLoadingState'),
            videoGrid: document.getElementById('videoGrid'),
            videoEmptyState: document.getElementById('videoEmptyState'),
            videoErrorState: document.getElementById('videoErrorState'),
            videoErrorMessage: document.getElementById('videoErrorMessage'),
            videoRetryBtn: document.getElementById('videoRetryBtn'),
            videoModal: document.getElementById('videoModal'),
            videoModalTitle: document.getElementById('videoModalTitle'),
            videoModalClose: document.getElementById('videoModalClose'),
            videoPlayer: document.getElementById('videoPlayer'),
        };

        elems.videoModalClose.addEventListener('click', closeModal);

        elems.videoModal.addEventListener('click', (e) => {
            if (e.target === elems.videoModal) closeModal();
        });

        elems.videoRetryBtn.addEventListener('click', () => loadVideos(true));

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && elems.videoModal.style.display !== 'none') {
                closeModal();
            }
        });
    }

    function setUIState(state) {
        elems.videoLoadingState.style.display = 'none';
        elems.videoGrid.style.display = 'none';
        elems.videoEmptyState.style.display = 'none';
        elems.videoErrorState.style.display = 'none';

        switch (state) {
            case 'loading':
                elems.videoLoadingState.style.display = 'flex';
                break;
            case 'grid':
                elems.videoGrid.style.display = 'grid';
                break;
            case 'empty':
                elems.videoEmptyState.style.display = 'flex';
                break;
            case 'error':
                elems.videoErrorState.style.display = 'flex';
                break;
        }
    }

    function stripExtension(filename) {
        return filename.replace(/\.[^/.]+$/, '');
    }

    function createVideoCard(video) {
        const title = stripExtension(video.name);
        const card = document.createElement('div');
        card.className = 'video-card';
        card.setAttribute('role', 'listitem');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `${title} 재생`);

        card.innerHTML = `
            <div class="video-thumb-wrap">
                <img class="video-thumb" src="${VideoAPI.getThumbnailUrl(video.id)}" alt="${title}" loading="lazy">
                <div class="video-thumb-fallback">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <polygon points="23 7 16 12 23 17 23 7"/>
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                </div>
                <div class="video-play-overlay" aria-hidden="true">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>
            </div>
            <div class="video-info">
                <p class="video-title">${title}</p>
            </div>
        `;

        const img = card.querySelector('.video-thumb');
        const fallback = card.querySelector('.video-thumb-fallback');
        img.addEventListener('error', () => {
            img.style.display = 'none';
            fallback.style.display = 'flex';
        });

        card.addEventListener('click', () => openModal(video));
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openModal(video);
            }
        });

        return card;
    }

    function displayVideos(videos) {
        elems.videoGrid.innerHTML = '';
        videos.forEach(video => {
            elems.videoGrid.appendChild(createVideoCard(video));
        });
        setUIState(videos.length > 0 ? 'grid' : 'empty');
    }

    function openModal(video) {
        elems.videoModalTitle.textContent = stripExtension(video.name);
        elems.videoPlayer.src = VideoAPI.getEmbedUrl(video.id);
        elems.videoModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    function closeModal() {
        elems.videoModal.style.display = 'none';
        elems.videoPlayer.src = '';
        document.body.style.overflow = '';
    }

    async function loadVideos(forceRefresh = false) {
        if (videosLoaded && !forceRefresh) {
            displayVideos(allVideos);
            return;
        }

        try {
            setUIState('loading');

            const videoFolderId = await VideoAPI.findVideoFolder();
            if (!videoFolderId) {
                setUIState('empty');
                return;
            }

            const videos = await VideoAPI.getVideos(videoFolderId);
            allVideos = videos;
            videosLoaded = true;

            displayVideos(allVideos);
        } catch (error) {
            log.error('영상 목록 로드 실패:', error);
            if (elems.videoErrorMessage) {
                elems.videoErrorMessage.textContent = '영상 목록을 불러올 수 없습니다.';
            }
            setUIState('error');
        }
    }

    function initialize() {
        initElements();
    }

    return { initialize, loadVideos };
})();

// ============================================
// 탭 네비게이션 모듈
// ============================================
const TabNav = (() => {
    const { log, eventBus } = window.FastBook;
    let activeTab = 'books';

    function switchTab(tabName) {
        activeTab = tabName;

        document.querySelectorAll('.nav-tab').forEach(btn => {
            const isActive = btn.dataset.tab === tabName;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        });

        const booksSection = document.getElementById('booksSection');
        const videosSection = document.getElementById('videosSection');

        if (tabName === 'books') {
            if (booksSection) booksSection.style.display = 'block';
            if (videosSection) videosSection.style.display = 'none';
        } else if (tabName === 'videos') {
            if (booksSection) booksSection.style.display = 'none';
            if (videosSection) videosSection.style.display = 'block';
            VideoUI.loadVideos();
        }

        log.info(`탭 전환: ${tabName}`);
    }

    function initialize() {
        document.querySelectorAll('.nav-tab').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        const mainNav = document.getElementById('mainNav');

        eventBus.on('auth-changed', (isAuthenticated) => {
            if (mainNav) {
                mainNav.style.display = isAuthenticated ? 'flex' : 'none';
            }

            if (!isAuthenticated) {
                const videosSection = document.getElementById('videosSection');
                if (videosSection) videosSection.style.display = 'none';

                activeTab = 'books';
                document.querySelectorAll('.nav-tab').forEach(btn => {
                    const isActive = btn.dataset.tab === 'books';
                    btn.classList.toggle('active', isActive);
                    btn.setAttribute('aria-selected', String(isActive));
                });
            }
        });
    }

    return { initialize };
})();

// ============================================
// 초기화
// ============================================
(function init() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            VideoUI.initialize();
            TabNav.initialize();
        });
    } else {
        VideoUI.initialize();
        TabNav.initialize();
    }
})();

window.FastBook.VideoAPI = VideoAPI;
window.FastBook.VideoUI = VideoUI;
