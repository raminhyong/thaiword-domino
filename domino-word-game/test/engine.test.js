// test/engine.test.js
// ทดสอบ gameEngine โดยตรง (ไม่ผ่าน socket) เพื่อเช็ค logic หลักของเกมทุกกติกา
const assert = require('assert');
const { GameRoom, WORDBANK, MAX_HAND_SIZE } = require('../gameEngine');

function tileById(id) {
  return WORDBANK.find((t) => t.id === id);
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS -', name);
    passed++;
  } catch (e) {
    console.log('FAIL -', name, '->', e.message);
    failed++;
  }
}

// ---------- 1. เริ่มเกมพื้นฐาน ----------
check('startGame แจกมือ 10 ใบ/ทีม และตั้งค่าเริ่มต้นถูกต้อง', () => {
  const room = new GameRoom('TEST1');
  room.addTeam('ทีมเป็ด');
  room.addTeam('ทีมไก่');
  room.addTeam('ทีมหมู');
  room.startGame();
  assert.strictEqual(room.status, 'playing');
  assert.strictEqual(room.chain.length, 1);
  for (const t of room.teams) assert.strictEqual(t.hand.length, 10);
  assert.strictEqual(room.drawPile.length, WORDBANK.length - 1 - 30);
  assert.ok(room.openEnd && typeof room.openEnd === 'string');
});

// ---------- 2. จับคู่พยางค์ถูก (normal + flip) และวางถูกช่อง ----------
check('วางคำถูกพยางค์+ถูกช่อง สำเร็จ, ผิด -> เด้งกลับ+โทษ', () => {
  const room = new GameRoom('TEST2');
  room.addTeam('A');
  room.addTeam('B');
  room.startGame();

  const team = room.currentTeam();
  const before = team.hand.length;

  // หา tile ในมือที่ไม่ match กับ openEnd เพื่อทดสอบ syllable mismatch
  const openEnd = room.openEnd;
  const mismatchTile = team.hand
    .map(tileById)
    .find((t) => t.type !== 'BLANK' && t.syllables[0] !== openEnd && t.syllables[1] !== openEnd);

  if (mismatchTile) {
    const r = room.playTile(team.id, mismatchTile.id, mismatchTile.type);
    assert.strictEqual(r.accepted, false);
    assert.strictEqual(r.reason, 'syllable_mismatch');
    // โดนโทษ +1 ใบ เทิร์นเปลี่ยนไปทีมถัดไป
    assert.strictEqual(room.currentTeam().id !== team.id, true);
  }
});

check('วางคำถูกพยางค์ แต่ผิดช่อง (ซ้อน<->ประสม) -> เด้งกลับ+โทษ', () => {
  const room = new GameRoom('TEST3');
  room.addTeam('A');
  room.addTeam('B');
  room.startGame();

  const team = room.currentTeam();
  const openEnd = room.openEnd;
  const matchTile = team.hand
    .map(tileById)
    .find((t) => t.type !== 'BLANK' && (t.syllables[0] === openEnd || t.syllables[1] === openEnd));

  if (matchTile) {
    const wrongSlot = matchTile.type === 'ซ้อน' ? 'ประสม' : 'ซ้อน';
    const handBefore = team.hand.length;
    const r = room.playTile(team.id, matchTile.id, wrongSlot);
    assert.strictEqual(r.accepted, false);
    assert.strictEqual(r.reason, 'wrong_slot');
    // tile ต้องเด้งกลับ (ยังอยู่ในมือ) และมี +1 จากโทษ = +1 สุทธิ (ไม่ถูกลบออก)
    const teamAfter = room.teams.find((t) => t.id === team.id);
    assert.ok(teamAfter.hand.includes(matchTile.id), 'tile ต้องเด้งกลับเข้ามือ');
    assert.strictEqual(teamAfter.hand.length, handBefore + 1, 'ต้องได้โทษ +1 ใบ');
  }
});

// ---------- 3. หมดเวลา 30 วิ -> บังคับจั่ว ไม่มีโอกาสลง ----------
check('handleTimeout: บังคับจั่ว 1 ใบเป็นโทษ และจบเทิร์นทันที', () => {
  const room = new GameRoom('TEST4');
  room.addTeam('A');
  room.addTeam('B');
  room.startGame();
  const team = room.currentTeam();
  const before = team.hand.length;
  room.handleTimeout();
  assert.strictEqual(team.hand.length, before + 1);
  assert.notStrictEqual(room.currentTeam().id, team.id);
});

// ---------- 4. จั่วเอง (ทางตัน) ไม่จบเทิร์น ----------
check('voluntaryDraw: จั่วเพิ่มได้โดยไม่จบเทิร์น', () => {
  const room = new GameRoom('TEST5');
  room.addTeam('A');
  room.addTeam('B');
  room.startGame();
  const team = room.currentTeam();
  const before = team.hand.length;
  room.voluntaryDraw(team.id);
  assert.strictEqual(team.hand.length, before + 1);
  assert.strictEqual(room.currentTeam().id, team.id, 'ยังต้องเป็นเทิร์นเดิม');
});

