(function () {
  const app = document.getElementById('app');
  const socket = io();

  let code = new URLSearchParams(location.search).get('code');
  let latestState = null;
  let qrDataUrl = null;
  let tickInterval = null;

  function joinUrl(c) {
    return `${location.origin}/player.html?code=${c}`;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function renderCreate() {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="center-screen">
        <h1 class="emoji-big">🁫 โดมิโนคำ 🁫</h1>
        <p class="subtle">คำประสม-คำซ้อน แบบเล่นสด</p>
        <button class="btn btn-pink" id="createBtn">สร้างห้องเกมใหม่</button>
      </div>
    `));
    document.getElementById('createBtn').onclick = () => {
      socket.emit('host:createRoom', {}, (res) => {
        if (!res.ok) return alert(res.error);
        code = res.code;
        history.replaceState(null, '', `/host.html?code=${code}`);
        fetchQr();
      });
    };
  }

  function fetchQr() {
    socket.emit('host:qrcode', { code, joinUrl: joinUrl(code) }, (res) => {
      if (res.ok) qrDataUrl = res.dataUrl;
    });
  }

  function tryRejoin() {
    socket.emit('host:rejoin', { code }, (res) => {
      if (!res.ok) {
        code = null;
        renderCreate();
      } else {
        fetchQr();
      }
    });
  }

  function startGame() {
    socket.emit('host:startGame', { code }, (res) => {
      if (!res.ok) alert(res.error);
    });
  }

  function renderLobby(state) {
    app.innerHTML = '';
    const teamsHtml = state.teams.length
      ? state.teams.map((t) => `<div class="team-chip">🙋 ${escapeHtml(t.name)}</div>`).join('')
      : '<p class="subtle">ยังไม่มีทีมเข้าร่วม... สแกน QR ด้านล่างเพื่อเข้าร่วม</p>';

    app.appendChild(el(`
      <div class="center-screen">
        <h1>🁫 โดมิโนคำ 🁫</h1>
        <div class="room-code">${state.code}</div>
        <div class="qr-box">${qrDataUrl ? `<img src="${qrDataUrl}" width="260" height="260"/>` : 'กำลังสร้าง QR...'}</div>
        <p class="subtle">สแกน QR หรือเข้า ${location.origin}/player.html แล้วกรอกรหัสห้อง</p>
        <div class="row" style="max-width:640px;">${teamsHtml}</div>
        <p class="subtle">${state.teams.length} / 10 ทีม</p>
        <button class="btn btn-green" id="startBtn" ${state.teams.length < 2 ? 'disabled' : ''}>เริ่มเกม!</button>
      </div>
    `));
    document.getElementById('startBtn').onclick = startGame;
  }

  function renderChainTile(c) {
    const flipCls = c.orientation === 'flip' ? 'flip' : '';
    return `<div class="domino-tile type-${c.type} ${flipCls}">
      <span class="tag">${c.type === 'BLANK' ? 'BLANK' : c.type}</span>
      <span class="word-text">${c.type === 'BLANK' ? '⭐' : escapeHtml(c.word)}</span>
    </div>`;
  }

  function renderPlaying(state) {
    app.innerHTML = '';
    const teamsHtml = state.teams
      .map((t) => {
        const activeCls = t.id === state.currentTeamId ? 'active' : '';
        const elimCls = t.eliminated ? 'eliminated' : '';
        return `<div class="team-chip ${activeCls} ${elimCls}">
          <span>${t.id === state.currentTeamId ? '👉 ' : ''}${escapeHtml(t.name)}</span>
          <span class="count">${t.handCount}</span>
        </div>`;
      })
      .join('');

    app.appendChild(el(`
      <div class="center-screen" style="justify-content:flex-start; padding-top:24px;">
        <div class="row" style="justify-content:space-between; width:100%; max-width:1000px;">
          <h2>ห้อง ${state.code}</h2>
          <div class="timer-badge" id="timerBadge">30</div>
        </div>
        <div class="chain-track" id="chainTrack">${state.chain.map(renderChainTile).join('')}</div>
        <div class="row" style="max-width:1000px;">${teamsHtml}</div>
        <p class="subtle">กองกลางเหลือ ${state.drawPileCount} ใบ</p>
      </div>
    `));

    const track = document.getElementById('chainTrack');
    track.scrollLeft = track.scrollWidth;

    clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      if (!latestState || !latestState.turnEndsAt) return;
      const remain = Math.max(0, Math.ceil((latestState.turnEndsAt - Date.now()) / 1000));
      const badge = document.getElementById('timerBadge');
      if (badge) {
        badge.textContent = remain;
        badge.classList.toggle('danger', remain <= 10);
      }
    }, 250);
  }

  function renderPodium(state) {
    clearInterval(tickInterval);
    app.innerHTML = '';
    const ranked = state.podium; // array ordered by rank 1..3
    const medal = ['🥇', '🥈', '🥉'];
    const stepClass = ['podium-1', 'podium-2', 'podium-3'];
    const html = ranked
      .map((t, i) => `<div class="podium-step ${stepClass[i]}"><div style="font-size:2rem">${medal[i]}</div>${escapeHtml(t ? t.name : '-')}</div>`)
      .join('');
    app.appendChild(el(`
      <div class="center-screen">
        <h1>🎉 จบเกม! 🎉</h1>
        <div class="podium-wrap">${html}</div>
        <p class="subtle">ขอบคุณที่ร่วมเล่นทุกทีม 💛</p>
      </div>
    `));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  socket.on('state', (state) => {
    latestState = state;
    if (state.status === 'lobby') renderLobby(state);
    else if (state.status === 'playing') renderPlaying(state);
    else if (state.status === 'podium') renderPodium(state);
  });

  socket.on('connect', () => {
    if (code) tryRejoin();
    else renderCreate();
  });
})();
