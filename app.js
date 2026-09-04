// Mリーグ ドラフト会議 - メインロジック
// Firestore の draft/state ドキュメント1つで全体の状態を管理する。

const PARTICIPANTS = ["うし", "犬丼", "ちんさん", "木村", "ヤンマ"];
const MAX_ROUNDS = 4;
const REVEAL_STEP_MS = 900;
const LOTTERY_SPIN_MS = 2200;

firebase.initializeApp(window.FIREBASE_CONFIG);
const db = firebase.firestore();
const stateRef = db.collection("draft").doc("state");

const PLAYERS_BY_ID = {};
window.PLAYERS_DATA.forEach(p => { PLAYERS_BY_ID[p.id] = p; });

function initialState() {
  const results = {};
  PARTICIPANTS.forEach(p => { results[p] = [null, null, null, null]; });
  return {
    participants: PARTICIPANTS,
    maxRounds: MAX_ROUNDS,
    round: 1,
    pendingParticipants: [...PARTICIPANTS],
    bids: {},
    revealed: false,
    conflicts: [],
    lotteryInProgress: false,
    lastLottery: null,
    drafted: {},
    results,
    status: "in_progress",
  };
}

// ---------- identity ----------
let myName = localStorage.getItem("draftIdentity") || "";
const identitySelect = document.getElementById("identity-select");
PARTICIPANTS.forEach(p => {
  const opt = document.createElement("option");
  opt.value = p; opt.textContent = p;
  identitySelect.appendChild(opt);
});
identitySelect.value = myName;
identitySelect.addEventListener("change", () => {
  myName = identitySelect.value;
  localStorage.setItem("draftIdentity", myName);
  render(latestState);
});

// ---------- bootstrap doc ----------
stateRef.get().then(snap => {
  if (!snap.exists) {
    stateRef.set(initialState());
  }
});

let latestState = null;
let prevRevealed = false;
let prevLotteryInProgress = false;
let revealAnimating = false;

stateRef.onSnapshot(snap => {
  if (!snap.exists) return;
  const state = snap.data();
  handleTransitions(state);
  latestState = state;
  render(state);
});

function handleTransitions(state) {
  if (state.revealed && !prevRevealed) {
    revealAnimating = true;
    runRevealAnimation(state, () => {
      revealAnimating = false;
      render(latestState);
    });
  }
  if (state.lotteryInProgress && !prevLotteryInProgress) {
    scheduleLotteryResolution();
    runLotterySpinAnimation(state);
  }
  prevRevealed = state.revealed;
  prevLotteryInProgress = state.lotteryInProgress;
}

// ---------- rendering ----------
const headerRow = document.getElementById("board-header-row");
PARTICIPANTS.forEach(p => {
  const th = document.createElement("th");
  th.textContent = p;
  headerRow.appendChild(th);
});

const boardBody = document.getElementById("board-body");
const statusBanner = document.getElementById("status-banner");
const revealBtn = document.getElementById("reveal-btn");
const lotteryBtn = document.getElementById("lottery-btn");
const nextRoundBtn = document.getElementById("next-round-btn");
const pickPanel = document.getElementById("pick-panel");
const pickRoundNum = document.getElementById("pick-round-num");
const playerSelect = document.getElementById("player-select");
const pickBtn = document.getElementById("pick-btn");
const waitPanel = document.getElementById("wait-panel");
const waitMessage = document.getElementById("wait-message");
const lotteryPanel = document.getElementById("lottery-panel");
const resultsPanel = document.getElementById("results-panel");
const resultsGrid = document.getElementById("results-grid");

function render(state) {
  if (!state) return;
  renderBoard(state);
  renderControls(state);
  renderPickPanel(state);
  renderResults(state);
}

