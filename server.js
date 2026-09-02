const express = require('express');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COMPANY_NAMES = ['一连','二连','三连','四连','五连','六连','七连','八连','九连','十连','十一连','十二连','十三连','十四连'];

// ===================== GAME STATE =====================
let questions = {};
try {
  questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
} catch(e) { console.error('题目文件加载失败:', e.message); }

let state = createInitialState();

function createInitialState() {
  return {
    phase: 'idle',
    subPhase: null,
    currentQuestionIndex: 0,
    showAnswer: false,
    companies: COMPANY_NAMES.map((name, i) => ({
      id: i+1, name, score: 0, active: true, eliminated: false, disqualified: false, tiebreakerRank: null
    })),
    buzzer: { status: 'idle', buzzedTeamId: null, violations: [], countdownEnd: null, answerEnd: null, hardwareDecided: false, hardwareWinner: null, judgeResult: null },
    buzzerResults: {}, // { questionKey: { teamId, result } } questionKey = phase + ':' + currentQuestionIndex
    requiredAnswers: {},
    pk: { currentMatch: 0, scores: {}, questionResults: [] },
    bracket: { round2: null, round3: null, final: null },
    final: { selectionOrder: [], currentSelection: 0, selectedQuestions: [], teamAnswered: {}, pendingChampion: null, firstPicker: null, needsCoinToss: false, scores: {} },
    tiebreaker: { usedGroups: [], currentGroupIndex: null, scores: {}, cumulativeTbScores: {}, context: null, currentQuestionIndex: 0, teams: [], queue: [], currentGroupTeams: [], round: 0, rankOffset: 0, recursionDepth: 0, maxDepth: 2, allDone: false },
    buzzerTest: { status: 'idle', results: {}, countdownEnd: null, firstBuzzTeamId: null },
    introTarget: null,
    history: [],
    settings: {
      soundEnabled: true,
      soundSettings: { countdown: true, buzzer: true, violation: true, correct: true, wrong: true },
      buzzerTimeout: 10,
      answerTimeout: 3,
      dllAddress: '127.0.0.1',
      dllPort: 9999,
      dllCmdPort: 9998,
      dllConnected: false,
      shortcutsEnabled: true,
      // key_id -> team_id mapping: 一连=15号台, 二连=2号台, ..., 十四连=14号台
      keyIdMapping: { 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9, 10:10, 11:11, 12:12, 13:13, 14:14, 15:1 },
    },
  };
}

// ===================== STATE PERSISTENCE =====================
const STATE_FILE = path.join(__dirname, 'state.json');
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) { console.error('状态保存失败:', e.message); }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = Object.assign(createInitialState(), saved);
      console.log('已恢复上次状态');
    }
  } catch(e) { console.error('状态恢复失败:', e.message); }
}
loadState();

// ===================== HARDWARE EVENT LOG (PERSISTENT) =====================
// 所有硬件抢答事件持久化存储，作为权威证据
const LOGS_DIR = path.join(__dirname, 'buzzer_logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogFileName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `buzzer_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.log`;
}

function logHardwareEvent(eventType, data) {
  const timestamp = new Date().toISOString();
  const logEntry = JSON.stringify({
    ts: timestamp,
    timestamp_ms: Date.now(),
    event: eventType,
    data: data,
    question_index: state.currentQuestionIndex,
    phase: state.phase,
    buzzer_status: state.buzzer.status
  });
  const logFile = path.join(LOGS_DIR, getLogFileName());
  try {
    fs.appendFileSync(logFile, logEntry + '\n', 'utf8');
  } catch(e) {
    console.error('[硬件日志] 写入失败:', e.message);
  }
  console.log(`[硬件日志] ${eventType}: ${JSON.stringify(data)}`);
}

// ===================== WEBSOCKET =====================
function broadcast(type, data) {
  let msg;
  try { msg = JSON.stringify({ type, data }); }
  catch(e) { console.error('[WS] 序列化失败:', e.message); return; }
  // 转数组避免迭代时集合被修改
  const clients = Array.from(wss.clients);
  for (const c of clients) {
    if (c.readyState === 1) {
      try { c.send(msg); }
      catch(e) { console.error('[WS] 发送失败:', e.message); }
    }
  }
}
function broadcastState() {
  let stateWithQ;
  try {
    stateWithQ = { ...state, _currentQuestion: getCurrentQuestion(), _currentQuestions: questions };
  } catch(e) {
    console.error('[WS] 构造state失败:', e.message);
    return;
  }
  broadcast('state_sync', stateWithQ);
  try { saveState(); } catch(e) { console.error('[Save] 保存失败:', e.message); }
}
function logHistory(action, details) {
  try {
    state.history.push({ time: Date.now(), action, details });
    if (state.history.length > 100) state.history.shift();
  } catch(e) { console.error('[History] 记录失败:', e.message); }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  try {
    ws.send(JSON.stringify({ type: 'state_sync', data: { ...state, _currentQuestion: getCurrentQuestion(), _currentQuestions: questions } }));
  } catch(e) { console.error('[WS] 初始同步失败:', e.message); }
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => { console.log(`[WS] 连接错误: ${err.message}`); });
  ws.on('close', (code, reason) => { console.log(`[WS] 连接关闭: code=${code}, reason=${reason}`); });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    try {
      handleMessage(msg.type, msg.data, ws);
    } catch(e) {
      console.error('[WS] 消息处理异常:', e.message, e.stack);
      try { ws.send(JSON.stringify({ type: 'error', data: { message: '服务器内部错误' } })); } catch(_) {}
    }
  });
});

// WebSocket 心跳保活 — 每30秒ping一次，防止连接被中间设备断开
const heartbeatInterval = setInterval(() => {
  try {
    const clients = Array.from(wss.clients);
    for (const ws of clients) {
      if (ws.isAlive === false) {
        console.log('[WS] 心跳超时，终止连接');
        try { ws.terminate(); } catch(e) {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch(e) {}
    }
  } catch(e) { console.error('[WS] 心跳异常:', e.message); }
}, 30000);
wss.on('close', () => { clearInterval(heartbeatInterval); });

// 全局异常兜底，防止未捕获异常导致进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[FATAL] 未捕获异常:', err.message, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] 未处理的Promise拒绝:', reason?.message || reason);
});

