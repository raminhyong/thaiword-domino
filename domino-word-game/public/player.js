(function () {
  const app = document.getElementById('app');
  const socket = io();

  const urlCode = new URLSearchParams(location.search).get('code') || '';
  let session = loadSession();
  let latestState = null;
  let tickInterval = null;

  function loadSession() {
    try {
      const raw = localStorage.getItem('domino_session');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function saveSession(s) {
    session = s;
    localStorage.setItem('domino_session', JSON.stringify(s));
  }
  function clearSession() {
    session = null;
    localStorage.removeItem('domino_session');
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, kind) {
    const t = el(`<div class="toast ${kind}">${escapeHtml(msg)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------- หน้าจอเข้าร่วม ----------
  function renderJoin(errorMsg) {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="center-screen">
        <h1 class="emoji-big">🁫 โดมิโนคำ 🁫</h1>
        <div class="card" style="display:flex; flex-direction:column; gap:14px;">
          <div>
            <label class="subtle">รหัสห้อง</label>
            <input type="text" id="codeInput" value="${escapeHtml(urlCode)}" placeholder="เช่น AB3XZ" maxlength="6" style="text-transform:uppercase;" />
          </div>
          <div>
            <label class="subtle">ชื่อทีม</label>
            <input type="text" id="nameInput" placeholder="ชื่อทีมของเรา" maxlength="24" />
          </div>
          ${errorMsg ? `<p style="color:#ef5f8f; font-weight:700;">${escapeHtml(errorMsg)}</p>` : ''}
          <button class="btn btn-pink" id="joinBtn">เข้าร่วมเกม</button>
        </div>
      </div>
    `));
    document.getElementById('joinBtn').onclick = () => {
      const code = document.getElementById('codeInput').value.trim().toUpperCase();
      const teamName = document.getElementById('nameInput').value.trim();
      if (!code || !teamName) return renderJoin('กรุณากรอกรหัสห้องและชื่อทีมให้ครบ');
      socket.emit('player:join', { code, teamName }, (res) => {
        if (!res.ok) return renderJoin(res.error);
        saveSession({ code: res.code, teamId: res.teamId });
      });
    };
  }

  function tryRejoin() {
    socket.emit('player:rejoin', { code: session.code, teamId: session.teamId }, (res) => {
      if (!res.ok) {
        clearSession();
        renderJoin();
      }
      // ถ้าสำเร็จ event 'state' จะตามมาเองแล้ว render ต่อ
    });
  }

  // ---------- หน้ารอเกมเริ่ม ----------
  function renderLobby(state) {
    clearInterval(tickInterval);
    const me = state.teams.find((t) => t.id === session.teamId);
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="center-screen">
        <h1 class="emoji-big">⏳</h1>
        <h2>ทีม ${escapeHtml(me ? me.name : '')}</h2>
        <p class="subtle">รอครูเริ่มเกม... (${state.teams.length} ทีมเข้าร่วมแล้ว)</p>
      </div>
    `));
  }

  // ---------- หน้าเล่นเกม ----------
  function renderPlaying(state) {
    const me = state.teams.find((t) => t.id === session.teamId);
    const isMyTurn = state.currentTeamId === session.teamId;
    const hand = state.myHand || [];
    const lastTile = state.chain[state.chain.length - 1];
    const openEndText = state.openEnd === 'ANY' ? 'อะไรก็ได้ (BLANK) ⭐' : state.openEnd;

    app.innerHTML = '';
    app.appendChild(el(`
      <div class="center-screen" style="justify-content:flex-start; padding-top:16px; gap:10px;">
        <div class="row" style="justify-content:space-between; width:100%;">
          <h3>ทีม ${escapeHtml(me ? me.name : '')}</h3>
          <div class="timer-badge" id="timerBadge">30</div>
        </div>
        <p style="font-weight:800;">${isMyTurn ? '🟢 ตาของทีมเรา!' : '⌛ รอตาทีมอื่น...'}</p>
        <div class="card" style="text-align:center; padding:12px;">
          <div class="subtle">คำล่าสุดบนกระดาน</div>
          <div style="font-size:1.4rem; font-weight:800;">${lastTile ? escapeHtml(lastTile.word || '⭐ BLANK') : '-'}</div>
          <div class="subtle">ต้องต่อด้วยคำที่มีพยางค์ว่า</div>
          <div style="font-size:1.6rem; font-weight:800; color:var(--pink-dark);">${escapeHtml(openEndText)}</div>
        </div>

        <div class="drop-zones">
          <div class="drop-zone ซ้อน" data-zone="ซ้อน">คำซ้อน</div>
          <div class="drop-zone ประสม" data-zone="ประสม">คำประสม</div>
        </div>

        <div class="hand-row" id="handRow"></div>

        <button class="btn btn-yellow" id="drawBtn" ${isMyTurn ? '' : 'disabled'}>🎲 จั่วคำเพิ่ม (มือไม่พอ/ทางตัน)</button>
        <p class="subtle">มือของเรา ${hand.length} ใบ · กองกลางเหลือ ${state.drawPileCount} ใบ</p>
      </div>
    `));

    const handRow = document.getElementById('handRow');
    hand.forEach((tile) => {
      const tileEl = el(`
        <div class="hand-tile type-${tile.type}" data-tile-id="${tile.id}" data-type="${tile.type}">
          ${tile.type === 'BLANK' ? '⭐<br/>BLANK' : escapeHtml(tile.word)}
        </div>
      `);
      if (isMyTurn) attachDrag(tileEl, tile);
      handRow.appendChild(tileEl);
    });

    document.getElementById('drawBtn').onclick = () => {
      socket.emit('player:voluntaryDraw', {}, (res) => {
        if (!res.ok) showToast(res.error, 'bad');
      });
    };

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

  // ---------- ลากเบี้ยด้วย Pointer Events (ใช้ได้ทั้งเมาส์และนิ้วมือถือ) ----------
  function attachDrag(tileEl, tile) {
    let ghost = null;
    let startX = 0, startY = 0;

    tileEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      tileEl.classList.add('selected');
      ghost = tileEl.cloneNode(true);
      ghost.classList.add('dragging');
      ghost.style.left = e.clientX - 48 + 'px';
      ghost.style.top = e.clientY - 40 + 'px';
      ghost.style.width = tileEl.offsetWidth + 'px';
      document.body.appendChild(ghost);
      tileEl.style.visibility = 'hidden';

      const move = (ev) => {
        ghost.style.left = ev.clientX - 48 + 'px';
        ghost.style.top = ev.clientY - 40 + 'px';
        document.querySelectorAll('.drop-zone').forEach((z) => {
          const r = z.getBoundingClientRect();
          const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
          z.classList.toggle('hover', inside);
        });
      };

      const up = (ev) => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        let droppedZone = null;
        document.querySelectorAll('.drop-zone').forEach((z) => {
          const r = z.getBoundingClientRect();
          const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
          z.classList.remove('hover');
          if (inside) droppedZone = z.dataset.zone;
        });
        if (ghost) ghost.remove();
        tileEl.style.visibility = 'visible';
        tileEl.classList.remove('selected');

        if (droppedZone) {
          socket.emit('player:playTile', { tileId: tile.id, slotType: droppedZone }, (res) => {
            if (!res.ok) showToast(res.error, 'bad');
          });
        }
      };

      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  // ---------- หน้าจบเกม ----------
  function renderPodium(state) {
    clearInterval(tickInterval);
    const me = state.teams.find((t) => t.id === session.teamId);
    const rank = me ? me.rank : null;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🎮';
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="center-screen">
        <div class="emoji-big">${medal}</div>
        <h2>${rank ? `ทีมเราได้อันดับที่ ${rank}!` : 'จบเกมแล้ว'}</h2>
        <p class="subtle">ขอบคุณที่ร่วมเล่น 💛</p>
      </div>
    `));
  }

  socket.on('state', (state) => {
    latestState = state;
    if (state.status === 'lobby') renderLobby(state);
    else if (state.status === 'playing') renderPlaying(state);
    else if (state.status === 'podium') renderPodium(state);
  });

  socket.on('gameEvent', ({ event, payload }) => {
    if (!payload) return;
    const mine = payload.teamId === session?.teamId;
    if (event === 'rejectedPlay' && mine) {
      const reasonText = payload.reason === 'wrong_slot' ? 'ลงผิดช่อง! เด้งกลับ + โดนจั่วเพิ่ม 1 ใบ 😖' : 'คำนี้ต่อไม่ได้! เด้งกลับ + โดนจั่วเพิ่ม 1 ใบ 😖';
      showToast(reasonText, 'bad');
    } else if (event === 'timeoutPenalty' && mine) {
      showToast('หมดเวลา! โดนจั่วเพิ่ม 1 ใบ ⏰', 'bad');
    } else if (event === 'acceptedPlay' && mine) {
      showToast('ลงคำสำเร็จ! 🎉', 'ok');
    } else if (event === 'teamEliminated' && mine) {
      showToast('มือเต็ม 15 ใบ! ทีมเราถูกคัดออก 💔', 'bad');
    } else if (event === 'teamFinished') {
      const t = latestState && latestState.teams.find((x) => x.id === payload.teamId);
      showToast(`🎉 ทีม${t ? t.name : ''} ได้อันดับที่ ${payload.rank}!`, 'ok');
    }
  });

  socket.on('connect', () => {
    if (session && session.code) tryRejoin();
    else renderJoin();
  });
})();
