const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|aif|aiff|caf|mp4)$/i;
const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf'
};
const SWIPE_W = 88;
const LAST_KEY = 'aural.last';
const SORT_KEY = 'aural.sort';

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
    this.coverUrl = null;
    this.toastTimer = null;
    this.pendingSeek = null;
    this.lastSaved = 0;
    this.suppressClick = false;
    this.selectMode = false;
    this.selected = new Set();
    this.sortMode = 'date';
    try { this.sortMode = localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'date'; } catch (e) { /* ignore */ }

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
    this.updateStorageInfo();
    this.restoreLast();
    this.enrichLegacy();
  }

  /* ---------- Storage ---------- */

  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('AuralDB', 3);
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
        // v3: full-size covers live in their own store (thumbnails stay on the track record)
        if (!db.objectStoreNames.contains('covers')) {
          db.createObjectStore('covers', { keyPath: 'id' });
        }
      };
    });
  }

  sortTracks() {
    const byName = (a, b) => this.displayTitle(a).localeCompare(this.displayTitle(b), 'pl', { numeric: true });
    const stamp = (t) => t.modified || t.added || 0;
    if (this.sortMode === 'name') this.tracks.sort(byName);
    else this.tracks.sort((a, b) => (stamp(b) - stamp(a)) || ((b.added || 0) - (a.added || 0)) || byName(a, b));
  }

  syncCurrentIndex() {
    this.currentIndex = this.currentId === null ? -1 : this.tracks.findIndex(t => t.id === this.currentId);
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

  /* Reads tags, cover (+thumbnail) and duration. Never throws. */
  async extractMeta(data, type) {
    const meta = { title: '', artist: '', album: '', duration: 0, thumb: null, cover: null };
    try {
      const tags = AuralTags.readTags(data);
      meta.title = tags.title; meta.artist = tags.artist; meta.album = tags.album;
      if (tags.cover) {
        meta.cover = tags.cover;
        meta.thumb = await this.makeThumb(tags.cover.data, tags.cover.type);
      }
    } catch (e) { /* ignore */ }
    try {
      meta.duration = await this.measureDuration(new Blob([data], { type }));
    } catch (e) { /* ignore */ }
    return meta;
  }

  makeThumb(buf, mime) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      const img = new Image();
      const finish = (v) => { URL.revokeObjectURL(url); resolve(v); };
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 96;
          const s = Math.min(img.width, img.height);
          c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
          finish(c.toDataURL('image/jpeg', 0.8));
        } catch (e) { finish(null); }
      };
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  measureDuration(blob) {
    return new Promise((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = (d) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.removeAttribute('src');
        URL.revokeObjectURL(url);
        resolve(d);
      };
      const timer = setTimeout(() => finish(0), 8000);
      a.onloadedmetadata = () => finish(isFinite(a.duration) ? a.duration : 0);
      a.onerror = () => finish(0);
      a.src = url;
    });
  }

  async saveTrack(file) {
    const data = await file.arrayBuffer();
    const type = this.guessType(file);
    const meta = await this.extractMeta(data, type);
    const track = {
      name: file.name,
      type,
      size: file.size,
      modified: file.lastModified || Date.now(),
      added: Date.now(),
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      duration: meta.duration,
      thumb: meta.thumb,
      hasCover: !!meta.cover,
      tagged: true
    };
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['tracks', 'files', 'covers'], 'readwrite');
      tx.objectStore('tracks').add(track).onsuccess = (e) => {
        track.id = e.target.result;
        tx.objectStore('files').put({ id: track.id, data });
        if (meta.cover) tx.objectStore('covers').put({ id: track.id, data: meta.cover.data, type: meta.cover.type });
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    this.tracks.push(track);
    return track;
  }

  /* Tracks imported by earlier versions have no tags/duration — fill them in quietly in the background. */
  async enrichLegacy() {
    if (!this.db) return;
    const todo = this.tracks.filter(t => !t.tagged);
    if (!todo.length) return;
    let n = 0;
    for (const t of todo) {
      try {
        const data = await this.getFileData(t.id);
        if (!data) { t.tagged = true; continue; }
        const meta = await this.extractMeta(data, t.type);
        Object.assign(t, {
          title: meta.title, artist: meta.artist, album: meta.album,
          duration: meta.duration, thumb: meta.thumb, hasCover: !!meta.cover, tagged: true
        });
        await new Promise((resolve) => {
          const tx = this.db.transaction(['tracks', 'covers'], 'readwrite');
          tx.objectStore('tracks').put(t);
          if (meta.cover) tx.objectStore('covers').put({ id: t.id, data: meta.cover.data, type: meta.cover.type });
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        });
      } catch (e) { /* skip */ }
      if (++n % 5 === 0) this.render();
    }
    this.sortTracks();
    this.syncCurrentIndex();
    this.render();
  }

  getFileData(id) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('files', 'readonly').objectStore('files').get(id);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => reject(req.error);
    });
  }

  getCover(id) {
    return new Promise((resolve) => {
      const req = this.db.transaction('covers', 'readonly').objectStore('covers').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async deleteTracks(ids) {
    const set = new Set(ids);
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['tracks', 'files', 'covers'], 'readwrite');
      for (const id of set) {
        tx.objectStore('tracks').delete(id);
        tx.objectStore('files').delete(id);
        tx.objectStore('covers').delete(id);
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    if (this.currentId !== null && set.has(this.currentId)) {
      this.stopPlayback();
      this.clearLast();
    }
    this.tracks = this.tracks.filter(t => !set.has(t.id));
    for (const id of set) this.selected.delete(id);
    this.syncCurrentIndex();
    if (!this.tracks.length) this.exitSelectMode();
    this.render();
    this.updateStorageInfo();
  }

  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (e) { /* ignore */ }
  }

  async updateStorageInfo() {
    const el = document.getElementById('storageInfo');
    try {
      if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ''; return; }
      const est = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
      const parts = [];
      if (est.usage != null) {
        parts.push(`Pamięć aplikacji: ${this.formatSize(est.usage)}` + (est.quota ? ` z ${this.formatSize(est.quota)} dostępnych` : ''));
      }
      if (persisted !== null) parts.push(persisted ? 'Trwały zapis: włączony' : 'Trwały zapis: przeglądarka może wyczyścić dane przy braku miejsca');
      el.textContent = parts.join(' · ');
    } catch (e) { el.textContent = ''; }
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
    this.syncCurrentIndex();
    this.render();
    this.updateStorageInfo();

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
    document.getElementById('importLabel').textContent = text || 'Importuj';
  }

  /* ---------- Events ---------- */

  setupEventListeners() {
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');

    document.querySelectorAll('[data-import="files"]').forEach(b =>
      b.addEventListener('click', () => fileInput.click()));
    document.querySelectorAll('[data-import="folder"]').forEach(b =>
      b.addEventListener('click', () => folderInput.click()));
    fileInput.addEventListener('change', (e) => this.importFiles(e.target.files, fileInput));
    folderInput.addEventListener('change', (e) => this.importFiles(e.target.files, folderInput));

    document.querySelectorAll('.js-play').forEach(b => b.addEventListener('click', () => this.togglePlay()));
    document.querySelectorAll('.js-prev').forEach(b => b.addEventListener('click', () => this.prev()));
    document.querySelectorAll('.js-next').forEach(b => b.addEventListener('click', () => this.next()));

    document.querySelectorAll('.js-progress').forEach((progress) => {
      progress.addEventListener('input', (e) => {
        this.seeking = true;
        if (this.audio.duration) {
          const t = (e.target.value / 1000) * this.audio.duration;
          document.querySelectorAll('.js-cur').forEach(el => { el.textContent = this.formatTime(t); });
          document.querySelectorAll('.js-progress').forEach(p => { if (p !== e.target) p.value = e.target.value; });
        }
      });
      progress.addEventListener('change', (e) => {
        if (this.audio.duration) this.audio.currentTime = (e.target.value / 1000) * this.audio.duration;
        this.seeking = false;
        this.saveLast(true);
      });
    });

    // Full-screen player
    const openFull = document.getElementById('openFull');
    openFull.addEventListener('click', () => this.openFull());
    openFull.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openFull(); } });
    document.getElementById('fpClose').addEventListener('click', () => this.closeFull());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeFull(); });

    // Sorting
    const sortSel = document.getElementById('sortSelect');
    sortSel.value = this.sortMode;
    sortSel.addEventListener('change', (e) => {
      this.sortMode = e.target.value === 'name' ? 'name' : 'date';
      try { localStorage.setItem(SORT_KEY, this.sortMode); } catch (err) { /* ignore */ }
      this.sortTracks();
      this.syncCurrentIndex();
      this.render();
    });

    document.getElementById('search').addEventListener('input', (e) => {
      this.searchTerm = e.target.value.trim().toLowerCase();
      this.render();
    });

    // Selection mode
    document.getElementById('selectBtn').addEventListener('click', () => this.enterSelectMode());
    document.getElementById('selCancel').addEventListener('click', () => this.exitSelectMode());
    document.getElementById('selAll').addEventListener('click', () => this.toggleSelectAll());
    document.getElementById('selDelete').addEventListener('click', () => this.deleteSelected());

    // Track list: click + swipe
    const list = document.getElementById('trackList');
    list.addEventListener('click', (e) => this.onListClick(e));
    this.setupSwipe(list);

    this.audio.addEventListener('timeupdate', () => { this.updateProgress(); this.saveLast(); });
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('play', () => this.setPlaying(true));
    this.audio.addEventListener('pause', () => { this.setPlaying(false); this.saveLast(true); });
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.pendingSeek != null) {
        try { this.audio.currentTime = Math.min(this.pendingSeek, Math.max(0, this.audio.duration - 1)); } catch (e) { /* ignore */ }
        this.pendingSeek = null;
      }
      this.updateDuration();
      this.updateProgress();
    });
    this.audio.addEventListener('durationchange', () => this.updateDuration());
    this.audio.addEventListener('error', () => {
      if (!this.audio.getAttribute('src')) return;
      this.toast('Nie można odtworzyć tego pliku (nieobsługiwany format?)');
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveLast(true); });
    window.addEventListener('pagehide', () => this.saveLast(true));
  }

  onListClick(e) {
    if (this.suppressClick) return;
    const item = e.target.closest('.track-item');
    if (!item) return;
    const id = parseInt(item.dataset.id, 10);

    if (e.target.closest('.swipe-action')) {
      this.deleteTracks([id]).catch(() => this.toast('Nie udało się usunąć utworu'));
      return;
    }
    if (document.querySelector('.track-item.swiped')) {
      this.closeSwiped();
      return;
    }
    if (this.selectMode) {
      this.toggleSelected(id);
      return;
    }
    this.playTrack(this.tracks.findIndex(t => t.id === id));
  }

  setupSwipe(list) {
    let st = null;
    list.addEventListener('pointerdown', (e) => {
      if (this.selectMode || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const fg = e.target.closest('.track-fg');
      if (!fg) return;
      const li = fg.parentElement;
      st = { li, fg, x: e.clientX, y: e.clientY, base: li.classList.contains('swiped') ? -SWIPE_W : 0, active: false, cur: 0, pid: e.pointerId };
    });
    list.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.active) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { st = null; return; }
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          st.active = true;
          st.li.classList.add('swiping');
          st.fg.classList.add('dragging');
          try { st.fg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          this.closeSwiped(st.li);
        } else return;
      }
      st.cur = Math.max(-SWIPE_W, Math.min(0, st.base + dx));
      st.fg.style.transform = `translateX(${st.cur}px)`;
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.pid) return;
      if (st.active) {
        st.fg.classList.remove('dragging');
        st.li.classList.remove('swiping');
        st.fg.style.transform = '';
        st.li.classList.toggle('swiped', st.cur < -SWIPE_W / 2);
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 60);
      }
      st = null;
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
  }

  closeSwiped(except) {
    document.querySelectorAll('.track-item.swiped').forEach(li => { if (li !== except) li.classList.remove('swiped'); });
  }

  /* ---------- Selection mode ---------- */

  enterSelectMode() {
    this.selectMode = true;
    this.selected.clear();
    this.closeSwiped();
    this.render();
  }

  exitSelectMode() {
    this.selectMode = false;
    this.selected.clear();
    this.render();
  }

  toggleSelected(id) {
    this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
    this.render();
  }

  visibleTracks() {
    return this.tracks.filter(t => this.matches(t));
  }

  toggleSelectAll() {
    const vis = this.visibleTracks();
    const all = vis.length > 0 && vis.every(t => this.selected.has(t.id));
    vis.forEach(t => all ? this.selected.delete(t.id) : this.selected.add(t.id));
    this.render();
  }

  async deleteSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    const everything = ids.length === this.tracks.length;
    const msg = everything
      ? `Usunąć CAŁĄ bibliotekę (${ids.length} utworów)? Tego nie można cofnąć.`
      : `Usunąć zaznaczone utwory (${ids.length})? Tego nie można cofnąć.`;
    if (!confirm(msg)) return;
    try {
      await this.deleteTracks(ids);
      this.toast(`Usunięto: ${ids.length}`);
    } catch (e) {
      this.toast('Nie udało się usunąć utworów');
    }
    this.exitSelectMode();
  }

  /* ---------- Media session ---------- */

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
      const artwork = this.coverUrl
        ? [{ src: this.coverUrl, sizes: '512x512' }]
        : [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: this.displayTitle(track),
          artist: track.artist || 'Aural',
          album: track.album || 'Lokalna biblioteka',
          artwork
        });
      } catch (e) { /* ignore */ }
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

  /* ---------- Remember last track ---------- */

  saveLast(force) {
    if (this.currentId === null) return;
    const now = Date.now();
    if (!force && now - this.lastSaved < 2000) return;
    this.lastSaved = now;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ id: this.currentId, pos: this.audio.currentTime || 0 }));
    } catch (e) { /* ignore */ }
  }

  clearLast() {
    try { localStorage.removeItem(LAST_KEY); } catch (e) { /* ignore */ }
  }

  async restoreLast() {
    let last = null;
    try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { /* ignore */ }
    if (!last || !this.tracks.length) return;
    const idx = this.tracks.findIndex(t => t.id === last.id);
    if (idx < 0) return;
    // Prepare the track but never start playback on its own.
    await this.playTrack(idx, { autoplay: false, startAt: last.pos || 0 });
  }

  /* ---------- Helpers ---------- */

  getDisplayName(filename) {
    return filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  displayTitle(t) {
    return t.title || this.getDisplayName(t.name);
  }

  matches(t) {
    if (!this.searchTerm) return true;
    const hay = `${this.displayTitle(t)} ${t.artist || ''} ${t.album || ''} ${t.name}`.toLowerCase();
    return hay.includes(this.searchTerm);
  }

  formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  formatTotal(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h ? `${h} godz. ${m} min` : `${m} min`;
  }

  formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  pluralTracks(n) {
    if (n === 1) return '1 utwór';
    const d = n % 10, dd = n % 100;
    return `${n} ${d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? 'utwory' : 'utworów'}`;
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
    const v = (this.audio.currentTime / d) * 1000;
    document.querySelectorAll('.js-progress').forEach(p => { p.value = v; });
    const t = this.formatTime(this.audio.currentTime);
    document.querySelectorAll('.js-cur').forEach(el => { el.textContent = t; });
  }

  updateDuration() {
    const t = this.formatTime(this.audio.duration);
    document.querySelectorAll('.js-dur').forEach(el => { el.textContent = t; });
    this.updatePositionState();
  }

  setPlaying(playing) {
    this.isPlaying = playing;
    document.querySelectorAll('.play-icon').forEach(el => { el.style.display = playing ? 'none' : 'block'; });
    document.querySelectorAll('.pause-icon').forEach(el => { el.style.display = playing ? 'block' : 'none'; });
    document.querySelectorAll('.js-play').forEach(el => el.setAttribute('aria-label', playing ? 'Pauza' : 'Odtwarzaj'));
    this.updateMediaSession();
    this.updatePositionState();
  }

  setCoverImgs(url) {
    for (const id of ['miniCover', 'fpCover']) {
      const img = document.getElementById(id);
      if (url) { img.src = url; img.hidden = false; }
      else { img.removeAttribute('src'); img.hidden = true; }
      const ph = img.parentElement.querySelector('.art-placeholder');
      if (ph) ph.style.display = url ? 'none' : '';
    }
  }

  async playTrack(index, opts = {}) {
    const { autoplay = true, startAt = 0 } = opts;
    if (index < 0 || index >= this.tracks.length) return;
    const track = this.tracks[index];
    const token = ++this.playToken;

    let data = null, cover = null;
    try {
      data = await this.getFileData(track.id);
      if (data && track.hasCover) cover = await this.getCover(track.id);
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
    this.pendingSeek = startAt > 0 ? startAt : null;

    const url = URL.createObjectURL(new Blob([data], { type: track.type }));
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = url;
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.coverUrl = cover ? URL.createObjectURL(new Blob([cover.data], { type: cover.type })) : null;

    this.audio.src = url;
    const title = this.displayTitle(track);
    document.getElementById('currentTitle').textContent = title;
    document.getElementById('currentArtist').textContent = track.artist || 'Aural';
    document.getElementById('fpTitle').textContent = title;
    document.getElementById('fpArtist').textContent = track.artist || '';
    document.getElementById('fpAlbum').textContent = track.album || '';
    this.setCoverImgs(this.coverUrl);
    document.querySelectorAll('.js-progress').forEach(p => { p.value = 0; });
    document.querySelectorAll('.js-cur').forEach(el => { el.textContent = '0:00'; });
    document.querySelectorAll('.js-dur').forEach(el => { el.textContent = this.formatTime(track.duration || 0); });
    document.getElementById('player').hidden = false;
    document.querySelector('.app').classList.add('has-player');

    this.setPlaying(false);
    this.render();
    this.updateMediaSession();
    this.saveLast(true);
    if (!autoplay) return;
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
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.currentUrl = null;
    this.coverUrl = null;
    this.currentId = null;
    this.currentIndex = -1;
    this.isPlaying = false;
    this.closeFull();
    document.getElementById('player').hidden = true;
    document.querySelector('.app').classList.remove('has-player');
    this.setPlaying(false);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  openFull() {
    if (this.currentIndex < 0) return;
    document.getElementById('fullPlayer').hidden = false;
  }

  closeFull() {
    document.getElementById('fullPlayer').hidden = true;
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
    const toolbar = document.getElementById('toolbar');

    if (!this.tracks.length) {
      empty.style.display = 'flex';
      noResults.hidden = true;
      toolbar.hidden = true;
      list.innerHTML = '';
      return;
    }
    empty.style.display = 'none';
    toolbar.hidden = false;

    const filtered = this.visibleTracks();
    noResults.hidden = filtered.length > 0;

    document.getElementById('sortRow').hidden = this.selectMode;
    document.getElementById('selectBar').hidden = !this.selectMode;
    if (this.selectMode) {
      document.getElementById('selCount').textContent = `Zaznaczono ${this.selected.size}`;
      document.getElementById('selDelete').disabled = this.selected.size === 0;
      const all = filtered.length > 0 && filtered.every(t => this.selected.has(t.id));
      document.getElementById('selAll').textContent = all ? 'Odznacz' : 'Wszystkie';
    }
    list.classList.toggle('selecting', this.selectMode);

    const totalSize = this.tracks.reduce((s, t) => s + (t.size || 0), 0);
    const totalDur = this.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    document.getElementById('summary').textContent =
      `${this.pluralTracks(this.tracks.length)} · ${this.formatSize(totalSize)}` + (totalDur ? ` · ${this.formatTotal(totalDur)}` : '');

    list.innerHTML = filtered.map((track) => {
      const playing = track.id === this.currentId;
      const sel = this.selected.has(track.id);
      const title = this.escapeHtml(this.displayTitle(track));
      const sub = [track.artist, track.duration ? this.formatTime(track.duration) : '', this.formatSize(track.size)]
        .filter(Boolean).map(s => this.escapeHtml(s)).join(' · ');
      const thumb = track.thumb
        ? `<img src="${track.thumb}" alt="" draggable="false">`
        : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
      return `
        <li class="track-item ${playing ? 'playing' : ''} ${sel ? 'selected' : ''}" data-id="${track.id}">
          <button class="swipe-action" tabindex="-1" aria-label="Usuń ${title}">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            <span>Usuń</span>
          </button>
          <div class="track-fg">
            <span class="check ${sel ? 'on' : ''}" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
            <span class="thumb">${thumb}${playing ? '<span class="eq">▶</span>' : ''}</span>
            <div class="track-info">
              <div class="track-title">${title}</div>
              <div class="track-meta">${sub}</div>
            </div>
          </div>
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
