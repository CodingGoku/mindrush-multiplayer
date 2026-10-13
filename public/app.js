
const socket = io();
const $ = id => document.getElementById(id);

let myId = null;
let currentState = null;
let lastPhase = null;
let timerInterval = null;
let toastTimeout = null;
let noticeTimeout = null;
let myAnswer = null;
let lastRound = null;
let startRequestPending = false;
let startRequestTimeout = null;

const letters = ["A", "B", "C", "D"];
const ROUND_SECONDS = 15;

socket.on("connect", () => {
  myId = socket.id;
});

socket.on("state", state => {
  console.log("[DEBUG] State received:", {
    phase: state.phase,
    round: state.round,
    hasResult: !!state.result,
    explanation: state.result?.explanation
  });

  currentState = state;
  render(state);
});

socket.on("disconnect", () => {
  showToast("Connection lost. Trying to reconnect…");
});

socket.on("connect_error", error => {
  console.error("[SOCKET] Connection error:", error);
  showToast("Could not connect to the game server. Refresh and try again.");
});

function showToast(message) {
  const el = $("toast");
  if (!el) return;

  el.textContent = message;
  el.classList.remove("hidden");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.classList.add("hidden");
  }, 3000);
}

function showNotice(message) {
  const el = $("notice");
  if (!el) {
    showToast(message);
    return;
  }

  el.textContent = message;
  el.classList.remove("hidden");

  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => {
    el.classList.add("hidden");
  }, 4000);
}

function setMainView(inGame) {
  $("home").classList.toggle("hidden", inGame);
  $("game").classList.toggle("hidden", !inGame);
}

function call(event, payload = {}) {
  socket.emit(event, payload, response => {
    if (response?.error) {
      showNotice(response.error);
      showToast(response.error);
    }
  });
}

/* Create room */

$("create-form").addEventListener("submit", e => {
  e.preventDefault();

  const name = $("host-name").value.trim();

  if (!name) {
    showToast("Enter your name first.");
    return;
  }

  socket.emit("createRoom", { name }, response => {
    if (response?.error) {
      showToast(response.error);
      return;
    }

    if (response?.ok) {
      setMainView(true);
      $("room-code-display").textContent = response.code;
    }
  });
});

/* Join room */

$("join-form").addEventListener("submit", e => {
  e.preventDefault();

  const name = $("join-name").value.trim();
  const code = $("room-code").value.trim().toUpperCase();

  if (!name || !code) {
    showToast("Enter your name and room code.");
    return;
  }

  socket.emit("joinRoom", { name, code }, response => {
    if (response?.error) {
      showToast(response.error);
      return;
    }

    if (response?.ok) {
      setMainView(true);
      $("room-code-display").textContent = response.code;
    }
  });
});

$("room-code").addEventListener("input", e => {
  e.target.value = e.target.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
});

/* Copy invite link */

$("copy-code").addEventListener("click", async () => {
  if (!currentState) return;

  const invite = `${location.origin}/?room=${currentState.code}`;

  try {
    await navigator.clipboard.writeText(invite);
    showToast("Invite link copied!");
  } catch {
    showToast(`Share room code: ${currentState.code}`);
  }
});

const params = new URLSearchParams(location.search);