function renderBoard(state) {
  boardBody.innerHTML = "";
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = `${r}巡選択指名選手`;
    tr.appendChild(th);

    PARTICIPANTS.forEach(p => {
      const td = document.createElement("td");
      td.dataset.round = r;
      td.dataset.participant = p;

      const confirmedId = state.results[p][r - 1];
      if (confirmedId) {
        td.innerHTML = playerCellHTML(confirmedId);
        td.className = "cell-player";
      } else if (r < state.round) {
        td.textContent = "";
        td.className = "cell-empty";
      } else if (r > state.round) {
        td.textContent = "";
        td.className = "cell-empty";
      } else {
        // current round, not yet confirmed for this participant
        const isConflict = state.conflicts.some(c => c.participants.includes(p));
        if (state.revealed && !revealAnimating && state.bids[p] && !confirmedId) {
          td.innerHTML = playerCellHTML(state.bids[p], isConflict);
          td.className = isConflict ? "cell-conflict" : "cell-player";
        } else if (state.pendingParticipants.includes(p)) {
          td.textContent = "指名前";
          td.className = "cell-pending";
        } else {
          td.textContent = "指名完了";
          td.className = "cell-done";
        }
      }
      tr.appendChild(td);
    });
    boardBody.appendChild(tr);
  }
}

function playerLabel(id) {
  const pl = PLAYERS_BY_ID[id];
  if (!pl) return "?";
  return `${pl.name}（${pl.team}）`;
}

function playerCellHTML(id, isConflict) {
  const pl = PLAYERS_BY_ID[id];
  if (!pl) return "?";
  const suffix = isConflict ? "（重複）" : "";
  return `<div class="player-name">${pl.name}${suffix}</div><div class="player-team">${pl.team}</div>`;
}

function renderControls(state) {
  if (state.status === "completed") {
    statusBanner.hidden = false;
    statusBanner.textContent = "ドラフト会議 終了！お疲れ様でした。";
    revealBtn.hidden = true;
    lotteryBtn.hidden = true;
    nextRoundBtn.hidden = true;
    lotteryPanel.hidden = true;
    waitPanel.hidden = true;
    pickPanel.hidden = true;
    return;
  }

  const canReveal = state.pendingParticipants.length === 0 && !state.revealed;
  revealBtn.hidden = state.revealed;
  revealBtn.disabled = !canReveal;

  const hasConflict = state.revealed && !revealAnimating && state.conflicts.length > 0;
  const roundSettled = state.revealed && !revealAnimating && state.conflicts.length === 0;

  lotteryBtn.hidden = !(hasConflict && !state.lotteryInProgress);
  lotteryPanel.hidden = !state.lotteryInProgress;
  nextRoundBtn.hidden = !roundSettled;

  if (state.lotteryInProgress) {
    statusBanner.hidden = true;
  } else if (hasConflict) {
    statusBanner.hidden = false;
    statusBanner.textContent = `指名が重複しました！（${state.conflicts.map(c => playerLabel(c.playerId)).join("、")}）抽選を行ってください。`;
  } else if (roundSettled) {
    statusBanner.hidden = false;
    statusBanner.textContent = `第${state.round}巡の指名が確定しました！`;
  } else {
    statusBanner.hidden = true;
  }
}

function renderPickPanel(state) {
  if (state.status === "completed") {
    pickPanel.hidden = true; waitPanel.hidden = true;
    return;
  }
  if (!myName) {
    pickPanel.hidden = true; waitPanel.hidden = true;
    return;
  }
  const iAmPending = state.pendingParticipants.includes(myName);
  const alreadyConfirmedThisRound = !!state.results[myName][state.round - 1];
  const myTurnToPick = iAmPending && !state.revealed;

  if (!myTurnToPick) {
    pickPanel.hidden = true;
    const shouldWait = !state.revealed && !iAmPending && !alreadyConfirmedThisRound;
    waitPanel.hidden = !shouldWait;
    if (shouldWait) {
      waitMessage.textContent = "指名完了しました。他の参加者の入力をお待ちください。";
    }
    return;
  }

  // it's my turn to pick
  waitPanel.hidden = true;
  pickPanel.hidden = false;
  pickRoundNum.textContent = state.round;

  const draftedIds = new Set(Object.keys(state.drafted));
  playerSelect.innerHTML = "";
  const teams = {};
  window.PLAYERS_DATA.forEach(p => {
    if (draftedIds.has(p.id)) return;
    teams[p.team] = teams[p.team] || [];
    teams[p.team].push(p);
  });
  Object.keys(teams).sort().forEach(team => {
    const group = document.createElement("optgroup");
    group.label = team;
    teams[team].forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      group.appendChild(opt);
    });
    playerSelect.appendChild(group);
  });
}

