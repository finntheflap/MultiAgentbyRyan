// Agent Room: phòng làm việc nhóm giữa bạn và 4 AI là Claude, ChatGPT (Codex), Gemini, Qwen.
// Chạy: node agent-room/server.js, rồi mở http://localhost:3028
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3028;
// Thư mục dự án mà các AI được đọc. Mặc định là thư mục cha của agent-room.
const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || path.join(__dirname, '..'));
const PROJECT_NAME = process.env.PROJECT_NAME || path.basename(PROJECT_DIR);
const DATA_DIR = process.env.AGENT_ROOM_DATA || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'history.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const HOME = os.homedir();
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 40; // số tin nhắn gần nhất đưa vào prompt
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const bin = (name, fallback) => (fs.existsSync(fallback) ? fallback : name);
const withModel = (flag, model) => (model ? [flag, model] : []);

// models: gợi ý hiển thị trong UI. Chuỗi rỗng nghĩa là dùng model mặc định của CLI.
const AGENTS = {
  claude: {
    name: 'Claude',
    maker: 'Anthropic',
    initial: 'C',
    aliases: ['claude'],
    role: 'Trưởng nhóm: trả lời chính, chia việc cho cả nhóm và viết phần code lõi.',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    cmd: (_, model) => [
      bin('claude', path.join(HOME, '.local/bin/claude')),
      ['-p', '--output-format', 'text', ...withModel('--model', model)],
    ],
  },
  codex: {
    name: 'ChatGPT',
    maker: 'OpenAI Codex',
    initial: 'X',
    aliases: ['codex', 'chatgpt', 'gpt'],
    role: 'Lên kịch bản (luồng người dùng, kế hoạch triển khai, kịch bản kiểm thử) và debug, tìm lỗi.',
    models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5'],
    cmd: (outFile, model) => [
      bin('codex', path.join(HOME, '.local/node/bin/codex')),
      ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', ...withModel('-m', model), '-o', outFile, '-'],
    ],
  },
  gemini: {
    name: 'Gemini',
    maker: 'Google',
    initial: 'G',
    aliases: ['gemini'],
    role: 'Hỗ trợ code và thiết kế giao diện (UI, UX, CSS, bố cục, trải nghiệm).',
    models: ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    cmd: (_, model) => [
      bin('gemini', path.join(HOME, '.local/node/bin/gemini')),
      ['--approval-mode', 'plan', '-o', 'text', ...withModel('-m', model), '-p', ' '],
    ],
  },
  design: {
    name: 'Claude Design',
    maker: 'Anthropic',
    initial: 'D',
    aliases: ['design', 'designer', 'claudedesign'],
    role: 'Thiết kế giao diện: dựng mockup HTML trực quan, chọn màu, typography, bố cục, xem trước được ngay trong chat.',
    designer: true,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'],
    cmd: (_, model) => [
      bin('claude', path.join(HOME, '.local/bin/claude')),
      ['-p', '--output-format', 'text', ...withModel('--model', model)],
    ],
  },
  qwen: {
    name: 'Qwen',
    maker: 'Alibaba · chạy trên máy',
    initial: 'Q',
    aliases: ['qwen'],
    role: 'Hỗ trợ Claude viết code: hàm, đoạn code cụ thể, unit test, refactor nhỏ.',
    local: true,
    defaultModel: 'qwen3.5:9b',
    models: ['qwen3.5:9b'],
  },
};
const ORDER = ['claude', 'codex', 'gemini', 'design', 'qwen'];

// ---------- state ----------
let history = loadHistory();
let busy = false;
let cancelled = false;
let currentChild = null;
let turn = { plan: [], index: -1 };
const clients = new Set();

function loadHistory() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(loaded) ? loaded : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2));
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) writeSSE(res, data);
}

function writeSSE(res, data) {
  if (res.destroyed || res.writableEnded) {
    clients.delete(res);
    return;
  }
  try {
    // Disconnect slow clients instead of buffering an unlimited history.
    if (!res.write(data)) {
      clients.delete(res);
      res.destroy();
    }
  } catch {
    clients.delete(res);
    res.destroy();
  }
}

function addMessage(msg) {
  const full = { id: Date.now() + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), ...msg };
  history.push(full);
  saveHistory();
  broadcast({ type: 'message', message: full });
  return full;
}

