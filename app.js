// Mリーグ ドラフト会議 - メインロジック
// 「選手ドラフト」「チームドラフト」はそれぞれ独立したFirestoreドキュメント1つで状態管理する。
// 参加者(5人)とアイデンティティ選択は両ドラフトで共通。

const PARTICIPANTS = ["うし", "犬丼", "ちんさん", "木村", "ヤンマ"];
const REVEAL_STEP_MS = 900;
const LOTTERY_SPIN_MS = 2200;

firebase.initializeApp(window.FIREBASE_CONFIG);
const db = firebase.firestore();

// ---------- shared identity ----------
let myName = localStorage.getItem("draftIdentity") || "";
const identitySelect = document.getElementById("identity-select");
PARTICIPANTS.forEach(p => {
  const opt = document.createElement("option");
  opt.value = p; opt.textContent = p;
  identitySelect.appendChild(opt);
});
identitySelect.value = myName;

const identityChangeListeners = [];
identitySelect.addEventListener("change", () => {
  myName = identitySelect.value;
  localStorage.setItem("draftIdentity", myName);
  identityChangeListeners.forEach(fn => fn());
});

// ---------- shared confirm modal ----------
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

// ---------- generic draft controller ----------
// items: [{id, name, sub}]  sub は省略可（選手ドラフトではチーム名、チームドラフトではなし）
function createDraftController(config) {
  const {
    collectionName, docId, items, maxRounds,
    roundLabel, pickHeadingText, prefix,
  } = config;

  const stateRef = db.collection(collectionName).doc(docId);
  const itemsById = {};
  items.forEach(it => { itemsById[it.id] = it; });

  function el(id) { return document.getElementById(id); }
  const dom = {
    headerRow: el(`${prefix}-board-header-row`),
    body: el(`${prefix}-board-body`),
    statusBanner: el(`${prefix}-status-banner`),
    revealBtn: el(`${prefix}-reveal-btn`),
    lotteryBtn: el(`${prefix}-lottery-btn`),
    nextRoundBtn: el(`${prefix}-next-round-btn`),
    pickPanel: el(`${prefix}-pick-panel`),
    pickRoundNum: el(`${prefix}-pick-round-num`),
    itemSelect: el(`${prefix}-item-select`),
    pickBtn: el(`${prefix}-pick-btn`),
    waitPanel: el(`${prefix}-wait-panel`),
    waitMessage: el(`${prefix}-wait-message`),
    lotteryPanel: el(`${prefix}-lottery-panel`),
    lotteryAnim: el(`${prefix}-lottery-anim`),
    resultsPanel: el(`${prefix}-results-panel`),
    resultsGrid: el(`${prefix}-results-grid`),
    resetBtn: el(`${prefix}-reset-btn`),
  };

  PARTICIPANTS.forEach(p => {
    const th = document.createElement("th");
    th.textContent = p;
    dom.headerRow.appendChild(th);
  });

  function initialState() {
    const results = {};
    PARTICIPANTS.forEach(p => { results[p] = new Array(maxRounds).fill(null); });
    return {
      participants: PARTICIPANTS,
      maxRounds,
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

  function displayName(it) {
    return it.tag ? `${it.name}（${it.tag}）` : it.name;
  }

  function itemLabel(id) {
    const it = itemsById[id];
    if (!it) return "?";
    return it.sub ? `${displayName(it)}（${it.sub}）` : displayName(it);
  }

  function itemCellHTML(id, isConflict) {
    const it = itemsById[id];
    if (!it) return "?";
    const suffix = isConflict ? "（重複）" : "";
    if (it.sub) {
      return `<div class="player-name">${displayName(it)}${suffix}</div><div class="player-team">${it.sub}</div>`;
    }
    return `<div class="player-name">${displayName(it)}${suffix}</div>`;
  }

  let latestState = null;
  let prevRevealed = false;
  let prevLotteryInProgress = false;
  let revealAnimating = false;

  function render(state) {
    if (!state) return;
    renderBoard(state);
    renderControls(state);
    renderPickPanel(state);
    renderResults(state);
  }
  identityChangeListeners.push(() => render(latestState));

  function renderBoard(state) {
    dom.body.innerHTML = "";
    for (let r = 1; r <= maxRounds; r++) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = roundLabel(r);
      tr.appendChild(th);

      PARTICIPANTS.forEach(p => {
        const td = document.createElement("td");
        td.dataset.round = r;
        td.dataset.participant = p;

        const confirmedId = state.results[p][r - 1];
        if (confirmedId) {
          td.innerHTML = itemCellHTML(confirmedId);
          td.className = "cell-player";
        } else if (r !== state.round) {
          td.textContent = "";
          td.className = "cell-empty";
        } else {
          const isConflict = state.conflicts.some(c => c.participants.includes(p));
          if (state.revealed && !revealAnimating && state.bids[p] && !confirmedId) {
            td.innerHTML = itemCellHTML(state.bids[p], isConflict);
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
      dom.body.appendChild(tr);
    }
  }

  function renderControls(state) {
    if (state.status === "completed") {
      dom.statusBanner.hidden = false;
      dom.statusBanner.textContent = "ドラフト終了！お疲れ様でした。";
      dom.revealBtn.hidden = true;
      dom.lotteryBtn.hidden = true;
      dom.nextRoundBtn.hidden = true;
      dom.lotteryPanel.hidden = true;
      dom.waitPanel.hidden = true;
      dom.pickPanel.hidden = true;
      return;
    }

    const canReveal = state.pendingParticipants.length === 0 && !state.revealed;
    dom.revealBtn.hidden = state.revealed;
    dom.revealBtn.disabled = !canReveal;

    const hasConflict = state.revealed && !revealAnimating && state.conflicts.length > 0;
    const roundSettled = state.revealed && !revealAnimating && state.conflicts.length === 0;

    dom.lotteryBtn.hidden = !(hasConflict && !state.lotteryInProgress);
    dom.lotteryPanel.hidden = !state.lotteryInProgress;
    dom.nextRoundBtn.hidden = !roundSettled;
    if (roundSettled) {
      const isLastRound = state.round + 1 > state.maxRounds;
      dom.nextRoundBtn.textContent = isLastRound ? "結果を確定する" : "次の巡へ進む";
    }

    if (state.lotteryInProgress) {
      dom.statusBanner.hidden = true;
    } else if (hasConflict) {
      dom.statusBanner.hidden = false;
      dom.statusBanner.textContent = `指名が重複しました！（${state.conflicts.map(c => itemLabel(c.playerId)).join("、")}）抽選を行ってください。`;
    } else if (roundSettled) {
      dom.statusBanner.hidden = false;
      dom.statusBanner.textContent = `第${state.round}巡の指名が確定しました！`;
    } else {
      dom.statusBanner.hidden = true;
    }
  }

  function renderPickPanel(state) {
    if (state.status === "completed" || !myName) {
      dom.pickPanel.hidden = true; dom.waitPanel.hidden = true;
      return;
    }
    const iAmPending = state.pendingParticipants.includes(myName);
    const alreadyConfirmedThisRound = !!state.results[myName][state.round - 1];
    const myTurnToPick = iAmPending && !state.revealed;

    if (!myTurnToPick) {
      dom.pickPanel.hidden = true;
      const shouldWait = !state.revealed && !iAmPending && !alreadyConfirmedThisRound;
      dom.waitPanel.hidden = !shouldWait;
      if (shouldWait) {
        dom.waitMessage.textContent = "指名完了しました。他の参加者の入力をお待ちください。";
      }
      return;
    }

    dom.waitPanel.hidden = true;
    dom.pickPanel.hidden = false;
    if (dom.pickRoundNum) dom.pickRoundNum.textContent = state.round;

    const draftedIds = new Set(Object.keys(state.drafted));
    dom.itemSelect.innerHTML = "";
    const groups = {};
    let hasGroups = false;
    items.forEach(it => {
      if (draftedIds.has(it.id)) return;
      const key = it.sub || "__flat__";
      if (it.sub) hasGroups = true;
      groups[key] = groups[key] || [];
      groups[key].push(it);
    });

    if (hasGroups) {
      Object.keys(groups).sort().forEach(key => {
        const group = document.createElement("optgroup");
        group.label = key;
        groups[key].forEach(it => {
          const opt = document.createElement("option");
          opt.value = it.id;
          opt.textContent = displayName(it);
          group.appendChild(opt);
        });
        dom.itemSelect.appendChild(group);
      });
    } else {
      (groups.__flat__ || []).forEach(it => {
        const opt = document.createElement("option");
        opt.value = it.id;
        opt.textContent = displayName(it);
        dom.itemSelect.appendChild(opt);
      });
    }
  }

  function renderResults(state) {
    if (state.status !== "completed") {
      dom.resultsPanel.hidden = true;
      return;
    }
    dom.resultsPanel.hidden = false;
    dom.resultsGrid.innerHTML = "";
    PARTICIPANTS.forEach(p => {
      const card = document.createElement("div");
      card.className = "team-card";
      const h3 = document.createElement("h3");
      h3.textContent = p;
      card.appendChild(h3);
      const ol = document.createElement("ol");
      state.results[p].forEach(id => {
        const li = document.createElement("li");
        li.textContent = id ? itemLabel(id) : "-";
        ol.appendChild(li);
      });
      card.appendChild(ol);
      dom.resultsGrid.appendChild(card);
    });
  }

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

  function runRevealAnimation(state, onDone) {
    const order = PARTICIPANTS.filter(p => state.bids[p]);
    order.forEach((p, i) => {
      setTimeout(() => {
        const td = dom.body.querySelector(`td[data-round="${state.round}"][data-participant="${p}"]`);
        if (td) {
          const isConflict = state.conflicts.some(c => c.participants.includes(p));
          td.innerHTML = itemCellHTML(state.bids[p], isConflict);
          td.className = isConflict ? "cell-conflict" : "cell-player";
        }
      }, i * REVEAL_STEP_MS);
    });
    dom.lotteryAnim.innerHTML = "";
    setTimeout(onDone, order.length * REVEAL_STEP_MS + 200);
  }

  function runLotterySpinAnimation(state) {
    dom.lotteryAnim.innerHTML = "";
    state.conflicts.forEach(c => {
      const line = document.createElement("div");
      line.dataset.playerId = c.playerId;
      line.textContent = `${itemLabel(c.playerId)}: ${c.participants.join(" / ")}`;
      dom.lotteryAnim.appendChild(line);
    });

    const spinIntervalMs = 120;
    const spinTimer = setInterval(() => {
      state.conflicts.forEach(c => {
        const line = dom.lotteryAnim.querySelector(`div[data-player-id="${c.playerId}"]`);
        if (!line) return;
        const pick = c.participants[Math.floor(Math.random() * c.participants.length)];
        line.textContent = `${itemLabel(c.playerId)}: 🎲 ${pick} ？`;
      });
    }, spinIntervalMs);

    setTimeout(() => clearInterval(spinTimer), LOTTERY_SPIN_MS - 200);
  }

  function scheduleLotteryResolution() {
    setTimeout(resolveLottery, LOTTERY_SPIN_MS);
  }

  async function resolveLottery() {
    await db.runTransaction(async tx => {
      const snap = await tx.get(stateRef);
      const state = snap.data();
      if (!state.lotteryInProgress) return;

      const drafted = { ...state.drafted };
      const results = JSON.parse(JSON.stringify(state.results));
      const conflictItemIds = new Set(state.conflicts.map(c => c.playerId));

      Object.entries(state.bids).forEach(([name, id]) => {
        if (!conflictItemIds.has(id)) {
          drafted[id] = { participant: name, round: state.round };
          results[name][state.round - 1] = id;
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

  async function confirmRoundAndAdvance() {
    await db.runTransaction(async tx => {
      const snap = await tx.get(stateRef);
      const state = snap.data();
      if (!state.revealed || state.conflicts.length > 0) return;

      const drafted = { ...state.drafted };
      const results = JSON.parse(JSON.stringify(state.results));
      Object.entries(state.bids).forEach(([name, id]) => {
        drafted[id] = { participant: name, round: state.round };
        results[name][state.round - 1] = id;
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

  dom.revealBtn.addEventListener("click", async () => {
    await db.runTransaction(async tx => {
      const snap = await tx.get(stateRef);
      const state = snap.data();
      if (state.pendingParticipants.length > 0 || state.revealed) return;
      const byItem = {};
      Object.entries(state.bids).forEach(([name, id]) => {
        (byItem[id] = byItem[id] || []).push(name);
      });
      const conflicts = Object.entries(byItem)
        .filter(([, names]) => names.length > 1)
        .map(([id, names]) => ({ playerId: id, participants: names }));
      tx.update(stateRef, { revealed: true, conflicts });
    });
  });

  dom.nextRoundBtn.addEventListener("click", confirmRoundAndAdvance);

  dom.lotteryBtn.addEventListener("click", async () => {
    await db.runTransaction(async tx => {
      const snap = await tx.get(stateRef);
      const state = snap.data();
      if (!state.revealed || state.conflicts.length === 0 || state.lotteryInProgress) return;
      tx.update(stateRef, { lotteryInProgress: true });
    });
  });

  dom.pickBtn.addEventListener("click", () => {
    const itemId = dom.itemSelect.value;
    if (!itemId) return;
    const it = itemsById[itemId];
    showConfirm(`${displayName(it)}の指名で確定させますか？入力後の変更はできません。`, async () => {
      await db.runTransaction(async tx => {
        const snap = await tx.get(stateRef);
        const state = snap.data();
        if (!state.pendingParticipants.includes(myName)) return;
        if (state.drafted[itemId]) return;
        const bids = { ...state.bids, [myName]: itemId };
        const pendingParticipants = state.pendingParticipants.filter(n => n !== myName);
        tx.update(stateRef, { bids, pendingParticipants });
      });
    });
  });

  dom.resetBtn.addEventListener("click", () => {
    showConfirm("進行状況を全てリセットします。よろしいですか？", async () => {
      await stateRef.set(initialState());
    });
  });

  stateRef.get().then(snap => {
    if (!snap.exists) stateRef.set(initialState());
  });

  stateRef.onSnapshot(snap => {
    if (!snap.exists) return;
    const state = snap.data();
    handleTransitions(state);
    latestState = state;
    render(state);
  });
}

// ---------- instantiate both drafts ----------
createDraftController({
  collectionName: "draft",
  docId: "state",
  prefix: "player",
  items: window.PLAYERS_DATA.map(p => ({ id: p.id, name: p.name, sub: p.team, tag: p.tag })),
  maxRounds: 4,
  roundLabel: r => `${r}巡選択指名選手`,
});

createDraftController({
  collectionName: "draft",
  docId: "teamState",
  prefix: "team",
  items: window.TEAMS_DATA.map(t => ({ id: t.id, name: t.name })),
  maxRounds: 1,
  roundLabel: r => `${r}巡選択指名チーム`,
});
