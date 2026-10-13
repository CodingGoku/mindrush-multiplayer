
require("dotenv").config();

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
const TOTAL_ROUNDS = 8;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const MAX_GENERATION_ATTEMPTS = 3;
const MAX_RECENT_QUESTIONS = 200;
const RECENT_QUESTIONS_IN_PROMPT = 80;

const CATEGORIES = [
  "Everyday Knowledge",
  "General Knowledge",
  "Science & Nature",
  "Technology",
  "Mixed Trivia"
];

const recentQuestionTexts = [];

function normalizeQuestion(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rememberQuestions(questions) {
  for (const question of questions) {
    const normalized = normalizeQuestion(question.q);

    if (!normalized) continue;

    const existingIndex = recentQuestionTexts.indexOf(normalized);

    if (existingIndex !== -1) {
      recentQuestionTexts.splice(existingIndex, 1);
    }

    recentQuestionTexts.push(normalized);
  }

  while (recentQuestionTexts.length > MAX_RECENT_QUESTIONS) {
    recentQuestionTexts.shift();
  }
}

function getRecentQuestionsForPrompt() {
  return recentQuestionTexts
    .slice(-RECENT_QUESTIONS_IN_PROMPT)
    .map(question => `- ${question}`)
    .join("\n");
}

function normalizeCategory(category) {
  if (typeof category !== "string") return null;

  return (
    CATEGORIES.find(
      allowed => allowed.toLowerCase() === category.trim().toLowerCase()
    ) || null
  );
}

/* Generate a fresh quiz using Groq. */

async function generateQuizQuestions() {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is missing from your .env file.");
  }

  let lastError;

  for (
    let attempt = 1;
    attempt <= MAX_GENERATION_ATTEMPTS;
    attempt++
  ) {
    try {
      console.log(
        `[GROQ] Generating quiz (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS})...`
      );

      const quizSeed = crypto.randomBytes(8).toString("hex");
      const recentQuestions = getRecentQuestionsForPrompt();

      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            model: GROQ_MODEL,
            temperature: 1,
            max_completion_tokens: 4000,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `You create engaging, accurate multiplayer trivia quizzes.

Create varied questions that feel fresh rather than formulaic.
Use accurate, unambiguous facts.
Follow the requested JSON schema exactly.
Do not invent facts or explanations.
Never repeat a question from the supplied recent-question list.`
              },
              {
                role: "user",
                content: `Generate exactly ${TOTAL_ROUNDS} original multiple-choice questions for a casual multiplayer quiz.

Quiz seed: ${quizSeed}

Categories to choose from:
- Everyday Knowledge
- General Knowledge
- Science & Nature
- Technology
- Mixed Trivia

Requirements:
- Select exactly one listed category for each question.
- Include a balanced variety of categories in this quiz.
- Use easy and medium difficulty.
- Prefer surprising but useful facts, practical knowledge, and interesting everyday questions.
- Avoid overly common examples and repetitive question patterns.
- Do not ask multiple questions about the same fact or concept.
- Avoid repeating questions from previous games.
- Do not repeat a previous question merely by changing its wording.
- Avoid using the same question structure repeatedly.
- Vary the subjects, wording, and types of knowledge tested.
- Keep each question short enough to answer in 15 seconds.
- Provide exactly four distinct, non-empty choices per question.
- Ensure exactly one choice is objectively correct.
- Randomize the position of the correct answer.
- The answer field must contain the zero-based correct-choice index: 0, 1, 2, or 3.
- Include an accurate explanation of the correct answer in 1–2 concise sentences.
- Do not use the same correct-answer position for every question.

Previously used questions. Do not repeat these or their underlying facts where practical:
${recentQuestions || "(No previous questions recorded yet.)"}

Return valid JSON only, in this structure:
{
  "questions": [
    {
      "category": "Science & Nature",
      "q": "Question text?",
      "choices": ["Option A", "Option B", "Option C", "Option D"],
      "answer": 0,
      "explanation": "Brief explanation of the correct answer."
    }
  ]
}

Return exactly ${TOTAL_ROUNDS} questions.
Use only the five listed categories.
Every question must have four distinct choices and a non-empty explanation.
Do not include markdown or text outside the JSON.`
              }
            ]
          })
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `Groq HTTP ${response.status}: ${responseText.slice(0, 500)}`
        );
      }

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error("Groq returned an invalid API response.");
      }

      const content = data.choices?.[0]?.message?.content;

      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Groq returned an empty response.");
      }

      let parsed;

      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error("Groq returned invalid quiz JSON.");
      }

      const questions = parsed.questions;

      if (
        !Array.isArray(questions) ||
        questions.length !== TOTAL_ROUNDS
      ) {
        throw new Error(
          `Groq must return exactly ${TOTAL_ROUNDS} questions.`
        );
      }

      const seenQuestions = new Set();
      const recentQuestionsSet = new Set(recentQuestionTexts);

      const result = questions.map((question, index) => {
        const category = normalizeCategory(question?.category);

        const valid =
          question &&
          typeof question.q === "string" &&
          question.q.trim().length > 0 &&
          question.q.trim().length <= 300 &&
          category !== null &&
          Array.isArray(question.choices) &&
          question.choices.length === 4 &&
          question.choices.every(
            choice =>
              typeof choice === "string" &&
              choice.trim().length > 0 &&
              choice.trim().length <= 200
          ) &&
          new Set(
            question.choices.map(choice =>
              choice.trim().toLowerCase()
            )
          ).size === 4 &&
          Number.isInteger(question.answer) &&
          question.answer >= 0 &&
          question.answer <= 3 &&
          typeof question.explanation === "string" &&
          question.explanation.trim().length > 0 &&
          question.explanation.trim().length <= 1000;

        if (!valid) {
          throw new Error(
            `Invalid generated question at position ${index + 1}.`
          );
        }

        const normalized = normalizeQuestion(question.q);

        if (seenQuestions.has(normalized)) {
          throw new Error("Groq generated duplicate questions.");
        }

        if (recentQuestionsSet.has(normalized)) {
          throw new Error(
            `Question repeated from a previous game: "${question.q.trim()}"`
          );
        }

        seenQuestions.add(normalized);

        return {
          q: question.q.trim(),
          category,
          choices: question.choices.map(choice => choice.trim()),
          answer: question.answer,
          explanation: question.explanation.trim()
        };
      });

      console.log(
        `[GROQ] Successfully generated ${result.length} questions.`
      );

      console.log(
        "[GROQ] Categories:",
        result.map(question => question.category).join(", ")
      );

      console.log("[GROQ] First generated question:", result[0].q);
      console.log(
        "[GROQ] First generated explanation:",
        result[0].explanation
      );

      return result;
    } catch (error) {
      lastError = error;

      console.error(
        `[GROQ] Attempt ${attempt} failed:`,
        error.message
      );

      if (attempt < MAX_GENERATION_ATTEMPTS) {
        console.log("[GROQ] Retrying with a fresh generation request...");
      }
    }
  }

  throw new Error(
    `Quiz generation failed after ${MAX_GENERATION_ATTEMPTS} attempts. ${
      lastError?.message || "Unknown error."
    }`
  );
}