// ===================== MESSAGE HANDLER =====================
function handleMessage(type, data) {
  switch(type) {
    case 'start_contest':
      state.phase = 'cover';
      logHistory('start_contest');
      broadcastState();
      break;
    case 'change_phase':
      state.phase = data.phase;
      if (data.subPhase !== undefined) state.subPhase = data.subPhase;
      state.currentQuestionIndex = 0;
      state.showAnswer = false;
      state.buzzer = createFreshBuzzerState();
      // 进入新阶段时清空必答题状态，避免状态残留
      state.requiredAnswers = {};
      // 进入抢答测试阶段时初始化所有队伍为黄色
      if (data.phase === 'buzzer_test') {
        state.buzzerTest = { status: 'idle', results: {}, countdownEnd: null, firstBuzzTeamId: null };
        state.companies.forEach(c => {
          state.buzzerTest.results[c.id] = { status: 'yellow', time: null };
        });
      }
      logHistory('change_phase', { phase: data.phase });
      broadcastState();
      break;
    case 'show_intro':
      state.introTarget = data.target || null;
      state.phase = 'intro';
      logHistory('show_intro', { target: data.target });
      broadcastState();
      break;
    case 'start_from_intro':
      if (state.phase !== 'intro' || !state.introTarget) return;
      const targetPhase = state.introTarget;
      state.introTarget = null;
      state.phase = targetPhase;
      state.currentQuestionIndex = 0;
      state.showAnswer = false;
      state.buzzer = createFreshBuzzerState();
      state.requiredAnswers = {};
      logHistory('start_from_intro', { target: targetPhase });
      broadcastState();
      break;
    case 'navigate':
      // 加赛阶段限制5题（0-4），不允许跳到第6题
      if (state.phase === 'tiebreaker' && data.index > 4) return;
      // PK阶段限制在当前场次题目范围内
      if (state.phase === 'round2_pk' || state.phase === 'round3_semifinal') {
        const matchQs = getPkQuestionsForCurrentMatch();
        if (data.index > matchQs.length - 1) return;
      }
      // 决赛阶段限制在题目范围内
      if (state.phase === 'round4_final' && data.index > (questions.round4_final || []).length - 1) return;
      // 必答/抢答阶段限制
      if (state.phase === 'round1_required' && data.index > (questions.round1_required || []).length - 1) return;
      if (state.phase === 'round1_buzzer' && data.index > (questions.round1_buzzer || []).length - 1) return;
      state.currentQuestionIndex = data.index;
      if (state.phase === 'tiebreaker') state.tiebreaker.currentQuestionIndex = data.index;
      state.showAnswer = false;
      clearBuzzerTimers();
      // 如果该题已判分，恢复判分状态
      {
        const qKey = getBuzzerQuestionKey();
        const stored = state.buzzerResults[qKey];
        if (stored) {
          state.buzzer = {
            status: 'judged',
            buzzedTeamId: stored.teamId,
            violations: [],
            countdownEnd: null,
            answerEnd: null,
            hardwareDecided: false,
            hardwareWinner: null,
            judgeResult: stored.result
          };
        } else {
          state.buzzer = createFreshBuzzerState();
        }
      }
      logHistory('navigate', { index: data.index });
      broadcastState();
      break;
    case 'toggle_answer':
      state.showAnswer = !state.showAnswer;
      logHistory('toggle_answer', { show: state.showAnswer });
      broadcastState();
      break;
    case 'buzzer_start':
      handleBuzzerStart();
      break;
    case 'buzzer_reopen':
      handleBuzzerReopen();
      break;
    case 'buzzer_manual':
      handleBuzzerManual(data.teamId);
      break;
    case 'buzzer_judge':
      handleBuzzerJudge(data.result);
      break;
    case 'buzzer_violation':
      handleBuzzerViolation(data.teamId);
      break;
    case 'buzzer_cancel':
      clearBuzzerTimers();
      if (state.settings.dllConnected) sendBuzzerCommand('rush_stop').catch(() => {});
      if (state.buzzer.status === 'counting') {
        // 倒计时阶段取消 —— 完全重置
        state.buzzer = createFreshBuzzerState();
        logHardwareEvent('buzzer_cancel', { phase: 'counting' });
      } else {
        // 答题阶段取消 —— 重置为开放状态，保留违规记录
        state.buzzer.status = 'open';
        state.buzzer.buzzedTeamId = null;
        state.buzzer.hardwareDecided = false;
        state.buzzer.hardwareWinner = null;
        state.buzzer.answerEnd = Date.now() + state.settings.buzzerTimeout * 1000;
        logHardwareEvent('buzzer_cancel', { phase: 'buzzed' });
        if (state.settings.buzzerTimeout > 0) {
          buzzerSkipTimer = setTimeout(() => {
            buzzerSkipTimer = null;
            if (state.buzzer.status === 'open' && !state.buzzer.hardwareDecided) {
              state.buzzer.status = 'timeout';
              broadcastState();
            }
          }, state.settings.buzzerTimeout * 1000);
        }
      }
      broadcastState();
      break;
    case 'buzzer_skip':
      handleBuzzerSkip();
      break;
    case 'buzzer_confirm_timeout':
      handleBuzzerConfirmTimeout();
      break;
    case 'buzzer_test_start':
      handleBuzzerTestStart();
      break;
    case 'buzzer_test_reset':
      handleBuzzerTestReset();
      break;
    case 'required_answer':
      handleRequiredAnswer(data.teamId, data.result);
      break;
    case 'required_batch':
      data.results.forEach(r => handleRequiredAnswer(r.teamId, r.result, false));
      broadcastState();
      break;
    case 'required_clear':
      { const q = getCurrentQuestion();
      const clearPoints = q ? q.points : 10;
      const currentQAnswers = state.requiredAnswers[state.currentQuestionIndex] || {};
      for (const [teamId, result] of Object.entries(currentQAnswers)) {
        const team = state.companies.find(c => c.id === parseInt(teamId));
        if (!team) continue;
        if (result === 'correct') team.score -= clearPoints;
        else if (result === 'violation') team.score += clearPoints;
      }
      delete state.requiredAnswers[state.currentQuestionIndex];
      logHistory('required_clear', { qIndex: state.currentQuestionIndex });
      broadcastState();
      break; }
    case 'score_update':
      handleScoreUpdate(data.teamId, data.delta, data.reason);
      break;
    case 'score_set':
      { const c = state.companies.find(c => c.id === data.teamId);
        if (c) { c.score = data.score; logHistory('score_set', { team: c.name, score: data.score }); broadcastState(); } }
      break;
    case 'team_status':
      { const c = state.companies.find(c => c.id === data.teamId);
        if (c) { if (data.field === 'active') c.active = data.value; if (data.field === 'eliminated') c.eliminated = data.value; broadcastState(); } }
      break;
    case 'disqualify':
      handleDisqualify(data.teamId);
      break;
    case 'reset_all_scores':
      state.companies.forEach(c => { c.score = 0; });
      logHistory('reset_all_scores');
      broadcastState();
      break;
    case 'confirm_ranking':
      handleConfirmRanking();
      break;
    case 'generate_bracket':
      handleGenerateBracket();
      break;
    case 'start_pk_from_bracket':
      handleStartPkFromBracket();
      break;
    case 'start_semifinal_from_bracket':
      handleStartSemifinalFromBracket();
      break;
    case 'adjust_bracket':
      handleAdjustBracket(data.matchIndex, data.team1Id, data.team2Id);
      break;
    case 'pk_start_match':
      handlePkStartMatch(data.matchIndex);
      break;
    case 'pk_judge':
      handleBuzzerJudge(data.result);
      break;
    case 'pk_mark_winner':
      handlePkMarkWinner(data.teamId);
      break;
    case 'final_confirm_order':
      state.final.selectionOrder = data.order;
      logHistory('final_confirm_order', { order: data.order });
      broadcastState();
      break;
    case 'final_select':
      handleFinalSelect(data.questionIndex);
      break;
    case 'final_judge':
      handleFinalJudge(data.result);
      break;
    case 'final_confirm_champion':
      handleConfirmChampion(data.teamId);
      break;
    case 'final_confirm_result':
      // 手动确认决赛结果，进入颁奖
      if (state.phase === 'final_result' && state.final.pendingChampion) {
        handleConfirmChampion(state.final.pendingChampion);
        state.final.pendingChampion = null;
      }
      break;
    case 'final_set_coin_toss_winner':
      if (state.final.needsCoinToss && data.teamId) {
        state.final.firstPicker = data.teamId;
        state.final.needsCoinToss = false;
        generateFinalSelectionOrder();
        logHistory('coin_toss_winner', { teamId: data.teamId });
        broadcastState();
      }
      break;
    case 'tiebreaker_start':
      handleTiebreakerStart(data.context, data.teams);
      break;
    case 'tiebreaker_auto_start':
      startAutoTiebreaker();
      break;
    case 'tiebreaker_judge':
      handleTiebreakerJudge(data.result);
      break;
    case 'tiebreaker_finish':
      handleTiebreakerFinish(data.ranking);
      break;
    case 'tiebreaker_next_group':
      // 手动开始下一组加赛
      if (state.phase === 'tiebreaker_result' && state.tiebreaker.queue.length > 0) {
        processNextTieGroup();
      }
      break;
    case 'tiebreaker_confirm_ranking':
      // 手动确认加赛全部完成，进入排名确认
      if (state.phase === 'tiebreaker_result' && state.tiebreaker.queue.length === 0) {
        handleConfirmRanking();
      }
      break;
    case 'tiebreaker_confirm_pk_winner':
      // 手动确认PK加赛获胜者
      if (state.phase === 'tiebreaker_result' && state.tiebreaker.pendingWinnerId) {
        // 恢复到原来的PK阶段，让advanceToNextMatch能正常工作
        const pkCtx = state.tiebreaker.context;
        if (pkCtx === 'round2_pk' || pkCtx === 'round3_semifinal') {
          state.phase = pkCtx;
        }
        handlePkMarkWinner(state.tiebreaker.pendingWinnerId);
        state.tiebreaker.pendingWinnerId = null;
      }
      break;
    case 'tiebreaker_confirm_champion':
      // 手动确认决赛加赛冠军
      if (state.phase === 'tiebreaker_result' && state.tiebreaker.pendingChampionId) {
        handleConfirmChampion(state.tiebreaker.pendingChampionId);
        state.tiebreaker.pendingChampionId = null;
      }
      break;
    case 'tiebreaker_force_ranking':
      // 强制排名（手动触发）
      if (state.phase === 'tiebreaker' || state.phase === 'tiebreaker_result') {
        // 立即结束当前加赛并强制排名
        const remainingTeams = state.tiebreaker.teams && state.tiebreaker.teams.length > 0
          ? state.tiebreaker.teams
          : (state.tiebreaker.lastResult ? state.tiebreaker.lastResult.map(r => r.id) : []);
        const scores = state.tiebreaker.scores;
        const ctx = state.tiebreaker.context;
        if (ctx === 'round1_ranking' && remainingTeams.length > 0) {
          const offset = state.tiebreaker.rankOffset || 0;
          const sorted = [...remainingTeams].sort((a, b) => {
            const teamA = state.companies.find(c => c.id === a);
            const teamB = state.companies.find(c => c.id === b);
            const totalA = (teamA?.score || 0) + (state.tiebreaker.cumulativeTbScores[a] || 0) + (scores[a] || 0);
            const totalB = (teamB?.score || 0) + (state.tiebreaker.cumulativeTbScores[b] || 0) + (scores[b] || 0);
            return totalB - totalA;
          });
          sorted.forEach((teamId, idx) => {
            const team = state.companies.find(c => c.id === teamId);
            if (team && !team.tiebreakerRank) {
              team.tiebreakerRank = offset + idx + 1;
            }
          });
          state.tiebreaker.queue = [];
          state.tiebreaker.allDone = true;
          // 如果还在答题阶段，先 finish 再展示结果；如果已经在结果页，直接更新
          if (state.phase === 'tiebreaker') {
            handleTiebreakerFinish(sorted);
          } else {
            // 已在结果页，直接更新结果展示
            state.tiebreaker.lastResult = sorted.map(id => {
              const t = state.companies.find(c => c.id === id);
              return {
                id,
                name: t?.name || '',
                score: t?.score || 0,
                tbScore: scores[id] || 0,
                cumulativeTbScore: state.tiebreaker.cumulativeTbScores[id] || 0,
                totalScore: (t?.score || 0) + (state.tiebreaker.cumulativeTbScores[id] || 0),
                tiebreakerRank: t?.tiebreakerRank || null,
                isTied: false
              };
            });
            broadcastState();
          }
        }
      }
      break;
    case 'undo':
      handleUndo();
      break;
    case 'settings_update':
      Object.assign(state.settings, data);
      logHistory('settings_update', data);
      broadcastState();
      break;
    case 'dll_reconnect':
      connectTcpBuzzer();
      break;
    case 'buzzer_scan':
      // 请求硬件扫描设备
      if (state.settings.dllConnected) {
        sendBuzzerCommand('scan').then(res => {
          ws.send(JSON.stringify({ type: 'scan_result', data: res }));
        });
      } else {
        ws.send(JSON.stringify({ type: 'scan_result', data: { error: '抢答器未连接' } }));
      }
      break;
    case 'reload_questions':
      try { questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
        broadcast('questions_loaded', { success: true, count: Object.keys(questions).length }); }
      catch(e) { broadcast('questions_loaded', { success: false, error: e.message }); }
      break;
    case 'reset_state':
      state = createInitialState();
      saveState();
      broadcastState();
      break;
    case 'export_data':
      handleExport();
      break;
    case 'export_csv':
      handleExportCsv();
      break;
    case 'export_history':
      handleExportHistory();
      break;
    default:
      console.log('Unknown message type:', type);
  }
}

// ===================== BUZZER LOGIC =====================
let buzzerSkipTimer = null;
let buzzerCountdownTimer = null;

function createFreshBuzzerState() {
  return {
    status: 'idle',
    buzzedTeamId: null,
    violations: [],
    countdownEnd: null,
    answerEnd: null,
    hardwareDecided: false,
    hardwareWinner: null,
    judgeResult: null
  };
}

function clearBuzzerTimers() {
  if (buzzerSkipTimer) { clearTimeout(buzzerSkipTimer); buzzerSkipTimer = null; }
  if (buzzerCountdownTimer) { clearTimeout(buzzerCountdownTimer); buzzerCountdownTimer = null; }
}