function renderResults(state) {
  if (state.status !== "completed") {
    resultsPanel.hidden = true;
    return;
  }
  resultsPanel.hidden = false;
  resultsGrid.innerHTML = "";
  PARTICIPANTS.forEach(p => {
    const card = document.createElement("div");
    card.className = "team-card";
    const h3 = document.createElement("h3");
    h3.textContent = p;
    card.appendChild(h3);
    const ol = document.createElement("ol");
    state.results[p].forEach(id => {
      const li = document.createElement("li");
      li.textContent = id ? playerLabel(id) : "-";
      ol.appendChild(li);
    });
    card.appendChild(ol);
    resultsGrid.appendChild(card);
  });
}

// ---------- actions ----------
revealBtn.addEventListener("click", async () => {
  await db.runTransaction(async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.data();
    if (state.pendingParticipants.length > 0 || state.revealed) return;
    const byPlayer = {};
    Object.entries(state.bids).forEach(([name, pid]) => {
      (byPlayer[pid] = byPlayer[pid] || []).push(name);
    });
    const conflicts = Object.entries(byPlayer)
      .filter(([, names]) => names.length > 1)
      .map(([pid, names]) => ({ playerId: pid, participants: names }));
    tx.update(stateRef, { revealed: true, conflicts });
  });
});

nextRoundBtn.addEventListener("click", async () => {
  await confirmNonConflictRoundAndAdvance();
});

async function confirmNonConflictRoundAndAdvance() {
  await db.runTransaction(async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.data();
    if (!state.revealed || state.conflicts.length > 0) return;

    const drafted = { ...state.drafted };
    const results = JSON.parse(JSON.stringify(state.results));
    Object.entries(state.bids).forEach(([name, pid]) => {
      drafted[pid] = { participant: name, round: state.round };
      results[name][state.round - 1] = pid;
    });

    const nextRound = state.round + 1;
    const done = nextRound > state.maxRounds;
    tx.update(stateRef, {
      drafted, results,
      round: done ? state.round : nextRound,
      pendingParticipants: done ? [] : [...state.participants],
      bids: {},
      revealed: false,
      conflicts: [],
      status: done ? "completed" : "in_progress",
    });
  });
}

lotteryBtn.addEventListener("click", async () => {
  await db.runTransaction(async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.data();
    if (!state.revealed || state.conflicts.length === 0 || state.lotteryInProgress) return;
    tx.update(stateRef, { lotteryInProgress: true });
  });
});

function scheduleLotteryResolution() {
  setTimeout(resolveLottery, LOTTERY_SPIN_MS);
}

async function resolveLottery() {
  await db.runTransaction(async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.data();
    if (!state.lotteryInProgress) return; // already resolved by another client

    const drafted = { ...state.drafted };
    const results = JSON.parse(JSON.stringify(state.results));
    const conflictPlayerIds = new Set(state.conflicts.map(c => c.playerId));

    Object.entries(state.bids).forEach(([name, pid]) => {
      if (!conflictPlayerIds.has(pid)) {
        drafted[pid] = { participant: name, round: state.round };
        results[name][state.round - 1] = pid;
      }
    });

    const losers = [];
    const outcome = [];
    state.conflicts.forEach(c => {
      const winner = c.participants[Math.floor(Math.random() * c.participants.length)];
      drafted[c.playerId] = { participant: winner, round: state.round };
      results[winner][state.round - 1] = c.playerId;
      c.participants.forEach(n => { if (n !== winner) losers.push(n); });
      outcome.push({ playerId: c.playerId, participants: c.participants, winner });
    });

    const allDone = losers.length === 0;
    const nextRound = state.round + 1;
    const finished = allDone && nextRound > state.maxRounds;

    tx.update(stateRef, {
      drafted, results,
      bids: {},
      pendingParticipants: allDone ? (finished ? [] : [...state.participants]) : losers,
      revealed: false,
      conflicts: [],
      lotteryInProgress: false,
      lastLottery: { round: state.round, outcome, at: Date.now() },
      round: allDone ? (finished ? state.round : nextRound) : state.round,
      status: finished ? "completed" : "in_progress",
    });
  });
}