function generateRoomCode() {
  let value;

  do {
    value = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(value));

  return value;
}

/* Only reveal the correct answer during the result phase. */

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,

    players: [...room.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      answered: !!player.answered
    })),

    round: room.round,
    totalRounds: room.totalRounds,
    deadline: room.deadline,
    generating: room.generating,

    question:
      room.phase === "question" && room.current
        ? {
            q: room.current.q,
            choices: room.current.choices,
            category: room.current.category,
            answerCount: [...room.players.values()].filter(
              player => player.answered
            ).length
          }
        : null,

    result: room.phase === "result" ? room.result : null,

    winner:
      room.phase === "finished"
        ? [...room.players.values()].sort(
            (a, b) => b.score - a.score
          )[0]?.name
        : null
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicRoom(room));
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

/* FIX: Save, log, and broadcast the explanation with the round result. */

function finishRound(room) {
  if (room.phase !== "question") return;

  clearTimer(room);
  room.phase = "result";

  const explanation = String(
    room.current?.explanation || ""
  ).trim();

  room.result = {
    answer: room.current.answer,
    explanation:
      explanation ||
      "An explanation was not provided for this question.",
    standings: [...room.players.values()]
      .sort((a, b) => b.score - a.score)
      .map(player => ({
        name: player.name,
        score: player.score,
        answered: !!player.answered,
        correct: player.lastCorrect === true
      }))
  };

  console.log("[ROUND] Finished:", room.code, room.round);
  console.log("[DEBUG] Sending round explanation:", room.result.explanation);

  broadcast(room);

  room.timer = setTimeout(() => {
    nextRound(room);
  }, 4500);
}

