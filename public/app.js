const socket = io();
const $ = id => document.getElementById(id);
const views = ["home","lobby-view","question-view","result-view","finished-view"];
let myId = null, currentState = null, lastPhase = null, timerInterval = null, toastTimeout = null;
const letters = ["A","B","C","D"];
socket.on("connect", () => { myId = socket.id; });
socket.on("state", state => { currentState = state; render(state); });
socket.on("disconnect", () => showToast("Connection lost. Trying to reconnect…"));
socket.on("connect_error", () => showToast("Could not connect to the game server. Refresh and try again."));

function showToast(message) {
  const el = $("toast"); el.textContent = message; el.classList.remove("hidden");
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.classList.add("hidden"), 3000);
}
function showNotice(message) {
  const el = $("notice"); el.textContent = message; el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}
function setMainView(inGame) { $("home").classList.toggle("hidden", inGame); $("game").classList.toggle("hidden", !inGame); }
function call(event, payload) {
  socket.emit(event, payload, response => {
    if (response?.error) { showNotice(response.error); showToast(response.error); }
  });
}
$("create-form").addEventListener("submit", e => {
  e.preventDefault(); const name = $("host-name").value.trim();
  socket.emit("createRoom", {name}, response => {
    if (response?.error) return showToast(response.error);
    if (response?.ok) { setMainView(true); $("room-code-display").textContent = response.code; }
  });
});
$("join-form").addEventListener("submit", e => {
  e.preventDefault(); const name = $("join-name").value.trim(), code = $("room-code").value.trim().toUpperCase();
  socket.emit("joinRoom", {name, code}, response => {
    if (response?.error) return showToast(response.error);
    if (response?.ok) { setMainView(true); $("room-code-display").textContent = response.code; }
  });
});
$("room-code").addEventListener("input", e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6));
$("copy-code").addEventListener("click", async () => {
  if (!currentState) return;
  const invite = `${location.origin}/?room=${currentState.code}`;
  try { await navigator.clipboard.writeText(invite); showToast("Invite link copied!"); }
  catch { showToast(`Share room code: ${currentState.code}`); }
});
const params = new URLSearchParams(location.search);
if (params.has("room")) $("room-code").value = params.get("room").toUpperCase();

