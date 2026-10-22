'use strict';

(() => {
  const state = {
    playlists: [],
    currentPlaylistIndex: -1,
    currentTrackIndex: -1,
    isSeeking: false,
    pendingSeek: null,
    loadId: 0,
    loadController: null,
    objectUrl: null,
    loading: false,
    repeatMode: 'off', // off | one | all
    metadata: { tracks: {} },
  };

  const $ = (id) => document.getElementById(id);
  const audio = $('audio-element');
  const homeScreen = $('home-screen');
  const playerScreen = $('player-screen');
  const playlistList = $('playlist-list');
  const trackList = $('track-list');
  const homeStatus = $('home-status');
  const playerStatus = $('player-status');
  const seekBar = $('seek-bar');
  const playButton = $('play-button');
  const playIcon = $('play-icon');
  const pauseIcon = $('pause-icon');

  const svgMarkup = {
    note: '<span class="cover-symbol" aria-hidden="true">♫</span>',
    play: '<span aria-hidden="true">♫</span>',
  };

  function setStatus(message, target = homeStatus) {
    target.textContent = message || '';
  }

  function showHome() {
    homeScreen.classList.remove('hidden');
    playerScreen.classList.add('hidden');
    setStatus('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showPlayer() {
    homeScreen.classList.add('hidden');
    playerScreen.classList.remove('hidden');
    setStatus('', playerStatus);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  }

  function getTrackMetadata(track) {
    return state.metadata.tracks[track.metadataKey] || {};
  }

  function trackTitle(track) {
    const metadata = getTrackMetadata(track);
    return metadata.title || track.name.replace(/\.mp3$/i, '');
  }

  function trackArtist(track) {
    const metadata = getTrackMetadata(track);
    return metadata.artist || 'アーティスト情報なし';
  }

  function trackAlbum(track) {
    return getTrackMetadata(track).album || '';
  }

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const seconds = Math.floor(value);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function sortJapanese(items, getter = (item) => item.name) {
    return items.sort((a, b) => getter(a).localeCompare(getter(b), 'ja', { numeric: true, sensitivity: 'base' }));
  }

  async function loadLibrary() {
    setStatus('プレイリストを読み込んでいます…');
    try {
      const response = await fetch(new URL('setting.meta', document.baseURI), { cache: 'no-cache' });
      if (!response.ok) throw new Error(`setting.meta を取得できませんでした（HTTP ${response.status}）。`);
      const metadata = await response.json();
      if (!metadata?.tracks || typeof metadata.tracks !== 'object' || Array.isArray(metadata.tracks)) {
        throw new Error('setting.meta の tracks に曲の相対パスを登録してください。');
      }
      state.metadata = metadata;
      const groups = new Map();
      const seen = new Set();
      for (const key of Object.keys(metadata.tracks)) {
        let path = normalizePath(key);
        if (path.startsWith('mp3/')) path = path.slice(4);
        const parts = path.split('/');
        if (!/\.mp3$/i.test(path) || parts.some((part) => !part || part === '.' || part === '..') || seen.has(path)) continue;
        seen.add(path);
        // A separate group for files directly inside mp3 preserves the default playlist.
        const group = parts.length > 1 ? parts[0] : '';
        if (!groups.has(group)) groups.set(group, { name: group || 'デフォルト', tracks: [] });
        groups.get(group).tracks.push({
          name: parts[parts.length - 1],
          path,
          metadataKey: key,
          url: new URL(`mp3/${parts.map(encodeURIComponent).join('/')}`, document.baseURI).href,
          duration: null,
        });
      }
      state.playlists = sortPlaylists(Array.from(groups.values()));
      state.playlists.forEach((playlist) => sortJapanese(playlist.tracks));
      renderPlaylists();
      setStatus(state.playlists.length ? '' : 'setting.meta に MP3 の曲パスが登録されていません。');
      void loadDurations(state.playlists.flatMap((playlist) => playlist.tracks));
    } catch (error) {
      state.playlists = [];
      renderPlaylists();
      setStatus(location.protocol === 'file:'
        ? '自動読み込みには HTTP/HTTPS が必要です。Webサーバー経由でこのページを開いてください。'
        : `ライブラリを読み込めませんでした。${error.message}`);
    }
  }

  function readDuration(track) {
    return new Promise((resolve) => {
      const probe = new Audio();
      probe.preload = 'metadata';
      const finish = () => {
        if (Number.isFinite(probe.duration) && probe.duration > 0) track.duration = probe.duration;
        clearTimeout(timer);
        probe.removeEventListener('loadedmetadata', finish);
        probe.removeEventListener('error', finish);
        probe.removeAttribute('src');
        probe.load();
        updateTrackDurations();
        resolve();
      };
      const timer = setTimeout(finish, 15000);
      probe.addEventListener('loadedmetadata', finish);
      probe.addEventListener('error', finish);
      probe.src = track.url;
      probe.load();
    });
  }

  async function loadDurations(tracks) {
    let next = 0;
    async function worker() {
      while (next < tracks.length) await readDuration(tracks[next++]);
    }
    await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, worker));
  }

  function updateTrackDurations() {
    const playlist = getCurrentPlaylist();
    if (!playlist) return;
    trackList.querySelectorAll('.track-row-duration').forEach((element, index) => {
      const duration = playlist.tracks[index].duration;
      element.textContent = Number.isFinite(duration) ? formatTime(duration) : '--:--';
      element.title = Number.isFinite(duration) ? '再生時間' : '再生時間を取得中、または取得できません';
    });
  }

  function sortPlaylists(playlists) {
    return playlists.sort((a, b) => {
      if (a.name === 'デフォルト') return 1;
      if (b.name === 'デフォルト') return -1;
      return a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });
    });
  }

  function makePlaylistCard(playlist, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'playlist-card';
    button.setAttribute('aria-label', `${playlist.name}、${playlist.tracks.length} 曲`);

    const cover = document.createElement('div');
    cover.className = `playlist-cover cover-${index % 4}`;
    cover.innerHTML = svgMarkup.note;

    const name = document.createElement('div');
    name.className = 'playlist-name';
    name.textContent = playlist.name;

    const count = document.createElement('div');
    count.className = 'playlist-count';
    count.textContent = `${playlist.tracks.length} 曲`;

    button.append(cover, name, count);
    button.addEventListener('click', () => openPlaylist(index));
    return button;
  }

  function renderPlaylists() {
    playlistList.replaceChildren();
    $('playlist-total').textContent = `${state.playlists.length} PLAYLIST${state.playlists.length === 1 ? '' : 'S'}`;
    if (!state.playlists.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-orbit" aria-hidden="true">♫</div><strong>再生できる曲がありません</strong><p>mp3 フォルダに音源を置き、setting.meta の tracks に曲の相対パスを登録してから、ページを再読み込みしてください。</p>';
      playlistList.append(empty);
      return;
    }
    state.playlists.forEach((playlist, index) => playlistList.append(makePlaylistCard(playlist, index)));
  }

  async function openPlaylist(index) {
    const playlist = state.playlists[index];
    if (!playlist || !playlist.tracks.length) return;
    state.currentPlaylistIndex = index;
    state.currentTrackIndex = 0;
    state.repeatMode = 'off';
    updateRepeatButton();
    renderTrackList();
    showPlayer();
    await loadTrack(0, false);
  }

  function getCurrentPlaylist() {
    return state.playlists[state.currentPlaylistIndex] || null;
  }

  function getCurrentTrack() {
    const playlist = getCurrentPlaylist();
    return playlist?.tracks[state.currentTrackIndex] || null;
  }

  async function loadTrack(index, autoplay) {
    const playlist = getCurrentPlaylist();
    if (!playlist || index < 0 || index >= playlist.tracks.length) return;
    const track = playlist.tracks[index];
    const loadId = ++state.loadId;
    state.loadController?.abort();
    const controller = new AbortController();
    state.loadController = controller;
    state.loading = true;
    state.isSeeking = false;
    state.pendingSeek = null;
    state.currentTrackIndex = index;
    seekBar.disabled = true;
    playButton.disabled = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    updateTrackInfo();
    updatePlayState();
    setStatus('音声ファイルを読み込んでいます…', playerStatus);

    try {
      // A complete Blob is seekable even on servers without HTTP Range support.
      // Keep only the current track, and discard superseded fetches.
      const response = await fetch(track.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`音声ファイルを取得できませんでした（HTTP ${response.status}）。`);
      const blob = await response.blob();
      if (loadId !== state.loadId) return;
      state.objectUrl = URL.createObjectURL(blob);
      audio.src = state.objectUrl;
      audio.load();
      state.loading = false;
      playButton.disabled = false;
      setStatus('', playerStatus);
      if (autoplay) await audio.play();
    } catch (error) {
      if (loadId !== state.loadId) return;
      state.loading = false;
      playButton.disabled = false;
      setStatus(error.message || '音声ファイルの読み込みに失敗しました。', playerStatus);
      updatePlayState();
    }
  }

  function updateTrackInfo() {
    const playlist = getCurrentPlaylist();
    const track = getCurrentTrack();
    if (!track || !playlist) return;
    const metadata = getTrackMetadata(track);
    $('current-playlist').textContent = playlist.name.toUpperCase();
    $('player-heading').textContent = trackTitle(track);
    $('current-artist').textContent = trackArtist(track);
    $('current-album').textContent = trackAlbum(track);
    $('lyrics-content').textContent = metadata.lyrics || 'この曲の歌詞は登録されていません。';
    $('lyrics-panel').classList.add('hidden');
    $('lyrics-button').classList.remove('active');
    $('lyrics-button').setAttribute('aria-pressed', 'false');
    $('lyrics-button').querySelector('span').textContent = '歌詞を表示';
    seekBar.value = '0';
    updateSeekProgress();
    $('current-time').textContent = '0:00';
    $('duration-time').textContent = '0:00';
  }

  function renderTrackList() {
    const playlist = getCurrentPlaylist();
    trackList.replaceChildren();
    if (!playlist) return;
    $('track-total').textContent = `${playlist.tracks.length} TRACK${playlist.tracks.length === 1 ? '' : 'S'}`;
    playlist.tracks.forEach((track, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `track-row${index === state.currentTrackIndex ? ' active' : ''}`;
      row.setAttribute('aria-label', `${index + 1}、${trackTitle(track)}を再生`);

      const number = document.createElement('span');
      number.className = 'track-number';
      number.textContent = index === state.currentTrackIndex && !audio.paused ? '♫' : String(index + 1).padStart(2, '0');
      const copy = document.createElement('span');
      copy.className = 'track-row-copy';
      const title = document.createElement('span');
      title.className = 'track-row-title';
      title.textContent = trackTitle(track);
      const artist = document.createElement('span');
      artist.className = 'track-row-artist';
      artist.textContent = trackArtist(track);
      copy.append(title, artist);
      const duration = document.createElement('span');
      duration.className = 'track-row-duration';
      duration.textContent = Number.isFinite(track.duration) ? formatTime(track.duration) : '--:--';
      row.append(number, copy, duration);
      row.addEventListener('click', () => loadTrack(index, true));
      trackList.append(row);
    });
  }

  function updatePlayState() {
    const playing = !audio.paused && !audio.ended;
    playIcon.classList.toggle('hidden', playing);
    pauseIcon.classList.toggle('hidden', !playing);
    playButton.setAttribute('aria-label', playing ? '一時停止' : '再生');
    document.body.classList.toggle('is-playing', playing);
    renderTrackList();
  }

  async function togglePlay() {
    if (state.loading) return;
    if (!getCurrentTrack()) {
      setStatus('先にプレイリストを選択してください。', playerStatus);
      return;
    }
    if (audio.paused) {
      try {
        if (!audio.src) await loadTrack(state.currentTrackIndex, false);
        await audio.play();
      } catch (error) {
        setStatus('再生できませんでした。MP3 ファイルを確認してください。', playerStatus);
      }
    } else {
      audio.pause();
    }
    updatePlayState();
  }

  function stopPlayback() {
    // Also cancel autoplay if Stop is pressed during the fetch.
    if (state.loading) {
      ++state.loadId;
      state.loadController?.abort();
      state.loading = false;
      playButton.disabled = false;
      setStatus('', playerStatus);
    }
    state.isSeeking = false;
    state.pendingSeek = null;
    audio.pause();
    try { audio.currentTime = 0; } catch (_) { /* メタデータ読み込み前は無視 */ }
    seekBar.value = '0';
    $('current-time').textContent = '0:00';
    updateSeekProgress();
    updatePlayState();
  }

  async function moveTrack(direction) {
    const playlist = getCurrentPlaylist();
    if (!playlist?.tracks.length) return;
    let next = state.currentTrackIndex + direction;
    if (next < 0) next = playlist.tracks.length - 1;
    if (next >= playlist.tracks.length) next = 0;
    await loadTrack(next, true);
  }

  function updateRepeatButton() {
    const button = $('repeat-button');
    const label = $('repeat-label');
    const names = { off: 'リピート OFF', one: 'リピート 1曲', all: 'リピート 全曲' };
    label.textContent = names[state.repeatMode];
    button.classList.toggle('active', state.repeatMode !== 'off');
    button.setAttribute('aria-pressed', String(state.repeatMode !== 'off'));
    button.setAttribute('aria-label', `${names[state.repeatMode]}。クリックして切り替え`);
  }

  function cycleRepeat() {
    const modes = ['off', 'one', 'all'];
    state.repeatMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
    updateRepeatButton();
  }

  function updateSeekProgress() {
    const max = Number(seekBar.max) || 1000;
    const value = Number(seekBar.value) || 0;
    seekBar.style.setProperty('--range-progress', `${(value / max) * 100}%`);
  }

  function toggleLyrics() {
    const panel = $('lyrics-panel');
    const isHidden = panel.classList.toggle('hidden');
    const button = $('lyrics-button');
    button.classList.toggle('active', !isHidden);
    button.setAttribute('aria-pressed', String(!isHidden));
    button.querySelector('span').textContent = isHidden ? '歌詞を表示' : '歌詞を隠す';
  }

  $('back-button').addEventListener('click', showHome);
  playButton.addEventListener('click', togglePlay);
  $('stop-button').addEventListener('click', stopPlayback);
  $('previous-button').addEventListener('click', () => moveTrack(-1));
  $('next-button').addEventListener('click', () => moveTrack(1));
  $('repeat-button').addEventListener('click', cycleRepeat);
  $('lyrics-button').addEventListener('click', toggleLyrics);

  function isCurrentAudio() {
    return !state.loading && state.objectUrl && audio.currentSrc === state.objectUrl;
  }

  function updateTimeline() {
    const ready = isCurrentAudio() && audio.readyState >= 1
      && Number.isFinite(audio.duration) && audio.duration > 0;
    seekBar.disabled = !ready || audio.seekable.length === 0;
    $('duration-time').textContent = formatTime(ready ? audio.duration : 0);
    // Neither timeupdate nor durationchange may overwrite an in-flight seek.
    if (state.isSeeking || state.pendingSeek !== null) return;
    $('current-time').textContent = formatTime(ready ? audio.currentTime : 0);
    seekBar.value = ready ? String((audio.currentTime / audio.duration) * Number(seekBar.max)) : '0';
    updateSeekProgress();
  }

  seekBar.addEventListener('input', () => {
    if (seekBar.disabled) return;
    state.isSeeking = true;
    updateSeekProgress();
    $('current-time').textContent = formatTime((Number(seekBar.value) / Number(seekBar.max)) * audio.duration);
  });
  seekBar.addEventListener('change', () => {
    state.isSeeking = false;
    if (seekBar.disabled || !isCurrentAudio()) {
      updateTimeline();
      return;
    }
    const target = (Number(seekBar.value) / Number(seekBar.max)) * audio.duration;
    try {
      state.pendingSeek = target;
      audio.currentTime = target;
      if (!audio.seeking) state.pendingSeek = null;
    } catch (_) {
      state.pendingSeek = null;
      setStatus('再生位置を変更できませんでした。もう一度操作してください。', playerStatus);
    }
    updateTimeline();
  });
  for (const eventName of ['pointercancel', 'blur']) {
    seekBar.addEventListener(eventName, () => {
      state.isSeeking = false;
      updateTimeline();
    });
  }
  $('volume-bar').addEventListener('input', (event) => {
    audio.volume = Number(event.target.value);
    $('volume-value').textContent = `${Math.round(audio.volume * 100)}%`;
  });

  audio.volume = 0.8;
  audio.addEventListener('loadedmetadata', () => {
    if (!isCurrentAudio()) return;
    const track = getCurrentTrack();
    if (track && Number.isFinite(audio.duration)) track.duration = audio.duration;
    updateTimeline();
    renderTrackList();
  });
  for (const eventName of ['timeupdate', 'durationchange', 'progress', 'canplay', 'emptied']) {
    audio.addEventListener(eventName, updateTimeline);
  }
  audio.addEventListener('seeked', () => {
    if (!isCurrentAudio() || audio.seeking) return;
    state.pendingSeek = null;
    updateTimeline();
  });
  audio.addEventListener('play', updatePlayState);
  audio.addEventListener('pause', updatePlayState);
  audio.addEventListener('ended', async () => {
    if (!isCurrentAudio()) return;
    if (state.repeatMode === 'one') {
      audio.currentTime = 0;
      try { await audio.play(); } catch (_) { updatePlayState(); }
      return;
    }
    const playlist = getCurrentPlaylist();
    if (!playlist) return;
    if (state.currentTrackIndex < playlist.tracks.length - 1) {
      await loadTrack(state.currentTrackIndex + 1, true);
    } else if (state.repeatMode === 'all') {
      await loadTrack(0, true);
    } else {
      updatePlayState();
    }
  });
  audio.addEventListener('error', () => {
    if (isCurrentAudio()) setStatus('このファイルはブラウザで再生できませんでした。MP3ファイルかどうか確認してください。', playerStatus);
  });

  updateRepeatButton();
  $('volume-value').textContent = '80%';
  updateSeekProgress();
  void loadLibrary();
})();