// ---------- prompts ----------
const ROUND_LABEL = { answer: 'Trả lời', task: 'Nhận việc', review: 'Góp ý', critique: 'Phản biện', summary: 'Tổng kết' };
// Người góp ý trả về đúng chữ này khi thấy câu trả lời đã ổn.
const PASS_RE = /^[\s*_`"'.]*ok[\s*_`"'.!]*$/i;

function transcript() {
  return history
    .slice(-HISTORY_LIMIT)
    .map((m) => {
      if (m.role === 'user') {
        const imgs = m.images?.length ? `\n[Người dùng đính kèm ${m.images.length} ảnh: ${m.images.map((i) => i.name).join(', ')}]` : '';
        return `### Người dùng:\n${m.text}${imgs}`;
      }
      if (m.role === 'system') return `### [Hệ thống]: ${m.text}`;
      if (m.pass) return `### ${AGENTS[m.agent].name} (Góp ý): đã xem, thấy ổn, không bổ sung gì.`;
      return `### ${AGENTS[m.agent].name} (${ROUND_LABEL[m.round] || 'Trả lời'}):\n${m.text}`;
    })
    .join('\n\n');
}

function teamList(participants) {
  return participants.map((a) => `${AGENTS[a].name} (gọi bằng @${AGENTS[a].aliases[0] === 'design' ? 'Design' : AGENTS[a].name}): ${AGENTS[a].role}`).join('\n');
}

const DESIGN_RULES = `Quy tắc riêng cho bạn khi thiết kế:
1. Mỗi khi đưa ra giao diện, xuất đúng MỘT khối \`\`\`html chứa trang HTML hoàn chỉnh, tự chứa: CSS viết trong thẻ style, không tải ảnh hay script từ ngoài (chỉ được dùng Google Fonts).
2. Thiết kế phải đẹp, hiện đại, có hệ màu và khoảng cách nhất quán, chữ tiếng Việt hiển thị đúng. Nếu là app điện thoại thì đặt trong khung rộng 390px.
3. Dùng nội dung thật hoặc gần thật, không dùng lorem ipsum.
4. Trước khối HTML, giải thích ngắn gọn các quyết định thiết kế chính (tối đa 5 ý). Giao diện chat sẽ tự hiện bản xem trước.`;

function currentImages() {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return (history[i].images || []).filter((img) => fs.existsSync(uploadPath(img.file)));
  }
  return [];
}

function imageNote(agentId, images) {
  if (!images.length) return '';
  const a = AGENTS[agentId];
  if (a.local) return `\nNgười dùng đã gửi kèm ${images.length} ảnh (đã được đính kèm trực tiếp cho bạn). Hãy xem kỹ ảnh trước khi trả lời.`;
  if (agentId === 'codex') return `\nNgười dùng đã gửi kèm ${images.length} ảnh (đã được đính kèm trực tiếp cho bạn). Hãy xem kỹ ảnh trước khi trả lời.`;
  if (agentId === 'gemini') return `\nNgười dùng đã gửi kèm ảnh, hãy xem kỹ: ${images.map((img) => '@' + path.relative(PROJECT_DIR, uploadPath(img.file))).join(' ')}`;
  return `\nNgười dùng đã gửi kèm ảnh. Hãy dùng công cụ Read để xem kỹ từng ảnh trước khi trả lời:\n${images.map((img) => uploadPath(img.file)).join('\n')}`;
}

