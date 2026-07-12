// gameEngine.js
// เอนจินหลักของเกม "โดมิโนคำประสม-คำซ้อน" — server-authoritative
// ทุกกฎอ้างอิงจากการคุยยืนยันกับผู้ใช้ (Ramin) เมื่อ 2026-07-12
// รองรับหลายชุดคำ (data/wordSets.json) เลือกได้ก่อนเริ่มเกม เพิ่มชุดใหม่ในอนาคตได้แค่เติมเข้าไปในไฟล์นั้น

const fs = require('fs');
const path = require('path');

const WORD_SETS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'wordSets.json'), 'utf-8')
);

const TURN_SECONDS = 40;
const START_HAND_SIZE = 10;
const MAX_HAND_SIZE = 15; // ครบ 15 = แพ้ (ถูกคัดออก)
const MAX_TEAMS = 10;
const PODIUM_SIZE = 3; // จบเกมเมื่อหาที่ 1-2-3 ได้ครบ

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// เมทาดาต้าของชุดคำทั้งหมดที่มี (ไม่ส่ง tiles เต็มออกไปเพื่อให้ payload เบา) ใช้แสดงในหน้าเลือกชุดคำฝั่ง host
function listWordSets() {
  return WORD_SETS.map((s) => ({ id: s.id, name: s.name, tileCount: s.tiles.length }));
}

class GameRoom {
  constructor(code) {
    this.code = code;
    this.status = 'lobby'; // lobby -> playing -> podium
    this.teams = []; // { id, name, hand:[tileId], eliminated:bool, rank:null }
    this.turnOrder = []; // team ids ในลำดับ round-robin
    this.currentTurnIndex = 0;
    this.drawPile = [];
    this.chain = []; // { tileId, orientation, slotType, teamId }
    this.openEnd = null; // syllable ที่เปิดอยู่ หรือ 'ANY' ถ้าเพิ่งลง BLANK
    this.podium = []; // team ids เรียงอันดับ 1,2,3
    this.turnEndsAt = null;
    this.turnTimer = null;
    this.paused = false; // ครูกดพักเกม
    this.pausedRemainingMs = null; // เวลาที่เหลืออยู่ ณ จังหวะที่กดพัก
    this.wordSetId = WORD_SETS.length ? WORD_SETS[0].id : null; // ค่าเริ่มต้น: ชุดแรกที่มี ครูเปลี่ยนได้ก่อนกดเริ่มเกม
    this.tiles = []; // เติมค่าตอน startGame() จากชุดคำที่เลือก
    this._onUpdate = null; // callback(room) เรียกทุกครั้งที่ state เปลี่ยน เพื่อ broadcast
  }

  onUpdate(fn) {
    this._onUpdate = fn;
  }

  emitUpdate(event, payload) {
    if (this._onUpdate) this._onUpdate(this, event, payload);
  }

  tileById(id) {
    return this.tiles.find((t) => t.id === id);
  }

  // ครูเลือกชุดคำก่อนเริ่มเกม (เลือกใหม่ได้เรื่อย ๆ ตราบใดที่ยังไม่กดเริ่มเกม)
  selectWordSet(setId) {
    if (this.status !== 'lobby') throw new Error('เกมเริ่มไปแล้ว เปลี่ยนชุดคำไม่ได้');
    const set = WORD_SETS.find((s) => s.id === setId);
    if (!set) throw new Error('ไม่พบชุดคำนี้');
    this.wordSetId = setId;
    this.emitUpdate('lobbyUpdate');
  }

  addTeam(name) {
    if (this.status !== 'lobby') throw new Error('เกมเริ่มไปแล้ว เข้าร่วมไม่ได้');
    if (this.teams.length >= MAX_TEAMS) throw new Error('ทีมเต็มแล้ว (สูงสุด 10 ทีม)');
    const id = 'team_' + Math.random().toString(36).slice(2, 9);
    const team = { id, name, hand: [], eliminated: false, rank: null };
    this.teams.push(team);
    this.emitUpdate('lobbyUpdate');
    return team;
  }

