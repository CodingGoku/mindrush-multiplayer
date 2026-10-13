const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "MindRush" });
});

const rooms = new Map();
const ROUND_SECONDS = 15;
const MAX_PLAYERS = 8;

const QUESTIONS = [
  { q: "Which planet is known as the Red Planet?", choices: ["Venus", "Mars", "Jupiter", "Mercury"], answer: 1, category: "SPACE" },
  { q: "What is the time complexity of binary search on a sorted array?", choices: ["O(n)", "O(log n)", "O(n²)", "O(1)"], answer: 1, category: "TECH" },
  { q: "Which is the largest ocean on Earth?", choices: ["Atlantic", "Indian", "Arctic", "Pacific"], answer: 3, category: "WORLD" },
  { q: "What does CPU stand for?", choices: ["Central Processing Unit", "Computer Power Utility", "Core Program User", "Central Print Unit"], answer: 0, category: "TECH" },
  { q: "How many sides does a hexagon have?", choices: ["Five", "Six", "Seven", "Eight"], answer: 1, category: "BRAIN" },
  { q: "Which gas do plants absorb from the atmosphere?", choices: ["Oxygen", "Nitrogen", "Carbon dioxide", "Hydrogen"], answer: 2, category: "SCIENCE" },
  { q: "What is the capital of Japan?", choices: ["Kyoto", "Osaka", "Tokyo", "Sapporo"], answer: 2, category: "WORLD" },
  { q: "Which data structure follows FIFO order?", choices: ["Stack", "Queue", "Tree", "Graph"], answer: 1, category: "TECH" },
  { q: "How many minutes are in 2.5 hours?", choices: ["120", "135", "150", "180"], answer: 2, category: "BRAIN" },
  { q: "Which is the closest star to Earth?", choices: ["Sirius", "Proxima Centauri", "The Sun", "Polaris"], answer: 2, category: "SPACE" },
  { q: "What is the chemical symbol for gold?", choices: ["Ag", "Au", "Gd", "Go"], answer: 1, category: "SCIENCE" },
  { q: "Which language runs natively in web browsers?", choices: ["C++", "Java", "JavaScript", "Rust"], answer: 2, category: "TECH" }
];

function code() {
  let value;

  do {
    value = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(value));

  return value;
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,

    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      answered: !!p.answered
    })),

    round: room.round,
    totalRounds: room.totalRounds,
    deadline: room.deadline,

    question: room.phase === "question"
      ? {
          q: room.current.q,
          choices: room.current.choices,
          category: room.current.category,
          answerCount: [...room.players.values()].filter(p => p.answered).length
        }
      : null,

    result: room.phase === "result" ? room.result : null,

    winner: room.phase === "finished"
      ? [...room.players.values()].sort((a, b) => b.score - a.score)[0]?.name
      : null
  };
}

function broadcast(room) {
  console.log("[STATE]", {
    room: room.code,
    phase: room.phase,
    round: room.round,
    players: room.players.size
  });

  io.to(room.code).emit("state", publicRoom(room));
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }

  room.timer = null;
}

function finishRound(room) {
  console.log("[ROUND] finishRound called:", {
    room: room.code,
    round: room.round,
    phase: room.phase
  });

  // Prevent duplicate transitions from the timer and answer handler.
  if (room.phase !== "question") {
    console.log("[ROUND] Ignored: round is not accepting answers.");
    return;
  }

  clearTimer(room);

  room.phase = "result";

  room.result = {
    answer: room.current.answer,
    explanation: "The correct answer is highlighted below.",
    standings: [...room.players.values()]
      .sort((a, b) => b.score - a.score)
      .map(p => ({
        name: p.name,
        score: p.score,
        answered: !!p.answered,
        correct: p.lastCorrect === true
      }))
  };

  console.log("[ROUND] Showing results:", {
    room: room.code,
    round: room.round
  });

  broadcast(room);

  room.timer = setTimeout(() => {
    console.log("[TIMER] Moving to next round:", {
      room: room.code,
      round: room.round,
      phase: room.phase
    });

    nextRound(room);
  }, 4500);
}