function getBuzzerQuestionKey() {
  if (isPkPhase()) return `${state.phase}:m${state.pk.currentMatch}:q${state.currentQuestionIndex}`;
  if (isTiebreakerPhase()) return `tb:g${state.tiebreaker.currentGroupIndex}:q${state.tiebreaker.currentQuestionIndex}`;
  return `${state.phase}:q${state.currentQuestionIndex}`;
}

function handleBuzzerStart() {
  clearBuzzerTimers();
  // 完全重置抢答状态 —— 每次抢答都是独立事件，不保留任何之前的状态
  state.buzzer = {
    status: 'counting',
    buzzedTeamId: null,
    violations: [],
    countdownEnd: Date.now() + 3000,
    answerEnd: null,
    hardwareDecided: false,  // 标记硬件是否已判定出结果
    hardwareWinner: null     // 硬件判定的获胜者（如果有）
  };
  console.log(`[抢答] ===== 新一轮抢答开始（完全重置）=====`);
  console.log(`[抢答] 题目序号: ${state.currentQuestionIndex}, 阶段: ${state.phase}`);
  logHardwareEvent('buzzer_start', { question_index: state.currentQuestionIndex, phase: state.phase });
  broadcastState();

  // 发送启动命令给硬件
  if (state.settings.dllConnected) {
    sendBuzzerCommand('rush_start').then(res => {
      console.log(`[抢答] 硬件启动命令响应:`, JSON.stringify(res));
      logHardwareEvent('hardware_start_ack', { response: res });
    }).catch(err => {
      console.log(`[抢答] 硬件启动命令发送失败:`, err.message);
      logHardwareEvent('hardware_start_error', { error: err.message });
    });
  }

  // 软件端倒计时仅用于UI展示，不参与判定
  // 判定完全依据硬件事件
  buzzerCountdownTimer = setTimeout(() => {
    buzzerCountdownTimer = null;
    if (state.buzzer.status === 'counting') {
      state.buzzer.status = 'open';
      state.buzzer.countdownEnd = null;
      state.buzzer.answerEnd = Date.now() + state.settings.buzzerTimeout * 1000;
      console.log(`[抢答] 软件端倒计时结束，UI切换为开放状态（判定仍以硬件为准）`);
      broadcastState();
      if (state.settings.buzzerTimeout > 0) {
        buzzerSkipTimer = setTimeout(() => {
          buzzerSkipTimer = null;
          if (state.buzzer.status === 'open' && !state.buzzer.hardwareDecided) {
            state.buzzer.status = 'timeout';
            broadcastState();
          }
        }, state.settings.buzzerTimeout * 1000);
      }
    }
  }, 3000);
}

function handleBuzzerManual(teamId) {
  if (state.buzzer.status !== 'open' && state.buzzer.status !== 'counting') {
    console.log(`[抢答] handleBuzzerManual 被拒绝: 状态为 ${state.buzzer.status}，需要 open 或 counting`);
    return;
  }
  if (state.buzzer.violations.some(v => v.teamId === teamId)) {
    console.log(`[抢答] handleBuzzerManual 被拒绝: 该队伍已有违规记录`);
    return;
  }
  // 检查该队伍是否是当前比赛的参赛队伍
  const activeTeams = getActiveTeams();
  if (!activeTeams.includes(teamId)) {
    const team = state.companies.find(c => c.id === teamId);
    console.log(`[抢答] handleBuzzerManual 被拒绝: ${team?.name || '未知队伍'} 不是本场参赛队伍`);
    broadcast('info', { message: `${team?.name || '未知队伍'} 不是本场参赛队伍` });
    return;
  }
  clearBuzzerTimers();
  state.buzzer.status = 'buzzed';
  state.buzzer.buzzedTeamId = teamId;
  state.buzzer.answerEnd = Date.now() + state.settings.answerTimeout * 1000;
  const team = state.companies.find(c => c.id === teamId);
  console.log(`[抢答] ${team?.name || '未知队伍'} 抢答成功，进入答题状态`);
  broadcast('buzzer_success', { teamId });
  broadcastState();
}

function handleBuzzerReopen() {
  clearBuzzerTimers();
  state.buzzer.status = 'open';
  state.buzzer.buzzedTeamId = null;
  state.buzzer.hardwareDecided = false;
  state.buzzer.hardwareWinner = null;
  state.buzzer.answerEnd = Date.now() + state.settings.buzzerTimeout * 1000;
  logHistory('buzzer_reopen');
  logHardwareEvent('buzzer_reopen', { question_index: state.currentQuestionIndex });
  broadcastState();
  if (state.settings.buzzerTimeout > 0) {
    buzzerSkipTimer = setTimeout(() => {
      buzzerSkipTimer = null;
      if (state.buzzer.status === 'open' && !state.buzzer.hardwareDecided) {
        state.buzzer.status = 'timeout';
        broadcastState();
      }
    }, state.settings.buzzerTimeout * 1000);
  }
}

function handleBuzzerJudge(result) {
  if (state.buzzer.status !== 'buzzed') return;
  const teamId = state.buzzer.buzzedTeamId;
  if (!teamId) return;
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  const q = getCurrentQuestion();
  const points = q ? q.points : 10;
  if (result === 'correct') {
    if (state.phase === 'final_tiebreak') {
      // 决赛第9题抢答：答对直接获胜
      const finalMatch = state.bracket.final;
      if (finalMatch) {
        state.phase = 'final_result';
        state.final.pendingChampion = teamId;
      }
      state.buzzer.status = 'judged';
      state.buzzer.judgeResult = 'correct';
      broadcast('play_sound', { sound: 'correct' });
      logHistory('final_tiebreak_correct', { team: team.name });
    } else if (isPkPhase()) {
      state.pk.scores[teamId] = (state.pk.scores[teamId] || 0) + points;
      state.buzzer.status = 'judged';
      state.buzzer.judgeResult = 'correct';
      const qKey = getBuzzerQuestionKey();
      state.buzzerResults[qKey] = { teamId, result: 'correct' };
      broadcast('play_sound', { sound: 'correct' });
      logHistory('buzzer_correct', { team: team.name, points });
      setTimeout(() => autoAdvancePk(), 1500);
    } else if (isTiebreakerPhase()) {
      state.tiebreaker.scores[teamId] = (state.tiebreaker.scores[teamId] || 0) + points;
      state.buzzer.status = 'judged';
      state.buzzer.judgeResult = 'correct';
      broadcast('play_sound', { sound: 'correct' });
      logHistory('buzzer_correct', { team: team.name, points });
      setTimeout(() => {
        if (state.tiebreaker.currentQuestionIndex >= 4) {
          handleTiebreakerFinish();
        } else {
          state.tiebreaker.currentQuestionIndex++;
          state.currentQuestionIndex++;
          state.buzzer = createFreshBuzzerState();
          broadcastState();
        }
      }, 1500);
    } else {
      team.score += points;
      state.buzzer.status = 'judged';
      state.buzzer.judgeResult = 'correct';
      const qKey = getBuzzerQuestionKey();
      state.buzzerResults[qKey] = { teamId, result: 'correct' };
      broadcast('play_sound', { sound: 'correct' });
      logHistory('buzzer_correct', { team: team.name, points });
    }
  } else {
    if (state.phase === 'final_tiebreak') {
      // 决赛第9题抢答：答错直接输（对方获胜）
      const finalMatch = state.bracket.final;
      if (finalMatch) {
        const winnerId = teamId === finalMatch.team1Id ? finalMatch.team2Id : finalMatch.team1Id;
        state.phase = 'final_result';
        state.final.pendingChampion = winnerId;
      }
      state.buzzer.status = 'judged';
      state.buzzer.buzzedTeamId = teamId;
      state.buzzer.judgeResult = 'wrong';
      broadcast('play_sound', { sound: 'wrong' });
      logHistory('final_tiebreak_wrong', { team: team.name });
    } else if (isPkPhase()) {
      state.pk.scores[teamId] = (state.pk.scores[teamId] || 0) - points;
      state.buzzer.status = 'judged';
      state.buzzer.buzzedTeamId = teamId;
      state.buzzer.judgeResult = 'wrong';
      state.buzzer.answerEnd = null;
      const qKey = getBuzzerQuestionKey();
      state.buzzerResults[qKey] = { teamId, result: 'wrong' };
      broadcast('play_sound', { sound: 'wrong' });
      logHistory('buzzer_wrong', { team: team.name, points: -points });
      setTimeout(() => autoAdvancePk(), 1500);
    } else if (isTiebreakerPhase()) {
      state.tiebreaker.scores[teamId] = (state.tiebreaker.scores[teamId] || 0) - points;
      state.buzzer.status = 'judged';
      state.buzzer.buzzedTeamId = teamId;
      state.buzzer.judgeResult = 'wrong';
      state.buzzer.answerEnd = null;
      broadcast('play_sound', { sound: 'wrong' });
      logHistory('buzzer_wrong', { team: team.name, points: -points });
      setTimeout(() => {
        if (state.tiebreaker.currentQuestionIndex >= 4) {
          handleTiebreakerFinish();
        } else {
          state.tiebreaker.currentQuestionIndex++;
          state.currentQuestionIndex++;
          state.buzzer = createFreshBuzzerState();
          broadcastState();
        }
      }, 1500);
    } else {
      team.score -= points;
      state.buzzer.status = 'judged';
      state.buzzer.buzzedTeamId = teamId;
      state.buzzer.judgeResult = 'wrong';
      state.buzzer.answerEnd = null;
      const qKey = getBuzzerQuestionKey();
      state.buzzerResults[qKey] = { teamId, result: 'wrong' };
      broadcast('play_sound', { sound: 'wrong' });
      logHistory('buzzer_wrong', { team: team.name, points: -points });
    }
  }
  broadcastState();
}

function handleBuzzerViolation(teamId) {
  if (state.buzzer.violations.some(v => v.teamId === teamId)) {
    console.log(`[抢答] handleBuzzerViolation 忽略: 队伍 ${teamId} 已有违规记录`);
    return;
  }
  const team = state.companies.find(c => c.id === teamId);
  if (!team) {
    console.log(`[抢答] handleBuzzerViolation 错误: 未找到队伍 ${teamId}`);
    return;
  }
  // 检查该队伍是否是当前比赛的参赛队伍
  const activeTeams = getActiveTeams();
  if (!activeTeams.includes(teamId)) {
    console.log(`[抢答] handleBuzzerViolation 忽略: ${team.name} 不是本场参赛队伍`);
    return;
  }
  state.buzzer.violations.push({ teamId, reason: 'early_buzz' });
  console.log(`[抢答] ${team.name} 被判提前抢答/违规，当前违规列表: [${state.buzzer.violations.map(v => {
    const t = state.companies.find(c => c.id === v.teamId);
    return t?.name || v.teamId;
  }).join(', ')}]`);
  broadcast('play_sound', { sound: 'violation' });
  broadcast('buzzer_violation', { teamId, teamName: team.name });
  logHistory('buzzer_violation', { team: team.name });
  broadcastState();
}