  startGame() {
    if (this.status !== 'lobby') throw new Error('เกมเริ่มไปแล้ว');
    if (this.teams.length < 2) throw new Error('ต้องมีอย่างน้อย 2 ทีมถึงจะเริ่มได้');
    const set = WORD_SETS.find((s) => s.id === this.wordSetId);
    if (!set) throw new Error('กรุณาเลือกชุดคำก่อนเริ่มเกม');
    this.tiles = set.tiles;

    const allIds = shuffle(this.tiles.map((t) => t.id));
    const nonBlankIds = allIds.filter((id) => this.tileById(id).type !== 'BLANK');
    if (nonBlankIds.length === 0) throw new Error('ชุดคำนี้ไม่มีคำจริงเลย');

    // 1. สุ่มคำตั้งต้นจากกองกลาง (ต้องไม่ใช่ BLANK) แยกออกจากกองที่จะแจก
    const startTileId = nonBlankIds[0];
    const pool = allIds.filter((id) => id !== startTileId);

    this.chain = [
      { tileId: startTileId, orientation: 'normal', slotType: this.tileById(startTileId).type, teamId: null },
    ];
    this.openEnd = this.tileById(startTileId).syllables[1];

    // 2. แจกมือเริ่มต้นทีมละ 10 ใบ จากกองที่เหลือ
    let idx = 0;
    for (const team of this.teams) {
      team.hand = pool.slice(idx, idx + START_HAND_SIZE);
      idx += START_HAND_SIZE;
    }
    this.drawPile = pool.slice(idx);

    // 3. สุ่มทีมเริ่มต้น จากนั้นวนตามลำดับทีม (round-robin)
    this.turnOrder = this.teams.map((t) => t.id);
    this.currentTurnIndex = Math.floor(Math.random() * this.turnOrder.length);

    this.status = 'playing';
    this.startTurnTimer();
    this.emitUpdate('gameStarted');
  }

  get activeTeams() {
    return this.teams.filter((t) => !t.eliminated && t.rank === null);
  }

  currentTeam() {
    const id = this.turnOrder[this.currentTurnIndex];
    return this.teams.find((t) => t.id === id);
  }

  startTurnTimer() {
    this.clearTurnTimer();
    this.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    this.turnTimer = setTimeout(() => this.handleTimeout(), TURN_SECONDS * 1000);
    this.emitUpdate('turnStart', { teamId: this.currentTeam()?.id, endsAt: this.turnEndsAt });
  }

  clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  // ครูกดพักเกม: หยุดนาฬิกาไว้ชั่วคราว จำเวลาที่เหลือไว้ ผู้เล่นลง/จั่วไม่ได้จนกว่าจะกดเล่นต่อ
  pauseGame() {
    if (this.status !== 'playing') throw new Error('เกมยังไม่เริ่มหรือจบไปแล้ว');
    if (this.paused) throw new Error('เกมพักอยู่แล้ว');
    this.pausedRemainingMs = this.turnEndsAt ? Math.max(0, this.turnEndsAt - Date.now()) : TURN_SECONDS * 1000;
    this.clearTurnTimer();
    this.paused = true;
    this.emitUpdate('gamePaused', {});
  }

  // ครูกดเล่นต่อ: นับเวลาต่อจากที่ค้างไว้ตอนกดพัก ไม่รีเซ็ตเป็น 40 วิใหม่
  resumeGame() {
    if (this.status !== 'playing') throw new Error('เกมยังไม่เริ่มหรือจบไปแล้ว');
    if (!this.paused) throw new Error('เกมไม่ได้พักอยู่');
    const remaining = this.pausedRemainingMs != null ? this.pausedRemainingMs : TURN_SECONDS * 1000;
    this.paused = false;
    this.pausedRemainingMs = null;
    this.turnEndsAt = Date.now() + remaining;
    this.turnTimer = setTimeout(() => this.handleTimeout(), remaining);
    this.emitUpdate('gameResumed', {});
  }

  // ครูกดจบเกมก่อนเวลา: จัดอันดับเท่าที่ทำได้ ณ ตอนนั้นแล้วจบเลย (ใช้ตรรกะเดียวกับ endGame() ตอน deadlock)
  forceEndGame() {
    if (this.status !== 'playing') throw new Error('เกมยังไม่เริ่มหรือจบไปแล้ว');
    this.paused = false;
    this.endGame();
  }

  drawFromPile() {
    if (this.drawPile.length === 0) return null;
    return this.drawPile.pop();
  }