if (params.has("room")) {
  $("room-code").value = params.get("room")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/* Game controls */

function resetStartRequest() {
  startRequestPending = false;

  if (startRequestTimeout) {
    clearTimeout(startRequestTimeout);
    startRequestTimeout = null;
  }
}

$("start-btn").addEventListener("click", () => {
  if (startRequestPending || !currentState) return;
  if (currentState.phase !== "lobby") return;

  if (socket.id !== currentState.hostId) {
    showToast("Only the host can start the game.");
    return;
  }

  if (currentState.players.length < 2) {
    showToast("Invite at least one more player.");
    return;
  }

  if (currentState.generating) {
    showToast("Groq is already generating your quiz.");
    return;
  }

  startRequestPending = true;

  const button = $("start-btn");
  button.disabled = true;
  button.textContent = "Generating fresh questions…";

  console.log("[CLIENT] Requesting a new Groq quiz...");

  socket.emit("startGame", {}, response => {
    resetStartRequest();

    if (response?.error) {
      console.error("[CLIENT] Game start error:", response.error);
      showNotice(response.error);
      showToast(response.error);

      if (currentState?.phase === "lobby") {
        render(currentState);
      }

      return;
    }

    if (response?.ok) {
      console.log("[CLIENT] Game started successfully.");
    }
  });

  startRequestTimeout = setTimeout(() => {
    if (!startRequestPending) return;

    resetStartRequest();

    showToast(
      "The server did not respond. Check the terminal and try again."
    );

    if (currentState?.phase === "lobby") {
      render(currentState);
    }
  }, 35000);
});

$("again-btn").addEventListener("click", () => {
  call("playAgain", {});
});

$("leave-btn").addEventListener("click", () => {
  socket.emit("leaveRoom");

  resetStartRequest();

  currentState = null;
  lastPhase = null;
  myAnswer = null;
  lastRound = null;
  window.lastChoices = [];

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  setMainView(false);
  $("notice").classList.add("hidden");
});

/* Helpers */

function escapeText(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function renderPlayers(players, hostId) {
  const avatarColors = [
    "#29213f",
    "#17353d",
    "#3a2b28",
    "#27304a",
    "#3a2942",
    "#25392f",
    "#403321",
    "#253b47"
  ];

  return players.map((p, i) => `
    <div class="player-card">
      <div
        class="avatar"
        style="background:${avatarColors[i % avatarColors.length]}"
      >${escapeText((p.name || "?").slice(0, 1).toUpperCase())}</div>

      <div style="min-width:0">
        <div class="player-name">${escapeText(p.name)}</div>
        <div class="host-tag">
          ${p.id === hostId ? "✦ HOST" : "PLAYER"}
        </div>
      </div>
    </div>
  `).join("");
}

function renderStandings(players, hostId, detailed = false) {
  return [...(players || [])]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((p, i) => `
      <div class="standing">
        <span class="rank">${String(i + 1).padStart(2, "0")}</span>

        <div class="standing-name">
          ${escapeText(p.name)}
          ${
            detailed
              ? `<div class="standing-sub">${
                  p.answered
                    ? (p.correct ? "✓ Correct answer" : "✕ Not quite")
                    : "No answer"
                }</div>`
              : ""
          }
        </div>

        <span class="standing-score">
          ${(p.score || 0).toLocaleString()} <small>PTS</small>
        </span>
      </div>
    `).join("");
}

/*
 * Ensure the explanation element exists and is visible.
 * It is placed immediately before the answer choices.
 */

function showRoundExplanation(explanation) {
  const resultAnswers = $("result-answers");

  if (!resultAnswers || !resultAnswers.parentNode) {
    console.error("[DEBUG] Could not find #result-answers in the page.");
    return;
  }

  let explanationEl = $("result-copy");

  if (!explanationEl) {
    explanationEl = document.createElement("p");
    explanationEl.id = "result-copy";
  }

  // Move it into the correct location even if it already exists elsewhere.
  resultAnswers.parentNode.insertBefore(explanationEl, resultAnswers);

  explanationEl.textContent =
    String(explanation || "").trim() ||
    "An explanation was not provided for this question.";

  explanationEl.classList.remove("hidden");

  Object.assign(explanationEl.style, {
    display: "block",
    visibility: "visible",
    opacity: "1",
    position: "relative",
    color: "#d7d3e5",
    fontSize: "14px",
    lineHeight: "1.6",
    margin: "12px 0 20px",
    padding: "12px",
    background: "#211c32",
    borderRadius: "10px",
    height: "auto",
    maxHeight: "none",
    overflow: "visible"
  });

  console.log(
    "[DEBUG] Explanation displayed in results:",
    explanationEl.textContent
  );
}

/* Render the complete game state */

function render(state) {
  setMainView(true);

  $("room-code-display").textContent = state.code || "";

  const isHost = socket.id === state.hostId;

  $("lobby-view").classList.toggle("hidden", state.phase !== "lobby");
  $("question-view").classList.toggle("hidden", state.phase !== "question");
  $("result-view").classList.toggle("hidden", state.phase !== "result");
  $("finished-view").classList.toggle("hidden", state.phase !== "finished");

  /* Lobby */

  if (state.phase === "lobby") {
    $("player-count").textContent = `${state.players.length} / 8`;

    $("lobby-players").innerHTML = renderPlayers(
      state.players,
      state.hostId
    );

    const canStart =
      isHost &&
      state.players.length >= 2 &&
      !state.generating &&
      !startRequestPending;

    $("start-btn").disabled = !canStart;

    if (state.generating || startRequestPending) {
      $("start-btn").textContent = "Generating fresh questions…";
    } else if (!isHost) {
      $("start-btn").textContent = "Waiting for host to start…";
    } else if (state.players.length < 2) {
      $("start-btn").textContent = "Waiting for one more player…";
    } else {
      $("start-btn").innerHTML =
        'Start the brain battle <span>↗</span>';
    }

    $("host-hint").textContent = state.generating
      ? "Groq is creating a fresh quiz. This may take a few seconds."
      : isHost
        ? "Everyone here? Start whenever you're ready."
        : "The host will start the game when everyone is ready.";
  }

  /* Question */

  if (state.phase === "question" && state.question) {
    if (lastPhase !== "question" || state.round !== lastRound) {
      myAnswer = null;
      lastRound = state.round;
    }

    $("category-chip").textContent = state.question.category;
    $("round-label").textContent =
      `ROUND ${state.round} / ${state.totalRounds}`;

    $("question-text").textContent = state.question.q;

    $("answer-progress").textContent =
      `${state.question.answerCount} / ${state.players.length} players answered`;

    window.lastChoices = [...state.question.choices];

    const me = state.players.find(p => p.id === socket.id);

    $("answers").innerHTML = state.question.choices
      .map((choice, i) => `
        <button
          type="button"
          class="answer-btn ${myAnswer === i ? "selected" : ""}"
          data-choice="${i}"
          ${me?.answered || myAnswer !== null ? "disabled" : ""}
        >
          <span class="answer-letter">${letters[i]}</span>
          <span>${escapeText(choice)}</span>
        </button>
      `).join("");

    $("answers").querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        if (myAnswer !== null || btn.disabled) return;

        myAnswer = Number(btn.dataset.choice);

        $("answers").querySelectorAll("button").forEach(button => {
          button.disabled = true;
          button.classList.remove("selected");
        });

        btn.classList.add("selected");

        call("answer", { choice: myAnswer });
      });
    });

    updateTimer(state.deadline);
  } else if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  /* Round results */

  if (state.phase === "result" && state.result) {
    console.log("[DEBUG] Round result received:", state.result);
    console.log(
      "[DEBUG] Explanation received by client:",
      state.result.explanation
    );

    $("result-title").textContent = "And the answer is…";

    showRoundExplanation(state.result.explanation);

    const correct = Number(state.result.answer ?? -1);
    const cachedChoices = window.lastChoices || [];

    $("result-answers").innerHTML = cachedChoices
      .map((choice, i) => {
        const isCorrect = i === correct;
        const isMyWrongAnswer = myAnswer === i && !isCorrect;

        const classes = [
          "result-option",
          isCorrect ? "correct" : "",
          isMyWrongAnswer ? "wrong" : ""
        ].filter(Boolean).join(" ");

        const marker = isCorrect
          ? "✓"
          : isMyWrongAnswer
            ? "✕"
            : "";

        return `
          <div class="${classes}">
            <span>${letters[i]}. ${escapeText(choice)}</span>
            <span class="result-marker">${marker}</span>
          </div>
        `;
      })
      .join("");

    // Re-apply the explanation after rendering the answer choices.
    showRoundExplanation(state.result.explanation);

    $("result-standings").innerHTML = renderStandings(
      state.result.standings || state.players,
      state.hostId,
      true
    );
  }

  /* Final standings */

  if (state.phase === "finished") {
    $("winner-title").textContent = state.winner
      ? `${state.winner} takes the crown!`
      : "Game complete!";

    $("final-standings").innerHTML = renderStandings(
      state.players,
      state.hostId
    );

    $("again-btn").classList.toggle("hidden", !isHost);

    $("again-hint").textContent = isHost
      ? "Start a fresh game with the same crew."
      : "Waiting for the host to run it back.";
  }

  lastPhase = state.phase;
}

/* Question timer */

function updateTimer(deadline) {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  const tick = () => {
    const remaining = Math.max(0, (deadline - Date.now()) / 1000);

    $("timer-number").textContent = Math.ceil(remaining);

    $("timer-fill").style.width =
      `${Math.max(0, remaining / ROUND_SECONDS * 100)}%`;

    if (remaining <= 0 && timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  };

  tick();
  timerInterval = setInterval(tick, 100);
}