function handleBuzzerSkip() {
  clearBuzzerTimers();
  state.buzzer = createFreshBuzzerState();
  logHistory('buzzer_skip');
  broadcastState();
  // PK phase: auto advance to next question after skip
  if (isPkPhase()) {
    setTimeout(() => autoAdvancePk(), 1500);
  } else if (isTiebreakerPhase()) {
    setTimeout(() => {
      if (state.tiebreaker.currentQuestionIndex >= 4) {
        handleTiebreakerFinish();
      } else {
        state.tiebreaker.currentQuestionIndex++;
        state.currentQuestionIndex++;
        state.buzzer = createFreshBuzzerState();
        broadcastState();
      }
    }, 1500);
  }
}

function handleBuzzerConfirmTimeout() {
  if (state.buzzer.status !== 'timeout') return;
  broadcast('play_sound', { sound: 'timeout' });
  broadcast('buzzer_timeout', {});
  clearBuzzerTimers();
  state.buzzer = createFreshBuzzerState();
  logHistory('buzzer_timeout_confirmed');
  broadcastState();
  if (state.phase === 'final_tiebreak') {
    // 决赛第9题双方都不抢答，3秒后进入加时赛
    setTimeout(() => {
      const finalMatch = state.bracket.final;
      if (finalMatch) {
        handleTiebreakerStart('round4_final', [finalMatch.team1Id, finalMatch.team2Id]);
      }
    }, 3000);
  } else if (isPkPhase()) {
    setTimeout(() => autoAdvancePk(), 3000);
  } else if (isTiebreakerPhase()) {
    setTimeout(() => {
      if (state.tiebreaker.currentQuestionIndex >= 4) {
        handleTiebreakerFinish();
      } else {
        state.tiebreaker.currentQuestionIndex++;
        state.currentQuestionIndex++;
        state.buzzer = createFreshBuzzerState();
        broadcastState();
      }
    }, 3000);
  }
}

// ===================== REQUIRED ANSWERS =====================
function getRequiredAnswersForCurrentQuestion() {
  if (!state.requiredAnswers[state.currentQuestionIndex]) {
    state.requiredAnswers[state.currentQuestionIndex] = {};
  }
  return state.requiredAnswers[state.currentQuestionIndex];
}
function handleRequiredAnswer(teamId, result, doBroadcast = true) {
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  const q = getCurrentQuestion();
  const points = q ? q.points : 10;
  const currentQ = getRequiredAnswersForCurrentQuestion();
  const prev = currentQ[teamId];
  if (prev === result) {
    delete currentQ[teamId];
    if (result === 'correct') team.score -= points;
    else if (result === 'violation') team.score += points;
  } else {
    if (prev === 'correct') team.score -= points;
    else if (prev === 'violation') team.score += points;
    currentQ[teamId] = result;
    if (result === 'correct') team.score += points;
    else if (result === 'violation') team.score -= points;
  }
  logHistory('required_answer', { team: team.name, result, qIndex: state.currentQuestionIndex });
  if (doBroadcast) broadcastState();
}

// ===================== SCORE / TEAM =====================
function handleScoreUpdate(teamId, delta, reason) {
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  team.score += delta;
  logHistory('score_update', { teamId, team: team.name, delta, reason });
  broadcastState();
}

function handleDisqualify(teamId) {
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  team.disqualified = true;
  team.eliminated = true;
  if (isPkPhase()) {
    const match = getCurrentMatch();
    if (match) {
      const winnerId = match.team1Id === teamId ? match.team2Id : match.team1Id;
      match.winnerId = winnerId;
      match.disqualified = teamId;
      const winnerTeam = state.companies.find(c => c.id === winnerId);
      logHistory('disqualify', { team: team.name });
      // 广播PK结果过场事件
      broadcast('pk_match_result', {
        winnerId,
        loserId: teamId,
        winnerName: winnerTeam?.name || '',
        loserName: team.name,
        score1: match.score1 || 0,
        score2: match.score2 || 0,
        team1Id: match.team1Id,
        team2Id: match.team2Id,
        context: state.phase,
        disqualified: true
      });
      broadcastState();
      setTimeout(() => advanceToNextMatch(), 3500);
      return;
    }
  }
  logHistory('disqualify', { team: team.name });
  broadcastState();
}

// ===================== RANKING =====================
function getRanking() {
  return [...state.companies].filter(c => !c.disqualified).sort((a,b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.tiebreakerRank !== null && b.tiebreakerRank !== null) return a.tiebreakerRank - b.tiebreakerRank;
    return 0;
  });
}

function handleConfirmRanking() {
  const ranking = getRanking();
  for (let i = 0; i < ranking.length; i++) {
    const c = state.companies.find(c => c.id === ranking[i].id);
    if (c) { c.eliminated = i >= 8; }
  }
  logHistory('confirm_ranking');
  // Auto-generate bracket
  handleGenerateBracket();
  // 进入对阵图展示页，等待管理员开始PK
  state.phase = 'bracket';
  state.bracket.currentRound = 'round2';
  broadcastState();
}

// 从对阵图进入PK答题
function handleStartPkFromBracket() {
  if (state.phase !== 'bracket') return;
  state.phase = 'round2_pk';
  state.currentQuestionIndex = 0;
  state.showAnswer = false;
  state.buzzer = createFreshBuzzerState();
  state.pk.currentMatch = 0;
  state.pk.scores = {};
  state.pk.questionResults = [];
  const m = state.bracket.round2[0];
  if (m) { state.pk.scores[m.team1Id] = 0; state.pk.scores[m.team2Id] = 0; }
  logHistory('start_pk_from_bracket', { match: 0 });
  broadcastState();
}

// ===================== BRACKET =====================
function handleGenerateBracket() {
  const ranking = getRanking();
  const top8 = ranking.filter(c => !c.eliminated).slice(0, 8);
  state.bracket.round2 = [];
  const pairs = [[0,7],[1,6],[2,5],[3,4]];
  for (const [i,j] of pairs) {
    if (top8[i] && top8[j]) {
      state.bracket.round2.push({ team1Id: top8[i].id, team2Id: top8[j].id, winnerId: null, score1: 0, score2: 0, matchLabel: `第${i+1}名 VS 第${j+1}名` });
    }
  }
  logHistory('generate_bracket');
  broadcastState();
}

function handleAdjustBracket(matchIndex, team1Id, team2Id) {
  if (state.bracket.round2 && state.bracket.round2[matchIndex]) {
    state.bracket.round2[matchIndex].team1Id = team1Id;
    state.bracket.round2[matchIndex].team2Id = team2Id;
    broadcastState();
  }
}

function handlePkStartMatch(matchIndex) {
  state.pk.currentMatch = matchIndex;
  state.pk.scores = {};
  state.pk.questionResults = [];
  state.currentQuestionIndex = 0;
  state.showAnswer = false;
  state.buzzer = createFreshBuzzerState();
  const match = getCurrentMatch();
  if (match) {
    state.pk.scores[match.team1Id] = 0;
    state.pk.scores[match.team2Id] = 0;
  }
  logHistory('pk_start', { matchIndex });
  broadcastState();
}

function handlePkMarkWinner(teamId) {
  const match = getCurrentMatch();
  if (!match) return;
  match.winnerId = teamId;
  match.score1 = state.pk.scores[match.team1Id] || 0;
  match.score2 = state.pk.scores[match.team2Id] || 0;
  // Mark loser as eliminated
  const loserId = teamId === match.team1Id ? match.team2Id : match.team1Id;
  const loserTeam = state.companies.find(c => c.id === loserId);
  const winnerTeam = state.companies.find(c => c.id === teamId);
  if (loserTeam) loserTeam.eliminated = true;
  logHistory('pk_winner', { teamId, matchIndex: state.pk.currentMatch });
  // 广播PK结果过场事件
  broadcast('pk_match_result', {
    winnerId: teamId,
    loserId,
    winnerName: winnerTeam?.name || '',
    loserName: loserTeam?.name || '',
    score1: match.score1,
    score2: match.score2,
    team1Id: match.team1Id,
    team2Id: match.team2Id,
    context: state.phase
  });
  broadcastState();
  // Auto-advance to next match after delay
  setTimeout(() => advanceToNextMatch(), 3500);
}

// ===================== AUTO ADVANCE PK =====================
function getPkQuestionsForCurrentMatch() {
  let group;
  if (state.phase === 'round2_pk') group = (questions.round2_pk || [])[state.pk.currentMatch];
  else if (state.phase === 'round3_semifinal') group = (questions.round3_semifinal || [])[state.pk.currentMatch];
  return group || [];
}

function autoAdvancePk() {
  const matchQs = getPkQuestionsForCurrentMatch();
  // If more questions remain, advance to next
  if (state.currentQuestionIndex < matchQs.length - 1) {
    state.currentQuestionIndex++;
    state.showAnswer = false;
    state.buzzer = createFreshBuzzerState();
    broadcastState();
    return;
  }
  // All questions done - determine winner
  const match = getCurrentMatch();
  if (!match) return;
  const s1 = state.pk.scores[match.team1Id] || 0;
  const s2 = state.pk.scores[match.team2Id] || 0;
  match.score1 = s1;
  match.score2 = s2;
  if (s1 > s2) {
    handlePkMarkWinner(match.team1Id);
  } else if (s2 > s1) {
    handlePkMarkWinner(match.team2Id);
  } else {
    // Tied - auto-start tiebreaker
    broadcast('tiebreaker_needed', { teams: [match.team1Id, match.team2Id], context: state.phase });
    handleTiebreakerStart(state.phase, [match.team1Id, match.team2Id]);
  }
}