function buildPrompt(agentId, task, participants, lead, assignment) {
  const me = AGENTS[agentId];
  const leadName = AGENTS[lead]?.name || 'trưởng nhóm';
  const others = participants.filter((a) => a !== agentId);
  const otherNames = others.map((a) => AGENTS[a].name);
  const instructions = {
    answer:
      'Trả lời tin nhắn mới nhất của Người dùng. Nếu đã có AI khác trả lời trước bạn trong lượt này thì đừng nhắc lại ý của họ. ' +
      'Hãy bổ sung góc nhìn mới, hoặc nói rõ bạn không đồng ý ở điểm nào và gọi tên người đó bằng @Tên.',
    lead:
      'Bạn là trưởng nhóm của lượt này. Trả lời tin nhắn mới nhất của Người dùng một cách đầy đủ và chính xác.\n' +
      (others.length
        ? `Nếu yêu cầu đủ lớn để chia việc, hãy giao phần việc phù hợp với vai trò của từng người (${otherNames.join(', ')}). ` +
          'Mỗi việc giao viết trên một dòng riêng ở CUỐI câu trả lời, đúng mẫu:\n📋 @Tên: việc cụ thể cần làm\n' +
          'Câu hỏi đơn giản thì tự trả lời, không cần giao việc. Không giao việc cho người không hợp vai trò. ' +
          'Những người không được giao việc sẽ đọc lại câu trả lời của bạn và chỉ lên tiếng khi thấy có vấn đề.'
        : ''),
    task:
      `${leadName} vừa giao cho bạn việc sau: "${assignment}".\n` +
      'Làm đúng việc được giao, theo đúng vai trò của bạn. Đi thẳng vào kết quả (kịch bản, code, thiết kế, danh sách lỗi...), ' +
      'không nhắc lại đề bài, không chào hỏi, không bình luận việc của người khác.',
    review:
      `${leadName} vừa trả lời Người dùng. Hãy đọc lại câu trả lời đó qua góc nhìn vai trò của bạn (${me.role}).\n` +
      'Nếu không có vấn đề gì quan trọng, chỉ viết đúng một chữ: OK\n' +
      'Chỉ lên tiếng khi có lỗi sai, rủi ro đáng kể, hoặc thiếu sót quan trọng có thể khiến Người dùng làm sai. ' +
      'Không góp ý về câu chữ, không nhắc lại ý đã có người nói, không khen. Nếu chỉ đồng ý với góp ý trước đó thì viết OK.\n' +
      `Khi lên tiếng: mở đầu bằng dòng ⚠️ @${leadName}: vấn đề cụ thể và lý do, sau đó đề xuất cách sửa. Tối đa 120 từ.`,
    critique:
      'Đây là vòng phản biện. Đọc kỹ câu trả lời của ' + (otherNames.join(', ') || 'các AI khác') + ' ở trên. ' +
      'Mở đầu bằng vài dòng đánh giá ngắn, mỗi dòng theo đúng một trong hai mẫu sau:\n' +
      '👍 @Tên: điểm bạn đồng ý\n⚠️ @Tên: điểm bạn thấy sai, thiếu hoặc rủi ro, kèm lý do cụ thể\n' +
      'Sau đó nói quan điểm cuối cùng của bạn. Nếu bị thuyết phục và đổi ý thì nói thẳng ra.',
    summary:
      'Bạn là người tổng kết cuộc thảo luận. Viết ngắn gọn theo ba ý: 1. Những điểm cả nhóm đã thống nhất. ' +
      '2. Những điểm còn tranh cãi và ai giữ quan điểm nào. 3. Khuyến nghị cuối cùng và bước tiếp theo cụ thể cho Người dùng.',
  }[task];

  return `Bạn là ${me.name} (${me.maker}) trong một nhóm AI cùng giúp Người dùng build app trong dự án "${PROJECT_NAME}".
Vai trò của bạn: ${me.role}

Thành viên và vai trò trong nhóm:
${teamList(participants)}

${me.local ? 'Bạn không đọc được file, chỉ dựa vào nội dung trong lịch sử chat.' : 'Thư mục hiện tại là dự án. Bạn được đọc file khi cần nhưng KHÔNG được sửa file.'}

Quy tắc:
1. Viết tiếng Việt tự nhiên như người thật nói chuyện, chuyên nghiệp, súc tích (thường dưới 200 từ, trừ khi cần code).
2. KHÔNG dùng dấu gạch ngang hay gạch dài (-, –, —) để nối câu hay liệt kê. Khi liệt kê, dùng số 1. 2. 3.
3. Chỉ viết phần nói của chính bạn. Không viết thay AI khác, không tự xưng tên ở đầu câu.
4. Thẳng thắn: nếu AI khác sai, nói rõ là sai và vì sao. Không khen xã giao.

=== LỊCH SỬ CHAT ===
${transcript()}
=== HẾT LỊCH SỬ ===

${me.designer ? DESIGN_RULES + '\n' : ''}${imageNote(agentId, currentImages())}

Nhiệm vụ của bạn lúc này: ${instructions}`;
}