pickBtn.addEventListener("click", () => {
  const playerId = playerSelect.value;
  if (!playerId) return;
  const pl = PLAYERS_BY_ID[playerId];
  showConfirm(`${pl.name}（${pl.team}）の指名で確定させますか？入力後の変更はできません。`, async () => {
    await db.runTransaction(async tx => {
      const snap = await tx.get(stateRef);
      const state = snap.data();
      if (!state.pendingParticipants.includes(myName)) return;
      if (state.drafted[playerId]) return; // already taken, stale option
      const bids = { ...state.bids, [myName]: playerId };
      const pendingParticipants = state.pendingParticipants.filter(n => n !== myName);
      tx.update(stateRef, { bids, pendingParticipants });
    });
  });
});

document.getElementById("reset-btn").addEventListener("click", () => {
  showConfirm("ドラフトの進行状況を全てリセットします。よろしいですか？", async () => {
    await stateRef.set(initialState());
  });
});

// ---------- confirm modal ----------
const modalOverlay = document.getElementById("confirm-modal");
const confirmMessage = document.getElementById("confirm-message");
const confirmYes = document.getElementById("confirm-yes");
const confirmNo = document.getElementById("confirm-no");
let pendingConfirmAction = null;

function showConfirm(message, onYes) {
  confirmMessage.textContent = message;
  pendingConfirmAction = onYes;
  modalOverlay.hidden = false;
}
confirmYes.addEventListener("click", () => {
  modalOverlay.hidden = true;
  if (pendingConfirmAction) pendingConfirmAction();
  pendingConfirmAction = null;
});
confirmNo.addEventListener("click", () => {
  modalOverlay.hidden = true;
  pendingConfirmAction = null;
});

// ---------- reveal animation ----------
function runRevealAnimation(state, onDone) {
  const order = PARTICIPANTS.filter(p => state.bids[p]);
  order.forEach((p, i) => {
    setTimeout(() => {
      const td = boardBody.querySelector(`td[data-round="${state.round}"][data-participant="${p}"]`);
      if (td) {
        const isConflict = state.conflicts.some(c => c.participants.includes(p));
        td.innerHTML = playerCellHTML(state.bids[p], isConflict);
        td.className = isConflict ? "cell-conflict" : "cell-player";
      }
    }, i * REVEAL_STEP_MS);
  });

  const lotteryAnim = document.getElementById("lottery-anim");
  lotteryAnim.innerHTML = "";

  setTimeout(onDone, order.length * REVEAL_STEP_MS + 200);
}

function runLotterySpinAnimation(state) {
  const lotteryAnim = document.getElementById("lottery-anim");
  lotteryAnim.innerHTML = "";
  state.conflicts.forEach(c => {
    const line = document.createElement("div");
    line.dataset.playerId = c.playerId;
    line.textContent = `${playerLabel(c.playerId)}: ${c.participants.join(" / ")}`;
    lotteryAnim.appendChild(line);
  });

  const spinIntervalMs = 120;
  const spinTimer = setInterval(() => {
    state.conflicts.forEach(c => {
      const line = lotteryAnim.querySelector(`div[data-player-id="${c.playerId}"]`);
      if (!line) return;
      const pick = c.participants[Math.floor(Math.random() * c.participants.length)];
      line.textContent = `${playerLabel(c.playerId)}: 🎲 ${pick} ？`;
    });
  }, spinIntervalMs);

  setTimeout(() => clearInterval(spinTimer), LOTTERY_SPIN_MS - 200);
}