function advanceToNextMatch() {
  const currentRound = state.phase === 'round2_pk' ? state.bracket.round2 : (state.phase === 'round3_semifinal' ? state.bracket.round3 : null);
  if (!currentRound) return;
  const nextMatch = state.pk.currentMatch + 1;
  if (nextMatch < currentRound.length) {
    // Start next match in same round
    state.pk.currentMatch = nextMatch;
    state.pk.scores = {};
    state.pk.questionResults = [];
    state.currentQuestionIndex = 0;
    state.showAnswer = false;
    state.buzzer = createFreshBuzzerState();
    const m = currentRound[nextMatch];
    if (m) { state.pk.scores[m.team1Id] = 0; state.pk.scores[m.team2Id] = 0; }
    logHistory('auto_start_pk', { match: nextMatch, phase: state.phase });
    broadcastState();
  } else {
    // All matches in current round done
    if (state.phase === 'round2_pk') {
      // Generate round3 (semifinals)
      generateRound3();
    } else if (state.phase === 'round3_semifinal') {
      // Setup final
      setupFinal();
    }
  }
}

function generateRound3() {
  const r2 = state.bracket.round2;
  if (!r2) return;
  const winners = r2.filter(m => m.winnerId).map(m => m.winnerId);
  if (winners.length < 4) { broadcast('error', { message: '八进四未全部完成' }); return; }
  // SF1: Winner M0 vs Winner M3, SF2: Winner M1 vs Winner M2
  state.bracket.round3 = [
    { team1Id: winners[0], team2Id: winners[3], winnerId: null, score1: 0, score2: 0, matchLabel: '半决赛1' },
    { team1Id: winners[1], team2Id: winners[2], winnerId: null, score1: 0, score2: 0, matchLabel: '半决赛2' }
  ];
  // 进入半决赛对阵图展示
  state.phase = 'bracket';
  state.bracket.currentRound = 'round3';
  logHistory('semifinal_bracket_show', {});
  broadcastState();
}

// 从半决赛对阵图进入答题
function handleStartSemifinalFromBracket() {
  if (state.phase !== 'bracket' || state.bracket.currentRound !== 'round3') return;
  state.phase = 'round3_semifinal';
  state.pk.currentMatch = 0;
  state.pk.scores = {};
  state.pk.questionResults = [];
  state.currentQuestionIndex = 0;
  state.showAnswer = false;
  state.buzzer = createFreshBuzzerState();
  const m = state.bracket.round3[0];
  if (m) { state.pk.scores[m.team1Id] = 0; state.pk.scores[m.team2Id] = 0; }
  logHistory('start_semifinal_from_bracket', {});
  broadcastState();
}

function setupFinal() {
  const r3 = state.bracket.round3;
  if (!r3) return;
  const finalists = r3.filter(m => m.winnerId).map(m => m.winnerId);
  if (finalists.length < 2) { broadcast('error', { message: '半决赛未全部完成' }); return; }
  state.bracket.final = { team1Id: finalists[0], team2Id: finalists[1], winnerId: null };
  state.phase = 'final_select';
  state.currentQuestionIndex = -1;
  state.showAnswer = false;
  // 用半决赛PK分数（不含加时赛）决定优先选题权
  // 找到每个 finalist 对应的半决赛分数
  const sfScore = {};
  r3.forEach(m => {
    if (m.winnerId) {
      // 用 winner 的半决赛分数（不含加时赛）
      const winnerScore = m.winnerId === m.team1Id ? m.score1 : m.score2;
      sfScore[m.winnerId] = winnerScore || 0;
    }
  });
  const sf1 = sfScore[finalists[0]] || 0;
  const sf2 = sfScore[finalists[1]] || 0;
  if (sf1 > sf2) {
    state.final.firstPicker = finalists[0];
    state.final.needsCoinToss = false;
  } else if (sf2 > sf1) {
    state.final.firstPicker = finalists[1];
    state.final.needsCoinToss = false;
  } else {
    // 半决赛分数相同，需要猜丁壳
    state.final.firstPicker = null;
    state.final.needsCoinToss = true;
  }
  state.final.scores = {};
  state.final.scores[finalists[0]] = 0;
  state.final.scores[finalists[1]] = 0;
  // 如果不需要猜丁壳，直接生成选题顺序
  if (!state.final.needsCoinToss) {
    generateFinalSelectionOrder();
  }
  state.final.selectedQuestions = [];
  state.final.teamAnswered = {};
  state.buzzer = createFreshBuzzerState();
  logHistory('auto_advance_final', { sf1, sf2, needsCoinToss: state.final.needsCoinToss });
  broadcastState();
}

function generateFinalSelectionOrder() {
  const r3 = state.bracket.round3;
  const finalists = r3.filter(m => m.winnerId).map(m => m.winnerId);
  const firstPicker = state.final.firstPicker;
  if (!firstPicker) return;
  const secondPicker = finalists.find(f => f !== firstPicker);
  const totalQuestions = (questions.round4_final || []).length;
  const order = [];
  for (let i = 0; i < totalQuestions; i++) {
    order.push(i % 2 === 0 ? firstPicker : secondPicker);
  }
  state.final.selectionOrder = order;
  state.final.currentSelection = 0;
}

function getCurrentMatch() {
  if (state.phase === 'round2_pk' && state.bracket.round2) return state.bracket.round2[state.pk.currentMatch];
  if (state.phase === 'round3_semifinal' && state.bracket.round3) return state.bracket.round3[state.pk.currentMatch];
  return null;
}

// ===================== FINAL =====================
function handleFinalSelect(questionIndex) {
  if (state.phase !== 'final_select') return;
  if (state.final.selectedQuestions.includes(questionIndex)) return;
  state.final.selectedQuestions.push(questionIndex);
  state.currentQuestionIndex = questionIndex;
  state.showAnswer = false;
  const order = state.final.selectionOrder;
  const currentTeam = order[state.final.currentSelection];
  state.final.teamAnswered[currentTeam] = (state.final.teamAnswered[currentTeam] || 0) + 1;
  logHistory('final_select', { questionIndex, teamId: currentTeam });
  // 切换到答题页面
  state.phase = 'round4_final';
  broadcastState();
}

function handleFinalJudge(result) {
  const order = state.final.selectionOrder;
  const currentTeam = order[state.final.currentSelection];
  if (!currentTeam) return;
  const q = getCurrentQuestion();
  const points = q ? q.points : 10;
  if (result === 'correct') {
    state.final.scores[currentTeam] = (state.final.scores[currentTeam] || 0) + points;
    broadcast('play_sound', { sound: 'correct' });
  } else {
    state.final.scores[currentTeam] = (state.final.scores[currentTeam] || 0) - points;
    broadcast('play_sound', { sound: 'wrong' });
  }
  state.final.currentSelection++;
  state.showAnswer = false;
  logHistory('final_judge', { team: currentTeam, result, points });
  const finalMatch = state.bracket.final;
  // 前8题答完
  if (state.final.currentSelection >= 8) {
    if (finalMatch) {
      const s1 = state.final.scores[finalMatch.team1Id] || 0;
      const s2 = state.final.scores[finalMatch.team2Id] || 0;
      if (s1 !== s2) {
        // 没平局，直接出结果
        state.phase = 'final_result';
        state.final.pendingChampion = s1 > s2 ? finalMatch.team1Id : finalMatch.team2Id;
        broadcastState();
        return;
      } else {
        // 8题平局，第9题自动展示，转为抢答模式
        state.currentQuestionIndex = 8;
        state.phase = 'final_tiebreak';
        state.buzzer = createFreshBuzzerState();
        logHistory('final_tiebreak_start', { s1, s2 });
        broadcastState();
        return;
      }
    }
  }
  // 回到选题页面，等待下一题选择
  state.phase = 'final_select';
  broadcastState();
}

function handleConfirmChampion(teamId) {
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  if (state.bracket.final) state.bracket.final.winnerId = teamId;
  logHistory('confirm_champion', { team: team.name });
  // Auto-transition to awards
  state.phase = 'awards';
  broadcastState();
}

// ===================== TIEBREAKER =====================

// 检测前8名中的同分组，返回 [{ score, teams: [id,...] }] 按分数从高到低
function detectTieGroups(topN = 8) {
  const ranking = getRanking();
  const groups = [];
  const seen = new Set();
  for (let i = 0; i < Math.min(topN, ranking.length); i++) {
    const c = ranking[i];
    if (seen.has(c.id)) continue;
    if (i + 1 < ranking.length && ranking[i + 1].score === c.score) {
      // 找到同分组，扩展到所有同分队伍（可能超出 topN）
      const group = [c.id];
      seen.add(c.id);
      for (let j = i + 1; j < ranking.length; j++) {
        if (ranking[j].score === c.score) {
          group.push(ranking[j].id);
          seen.add(ranking[j].id);
        } else break;
      }
      groups.push({ score: c.score, teams: group, rankStart: i + 1, offset: 0, depth: 0 });
    }
  }
  return groups;
}

// 开始自动加赛流程（round1_ranking 专用）
function startAutoTiebreaker() {
  const tieGroups = detectTieGroups(8);
  if (tieGroups.length === 0) {
    // 没有同分，直接确认排名
    handleConfirmRanking();
    return;
  }
  // 填入队列，从高分到低分
  state.tiebreaker.queue = tieGroups;
  state.tiebreaker.round = 0;
  state.tiebreaker.rankOffset = 0;
  state.tiebreaker.recursionDepth = 0;
  state.tiebreaker.cumulativeTbScores = {};
  state.tiebreaker.allDone = false;
  // 初始化所有涉及队伍的累计加赛分数为0
  tieGroups.forEach(g => g.teams.forEach(id => {
    state.tiebreaker.cumulativeTbScores[id] = 0;
  }));
  processNextTieGroup();
}

// 处理队列中下一个同分组
function processNextTieGroup() {
  if (state.tiebreaker.queue.length === 0) {
    // 全部同分已解决，确认排名进入PK赛
    handleConfirmRanking();
    return;
  }
  const group = state.tiebreaker.queue.shift();
  state.tiebreaker.currentGroupTeams = group.teams;
  state.tiebreaker.rankOffset = group.offset || 0;
  state.tiebreaker.recursionDepth = group.depth || 0;
  // 开始加赛
  doTiebreakerStart('round1_ranking', group.teams);
}