$("start-btn").addEventListener("click", () => call("startGame", {}));
$("again-btn").addEventListener("click", () => call("playAgain", {}));
$("leave-btn").addEventListener("click", () => {
  socket.emit("leaveRoom"); currentState = null; lastPhase = null;
  if (timerInterval) clearInterval(timerInterval);
  setMainView(false); $("notice").classList.add("hidden");
});
function escapeText(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function renderPlayers(players, hostId) {
  return players.map((p,i) => `<div class="player-card"><div class="avatar" style="background:${["#29213f","#17353d","#3a2b28","#27304a","#3a2942","#25392f","#403321","#253b47"][i%8]}">${escapeText(p.name.slice(0,1).toUpperCase())}</div><div style="min-width:0"><div class="player-name">${escapeText(p.name)}</div><div class="host-tag">${p.id===hostId?"✦ HOST":"PLAYER"}</div></div></div>`).join("");
}
function renderStandings(players, hostId, detailed=false) {
  return [...players].sort((a,b)=>b.score-a.score).map((p,i) => `<div class="standing"><span class="rank">${String(i+1).padStart(2,"0")}</span><div class="standing-name">${escapeText(p.name)}${detailed?`<div class="standing-sub">${p.answered?(p.correct?"✓ Correct answer":"✕ Not quite"):"No answer"}</div>`:""}</div><span class="standing-score">${p.score.toLocaleString()} <small>PTS</small></span></div>`).join("");
}
function render(state) {
  setMainView(true); $("room-code-display").textContent = state.code;
  const isHost = socket.id === state.hostId;
  $("lobby-view").classList.toggle("hidden", state.phase !== "lobby");
  $("question-view").classList.toggle("hidden", state.phase !== "question");
  $("result-view").classList.toggle("hidden", state.phase !== "result");
  $("finished-view").classList.toggle("hidden", state.phase !== "finished");
  if (state.phase === "lobby") {
    $("player-count").textContent = `${state.players.length} / 8`;
    $("lobby-players").innerHTML = renderPlayers(state.players,state.hostId);
    $("start-btn").disabled = !isHost || state.players.length < 2;
    $("start-btn").innerHTML = isHost ? (state.players.length < 2 ? "Waiting for one more player…" : 'Start the brain battle <span>↗</span>') : "Waiting for host to start…";
    $("host-hint").textContent = isHost ? "Everyone here? Start whenever you're ready." : "The host will start the game when everyone is ready.";
  }
  if (state.phase === "question") {
    if (lastPhase !== "question" || state.round !== currentState?.round) lastPhase = "question";
    $("category-chip").textContent = state.question.category;
    $("round-label").textContent = `ROUND ${state.round} / ${state.totalRounds}`;
    $("question-text").textContent = state.question.q;
    $("answer-progress").textContent = `${state.question.answerCount} / ${state.players.length} players answered`;
    const me = state.players.find(p => p.id === socket.id);
    $("answers").innerHTML = state.question.choices.map((choice,i) => `<button class="answer-btn ${me?.answered?"":" "}" data-choice="${i}" ${me?.answered?"disabled":""}><span class="answer-letter">${letters[i]}</span><span>${escapeText(choice)}</span></button>`).join("");
    $("answers").querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
      $("answers").querySelectorAll("button").forEach(b => b.disabled = true);
      btn.classList.add("selected"); call("answer", {choice:Number(btn.dataset.choice)});
    }));
    updateTimer(state.deadline);
  } else if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (state.phase === "result") {
    $("result-title").textContent = "And the answer is…";
    $("result-copy").textContent = state.question ? "" : "Nice work — here's how that round shook out.";
    const question = currentState?.question;
    // Correct option is available in the result payload; choices are retained client-side below.
    const correct = state.result?.answer ?? -1;
    const cachedChoices = window.lastChoices || [];
    $("result-answers").innerHTML = cachedChoices.map((choice,i) => `<div class="result-option ${i===correct?"correct":""}">${letters[i]}. ${escapeText(choice)} ${i===correct?"✓":""}</div>`).join("");
    $("result-standings").innerHTML = renderStandings(state.result?.standings || state.players,state.hostId,true);
  }
  if (state.phase === "finished") {
    $("winner-title").textContent = state.winner ? `${state.winner} takes the crown!` : "Game complete!";
    $("final-standings").innerHTML = renderStandings(state.players,state.hostId);
    $("again-btn").classList.toggle("hidden",!isHost);
    $("again-hint").textContent = isHost ? "Start a fresh game with the same crew." : "Waiting for the host to run it back.";
  }
  if (state.phase === "question" && state.question) window.lastChoices = state.question.choices;
  if (state.phase === "result") {
    const resultState = state;
    // Re-render answer reveal using the previous question choices cached in the browser.
    const correct = resultState.result?.answer ?? -1;
    $("result-answers").innerHTML = (window.lastChoices || []).map((choice,i) => `<div class="result-option ${i===correct?"correct":""}">${letters[i]}. ${escapeText(choice)} ${i===correct?"✓":""}</div>`).join("");
  }
  lastPhase = state.phase;
}
function updateTimer(deadline) {
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => {
    const remaining = Math.max(0,(deadline-Date.now())/1000);
    $("timer-number").textContent = Math.ceil(remaining);
    $("timer-fill").style.width = `${Math.max(0,remaining/15*100)}%`;
    if (remaining <= 0) { clearInterval(timerInterval); timerInterval = null; }
  };
  tick(); timerInterval = setInterval(tick,100);
}