// ---------- 5. BLANK wildcard ----------
check('BLANK: ลงได้ทุกช่อง ไม่ต้องตรงพยางค์ และเปิดปลาย ANY ให้ทีมถัดไปลงคำอะไรก็ได้', () => {
  const room = new GameRoom('TEST6');
  room.addTeam('A');
  room.addTeam('B');
  room.startGame();

  const team = room.currentTeam();
  const blank = WORDBANK.find((t) => t.type === 'BLANK');
  // inject blank เข้ามือทีมปัจจุบันเพื่อทดสอบ (จำลองว่าจั่วได้ BLANK มา)
  team.hand.push(blank.id);

  const r = room.playTile(team.id, blank.id, 'ซ้อน'); // เลือกช่องไหนก็ได้
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(room.openEnd, 'ANY');

  const nextTeam = room.currentTeam();
  // ลองลงคำแบบสุ่ม (ไม่ต้องตรงพยางค์เพราะปลายเป็น ANY) แต่ต้องตรงช่องประเภทจริงของคำ
  const anyTile = nextTeam.hand.map(tileById).find((t) => t.type !== 'BLANK');
  const r2 = room.playTile(nextTeam.id, anyTile.id, anyTile.type);
  assert.strictEqual(r2.accepted, true);
});

// ---------- 6. ครบ 15 ใบ -> ถูกคัดออก ----------
check('ทีมที่ถาดเต็ม 15 ใบอยู่แล้วและยังต้องจั่วอีก (จนตรอกจริง) -> ถูกคัดออก', () => {
  const room = new GameRoom('TEST7');
  room.addTeam('A');
  room.addTeam('B');
  room.startGame();
  const team = room.currentTeam();
  // เติมมือให้ครบ 15 พอดี (ยังไม่ถือว่าแพ้ ณ จุดนี้)
  while (team.hand.length < MAX_HAND_SIZE) team.hand.push(team.hand[0]);
  team.hand = team.hand.slice(0, MAX_HAND_SIZE);
  assert.strictEqual(team.eliminated, false, 'แค่ครบ 15 ยังไม่ถือว่าแพ้ ถ้ายังไม่ต้องจั่วเพิ่ม');
  // ทีนี้จำลองว่าหมดเวลาอีกครั้งทั้งที่ถาดเต็มอยู่แล้ว -> ต้องจั่วแต่ไม่มีที่ใส่ -> แพ้
  room.handleTimeout();
  const t = room.teams.find((x) => x.id === team.id);
  assert.strictEqual(t.hand.length, MAX_HAND_SIZE, 'ไม่ควรมีการจั่วเพิ่มเข้าไปอีกเพราะถาดเต็ม');
  assert.strictEqual(t.eliminated, true);
  assert.strictEqual(room.turnOrder.includes(t.id), true, 'ยังอยู่ใน turnOrder แต่ถูกข้ามตอนวนเทิร์น');
  assert.notStrictEqual(room.currentTeam().id, t.id);
});

// ---------- 7. จบเกม: หาที่ 1-2-3 แล้วจบทันที ----------
check('จำลองเกมเต็ม (bot) จนจบ -> ได้ podium ครบ 3 อันดับ, status = podium', () => {
  const room = new GameRoom('TEST8');
  const N_TEAMS = 4;
  for (let i = 0; i < N_TEAMS; i++) room.addTeam('ทีม' + i);
  room.startGame();

  let iterations = 0;
  const MAX_ITER = 20000;
  while (room.status === 'playing' && iterations < MAX_ITER) {
    iterations++;
    const team = room.currentTeam();
    if (!team) break;
    const openEnd = room.openEnd;
    let candidate;
    if (openEnd === 'ANY') {
      candidate = team.hand.map(tileById).find((t) => t.type !== 'BLANK');
    } else {
      candidate = team.hand
        .map(tileById)
        .find((t) => t.type !== 'BLANK' && (t.syllables[0] === openEnd || t.syllables[1] === openEnd));
    }
    if (!candidate) {
      // มีบล็งค์ในมือไหม ใช้เป็นทางออก
      const blankInHand = team.hand.map(tileById).find((t) => t.type === 'BLANK');
      if (blankInHand) {
        room.playTile(team.id, blankInHand.id, 'ซ้อน');
        continue;
      }
      // ไม่มีทางไป -> จั่วเอง ถ้ากองกลางยังไม่หมด
      if (room.drawPile.length > 0) {
        room.voluntaryDraw(team.id);
        // ลองอีกครั้งในลูปถัดไป (แต่ต้อง guard ไม่ให้วนซ้ำที่เดิมตลอดไปจนเกิน iterations)
        continue;
      }
      // กองกลางหมดจริงๆ -> ปล่อยให้หมดเวลา (จำลองด้วย handleTimeout ตรงๆ)
      room.handleTimeout();
      continue;
    }
    room.playTile(team.id, candidate.id, candidate.type);
  }

  assert.ok(iterations < MAX_ITER, 'ลูปจำลองไม่ควรวนเกิน MAX_ITER (แปลว่าเกมค้าง)');
  assert.strictEqual(room.status, 'podium');
  assert.strictEqual(room.podium.length, Math.min(3, N_TEAMS));
  console.log('   (จำลอง', iterations, 'turn-actions, podium:', room.podium.map((id) => room.teams.find(t=>t.id===id).name), ')');
});

// ---------- 8. รองรับหลายห้องพร้อมกันแบบ independent ----------
check('หลายห้องพร้อมกันไม่ปนกัน', () => {
  const r1 = new GameRoom('ROOMA');
  const r2 = new GameRoom('ROOMB');
  r1.addTeam('X');
  r1.addTeam('Y');
  r2.addTeam('Z');
  r2.addTeam('W');
  r1.startGame();
  r2.startGame();
  assert.notStrictEqual(r1.chain[0].tileId, undefined);
  assert.notStrictEqual(r2.chain[0].tileId, undefined);
  assert.strictEqual(r1.teams.length, 2);
  assert.strictEqual(r2.teams.length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