// 实际启动加赛的内部函数
function doTiebreakerStart(context, teams) {
  const usedCount = state.tiebreaker.usedGroups.length;
  const groupIndex = usedCount;
  if (groupIndex >= (questions.tiebreaker || []).length) {
    broadcast('error', { message: '加赛题组已用完！请添加更多加赛题目。' });
    return;
  }
  state.tiebreaker.currentGroupIndex = groupIndex;
  state.tiebreaker.scores = {};
  state.tiebreaker.context = context;
  state.tiebreaker.teams = teams;
  state.tiebreaker.currentQuestionIndex = 0;
  state.currentQuestionIndex = 0;
  teams.forEach(id => { state.tiebreaker.scores[id] = 0; });
  state.buzzer = createFreshBuzzerState();
  state.phase = 'tiebreaker';
  logHistory('tiebreaker_start', { context, teams, groupIndex });
  broadcastState();
}

function handleTiebreakerStart(context, teams) {
  // 非排名加赛（PK/决赛）重置题组使用记录，避免题组耗尽
  if (context !== 'round1_ranking') {
    state.tiebreaker.usedGroups = [];
    state.tiebreaker.queue = [];
    state.tiebreaker.cumulativeTbScores = {};
  }
  const usedCount = state.tiebreaker.usedGroups.length;
  const groupIndex = usedCount;
  if (groupIndex >= (questions.tiebreaker || []).length) {
    broadcast('error', { message: '加赛题组已用完！请添加更多加赛题目。' });
    return;
  }
  state.tiebreaker.currentGroupIndex = groupIndex;
  state.tiebreaker.scores = {};
  state.tiebreaker.context = context;
  state.tiebreaker.teams = teams;
  state.tiebreaker.currentQuestionIndex = 0;
  state.currentQuestionIndex = 0;
  teams.forEach(id => { state.tiebreaker.scores[id] = 0; });
  state.tiebreaker.rankOffset = 0;
  state.tiebreaker.recursionDepth = 0;
  state.buzzer = createFreshBuzzerState();
  state.phase = 'tiebreaker';
  logHistory('tiebreaker_start', { context, teams, groupIndex });
  broadcastState();
}

function handleTiebreakerJudge(result) {
  if (state.buzzer.status !== 'buzzed') return;
  const teamId = state.buzzer.buzzedTeamId;
  if (!teamId) return;
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  if (result === 'correct') {
    state.tiebreaker.scores[teamId] = (state.tiebreaker.scores[teamId] || 0) + 10;
    broadcast('play_sound', { sound: 'correct' });
  } else {
    state.tiebreaker.scores[teamId] = (state.tiebreaker.scores[teamId] || 0) - 10;
    broadcast('play_sound', { sound: 'wrong' });
  }
  state.buzzer.status = 'judged';
  state.buzzer.judgeResult = result;
  // 存储判分结果，切换回去时恢复显示
  const qKey = getBuzzerQuestionKey();
  state.buzzerResults[qKey] = { teamId, result };
  logHistory('tiebreaker_judge', { team: team.name, result });
  broadcastState();
  // 第5题判分后自动结算（index=4 是第5题）
  if (state.tiebreaker.currentQuestionIndex >= 4) {
    setTimeout(() => {
      handleTiebreakerFinish();
    }, 2000);
  } else {
    // 1-4题判分后自动切换下一题
    setTimeout(() => {
      state.tiebreaker.currentQuestionIndex++;
      state.currentQuestionIndex++;
      state.buzzer = createFreshBuzzerState();
      broadcastState();
    }, 1500);
  }
}

function handleTiebreakerFinish(ranking) {
  const scores = state.tiebreaker.scores;
  const ctx = state.tiebreaker.context;
  const offset = state.tiebreaker.rankOffset || 0;
  const depth = state.tiebreaker.recursionDepth || 0;

  // 将本轮加赛分数累加到累计加赛总分中（后台保留历史）
  Object.keys(scores).forEach(teamId => {
    if (!state.tiebreaker.cumulativeTbScores[teamId]) {
      state.tiebreaker.cumulativeTbScores[teamId] = 0;
    }
    state.tiebreaker.cumulativeTbScores[teamId] += scores[teamId] || 0;
  });

  // 排序：优先按当前轮加赛分数排序（用于确定本轮结果展示顺序）
  const sortedTeams = [...state.tiebreaker.teams].sort((a, b) => (scores[b] || 0) - (scores[a] || 0));

  state.tiebreaker.usedGroups.push(state.tiebreaker.currentGroupIndex);
  logHistory('tiebreaker_finish', { ranking: sortedTeams, offset, depth, roundScores: { ...scores }, cumulativeScores: { ...state.tiebreaker.cumulativeTbScores } });

  // 清空当前加赛状态（保留 queue, usedGroups, rankOffset, recursionDepth, cumulativeTbScores, context）
  state.tiebreaker.currentGroupIndex = null;
  state.tiebreaker.scores = {};
  state.tiebreaker.teams = [];
  // context 在结果展示阶段仍需使用，暂不清空，确认后再清
  // state.tiebreaker.context = null;
  state.tiebreaker.currentQuestionIndex = 0;
  state.currentQuestionIndex = 0;
  state.buzzer = createFreshBuzzerState();

  // --- round1_ranking: 递归加赛 ---
  if (ctx === 'round1_ranking') {
    const tiedGroups = findTiedInTiebreaker(sortedTeams, scores);
    const tiedSet = new Set();
    tiedGroups.forEach(g => g.teams.forEach(id => tiedSet.add(id)));

    // 为非同分队伍分配 tiebreakerRank（带偏移量）
    sortedTeams.forEach((teamId, idx) => {
      if (!tiedSet.has(teamId)) {
        const team = state.companies.find(c => c.id === teamId);
        if (team) team.tiebreakerRank = offset + idx + 1;
      }
    });

    // 达到最大递归深度（3轮：depth 0,1,2），强行分配排名
    // 排名依据：基础分 + 所有轮加赛累计总分
    const maxDepth = state.tiebreaker.maxDepth || 2;
    if (tiedGroups.length > 0 && depth >= maxDepth) {
      // 按 基础分 + 累计加赛总分 综合排序
      const forcedSorted = [...sortedTeams].sort((a, b) => {
        const teamA = state.companies.find(c => c.id === a);
        const teamB = state.companies.find(c => c.id === b);
        const totalA = (teamA?.score || 0) + (state.tiebreaker.cumulativeTbScores[a] || 0);
        const totalB = (teamB?.score || 0) + (state.tiebreaker.cumulativeTbScores[b] || 0);
        if (totalB !== totalA) return totalB - totalA;
        // 总分仍相同则按累计加赛分排序
        const tbA = state.tiebreaker.cumulativeTbScores[a] || 0;
        const tbB = state.tiebreaker.cumulativeTbScores[b] || 0;
        return tbB - tbA;
      });
      forcedSorted.forEach((teamId, idx) => {
        const team = state.companies.find(c => c.id === teamId);
        if (team && !team.tiebreakerRank) {
          team.tiebreakerRank = offset + idx + 1;
        }
      });
      tiedGroups.length = 0;
      state.tiebreaker.allDone = true;
    }

    // 如果有同分子分组，插入队列前端（高分组优先，已按 tbScore 降序）
    if (tiedGroups.length > 0) {
      const subGroups = tiedGroups.map(g => ({
        teams: g.teams,
        offset: offset + g.offset,
        depth: depth + 1
      }));
      state.tiebreaker.queue.unshift(...subGroups);
    }

    // 展示结果（手动控制，不自动跳转）
    state.phase = 'tiebreaker_result';
    state.tiebreaker.lastResult = sortedTeams.map(id => {
      const t = state.companies.find(c => c.id === id);
      return {
        id,
        name: t?.name || '',
        score: t?.score || 0,
        tbScore: scores[id] || 0,
        cumulativeTbScore: state.tiebreaker.cumulativeTbScores[id] || 0,
        totalScore: (t?.score || 0) + (state.tiebreaker.cumulativeTbScores[id] || 0),
        tiebreakerRank: t?.tiebreakerRank || null,
        isTied: tiedSet.has(id)
      };
    });
    broadcastState();
    return;
  }

  // --- PK / semifinal tiebreaker ---
  if (ctx === 'round2_pk' || ctx === 'round3_semifinal') {
    // 检查加赛是否仍然平局
    const s1 = scores[sortedTeams[0]] || 0;
    const s2 = scores[sortedTeams[1]] || 0;
    if (s1 === s2) {
      // 加赛仍然平局，再进行一轮加赛
      state.phase = 'tiebreaker_result';
      state.tiebreaker.lastResult = sortedTeams.map(id => {
        const t = state.companies.find(c => c.id === id);
        return { id, name: t?.name || '', score: t?.score || 0, tbScore: scores[id] || 0 };
      });
      state.tiebreaker.pendingWinnerId = null;
      broadcastState();
      // 自动开始下一轮加赛
      setTimeout(() => {
        handleTiebreakerStart(ctx, sortedTeams);
      }, 3000);
      return;
    }
    const winnerId = sortedTeams[0];
    state.phase = 'tiebreaker_result';
    state.tiebreaker.lastResult = sortedTeams.map(id => {
      const t = state.companies.find(c => c.id === id);
      return { id, name: t?.name || '', score: t?.score || 0, tbScore: scores[id] || 0 };
    });
    broadcastState();
    // 保留 winnerId 供手动确认使用
    state.tiebreaker.pendingWinnerId = winnerId;
    return;
  }

  // --- Final tiebreaker ---
  if (ctx === 'round4_final') {
    // 检查加赛是否仍然平局
    const s1 = scores[sortedTeams[0]] || 0;
    const s2 = scores[sortedTeams[1]] || 0;
    if (s1 === s2) {
      // 决赛加赛仍然平局，再进行一轮
      state.phase = 'tiebreaker_result';
      state.tiebreaker.lastResult = sortedTeams.map(id => {
        const t = state.companies.find(c => c.id === id);
        return { id, name: t?.name || '', score: t?.score || 0, tbScore: scores[id] || 0 };
      });
      state.tiebreaker.pendingChampionId = null;
      broadcastState();
      setTimeout(() => {
        handleTiebreakerStart(ctx, sortedTeams);
      }, 3000);
      return;
    }
    const championId = sortedTeams[0];
    state.phase = 'tiebreaker_result';
    state.tiebreaker.lastResult = sortedTeams.map(id => {
      const t = state.companies.find(c => c.id === id);
      return { id, name: t?.name || '', score: t?.score || 0, tbScore: scores[id] || 0 };
    });
    state.tiebreaker.pendingChampionId = championId;
    broadcastState();
    return;
  }

  broadcastState();
}