function nextRound(room) {
  clearTimer(room);

  if (room.round >= room.totalRounds) {
    room.phase = "finished";
    room.current = null;
    room.deadline = null;

    console.log("[GAME] Finished:", room.code);
    broadcast(room);
    return;
  }

  if (
    !Array.isArray(room.questions) ||
    room.questions.length !== room.totalRounds
  ) {
    console.error("[GAME] No valid generated quiz for:", room.code);

    room.phase = "lobby";
    room.current = null;
    room.deadline = null;
    room.questions = [];

    broadcast(room);
    return;
  }

  room.round += 1;
  room.current = room.questions[room.round - 1];
  room.phase = "question";
  room.deadline = Date.now() + ROUND_SECONDS * 1000;
  room.result = null;

  for (const player of room.players.values()) {
    player.answered = false;
    player.lastCorrect = null;
  }

  console.log("[ROUND] Starting:", {
    room: room.code,
    round: room.round,
    question: room.current.q
  });

  broadcast(room);

  room.timer = setTimeout(() => {
    finishRound(room);
  }, ROUND_SECONDS * 1000);
}

async function startGame(room) {
  if (room.players.size < 2) {
    return {
      error: "Invite at least one more player before starting."
    };
  }

  if (room.phase !== "lobby") {
    return { error: "The game is not in the lobby." };
  }

  if (room.generating) {
    return {
      error: "Questions are already being generated. Please wait."
    };
  }

  room.generating = true;
  broadcast(room);

  try {
    const questions = await generateQuizQuestions();

    if (rooms.get(room.code) !== room) {
      return { error: "This room no longer exists." };
    }

    if (room.phase !== "lobby") {
      return { error: "The game is no longer in the lobby." };
    }

    if (room.players.size < 2) {
      return { error: "At least two players are required." };
    }

    rememberQuestions(questions);

    room.questions = questions;
    room.round = 0;
    room.totalRounds = TOTAL_ROUNDS;
    room.current = null;
    room.result = null;
    room.deadline = null;

    for (const player of room.players.values()) {
      player.score = 0;
      player.answered = false;
      player.lastCorrect = null;
    }

    console.log("[GAME] Starting with Groq quiz:", room.code);

    nextRound(room);

    return { ok: true };
  } catch (error) {
    console.error("[GROQ] Could not generate quiz:", error.message);

    room.questions = [];
    room.current = null;
    room.round = 0;
    room.phase = "lobby";
    room.deadline = null;

    return {
      error:
        "Groq could not generate a valid quiz. Check the server terminal and try again."
    };
  } finally {
    room.generating = false;

    if (rooms.get(room.code) === room) {
      broadcast(room);
    }
  }
}

function leave(socket) {
  const roomCode = socket.data.roomCode;

  if (!roomCode) return;

  const room = rooms.get(roomCode);

  socket.leave(roomCode);
  socket.data.roomCode = null;

  if (!room) return;

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    clearTimer(room);
    rooms.delete(roomCode);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  broadcast(room);
}