  // หมดเวลา โดยยังไม่ลงคำ -> บังคับจั่ว 1 ใบเป็นโทษ จบเทิร์นทันที ไม่มีโอกาสลง
  handleTimeout() {
    if (this.status !== 'playing' || this.paused) return;
    const team = this.currentTeam();
    if (!team) return;
    if (team.hand.length >= MAX_HAND_SIZE) {
      // ถาดเต็มอยู่แล้ว ไม่มีที่ใส่เบี้ยโทษ -> แพ้
      this.eliminateForFullTray(team);
      return;
    }
    const drawn = this.drawFromPile();
    if (drawn !== null) team.hand.push(drawn);
    this.emitUpdate('timeoutPenalty', { teamId: team.id, drawnTileId: drawn });
    this.advanceTurn();
  }

  // ผู้เล่นกดจั่วเองระหว่างเทิร์น (ทางตัน) - ไม่ใช่โทษ นาฬิกาเดินต่อรวมเวลาเดิม ไม่รีเซ็ต
  // ถาดมี 15 ช่อง: ถ้าถาดเต็มอยู่แล้ว (15) และยังต้องจั่วอีก แปลว่าจนตรอกจริง ๆ -> แพ้ทันที
  // แต่ถ้าจั่วแล้วพอดีทำให้ครบ 15 (ยังไม่เกิน) ทีมยังลงคำจากมือ 15 ใบนั้นได้ตามปกติ ไม่ถือว่าแพ้ทันที
  voluntaryDraw(teamId) {
    this.assertTurn(teamId);
    const team = this.currentTeam();
    if (team.hand.length >= MAX_HAND_SIZE) {
      // ถาดเต็มอยู่แล้วและยังจนตรอก -> แพ้
      this.eliminateForFullTray(team);
      return null;
    }
    const drawn = this.drawFromPile();
    if (drawn === null) throw new Error('กองกลางหมดแล้ว');
    team.hand.push(drawn);
    this.emitUpdate('voluntaryDraw', { teamId, drawnTileId: drawn });
    return drawn;
  }

  // ใช้ตอนทีมต้องจั่ว (โทษ หรือ จั่วเอง) แต่ถาด 15 ช่องเต็มอยู่แล้ว ไม่มีที่ใส่ -> แพ้/ถูกคัดออก
  eliminateForFullTray(team) {
    team.eliminated = true;
    this.emitUpdate('teamEliminated', { teamId: team.id, reason: 'tray_full' });
    if (this.activeTeams.length === 0) {
      this.endGame();
    } else {
      this.advanceTurn();
    }
  }

  assertTurn(teamId) {
    if (this.status !== 'playing') throw new Error('เกมยังไม่เริ่มหรือจบไปแล้ว');
    if (this.paused) throw new Error('เกมหยุดชั่วคราวอยู่ กรุณารอครู');
    const team = this.currentTeam();
    if (!team || team.id !== teamId) throw new Error('ยังไม่ถึงตาทีมนี้');
  }

  // พยายามลงคำ: { teamId, tileId, slotType }
  playTile(teamId, tileId, slotType) {
    this.assertTurn(teamId);
    const team = this.currentTeam();
    if (!team.hand.includes(tileId)) throw new Error('ทีมนี้ไม่มีคำนี้ในมือ');

    const tile = this.tileById(tileId);
    const isBlank = tile.type === 'BLANK';

    let orientation = 'normal';
    let matchOk = false;

    if (this.openEnd === 'ANY') {
      // ปลายเปิดจาก BLANK ก่อนหน้า -> ลงคำอะไรก็ได้ (ไม่ต้องตรงพยางค์)
      matchOk = true;
      if (!isBlank) orientation = 'normal';
    } else if (isBlank) {
      matchOk = true; // BLANK ลงได้ตลอดไม่ต้องตรงพยางค์
    } else {
      if (tile.syllables[0] === this.openEnd) {
        matchOk = true;
        orientation = 'normal';
      } else if (tile.syllables[1] === this.openEnd) {
        matchOk = true;
        orientation = 'flip';
      }
    }

    // ตรวจช่อง: BLANK เลือกช่องไหนก็ได้ไม่โดนโทษ, คำจริงต้องตรงประเภท
    const slotOk = isBlank || slotType === tile.type;

    if (!matchOk || !slotOk) {
      // ลงผิด -> เด้งกลับ (ไม่ถูกวาง) + โทษจั่วเพิ่ม 1 ใบ + จบเทิร์น
      const reason = !matchOk ? 'syllable_mismatch' : 'wrong_slot';
      if (team.hand.length >= MAX_HAND_SIZE) {
        // ถาดเต็มอยู่แล้ว ไม่มีที่ใส่เบี้ยโทษ -> แพ้
        this.emitUpdate('rejectedPlay', { teamId, tileId, reason, drawnTileId: null });
        this.eliminateForFullTray(team);
        return { accepted: false, reason };
      }
      const drawn = this.drawFromPile();
      if (drawn !== null) team.hand.push(drawn);
      this.emitUpdate('rejectedPlay', { teamId, tileId, reason, drawnTileId: drawn });
      this.advanceTurn();
      return { accepted: false, reason };
    }

    // ลงถูก
    team.hand = team.hand.filter((id) => id !== tileId);
    this.chain.push({ tileId, orientation, slotType: isBlank ? slotType : tile.type, teamId });
    this.openEnd = isBlank ? 'ANY' : tile.syllables[orientation === 'normal' ? 1 : 0];

    this.emitUpdate('acceptedPlay', { teamId, tileId, orientation, slotType });

    if (team.hand.length === 0) {
      this.finishTeam(team);
      if (this.status === 'podium') return { accepted: true };
    }

    this.advanceTurn();
    return { accepted: true };
  }