function nextRound(room) {
  clearTimer(room);

  console.log("[ROUND] nextRound called:", {
    room: room.code,
    currentRound: room.round,
    totalRounds: room.totalRounds,
    phase: room.phase
  });

  if (room.round >= room.totalRounds) {
    room.phase = "finished";

    console.log("[GAME] Finished:", room.code);

    broadcast(room);
    return;
  }

  // Increment exactly once per round.
  room.round++;

  const questionIndex =
    (room.questionOffset + room.round - 1) % QUESTIONS.length;

  room.current = QUESTIONS[questionIndex];
  room.phase = "question";
  room.deadline = Date.now() + ROUND_SECONDS * 1000;
  room.result = null;

  for (const player of room.players.values()) {
    player.answered = false;
    player.lastCorrect = null;
  }

  console.log("[ROUND] Starting question:", {
    room: room.code,
    round: room.round,
    questionIndex,
    question: room.current.q
  });

  broadcast(room);

  room.timer = setTimeout(() => {
    console.log("[TIMER] Question timer expired:", {
      room: room.code,
      round: room.round,
      phase: room.phase
    });

    finishRound(room);
  }, ROUND_SECONDS * 1000);
}

function startGame(room) {
  if (room.players.size < 2) {
    return {
      error: "Invite at least one more player before starting."
    };
  }

  // nextRound() increments this to Round 1.
  room.round = 0;
  room.totalRounds = 8;
  room.questionOffset = Math.floor(Math.random() * QUESTIONS.length);

  console.log("[GAME] Starting:", {
    room: room.code,
    players: room.players.size
  });

  nextRound(room);

  return {};
}

