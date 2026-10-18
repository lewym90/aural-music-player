const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|aif|aiff|caf|mp4)$/i;
const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf'
};

class AuralPlayer {
  constructor() {
    this.audio = document.getElementById('audio');
    this.tracks = [];
    this.currentIndex = -1;
    this.currentId = null;
    this.isPlaying = false;
    this.db = null;
    this.searchTerm = '';
    this.seeking = false;
    this.playToken = 0;
    this.currentUrl = null;
    this.toastTimer = null;

    this.init();
  }

  async init() {
    try {
      await this.openDB();
      await this.loadTracks();
    } catch (err) {
      console.error('DB error', err);
      this.toast('Nie można otworzyć pamięci aplikacji (tryb prywatny?)');
    }
    this.setupEventListeners();
    this.setupMediaSession();
    this.render();
    this.registerServiceWorker();
    this.requestPersistence();
  }

  /* ---------- Storage ---------- */

  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('AuralDB', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
        if (!db.objectStoreNames.contains('tracks')) {
          db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
        }
        // v2: audio data lives in a separate store so the list loads without reading every file
        if (!db.objectStoreNames.contains('files')) {
          const files = db.createObjectStore('files', { keyPath: 'id' });
          if (e.oldVersion === 1) {
            const tracks = tx.objectStore('tracks');
            tracks.openCursor().onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (!cursor) return;
              const rec = cursor.value;
              if (rec.data) {
                files.put({ id: rec.id, data: rec.data });
                delete rec.data;
                cursor.update(rec);
              }
              cursor.continue();
            };
          }
        }
      };
    });
  }

  sortTracks() {
    this.tracks.sort((a, b) => a.name.localeCompare(b.name, 'pl', { numeric: true }));
  }

  loadTracks() {
    return new Promise((resolve) => {
      const request = this.db.transaction('tracks', 'readonly').objectStore('tracks').getAll();
      request.onsuccess = () => {
        this.tracks = request.result;
        this.sortTracks();
        resolve();
      };
      request.onerror = () => resolve();
    });
  }

  guessType(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (file.type && file.type.startsWith('audio/')) return file.type;
    return MIME_BY_EXT[ext] || 'audio/mpeg';
  }

  async saveTrack(file) {
    const data = await file.arrayBuffer();
    const track = {
      name: file.name,
      type: this.guessType(file),
      size: file.size,
      added: Date.now()
    };
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['tracks', 'files'], 'readwrite');
      tx.objectStore('tracks').add(track).onsuccess = (e) => {
        track.id = e.target.result;
        tx.objectStore('files').put({ id: track.id, data });
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    this.tracks.push(track);
    return track;
  }

  getFileData(id) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('files', 'readonly').objectStore('files').get(id);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteTrack(id) {
    const idx = this.tracks.findIndex(t => t.id === id);
    if (idx < 0) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['tracks', 'files'], 'readwrite');
      tx.objectStore('tracks').delete(id);
      tx.objectStore('files').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    if (this.currentId === id) this.stopPlayback();
    this.tracks.splice(idx, 1);
    if (this.currentId !== null) {
      this.currentIndex = this.tracks.findIndex(t => t.id === this.currentId);
    }
    this.render();
  }

  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (e) { /* ignore */ }
  }

  /* ---------- Import ---------- */

  async importFiles(fileList, inputEl) {
    const files = Array.from(fileList).filter(
      f => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name)
    );
    inputEl.value = '';
    if (!files.length) {
      this.toast('Nie znaleziono plików audio');
      return;
    }
    if (!this.db) {
      this.toast('Pamięć aplikacji jest niedostępna');
      return;
    }

    this.setImporting(true);
    let added = 0, skipped = 0, failed = 0, quota = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.setImportLabel(`Importuję ${i + 1}/${files.length}`);
      if (this.tracks.some(t => t.name === file.name && t.size === file.size)) {
        skipped++;
        continue;
      }
      try {
        await this.saveTrack(file);
        added++;
      } catch (err) {
        console.warn('Failed to import', file.name, err);
        failed++;
        if (err && err.name === 'QuotaExceededError') { quota = true; break; }
      }
    }
    this.setImporting(false);

    this.sortTracks();
    if (this.currentId !== null) {
      this.currentIndex = this.tracks.findIndex(t => t.id === this.currentId);
    }
    this.render();

    const parts = [`Dodano: ${added}`];
    if (skipped) parts.push(`duplikaty: ${skipped}`);
    if (failed) parts.push(quota ? 'brak miejsca na urządzeniu' : `błędy: ${failed}`);
    this.toast(parts.join(' · '));
  }

  setImporting(on) {
    document.querySelectorAll('[data-import]').forEach(b => { b.disabled = on; });
    if (!on) this.setImportLabel(null);
  }

  setImportLabel(text) {
    const label = document.getElementById('importLabel');
    label.textContent = text || 'Importuj';
  }

  /* ---------- Events ---------- */

  setupEventListeners() {
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const progress = document.getElementById('progress');

    document.querySelectorAll('[data-import="files"]').forEach(b =>
      b.addEventListener('click', () => fileInput.click()));
    document.querySelectorAll('[data-import="folder"]').forEach(b =>
      b.addEventListener('click', () => folderInput.click()));

    fileInput.addEventListener('change', (e) => this.importFiles(e.target.files, fileInput));
    folderInput.addEventListener('change', (e) => this.importFiles(e.target.files, folderInput));

    document.getElementById('playBtn').addEventListener('click', () => this.togglePlay());
    document.getElementById('prevBtn').addEventListener('click', () => this.prev());
    document.getElementById('nextBtn').addEventListener('click', () => this.next());

    progress.addEventListener('input', (e) => {
      this.seeking = true;
      if (this.audio.duration) {
        const t = (e.target.value / 1000) * this.audio.duration;
        document.getElementById('currentTime').textContent = this.formatTime(t);
      }
    });
    progress.addEventListener('change', (e) => {
      if (this.audio.duration) {
        this.audio.currentTime = (e.target.value / 1000) * this.audio.duration;
      }
      this.seeking = false;
    });

    document.getElementById('search').addEventListener('input', (e) => {
      this.searchTerm = e.target.value.trim().toLowerCase();
      this.render();
    });

    // Event delegation for the track list
    document.getElementById('trackList').addEventListener('click', (e) => {
      const item = e.target.closest('.track-item');
      if (!item) return;
      const id = parseInt(item.dataset.id, 10);
      if (e.target.closest('.delete-btn')) {
        e.stopPropagation();
        const track = this.tracks.find(t => t.id === id);
        if (track && confirm(`Usunąć „${this.getDisplayName(track.name)}” z biblioteki?`)) {
          this.deleteTrack(id).catch(() => this.toast('Nie udało się usunąć utworu'));
        }
        return;
      }
      this.playTrack(this.tracks.findIndex(t => t.id === id));
    });

    this.audio.addEventListener('timeupdate', () => this.updateProgress());
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('play', () => this.setPlaying(true));
    this.audio.addEventListener('pause', () => this.setPlaying(false));
    this.audio.addEventListener('loadedmetadata', () => this.updateDuration());
    this.audio.addEventListener('durationchange', () => this.updateDuration());
    this.audio.addEventListener('error', () => {
      if (!this.audio.getAttribute('src')) return;
      this.toast('Nie można odtworzyć tego pliku (nieobsługiwany format?)');
    });
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) { /* unsupported */ }
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => {
      if (d.seekTime != null && this.audio.duration) this.audio.currentTime = d.seekTime;
    });
    set('seekbackward', (d) => { this.audio.currentTime = Math.max(0, this.audio.currentTime - (d.seekOffset || 10)); });
    set('seekforward', (d) => { this.audio.currentTime = Math.min(this.audio.duration || 0, this.audio.currentTime + (d.seekOffset || 10)); });
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = this.tracks[this.currentIndex];
    if (track) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.getDisplayName(track.name),
        artist: 'Aural',
        album: 'Lokalna biblioteka',
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    }
    navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
  }

  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.audio.duration;
    if (!isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: this.audio.playbackRate || 1,
        position: Math.min(this.audio.currentTime, d)
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- Helpers ---------- */

  getDisplayName(filename) {
    return filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  /* ---------- Playback ---------- */

  updateProgress() {
    const d = this.audio.duration;
    if (!d || !isFinite(d) || this.seeking) return;
    document.getElementById('progress').value = (this.audio.currentTime / d) * 1000;
    document.getElementById('currentTime').textContent = this.formatTime(this.audio.currentTime);
  }

  updateDuration() {
    document.getElementById('duration').textContent = this.formatTime(this.audio.duration);
    this.updatePositionState();
  }

  setPlaying(playing) {
    this.isPlaying = playing;
    document.querySelector('.play-icon').style.display = playing ? 'none' : 'block';
    document.querySelector('.pause-icon').style.display = playing ? 'block' : 'none';
    document.getElementById('playBtn').setAttribute('aria-label', playing ? 'Pauza' : 'Odtwarzaj');
    this.updateMediaSession();
    this.updatePositionState();
  }

  async playTrack(index) {
    if (index < 0 || index >= this.tracks.length) return;
    const track = this.tracks[index];
    const token = ++this.playToken;

    let data;
    try {
      data = await this.getFileData(track.id);
    } catch (err) {
      data = null;
    }
    if (token !== this.playToken) return; // a newer request superseded this one
    if (!data) {
      this.toast('Nie można wczytać pliku z pamięci');
      return;
    }

    this.currentIndex = index;
    this.currentId = track.id;

    const url = URL.createObjectURL(new Blob([data], { type: track.type }));
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = url;

    this.audio.src = url;
    document.getElementById('currentTitle').textContent = this.getDisplayName(track.name);
    document.getElementById('progress').value = 0;
    document.getElementById('currentTime').textContent = '0:00';
    document.getElementById('duration').textContent = '0:00';
    document.getElementById('player').hidden = false;
    document.querySelector('.app').classList.add('has-player');

    this.render();
    this.updateMediaSession();
    try {
      await this.audio.play();
    } catch (err) {
      if (err && err.name !== 'AbortError') console.warn('Play failed', err);
    }
  }

  stopPlayback() {
    this.playToken++;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = null;
    this.currentId = null;
    this.currentIndex = -1;
    this.isPlaying = false;
    document.getElementById('player').hidden = true;
    document.querySelector('.app').classList.remove('has-player');
    this.setPlaying(false);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  togglePlay() {
    if (this.currentIndex < 0) {
      if (this.tracks.length) this.playTrack(0);
      return;
    }
    this.isPlaying ? this.pause() : this.play();
  }

  play() {
    if (this.currentIndex >= 0) this.audio.play().catch(() => {});
  }

  pause() {
    this.audio.pause();
  }

  next() {
    if (!this.tracks.length) return;
    this.playTrack((this.currentIndex + 1) % this.tracks.length);
  }

  prev() {
    if (!this.tracks.length) return;
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    this.playTrack(this.currentIndex <= 0 ? this.tracks.length - 1 : this.currentIndex - 1);
  }

  /* ---------- Render ---------- */

  render() {
    const list = document.getElementById('trackList');
    const empty = document.getElementById('emptyState');
    const noResults = document.getElementById('noResults');

    if (!this.tracks.length) {
      empty.style.display = 'flex';
      noResults.hidden = true;
      list.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    const filtered = this.tracks.filter(t =>
      this.getDisplayName(t.name).toLowerCase().includes(this.searchTerm)
    );
    noResults.hidden = filtered.length > 0;

    list.innerHTML = filtered.map((track, i) => {
      const playing = track.id === this.currentId;
      const name = this.escapeHtml(this.getDisplayName(track.name));
      return `
        <li class="track-item ${playing ? 'playing' : ''}" data-id="${track.id}">
          <span class="index">${playing ? '▶' : (i + 1)}</span>
          <div class="track-info">
            <div class="track-title">${name}</div>
            <div class="track-meta">${this.formatSize(track.size)}</div>
          </div>
          <button class="delete-btn" aria-label="Usuń ${name}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </li>`;
    }).join('');
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.player = new AuralPlayer();
});