  finishTeam(team) {
    team.rank = this.podium.length + 1;
    this.podium.push(team.id);
    this.emitUpdate('teamFinished', { teamId: team.id, rank: team.rank });
    if (this.podium.length >= PODIUM_SIZE) {
      this.endGame();
    }
  }

  advanceTurn() {
    if (this.status !== 'playing') return;
    if (this.activeTeams.length === 0) {
      this.endGame();
      return;
    }
    let next = this.currentTurnIndex;
    for (let i = 0; i < this.turnOrder.length; i++) {
      next = (next + 1) % this.turnOrder.length;
      const t = this.teams.find((t) => t.id === this.turnOrder[next]);
      if (t && !t.eliminated && t.rank === null) {
        this.currentTurnIndex = next;
        this.startTurnTimer();
        return;
      }
    }
    this.endGame();
  }

  endGame() {
    // ถ้าทีมที่เหลือถูกคัดออกหมดก่อนจะหาที่ 1-2-3 ได้ครบ (deadlock/โชคร้ายทั้งกระดาน)
    // หรือครูกดจบเกมก่อนเวลา ให้จัดอันดับที่เหลือด้วยทีมที่มีเบี้ยในมือน้อยที่สุด (ใกล้ชนะที่สุด)
    // เพื่อให้เกมจบแบบมีผลสรุปเสมอ
    if (this.podium.length < PODIUM_SIZE) {
      const unranked = this.teams
        .filter((t) => t.rank === null)
        .sort((a, b) => a.hand.length - b.hand.length);
      for (const t of unranked) {
        if (this.podium.length >= PODIUM_SIZE) break;
        t.rank = this.podium.length + 1;
        this.podium.push(t.id);
      }
    }
    this.status = 'podium';
    this.paused = false;
    this.clearTurnTimer();
    this.emitUpdate('gameEnded', { podium: this.podium });
  }

  publicState(forTeamId) {
    const activeSet = WORD_SETS.find((s) => s.id === this.wordSetId);
    return {
      code: this.code,
      status: this.status,
      paused: this.paused,
      wordSetId: this.wordSetId,
      wordSetName: activeSet ? activeSet.name : null,
      availableWordSets: this.status === 'lobby' ? listWordSets() : undefined,
      teams: this.teams.map((t) => ({
        id: t.id,
        name: t.name,
        handCount: t.hand.length,
        eliminated: t.eliminated,
        rank: t.rank,
      })),
      currentTeamId: this.status === 'playing' ? (this.currentTeam() ? this.currentTeam().id : null) : null,
      turnEndsAt: this.turnEndsAt,
      chain: this.chain.map((c) => ({
        tileId: c.tileId,
        word: this.tileById(c.tileId).word,
        type: this.tileById(c.tileId).type,
        orientation: c.orientation,
        slotType: c.slotType,
      })),
      openEnd: this.openEnd,
      drawPileCount: this.drawPile.length,
      podium: this.podium.map((id) => this.teams.find((t) => t.id === id)),
      myHand: forTeamId
        ? (this.teams.find((t) => t.id === forTeamId) ? this.teams.find((t) => t.id === forTeamId).hand : []).map((id) => this.tileById(id))
        : undefined,
    };
  }
}

module.exports = { GameRoom, WORD_SETS, listWordSets, TURN_SECONDS, START_HAND_SIZE, MAX_HAND_SIZE, MAX_TEAMS, PODIUM_SIZE };
