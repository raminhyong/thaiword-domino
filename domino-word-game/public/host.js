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
      if (res.ok) {
        qrDataUrl = res.dataUrl;
      } else {
        qrDataUrl = 'ERROR';
        console.error('สร้าง QR ไม่สำเร็จ:', res.error);
      }
      // จุดสำคัญ: ต้องสั่ง re-render ทันทีตรงนี้ ไม่งั้น QR จะค้างที่ "กำลังสร้าง QR..."
      // จนกว่าจะมี event 'state' รอบใหม่มาจากเซิร์ฟเวอร์ (เช่น รอทีมแรกเข้าร่วม) ซึ่งอาจไม่มาเลย
      if (latestState && latestState.status === 'lobby') renderLobby(latestState);
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

  function selectWordSet(setId) {
    socket.emit('host:selectWordSet', { code, setId }, (res) => {
      if (!res.ok) alert(res.error);
    });
  }

  function togglePause(isPaused) {
    const event = isPaused ? 'host:resumeGame' : 'host:pauseGame';
    socket.emit(event, { code }, (res) => {
      if (!res.ok) alert(res.error);
    });
  }

  function endGameNow() {
    if (!confirm('แน่ใจนะว่าจะจบเกมนี้ตอนนี้เลย? (จะจัดอันดับจากเบี้ยที่เหลือให้ทันที)')) return;
    socket.emit('host:endGame', { code }, (res) => {
      if (!res.ok) alert(res.error);
    });
  }

  function renderLobby(state) {
    app.innerHTML = '';
    const teamsHtml = state.teams.length
      ? state.teams.map((t) => `<div class="team-chip">🙋 ${escapeHtml(t.name)}</div>`).join('')
      : '<p class="subtle">ยังไม่มีทีมเข้าร่วม... สแกน QR ด้านล่างเพื่อเข้าร่วม</p>';

    let qrHtml;
    if (qrDataUrl === 'ERROR') {
      qrHtml = `<div style="padding:20px;">
        <p style="color:#ef5f8f; font-weight:700;">สร้าง QR ไม่สำเร็จ 😢</p>
        <button class="btn btn-blue" id="retryQrBtn">ลองใหม่</button>
      </div>`;
    } else if (qrDataUrl) {
      qrHtml = `<img src="${qrDataUrl}" width="260" height="260"/>`;
    } else {
      qrHtml = 'กำลังสร้าง QR...';
    }

    const sets = state.availableWordSets || [];
    const setButtonsHtml = sets
      .map((s) => {
        const isSelected = s.id === state.wordSetId;
        return `<button class="btn ${isSelected ? 'btn-green' : 'btn-blue'}" data-set-id="${s.id}" style="opacity:${isSelected ? '1' : '.65'};">
          ${isSelected ? '✅ ' : ''}${escapeHtml(s.name)}
        </button>`;
      })
      .join('');

    app.appendChild(el(`
      <div class="center-screen">
        <h1>🁫 โดมิโนคำ 🁫</h1>
        <div class="room-code">${state.code}</div>
        <div class="qr-box">${qrHtml}</div>
        <p class="subtle">สแกน QR หรือเข้า ${location.origin}/player.html แล้วกรอกรหัสห้อง</p>

        <div class="card" style="text-align:center;">
          <p class="subtle" style="margin-top:0;">เลือกชุดคำที่จะใช้เล่น</p>
          <div class="row">${setButtonsHtml}</div>
        </div>

        <div class="row" style="max-width:640px;">${teamsHtml}</div>
        <p class="subtle">${state.teams.length} / 10 ทีม</p>
        <button class="btn btn-green" id="startBtn" ${state.teams.length < 2 ? 'disabled' : ''}>เริ่มเกม!</button>
      </div>
    `));
    document.getElementById('startBtn').onclick = startGame;
    const retryBtn = document.getElementById('retryQrBtn');
    if (retryBtn) retryBtn.onclick = () => { qrDataUrl = null; renderLobby(state); fetchQr(); };
    document.querySelectorAll('[data-set-id]').forEach((btn) => {
      btn.onclick = () => selectWordSet(btn.dataset.setId);
    });
  }

  // แสดงเบี้ยแบบโดมิโนจริง: แบ่ง 2 ฝั่ง ฝั่งซ้าย = พยางค์ที่ต่อกับเบี้ยก่อนหน้า, ฝั่งขวา = พยางค์ที่เปิดให้ทีมถัดไปต่อ
  // ถ้า orientation เป็น 'flip' ต้องสลับตำแหน่งพยางค์ (เพราะพยางค์ที่ใช้ต่อคือพยางค์หลังของคำ ไม่ใช่พยางค์แรก)
  function renderChainTile(c, isLast) {
    if (c.type === 'BLANK' || !c.syllables) {
      return `<div class="domino-tile type-BLANK">
        <span class="tag">BLANK</span>
        <div class="domino-halves"><span class="half">⭐ อะไรก็ได้</span></div>
      </div>`;
    }
    const [leftSyl, rightSyl] = c.orientation === 'flip'
      ? [c.syllables[1], c.syllables[0]]
      : [c.syllables[0], c.syllables[1]];
    return `<div class="domino-tile type-${c.type}">
      <span class="tag">${c.type}</span>
      <div class="domino-halves">
        <span class="half">${escapeHtml(leftSyl)}</span>
        <span class="divider"></span>
        <span class="half ${isLast ? 'open-end' : ''}">${escapeHtml(rightSyl)}</span>
      </div>
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
          <h2>ห้อง ${state.code} · ${escapeHtml(state.wordSetName || '')}</h2>
          <div class="row">
            ${state.paused ? '<span class="timer-badge" style="background:var(--purple);">⏸ พัก</span>' : `<div class="timer-badge" id="timerBadge">40</div>`}
          </div>
        </div>
        <div class="row">
          <button class="btn ${state.paused ? 'btn-green' : 'btn-yellow'}" id="pauseBtn">${state.paused ? '▶️ เล่นต่อ' : '⏸ พักเกม'}</button>
          <button class="btn btn-pink" id="endBtn">🏁 จบเกมนี้</button>
        </div>
        <div class="chain-track" id="chainTrack">${state.chain.map((c, i) => renderChainTile(c, i === state.chain.length - 1)).join('')}</div>
        <div class="row" style="max-width:1000px;">${teamsHtml}</div>
        <p class="subtle">กองกลางเหลือ ${state.drawPileCount} ใบ</p>
      </div>
    `));

    const track = document.getElementById('chainTrack');
    track.scrollLeft = track.scrollWidth;

    document.getElementById('pauseBtn').onclick = () => togglePause(state.paused);
    document.getElementById('endBtn').onclick = endGameNow;

    clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      if (!latestState || latestState.paused || !latestState.turnEndsAt) return;
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