// 在加赛结果中找出仍有同分的队伍，返回分组（含偏移量）
function findTiedInTiebreaker(sortedTeams, scores) {
  const groups = [];
  const seen = new Set();
  for (let i = 0; i < sortedTeams.length; i++) {
    if (seen.has(sortedTeams[i])) continue;
    if (i + 1 < sortedTeams.length && (scores[sortedTeams[i]] || 0) === (scores[sortedTeams[i+1]] || 0)) {
      const group = [sortedTeams[i]];
      seen.add(sortedTeams[i]);
      for (let j = i + 1; j < sortedTeams.length; j++) {
        if ((scores[sortedTeams[j]] || 0) === (scores[sortedTeams[i]] || 0)) {
          group.push(sortedTeams[j]);
          seen.add(sortedTeams[j]);
        } else break;
      }
      groups.push({ tbScore: scores[sortedTeams[i]] || 0, teams: group, offset: i });
    }
  }
  return groups;
}

// ===================== UNDO =====================
function handleUndo() {
  if (state.history.length === 0) return;
  const last = state.history.pop();
  const q = getCurrentQuestion();
  const points = q ? q.points : 10;
  switch(last.action) {
    case 'buzzer_correct': {
      const team = state.companies.find(c => c.name === last.details.team);
      if (team) {
        if (isPkPhase()) state.pk.scores[team.id] = (state.pk.scores[team.id] || 0) - (last.details.points || points);
        else if (isTiebreakerPhase()) state.tiebreaker.scores[team.id] = (state.tiebreaker.scores[team.id] || 0) - (last.details.points || points);
        else team.score -= (last.details.points || points);
      }
      state.buzzer.status = 'buzzed';
      state.buzzer.buzzedTeamId = team ? team.id : null;
      break;
    }
    case 'buzzer_wrong': {
      const team = state.companies.find(c => c.name === last.details.team);
      const undoPoints = Math.abs(last.details.points || points);
      if (team) {
        if (isPkPhase()) state.pk.scores[team.id] = (state.pk.scores[team.id] || 0) + undoPoints;
        else if (isTiebreakerPhase()) state.tiebreaker.scores[team.id] = (state.tiebreaker.scores[team.id] || 0) + undoPoints;
        else team.score += undoPoints;
      }
      state.buzzer.violations = state.buzzer.violations.filter(v => v.teamId !== (team ? team.id : -1));
      state.buzzer.status = 'buzzed';
      state.buzzer.buzzedTeamId = team ? team.id : null;
      break;
    }
    case 'buzzer_violation': {
      const team = state.companies.find(c => c.name === last.details.team);
      if (team) state.buzzer.violations = state.buzzer.violations.filter(v => v.teamId !== team.id);
      break;
    }
    case 'required_answer': {
      const team = state.companies.find(c => c.name === last.details.team);
      if (team) {
        const currentQ = getRequiredAnswersForCurrentQuestion();
        const prev = currentQ[team.id];
        if (prev === 'correct') { team.score -= (last.details.points || points); delete currentQ[team.id]; }
        else if (prev === 'violation') { team.score += (last.details.points || points); delete currentQ[team.id]; }
        else if (prev === 'wrong') { delete currentQ[team.id]; }
      }
      break;
    }
    case 'score_update': {
      const team = state.companies.find(c => c.id === last.details.teamId);
      if (team) team.score -= last.details.delta;
      break;
    }
    case 'final_judge': {
      const team = state.companies.find(c => c.name === last.details.team);
      if (team) {
        if (last.details.result === 'correct') {
          if (state.final.scores) state.final.scores[team.id] = (state.final.scores[team.id]||0) - (last.details.points || points);
          else team.score -= (last.details.points || points);
        } else {
          if (state.final.scores) state.final.scores[team.id] = (state.final.scores[team.id]||0) + (last.details.points || points);
          else team.score += (last.details.points || points);
        }
      }
      if (state.final.currentSelection > 0) state.final.currentSelection--;
      state.showAnswer = false;
      state.phase = 'final_select';
      state.final.pendingChampion = null;
      break;
    }
    case 'tiebreaker_judge': {
      const team = state.companies.find(c => c.name === last.details.team);
      if (team) {
        if (last.details.result === 'correct') state.tiebreaker.scores[team.id] = (state.tiebreaker.scores[team.id] || 0) - 10;
        else state.tiebreaker.scores[team.id] = (state.tiebreaker.scores[team.id] || 0) + 10;
      }
      state.buzzer.status = 'buzzed';
      state.buzzer.buzzedTeamId = team ? team.id : null;
      break;
    }
    case 'buzzer_skip':
      state.buzzer.status = 'buzzed';
      break;
    default:
      break;
  }
  broadcast('undo_notification', { action: last.action });
  broadcastState();
}

// ===================== EXPORT =====================
function handleExport() {
  const data = {
    timestamp: new Date().toISOString(),
    companies: state.companies.map(c => ({ id: c.id, name: c.name, score: c.score, status: c.disqualified ? 'disqualified' : c.eliminated ? 'eliminated' : 'active' })),
    ranking: getRanking().map((c, i) => ({ rank: i+1, name: c.name, score: c.score })),
    history: state.history,
    bracket: state.bracket,
  };
  broadcast('export_data', data);
}
function handleExportCsv() {
  const ranking = getRanking();
  let csv = '排名,连队,分数,状态\n';
  ranking.forEach((c, i) => {
    const status = c.disqualified ? '判负' : c.eliminated ? '淘汰' : '参赛';
    csv += `${i+1},${c.name},${c.score},${status}\n`;
  });
  broadcast('export_data', { csv, filename: `成绩表_${Date.now()}.csv` });
}
function handleExportHistory() {
  const data = {
    timestamp: new Date().toISOString(),
    history: state.history.map(h => ({
      time: new Date(h.time).toLocaleString(),
      action: h.action,
      details: h.details || {}
    })),
  };
  broadcast('export_data', data);
}

// ===================== HELPERS =====================
function getCurrentQuestion() {
  const phase = state.phase;
  if (phase === 'round1_required') return (questions.round1_required || [])[state.currentQuestionIndex];
  if (phase === 'round1_buzzer') return (questions.round1_buzzer || [])[state.currentQuestionIndex];
  if (phase === 'round2_pk') {
    const group = (questions.round2_pk || [])[state.pk.currentMatch];
    return group ? group[state.currentQuestionIndex] : null;
  }
  if (phase === 'round3_semifinal') {
    const group = (questions.round3_semifinal || [])[state.pk.currentMatch];
    return group ? group[state.currentQuestionIndex] : null;
  }
  if (phase === 'round4_final' || phase === 'final_tiebreak') return (questions.round4_final || [])[state.currentQuestionIndex];
  if (phase === 'tiebreaker') {
    const group = (questions.tiebreaker || [])[state.tiebreaker.currentGroupIndex];
    return group ? group[state.currentQuestionIndex] : null;
  }
  return null;
}

function isPkPhase() { return state.phase === 'round2_pk' || state.phase === 'round3_semifinal'; }
function isTiebreakerPhase() { return state.phase === 'tiebreaker'; }

function getActiveTeams() {
  if (state.phase === 'buzzer_test') return state.companies.map(c => c.id);
  if (isPkPhase()) {
    const match = getCurrentMatch();
    if (match) return [match.team1Id, match.team2Id];
  }
  if (isTiebreakerPhase()) return state.tiebreaker.teams;
  if (state.phase === 'round4_final' || state.phase === 'final_tiebreak') {
    if (state.bracket.final && state.bracket.final.team1Id && state.bracket.final.team2Id) {
      return [state.bracket.final.team1Id, state.bracket.final.team2Id];
    }
    if (state.bracket.round3) {
      const winners = state.bracket.round3.filter(m => m.winnerId).map(m => m.winnerId);
      return winners;
    }
  }
  return state.companies.filter(c => c.active && !c.eliminated).map(c => c.id);
}

// ===================== TCP BUZZER CLIENT (ResponderControllerV3) =====================
// Dual-port protocol:
//   Event port  : 9999 (push events, JSON lines: { event, data, ts })
//   Command port: 9998 (request-response, text commands)
let eventSock = null;
let cmdSock = null;
let tcpReconnectTimer = null;
let _cmdResolvers = []; // queue of {resolve, reject} for pending commands

function connectTcpBuzzer() {
  const { dllAddress, dllPort } = state.settings;
  const cmdPort = state.settings.dllCmdPort || 9998;
  if (eventSock) { eventSock.destroy(); eventSock = null; }
  if (cmdSock) { cmdSock.destroy(); cmdSock = null; }
  clearTimeout(tcpReconnectTimer);
  _cmdResolvers = [];

  // ---- Event socket ----
  eventSock = new net.Socket();
  eventSock.connect(dllPort, dllAddress, () => {
    console.log(`[Buzzer] 事件端口已连接 ${dllAddress}:${dllPort}`);
  });
  let evtBuf = '';
  eventSock.on('data', (chunk) => {
    evtBuf += chunk.toString();
    let idx;
    while ((idx = evtBuf.indexOf('\n')) >= 0) {
      const line = evtBuf.slice(0, idx).trim();
      evtBuf = evtBuf.slice(idx + 1);
      if (line) handleBuzzerEvent(line);
    }
  });
  eventSock.on('error', (e) => {
    console.log('[Buzzer] 事件端口错误:', e.message);
  });
  eventSock.on('close', () => {
    state.settings.dllConnected = false;
    broadcastState();
    console.log('[Buzzer] 事件端口断开，3秒后重连...');
    tcpReconnectTimer = setTimeout(connectTcpBuzzer, 3000);
  });

  // ---- Command socket ----
  cmdSock = new net.Socket();
  cmdSock.connect(cmdPort, dllAddress, () => {
    state.settings.dllConnected = true;
    console.log(`[Buzzer] 命令端口已连接 ${dllAddress}:${cmdPort}`);
    broadcastState();
  });
  let cmdBuf = '';
  cmdSock.on('data', (chunk) => {
    cmdBuf += chunk.toString();
    let idx;
    while ((idx = cmdBuf.indexOf('\n')) >= 0) {
      const line = cmdBuf.slice(0, idx).trim();
      cmdBuf = cmdBuf.slice(idx + 1);
      if (line && _cmdResolvers.length > 0) {
        const r = _cmdResolvers.shift();
        try { r.resolve(JSON.parse(line)); } catch(e) { r.resolve({ raw: line }); }
      }
    }
  });
  cmdSock.on('error', (e) => {
    console.log('[Buzzer] 命令端口错误:', e.message);
  });
  cmdSock.on('close', () => {
    // Command port close is handled by event port close -> reconnect
  });
}