// ---------- running agents ----------
async function runOllama(agentId, prompt, model) {
  const controller = new AbortController();
  let reason = null;
  const stop = (why) => { reason = why; controller.abort(); };
  currentChild = { stop };
  const timer = setTimeout(() => stop('Quá 5 phút mà vẫn chưa có câu trả lời nên đã dừng.'), AGENT_TIMEOUT_MS);
  const name = model || AGENTS[agentId].defaultModel;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name,
        messages: [{ role: 'user', content: prompt, images: currentImages().map((img) => fs.readFileSync(uploadPath(img.file)).toString('base64')) }],
        stream: false,
        think: false,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = /not found/i.test(data.error || '') ? `\nChạy lệnh: ollama pull ${name}` : '';
      return { ok: false, text: `${data.error || 'Ollama báo lỗi ' + r.status}${hint}` };
    }
    const text = (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return text ? { ok: true, text } : { ok: false, text: 'Model không trả về nội dung' };
  } catch (err) {
    if (reason) return { ok: false, text: reason };
    return { ok: false, text: `Không kết nối được Ollama tại ${OLLAMA_URL}. Hãy mở app Ollama rồi thử lại.\n${err.message}` };
  } finally {
    clearTimeout(timer);
    currentChild = null;
  }
}

function runAgent(agentId, prompt, model) {
  if (AGENTS[agentId].local) return runOllama(agentId, prompt, model);
  return new Promise((resolve) => {
    let tempDir;
    let child;
    let timer;
    let settled = false;
    let failure;
    let stdout = '';
    let stderr = '';
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (currentChild?.child === child) currentChild = null;
      let text = stdout.trim();
      try {
        const outFile = tempDir && path.join(tempDir, 'output.txt');
        if (outFile && fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8').trim();
      } catch (err) {
        failure = `Không đọc được output: ${err.message}`;
      } finally {
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); }
          catch (err) { failure = `Không xoá được file tạm: ${err.message}`; }
        }
      }
      if (!failure && code === 0 && text) return resolve({ ok: true, text });
      const err = stderr.trim().split('\n').slice(-5).join('\n');
      resolve({ ok: false, text: failure || `Mã thoát ${code}\n${err || text || 'Không có nội dung trả về'}` });
    };
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-room-${agentId}-`));
      const [cmd, baseArgs] = AGENTS[agentId].cmd(path.join(tempDir, 'output.txt'), model);
      // Codex nhận ảnh qua tham số -i, đặt trước dấu '-' (đọc prompt từ stdin).
      const imgs = agentId === 'codex' ? currentImages().flatMap((img) => ['-i', uploadPath(img.file)]) : [];
      const args = imgs.length ? [...baseArgs.slice(0, -1), ...imgs, baseArgs.at(-1)] : baseArgs;
      child = spawn(cmd, args, {
        cwd: PROJECT_DIR, env: process.env, detached: process.platform !== 'win32',
      });
      let stopping = false;
      let closed = false;
      let closeCode;
      const signalTree = (signal) => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') {
            // taskkill is an OS command, not an external Node dependency.
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            killer.on('error', () => child.kill(signal));
          } else process.kill(-child.pid, signal);
        } catch (err) {
          if (err.code !== 'ESRCH') child.kill(signal);
        }
      };
      const stop = (reason) => {
        if (stopping || settled) return;
        stopping = true;
        failure = reason;
        clearTimeout(timer);
        signalTree('SIGTERM');
        // Keep the turn busy until descendants have also received SIGKILL.
        timer = setTimeout(() => {
          signalTree('SIGKILL');
          if (closed) finish(closeCode);
          else timer = setTimeout(() => finish(null), 1000);
        }, 1000);
      };
      currentChild = { child, stop };
      timer = setTimeout(() => stop('Quá 5 phút mà vẫn chưa có câu trả lời nên đã dừng.'), AGENT_TIMEOUT_MS);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        failure = `Không chạy được ${cmd}: ${err.message}`;
        if (!child.pid) finish(null);
        else stop(failure);
      });
      child.on('close', (code) => {
        closed = true;
        closeCode = code;
        if (!stopping) finish(code);
      });
      child.stdin.on('error', (err) => stop(`Không gửi được prompt: ${err.message}`));
      child.stdin.end(prompt);
    } catch (err) {
      if (child && currentChild?.child === child) currentChild.stop(err.message);
      else { failure = err.message; finish(null); }
    }
  });
}

// Trả về message vừa thêm (null nếu đã dừng).
async function speak(agentId, step, participants, lead, models) {
  const { round, task = round, assignment } = step;
  if (cancelled) return null;
  broadcast({ type: 'thinking', agent: agentId, round });
  const started = Date.now();
  const model = typeof models?.[agentId] === 'string' ? models[agentId].trim() : '';
  const result = await runAgent(agentId, buildPrompt(agentId, task, participants, lead, assignment), model);
  if (cancelled) return null;
  const seconds = Math.round((Date.now() - started) / 1000);
  if (round === 'review' && result.ok && PASS_RE.test(result.text)) {
    return addMessage({ role: 'agent', agent: agentId, round, pass: true, text: '', seconds, ...(model ? { model } : {}) });
  }
  return addMessage({
    role: 'agent',
    agent: agentId,
    round,
    text: result.text,
    error: !result.ok,
    ...(round === 'critique' || round === 'review' ? { targets: parseTargets(result.text) } : {}),
    ...(assignment ? { assignment } : {}),
    ...(model ? { model } : {}),
    seconds,
  });
}

function mentionRe(id) {
  return new RegExp(`@(${AGENTS[id].aliases.join('|')})\\b`, 'i');
}

// "@Claude Design" phải được hiểu là Claude Design, không phải Claude.
function normalizeMentions(text) {
  return String(text).replace(/@Claude[\s_-]*Design\b/gi, '@Design');
}

function parseMentions(text) {
  const t = normalizeMentions(text);
  return ORDER.filter((id) => mentionRe(id).test(t));
}

// Đọc các dòng "📋 @Tên: việc" trong câu trả lời của trưởng nhóm.
function parseAssignments(text) {
  const tasks = {};
  for (const line of normalizeMentions(text).split('\n')) {
    const m = line.match(/^\s*(?:[*_-]\s*)?📋\s*\**@([\wÀ-ỹ]+)\**\s*[:：]?\s*(.+)$/u);
    if (!m) continue;
    const id = ORDER.find((a) => AGENTS[a].aliases.includes(m[1].toLowerCase()));
    if (id) tasks[id] = tasks[id] ? `${tasks[id]}; ${m[2].trim()}` : m[2].trim();
  }
  return tasks;
}

function parseTargets(text) {
  return parseMentions(text).map((agent) => {
    const lines = normalizeMentions(text).split('\n');
    let stance;
    for (const line of lines) {
      const match = line.match(/^\s*(👍|⚠️?)\s*@([a-z]+)\b/i);
      if (match && AGENTS[agent].aliases.includes(match[2].toLowerCase())) {
        const next = match[1] === '👍' ? 'agree' : 'disagree';
        if (stance && stance !== next) return { agent };
        stance = next;
      }
    }
    return stance ? { agent, stance } : { agent };
  });
}

function uploadPath(file) {
  return path.join(UPLOAD_DIR, path.basename(String(file)));
}

async function runTurn(text, opts, images = []) {
  busy = true;
  cancelled = false;
  try {
    const mentioned = parseMentions(text);
    const enabled = ORDER.filter((id) => opts.agents?.[id] !== false);
    const participants = mentioned.length ? mentioned : enabled;
    if (!participants.length) throw new Error('Không có AI nào được bật');
    const pick = (id) => (participants.includes(id) ? id : participants[0]);
    // Chế độ mặc định: trưởng nhóm trả lời và chia việc. Ai được giao thì làm, ai không thì chỉ lên tiếng khi thấy có vấn đề.
    const teamMode = opts.mode !== 'debate' && !mentioned.length && participants.length > 1;
    const lead = pick(opts.lead || opts.judge || 'claude');
    let plan;
    if (teamMode) {
      plan = [{ agent: lead, round: 'answer', task: 'lead' }];
      plan.push(...participants.filter((a) => a !== lead).map((agent) => ({ agent, round: 'review' })));
    } else {
      plan = participants.map((agent) => ({ agent, round: 'answer' }));
      if (opts.mode === 'debate' && participants.length > 1) {
        plan.push(...participants.map((agent) => ({ agent, round: 'critique' })));
        plan.push({ agent: pick(opts.judge), round: 'summary' });
      }
    }
    turn = { plan, index: -1 };
    broadcast({ type: 'busy', busy: true });
    broadcast({ type: 'turn', ...turn });
    addMessage({ role: 'user', text, ...(images.length ? { images } : {}) });
    for (let index = 0; index < plan.length && !cancelled; index++) {
      turn = { plan, index };
      broadcast({ type: 'turn', ...turn });
      const step = plan[index];
      const msg = await speak(step.agent, step, participants, lead, opts.models);
      // Trưởng nhóm vừa trả lời: người được giao việc chuyển sang làm việc, xếp trước những người chỉ đọc lại.
      if (teamMode && index === 0 && msg && !msg.error) {
        const tasks = parseAssignments(msg.text);
        const rest = plan.slice(1).map((s) => (tasks[s.agent] ? { agent: s.agent, round: 'task', assignment: tasks[s.agent] } : s));
        plan.splice(1, rest.length, ...rest.filter((s) => s.round === 'task'), ...rest.filter((s) => s.round !== 'task'));
      }
    }
  } catch (err) {
    console.error('Không hoàn thành lượt:', err);
    broadcast({ type: 'error', text: 'Lượt này bị gián đoạn, bạn thử gửi lại nhé.' });
  } finally {
    try {
      if (cancelled) addMessage({ role: 'system', text: 'Bạn đã dừng lượt thảo luận này' });
    } catch (err) {
      console.error('Không lưu được lịch sử:', err);
    } finally {
      busy = false;
      turn = { plan: [], index: -1 };
      broadcast({ type: 'turn', ...turn });
      broadcast({ type: 'thinking', agent: null });
      broadcast({ type: 'busy', busy: false });
    }
  }
}

// ---------- http ----------
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_UPLOAD_BYTES * 1.5) req.destroy();
    });
    req.on('error', () => resolve({}));
    req.on('aborted', () => resolve({}));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const agents = {};
    for (const id of ORDER) {
      const { name, maker, initial, role, models, local, defaultModel, designer, aliases } = AGENTS[id];
      agents[id] = { name, maker, initial, role, aliases, models: [...models], local: !!local, designer: !!designer, defaultModel: defaultModel || '' };
    }
    // Lấy danh sách model đã tải trong Ollama, nếu Ollama đang chạy.
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const names = ((await r.json()).models || []).map((m) => m.name).filter((n) => !/embed/i.test(n));
      agents.qwen.models = [...new Set([...names.filter((n) => /qwen/i.test(n)), ...names])];
      agents.qwen.ollama = true;
    } catch {
      agents.qwen.ollama = false;
    }
    return json(res, 200, { order: ORDER, agents });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'init', history, busy, turn })}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => writeSSE(res, ': heartbeat\n\n'), 20000);
    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const { name, type, data } = await readBody(req);
    const ext = IMAGE_TYPES[type];
    if (!ext || typeof data !== 'string') return json(res, 400, { error: 'Chỉ nhận ảnh PNG, JPG, GIF hoặc WEBP' });
    const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return json(res, 400, { error: 'Ảnh phải nhỏ hơn 10 MB' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    const safeName = String(name || file).replace(/[\r\n]/g, ' ').slice(0, 120);
    return json(res, 200, { file, name: safeName, url: `/uploads/${file}` });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
    const file = path.basename(decodeURIComponent(url.pathname.slice('/uploads/'.length)));
    const type = Object.keys(IMAGE_TYPES).find((t) => file.endsWith('.' + IMAGE_TYPES[t]));
    const full = path.join(UPLOAD_DIR, file);
    if (!type || !fs.existsSync(full)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=31536000, immutable' });
    return fs.createReadStream(full).pipe(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/message') {
    const { text, images, ...opts } = await readBody(req);
    const files = (Array.isArray(images) ? images : [])
      .filter((img) => img && typeof img.file === 'string' && fs.existsSync(uploadPath(img.file)))
      .slice(0, 6)
      .map((img) => ({ file: path.basename(img.file), name: String(img.name || img.file).slice(0, 120) }));
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body && !files.length) return json(res, 400, { error: 'Bạn chưa nhập nội dung' });
    if (busy) return json(res, 409, { error: 'Các AI đang thảo luận, bạn đợi chút hoặc bấm dừng nhé' });
    runTurn(body || 'Xem giúp mình ảnh này.', opts, files);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    if (busy) {
      cancelled = true;
      currentChild?.stop('Đã dừng.');
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    if (busy) return json(res, 409, { error: 'Đợi các AI nói xong hoặc bấm dừng trước nhé' });
    history = [];
    saveHistory();
    broadcast({ type: 'init', history, busy, turn });
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Room đang chạy: http://localhost:${PORT}`);
});