function leave(socket) {
  const roomCode = socket.data.roomCode;

  if (!roomCode) return;

  const room = rooms.get(roomCode);

  socket.leave(roomCode);
  socket.data.roomCode = null;

  if (!room) return;

  room.players.delete(socket.id);

  console.log("[PLAYER] Left:", {
    room: roomCode,
    remainingPlayers: room.players.size
  });

  if (room.players.size === 0) {
    clearTimer(room);
    rooms.delete(roomCode);
    console.log("[ROOM] Deleted:", roomCode);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  broadcast(room);
}

io.on("connection", socket => {
  console.log("[SOCKET] Connected:", socket.id);

  socket.on("createRoom", ({ name }, cb = () => {}) => {
    try {
      name = String(name || "").trim().slice(0, 18);

      if (!name) {
        return cb({ error: "Enter a display name first." });
      }

      const roomCode = code();

      const room = {
        code: roomCode,
        hostId: socket.id,
        players: new Map(),
        phase: "lobby",
        round: 0,
        totalRounds: 8,
        current: null,
        result: null,
        deadline: null,
        timer: null,
        questionOffset: 0
      };

      room.players.set(socket.id, {
        id: socket.id,
        name,
        score: 0,
        answered: false,
        lastCorrect: null
      });

      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.data.roomCode = roomCode;

      console.log("[ROOM] Created:", {
        room: roomCode,
        host: name
      });

      cb({ ok: true, code: roomCode });
      broadcast(room);
    } catch (error) {
      console.error("[ERROR] createRoom:", error);
      cb({ error: "Could not create the room. Please try again." });
    }
  });

  socket.on("joinRoom", ({ name, code: rawCode }, cb = () => {}) => {
    try {
      name = String(name || "").trim().slice(0, 18);

      const roomCode = String(rawCode || "").trim().toUpperCase();
      const room = rooms.get(roomCode);

      if (!name) {
        return cb({ error: "Enter a display name first." });
      }

      if (!room) {
        return cb({ error: "Room not found. Check the code and try again." });
      }

      if (room.players.size >= MAX_PLAYERS) {
        return cb({ error: "This room is full (8 players maximum)." });
      }

      if (room.phase !== "lobby") {
        return cb({ error: "This game has already started." });
      }

      if ([...room.players.values()].some(
        p => p.name.toLowerCase() === name.toLowerCase()
      )) {
        return cb({
          error: "That name is already in this room. Try another."
        });
      }

      room.players.set(socket.id, {
        id: socket.id,
        name,
        score: 0,
        answered: false,
        lastCorrect: null
      });

      socket.join(roomCode);
      socket.data.roomCode = roomCode;

      console.log("[PLAYER] Joined:", {
        room: roomCode,
        name,
        playerCount: room.players.size
      });

      cb({ ok: true, code: roomCode });
      broadcast(room);
    } catch (error) {
      console.error("[ERROR] joinRoom:", error);
      cb({ error: "Could not join the room. Please try again." });
    }
  });

socket.on("startGame", cb => {
  const reply = typeof cb === "function" ? cb : () => {};

  try {
    const room = rooms.get(socket.data.roomCode);

    if (!room) {
      return reply({ error: "Room not found." });
    }

    if (room.hostId !== socket.id) {
      return reply({ error: "Only the host can start the game." });
    }

    const result = startGame(room);

    if (result.error) {
      return reply(result);
    }

    reply({ ok: true });
  } catch (error) {
    console.error("[ERROR] startGame:", error);
    reply({ error: "Could not start the game." });
  }
});


  socket.on("answer", ({ choice }, cb = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room?.players.get(socket.id);

      console.log("[ANSWER] Received:", {
        socket: socket.id,
        room: room?.code,
        player: player?.name,
        phase: room?.phase,
        round: room?.round,
        choice
      });

      if (!room || !player || room.phase !== "question") {
        console.warn("[ANSWER] Rejected: room/player/phase check failed.");

        return cb({
          error: "This round is not accepting answers."
        });
      }

      if (player.answered) {
        console.warn("[ANSWER] Rejected: player already answered.", player.name);

        return cb({
          error: "You have already answered this round."
        });
      }

      if (Date.now() >= room.deadline) {
        console.warn("[ANSWER] Rejected: time is up.");

        finishRound(room);
        return cb({ error: "Time is up." });
      }

      const answer = Number(choice);

      if (
        !Number.isInteger(answer) ||
        answer < 0 ||
        answer >= room.current.choices.length
      ) {
        console.warn("[ANSWER] Rejected: invalid choice.", choice);

        return cb({ error: "Invalid answer." });
      }

      player.answered = true;
      player.lastCorrect = answer === room.current.answer;

      if (player.lastCorrect) {
        const secondsLeft = Math.max(
          0,
          (room.deadline - Date.now()) / 1000
        );

        player.score += 100 + Math.round(secondsLeft * 5);
      }

      console.log("[ANSWER] Processed:", {
        room: room.code,
        player: player.name,
        choice: answer,
        correct: player.lastCorrect,
        score: player.score
      });

      broadcast(room);

      cb({ ok: true });

      const allAnswered = [...room.players.values()]
        .every(p => p.answered);

      console.log("[ANSWER] All players answered:", allAnswered);

      if (allAnswered) {
        finishRound(room);
      }
    } catch (error) {
      console.error("[ERROR] answer handler:", error);
      cb({ error: "An internal error occurred while submitting your answer." });
    }
  });

  socket.on("playAgain", cb => {
    try {
      const room = rooms.get(socket.data.roomCode);

      if (!room) {
        return cb?.({ error: "Room not found." });
      }

      if (room.hostId !== socket.id) {
        return cb?.({
          error: "Only the host can start another game."
        });
      }

      if (room.phase !== "finished") {
        return cb?.({
          error: "The current game has not finished."
        });
      }

      for (const player of room.players.values()) {
        player.score = 0;
        player.answered = false;
        player.lastCorrect = null;
      }

      room.phase = "lobby";
      room.round = 0;
      room.current = null;
      room.result = null;
      room.deadline = null;

      console.log("[GAME] Play again:", room.code);

      broadcast(room);
      cb?.({ ok: true });
    } catch (error) {
      console.error("[ERROR] playAgain:", error);
      cb?.({ error: "Could not restart the game." });
    }
  });

  socket.on("leaveRoom", () => leave(socket));

  socket.on("disconnect", reason => {
    console.log("[SOCKET] Disconnected:", {
      socket: socket.id,
      reason
    });

    leave(socket);
  });
});

server.listen(PORT, () => {
  console.log(`MindRush running on port ${PORT}`);
});