function sendBuzzerCommand(cmd) {
  return new Promise((resolve) => {
    if (!cmdSock) { resolve({ error: '未连接' }); return; }
    const timeout = setTimeout(() => {
      const idx = _cmdResolvers.findIndex(r => r._timeout === timeout);
      if (idx >= 0) _cmdResolvers.splice(idx, 1);
      resolve({ error: '超时' });
    }, 3000);
    const entry = { resolve: (d) => { clearTimeout(timeout); resolve(d); }, _timeout: timeout };
    _cmdResolvers.push(entry);
    try {
      cmdSock.write(cmd + '\n');
    } catch(e) {
      resolve({ error: e.message });
    }
  });
}

function handleBuzzerEvent(line) {
  try {
    const msg = JSON.parse(line);
    const evt = msg.event || '';
    const data = msg.data || {};

    // ===== 所有硬件事件先写入持久化日志（作为权威证据）=====
    logHardwareEvent(evt, data);

    if (evt === 'rush_answer') {
      const keyId = data.key_id;
      const stateVal = data.state; // 6=抢答成功, 5=抢答锁定, 1=无效/提前, 2=超时
      const timeVal = data.time !== undefined ? data.time : null;
      
      // 按键号到队伍号的映射
      const map = state.settings.keyIdMapping || {};
      const teamId = map[keyId] !== undefined ? map[keyId] : keyId;
      const team = state.companies.find(c => c.id === teamId);
      const stateDesc = {1:'提前抢答/无效', 2:'超时', 5:'抢答锁定', 6:'抢答成功'}[stateVal] || '未知';
      
      console.log(`[抢答] 硬件事件: #${keyId} → ${team?.name || '未知队伍'} (teamId=${teamId}), state=${stateVal}(${stateDesc}), time=${timeVal}ms`);

      // 抢答测试模式 —— 独立处理，不走正常抢答逻辑
      if (state.phase === 'buzzer_test') {
        handleBuzzerTestEvent(keyId, stateVal, timeVal);
        return;
      }

      // ============================================================
      // 核心原则：完全信任硬件判定，软件只做展示和记录
      // 硬件是权威，软件不做二次判断
      // ============================================================

      // state=5: 抢答锁定确认 —— 忽略（state=6时已处理）
      if (stateVal === 5) {
        return;
      }

      // state=1: 硬件判定为提前抢答/犯规
      if (stateVal === 1) {
        console.log(`[抢答] → 硬件判定: 提前抢答 → ${team?.name || '未知队伍'}`);
        // 直接记录违规，完全信任硬件
        recordBuzzerViolationFromHardware(teamId, timeVal);
        return;
      }

      // state=6: 硬件判定为抢答成功（第一个有效抢答）
      if (stateVal === 6) {
        console.log(`[抢答] → 硬件判定: 抢答成功 → ${team?.name || '未知队伍'}`);
        // 直接认定抢答成功，完全信任硬件
        recordBuzzerSuccessFromHardware(teamId, timeVal);
        return;
      }

      // state=2: 超时（无人抢答）
      if (stateVal === 2) {
        console.log(`[抢答] → 硬件判定: 超时无人抢答`);
        if (state.buzzer.status === 'open' || state.buzzer.status === 'counting') {
          state.buzzer.status = 'timeout';
          broadcastState();
        }
        return;
      }
    }

    // 转发其他事件给前端
    if (evt === 'rush_state') broadcast('buzzer_state', data);
    if (evt === 'scan') broadcast('device_scan', data);
    if (evt === 'connected') {
      state.settings.dllConnected = true;
      broadcastState();
    }
  } catch(e) {
    console.log('[Buzzer] 事件解析失败:', line, '错误:', e.message);
    logHardwareEvent('parse_error', { line: line, error: e.message });
  }
}

// 硬件判定的抢答成功 —— 完全信任硬件
function recordBuzzerSuccessFromHardware(teamId, timeMs) {
  // 检查硬件是否已经判定过（防止重复处理）
  if (state.buzzer.hardwareDecided && state.buzzer.hardwareWinner) {
    console.log(`[抢答] 忽略: 硬件已判定 ${state.buzzer.hardwareWinner} 获胜，忽略后续事件`);
    return;
  }

  const team = state.companies.find(c => c.id === teamId);
  if (!team) {
    console.log(`[抢答] 错误: 未找到队伍 ${teamId}`);
    return;
  }

  // 检查该队伍是否是当前比赛的参赛队伍
  const activeTeams = getActiveTeams();
  if (!activeTeams.includes(teamId)) {
    console.log(`[抢答] 忽略: ${team.name} 不是本场参赛队伍，跳过抢答`);
    return;
  }

  // 标记硬件已判定
  state.buzzer.hardwareDecided = true;
  state.buzzer.hardwareWinner = teamId;

  // 清除所有定时器
  clearBuzzerTimers();

  // 更新状态
  state.buzzer.status = 'buzzed';
  state.buzzer.buzzedTeamId = teamId;
  state.buzzer.answerEnd = Date.now() + state.settings.answerTimeout * 1000;

  console.log(`[抢答] ${team.name} 抢答成功（硬件判定），时间 ${timeMs}ms`);
  
  // 记录到历史
  logHistory('buzzer_success_hardware', { 
    team: team.name, 
    teamId: teamId, 
    time_ms: timeMs,
    question_index: state.currentQuestionIndex
  });

  // 广播
  broadcast('buzzer_success', { teamId, timeMs });
  broadcastState();
}

// 硬件判定的提前抢答 —— 完全信任硬件
function recordBuzzerViolationFromHardware(teamId, timeMs) {
  const team = state.companies.find(c => c.id === teamId);
  if (!team) {
    console.log(`[抢答] 错误: 未找到队伍 ${teamId}`);
    return;
  }

  // 检查该队伍是否是当前比赛的参赛队伍
  const activeTeams = getActiveTeams();
  if (!activeTeams.includes(teamId)) {
    console.log(`[抢答] 忽略: ${team.name} 不是本场参赛队伍，跳过违规记录`);
    return;
  }

  // 检查是否已经记录过（防止重复）
  if (state.buzzer.violations.some(v => v.teamId === teamId && v.reason === 'early_buzz')) {
    console.log(`[抢答] 忽略: ${team.name} 已记录过提前抢答`);
    return;
  }

  // 记录违规
  state.buzzer.violations.push({ 
    teamId, 
    reason: 'early_buzz',
    time_ms: timeMs,
    from_hardware: true
  });

  console.log(`[抢答] ${team.name} 提前抢答（硬件判定），时间 ${timeMs}ms`);
  console.log(`[抢答] 当前违规列表: [${state.buzzer.violations.map(v => {
    const t = state.companies.find(c => c.id === v.teamId);
    return t?.name || v.teamId;
  }).join(', ')}]`);

  // 记录到历史
  logHistory('buzzer_violation_hardware', { 
    team: team.name, 
    teamId: teamId, 
    time_ms: timeMs,
    question_index: state.currentQuestionIndex
  });

  // 广播
  broadcast('play_sound', { sound: 'violation' });
  broadcast('buzzer_violation', { teamId, teamName: team.name, timeMs });
  broadcastState();
}

// ===================== BUZZER TEST (Round 0) =====================
function handleBuzzerTestStart() {
  clearBuzzerTimers();
  state.buzzerTest = {
    status: 'counting',
    results: {},
    countdownEnd: Date.now() + 3000,
    firstBuzzTeamId: null
  };
  state.companies.forEach(c => {
    state.buzzerTest.results[c.id] = { status: 'yellow', time: null };
  });
  logHistory('buzzer_test_start');
  if (state.settings.dllConnected) {
    sendBuzzerCommand('rush_start').catch(() => {});
  }
  broadcastState();
  buzzerCountdownTimer = setTimeout(() => {
    buzzerCountdownTimer = null;
    if (state.buzzerTest.status === 'counting') {
      state.buzzerTest.status = 'open';
      state.buzzerTest.countdownEnd = null;
      broadcastState();
    }
  }, 3000);
}

function handleBuzzerTestReset() {
  clearBuzzerTimers();
  if (state.settings.dllConnected) sendBuzzerCommand('rush_stop').catch(() => {});
  state.buzzerTest = {
    status: 'idle',
    results: {},
    countdownEnd: null,
    firstBuzzTeamId: null
  };
  state.companies.forEach(c => {
    state.buzzerTest.results[c.id] = { status: 'yellow', time: null };
  });
  broadcastState();
}

function handleBuzzerTestEvent(keyId, stateVal, timeVal) {
  const map = state.settings.keyIdMapping || {};
  const teamId = map[keyId] !== undefined ? map[keyId] : keyId;
  const team = state.companies.find(c => c.id === teamId);
  if (!team) return;
  const r = state.buzzerTest.results[teamId];
  if (!r) return;
  if (stateVal === 1) {
    if (r.status === 'yellow') {
      state.buzzerTest.results[teamId] = { status: 'red', time: timeVal };
      console.log(`[抢答测试] ${team.name} 提前抢答`);
      broadcast('play_sound', { sound: 'violation' });
      broadcastState();
    }
    return;
  }
  if (stateVal === 6) {
    if (r.status !== 'yellow') return;
    if (!state.buzzerTest.firstBuzzTeamId) {
      state.buzzerTest.firstBuzzTeamId = teamId;
      state.buzzerTest.results[teamId] = { status: 'green', time: timeVal };
      state.buzzerTest.status = 'buzzed';
      console.log(`[抢答测试] ${team.name} 第一个抢答成功！`);
      broadcast('play_sound', { sound: 'buzzer' });
      broadcast('buzzer_success', { teamId });
    } else {
      state.buzzerTest.results[teamId] = { status: 'blue', time: timeVal };
      console.log(`[抢答测试] ${team.name} 抢答成功（非首个）`);
    }
    broadcastState();
    return;
  }
}

connectTcpBuzzer();

// ===================== START SERVER =====================
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`  2025级本科生军训国防知识竞赛系统已启动`);
  console.log(`  展示端: http://localhost:${PORT}/display.html`);
  console.log(`  管理端: http://localhost:${PORT}/admin.html`);
  console.log(`=================================`);
});