io.on("connection", socket => {
  console.log("[SOCKET] Connected:", socket.id);

  socket.on("createRoom", ({ name } = {}, cb) => {
    const reply = typeof cb === "function" ? cb : () => {};

    try {
      name = String(name || "").trim().slice(0, 18);

      if (!name) {
        return reply({ error: "Enter a display name first." });
      }

      if (socket.data.roomCode) {
        return reply({ error: "Leave your current room first." });
      }

      const roomCode = generateRoomCode();

      const room = {
        code: roomCode,
        hostId: socket.id,
        players: new Map(),
        phase: "lobby",
        round: 0,
        totalRounds: TOTAL_ROUNDS,
        current: null,
        questions: [],
        result: null,
        deadline: null,
        timer: null,
        generating: false
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

      reply({ ok: true, code: roomCode });
      broadcast(room);
    } catch (error) {
      console.error("[ERROR] createRoom:", error);
      reply({ error: "Could not create the room." });
    }
  });

  socket.on("joinRoom", ({ name, code: rawCode } = {}, cb) => {
    const reply = typeof cb === "function" ? cb : () => {};

    try {
      name = String(name || "").trim().slice(0, 18);

      const roomCode = String(rawCode || "").trim().toUpperCase();
      const room = rooms.get(roomCode);

      if (!name) {
        return reply({ error: "Enter your name first." });
      }

      if (!room) {
        return reply({ error: "Room not found. Check the code." });
      }

      if (socket.data.roomCode) {
        return reply({
          error: "Leave your current room before joining another."
        });
      }

      if (room.players.size >= MAX_PLAYERS) {
        return reply({
          error: "This room is full (8 players maximum)."
        });
      }

      if (room.phase !== "lobby" || room.generating) {
        return reply({
          error: "This game is already starting or has started."
        });
      }

      if (
        [...room.players.values()].some(
          player => player.name.toLowerCase() === name.toLowerCase()
        )
      ) {
        return reply({
          error: "That name is already in this room."
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

      reply({ ok: true, code: roomCode });
      broadcast(room);
    } catch (error) {
      console.error("[ERROR] joinRoom:", error);
      reply({ error: "Could not join the room." });
    }
  });

  socket.on("startGame", async (_payload, cb) => {
    const reply = typeof cb === "function" ? cb : () => {};
    const room = rooms.get(socket.data.roomCode);

    if (!room) {
      return reply({ error: "Room not found." });
    }

    if (room.hostId !== socket.id) {
      return reply({ error: "Only the host can start the game." });
    }

    try {
      console.log("[GAME] Start button clicked:", socket.id);

      const result = await startGame(room);
      reply(result);
    } catch (error) {
      console.error("[GAME] Start handler failed:", error);
      reply({
        error: "Could not start the game. Check the server terminal."
      });
    }
  });

  socket.on("answer", ({ choice } = {}, cb) => {
    const reply = typeof cb === "function" ? cb : () => {};

    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room?.players.get(socket.id);

      if (!room || !player || room.phase !== "question") {
        return reply({
          error: "This round is not accepting answers."
        });
      }

      if (player.answered) {
        return reply({
          error: "You have already answered this round."
        });
      }

      if (Date.now() >= room.deadline) {
        finishRound(room);
        return reply({ error: "Time is up." });
      }

      const answer = Number(choice);

      if (
        !Number.isInteger(answer) ||
        answer < 0 ||
        answer >= room.current.choices.length
      ) {
        return reply({ error: "Invalid answer." });
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

      broadcast(room);
      reply({ ok: true });

      if ([...room.players.values()].every(p => p.answered)) {
        finishRound(room);
      }
    } catch (error) {
      console.error("[ERROR] answer:", error);
      reply({ error: "Could not submit your answer." });
    }
  });

  socket.on("playAgain", (_payload, cb) => {
    const reply = typeof cb === "function" ? cb : () => {};
    const room = rooms.get(socket.data.roomCode);

    if (!room) {
      return reply({ error: "Room not found." });
    }

    if (room.hostId !== socket.id) {
      return reply({
        error: "Only the host can start another game."
      });
    }

    if (room.phase !== "finished") {
      return reply({
        error: "The current game has not finished."
      });
    }

    clearTimer(room);

    for (const player of room.players.values()) {
      player.score = 0;
      player.answered = false;
      player.lastCorrect = null;
    }

    room.phase = "lobby";
    room.round = 0;
    room.current = null;
    room.questions = [];
    room.result = null;
    room.deadline = null;
    room.generating = false;

    broadcast(room);
    reply({ ok: true });
  });

  socket.on("leaveRoom", () => leave(socket));

  socket.on("disconnect", reason => {
    console.log("[SOCKET] Disconnected:", socket.id, reason);
    leave(socket);
  });
});

server.listen(PORT, () => {
  console.log(`MindRush running on port ${PORT}`);
  console.log(`[GROQ] Model configured: ${GROQ_MODEL}`);
});
