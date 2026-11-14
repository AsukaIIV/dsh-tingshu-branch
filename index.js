/**
 * dsh-tingshu-branch — 听书稿分支。
 *
 * 一个操作，两个调用方（见 references/user-actions.md）：
 *   - 人：composer 里的 `/tingshu` 命令
 *   - 模型：`tingshu_branch` 工具
 * 两者都走同一个 launch()。
 *
 * 这个插件本身不写稿。它做确定性的事，然后把写作交出去：
 *   1. 算日期与当日版本号，定死输出文件的绝对路径；
 *   2. 量一下源会话有多大，选投递方式：
 *      - 会话不长 → sessionController.fork 派生分支，让分支带着上下文直接写；
 *      - 会话很长 → 把对话抽成纯文本、切块落到磁盘，再开一个**全新的空会话**
 *        让它一块一块读、一节一节写，最后拼成一稿。这样上下文永远不爆。
 *   3. 用 sessionController.prompt 把命令全文投给目标会话。
 */

const COMMAND_NAME = 'tingshu';
const TOOL_NAME = 'tingshu_branch';
const DEFAULT_MINUTES = 75;
/** 中文口播的大致字速，用来把「多少分钟」换算成字数。 */
const CHARS_PER_MINUTE = 260;
/** 源会话素材超过这么多字，就不再 fork（否则分支一开局就顶到上下文上限）。 */
/** 读不到模型窗口时的字数兜底线（只在拿不到 contextWindow 时才用得上）。 */
const DEFAULT_CHAR_FALLBACK = 45000;
/** 分支会整段继承上下文：模型窗口用到这个比例以上，就改走分块。 */
const DEFAULT_FORK_WINDOW_RATIO = 0.5;
/** 分块模式下每一块的目标字数。 */
const DEFAULT_CHUNK_CHARS = 6000;
/** 分块数量上限：块再多就自动加粗每块的字数，不让分支跑上百轮。 */
const MAX_CHUNKS = 60;

const FALLBACK_TOPIC = '当前会话';

/** 去掉文件名里不能出现的字符，并收短。 */
function sanitizeTopic(value) {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/^[._]+/u, '')
    .replace(/[._]+$/u, '')
    .trim();
  return cleaned.length === 0 ? '' : cleaned.slice(0, 48);
}

function pathBaseName(value) {
  if (typeof value !== 'string') return '';
  const parts = value.replace(/[\\/]+$/u, '').split(/[\\/]/u);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** 今天的日期（YYYYMMDD），按配置时区。 */
function todayStamp(timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  if (year.length !== 4 || month.length !== 2 || day.length !== 2) {
    return now.toISOString().slice(0, 10).replace(/-/gu, '');
  }
  return `${year}${month}${day}`;
}

/** 命令行解析：`-t/--topic` 主题，`-m/--minutes` 分钟数，其余算「本次额外要求」。 */
function parseRawInput(rawInput) {
  const text = String(rawInput ?? '').trim();
  const options = { topic: '', minutes: 0, extra: '' };
  if (text.length === 0) return options;
  if (!text.startsWith('-')) {
    options.extra = text;
    return options;
  }
  const tokens = text.split(/\s+/u);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-t' || token === '--topic') {
      options.topic = tokens[(index += 1)] ?? '';
    } else if (token === '-m' || token === '--minutes') {
      const minutes = Number(tokens[(index += 1)] ?? '');
      options.minutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
    } else if (token.length > 0) {
      options.extra = `${options.extra} ${token}`.trim();
    }
  }
  return options;
}

/** 会话当前目录；拿不到就退回进程目录。 */
async function resolveWorkspace(ctx, agent, signal) {
  const fromHeader = agent?.session?.header?.cwd;
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
  try {
    const cwd = await ctx.workingDirectory?.ensure?.(agent, signal);
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  } catch {
    // 退回到 fs 的默认目录。
  }
  const target = await ctx.fs.resolve('.', { signal });
  return ctx.fs.processPath(target);
}

/** 找出目录里今天已经存在的最大版本号，然后 +1。 */
async function nextVersion(ctx, cwd, topic, stamp, signal) {
  const pattern = new RegExp(`^听书稿_${escapeRegExp(topic)}_${stamp}_v(\\d+)\\.txt$`, 'u');
  try {
    const target = await ctx.fs.resolve('.', { cwd, signal });
    const entries = await ctx.fs.listDir(target, signal);
    let max = 0;
    for (const entry of entries) {
      const match = pattern.exec(entry.name ?? '');
      if (match === null) continue;
      const version = Number(match[1]);
      if (Number.isFinite(version) && version > max) max = version;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function joinPath(cwd, fileName) {
  const separator = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/u, '')}${separator}${fileName}`;
}

function uniqueId() {
  const generator = globalThis.crypto?.randomUUID;
  if (typeof generator === 'function') return generator.call(globalThis.crypto);
  return `tingshu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── 素材抽取 ────────────────────────────────────────────────────────────

const NOISE_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gu,
  /<acp[^>]*>[\s\S]*?<\/acp>/gu,
  /^Time sampled while.*$/gmu,
  /^Browser time zone for this request:.*$/gmu,
  /^Elapsed since the preceding.*$/gmu,
  /^\[model changed:.*$/gmu,
  /^\[Compressed conversation section\][^\n]*$/gmu,
];

/** 运行时注入的房务行——一条都不该出现在听书稿素材里。 */
const NOISE_LINE = /^(?:Current runtime context|Current working directory:|Current file policy:|Current DeepSeek Harness|Approval requests are auto-granted|This snapshot supersedes|You are the Team Lead|Use `?list_agents|To message another teammate|If the user names a skill|A user may also invoke a skill)/u;

/** 把一段内容块数组里的正文取出来（reasoning、tool-call 丢弃）。 */
function blocksToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function stripNoise(text) {
  let out = text;
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, '');
  const kept = [];
  for (const line of out.split('\n')) {
    if (NOISE_LINE.test(line.trim())) continue;
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * 把事件流抽成「你说 / 我说」的线性文本。
 * 只留人和模型的正文，工具调用与工具返回全部丢掉——那部分通常是长会话里最占地方、
 * 对听书稿又没有直接价值的东西。
 */
function buildTranscript(events) {
  if (!Array.isArray(events)) return '';
  const lines = [];
  for (const event of events) {
    const type = event?.type;
    let speaker = '';
    let raw = '';
    if (type === 'user/message') {
      speaker = '【你说】';
      raw = blocksToText(event?.data?.content);
    } else if (type === 'assistant/message') {
      speaker = '【我说】';
      raw = blocksToText(event?.data?.message?.content);
    } else {
      continue;
    }
    const text = stripNoise(raw);
    if (text.length === 0) continue;
    lines.push(`${speaker}\n${text}`);
  }
  return lines.join('\n\n');
}

// ── 分块 ────────────────────────────────────────────────────────────────

/** 按空行切段，再按目标字数累积成块；单段超长就硬切。 */
function planChunks(transcript, targetChars, maxChunks) {
  const text = String(transcript ?? '');
  const hardCap = Math.max(1, Math.min(Number(maxChunks) || MAX_CHUNKS, 200));
  let limit = Math.max(1000, Math.round(targetChars));
  let chunks = sliceChunks(text, limit);
  // 块数超过上限就加粗每块，重切；用比例外推，最多试十几次。
  for (let attempt = 0; attempt < 12 && chunks.length > hardCap; attempt += 1) {
    const ratio = chunks.length / hardCap;
    limit = Math.ceil(limit * ratio * 1.15);
    chunks = sliceChunks(text, limit);
  }
  return chunks;
}

function sliceChunks(text, limit) {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const pieces = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) {
      pieces.push(paragraph);
      continue;
    }
    for (let offset = 0; offset < paragraph.length; offset += limit) {
      pieces.push(paragraph.slice(offset, offset + limit));
    }
  }
  return mergePieces(pieces, limit);
}

function mergePieces(pieces, size) {
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece;
      continue;
    }
    if (current.length + 2 + piece.length <= size) {
      current = `${current}\n\n${piece}`;
      continue;
    }
    chunks.push(current);
    current = piece;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// ── 命令全文 ────────────────────────────────────────────────────────────

const SHARED_RULES = `【为听而写：硬约束，写完逐条自查】
一、全文不出现阿拉伯数字。数字都用中文写：零点四八、二零二六年、百分之九十、第三章、十二点五分贝。
二、不出现英文缩写和术语原文。必须提到的名词，第一次给中文全称并解释一句，之后用中文简称。确实必须保留的字母标识最多留几个，第一次出现时交代一句"这个念作什么"。
三、不用列表、不用表格、不用代码块、不用反引号、不用星号加粗。全部是成段的口语。
四、句子短，能一口气读完。少用"首先、其次、综上所述"，多用"那么、所以、这里要注意"。
五、每讲完一个意思就空一行，给听众一个自然停顿。
六、不写"如上表所示""见图三"这种只有在纸上才成立的话。
七、少用括号；确需补充，就用一整句话讲出来。`;

const SHARED_TONE = `【口吻】
像一个懂行的人坐在旁边给朋友讲，而不是念报告。可以用"我们""你"，可以适当感慨，但别煽情。该说"这一步我们其实做错了"就直说。`;

function structureBlock() {
  return `【结构】
一、开头给一小段收听说明：这份稿子讲什么、素材来自哪里、大概要听多久。
二、中间分成若干卷、若干章依次讲。每一章开头用一两句话交代这一章要讲什么，结尾用一两句话收束，让听众知道自己走到哪了。
三、章的顺序按"听的人能不能跟上"来排：先补必要的背景知识（如果听众可能是外行，就从零讲起，多用生活里的比方），再讲这条对话到底干了什么，最后讲结论、发现、经验教训和下一步。
四、结尾要有收束，不要突然截断。`;
}

function reportBlock(sectionNote) {
  return `【写完之后，在你的回复里逐项报告】
一、文件确实写到哪个绝对路径，一共多少行、多少字。
二、章节清单，一卷一行、一章一行。${sectionNote}
三、全文阿拉伯数字出现次数，应该是零。
四、全文英文缩写出现次数，并列出你主动保留的那几个是哪些、念作什么。
五、是否出现了列表、表格、代码块，应该是零。
六、这份稿子听下来大概多少分钟。`;
}

function outputBlock(job) {
  const { outPath, fileName, stamp, version } = job;
  return `【输出文件】
绝对路径：${outPath}
文件名：${fileName}
编码：UTF-8，不带 BOM，不要写成 Markdown。
这个路径已经算好：日期是 ${stamp}，当天第 ${version} 版，且文件当前不存在。请原样使用——不要改名、不要改日期、不要改版本号、不要另建目录、不要覆盖同名文件。如果写入时发现文件已存在，把版本号加一改个新名字，并在最后告诉我你实际用的文件名。`;
}

function extraBlock(extra) {
  if (typeof extra !== 'string' || extra.trim().length === 0) return '';
  return `\n【这一次的额外要求】\n用户还提了这句话，能照做就照做，做不到就用一句自然的话说明为什么：\n${extra.trim()}\n`;
}

function lengthBlock(minutes, targetChars) {
  return `【篇幅】
目标收听时长约 ${minutes} 分钟。中文口播大约每分钟 ${CHARS_PER_MINUTE} 字，所以正文控制在 ${targetChars} 字上下（上下浮动两成都可以）。宁可讲透几件事，也不要平铺一堆没讲清楚的事。`;
}

/** 分支继承上下文时的命令全文。 */
function buildPrompt(job) {
  const targetChars = job.minutes * CHARS_PER_MINUTE;
  return `你在这个分支里工作。这个分支是从一个进行中的对话派生出来的，继承了那条对话里已经完成的全部上下文。你现在只做一件事：把这些上下文整理成一份适合用耳朵听的口语化 txt 听书稿，写到下面这个确切路径。

【主题】
${job.topic}

${outputBlock(job)}

${lengthBlock(job.minutes, targetChars)}

【内容来源：只用真的发生过的事】
一、素材就是你在本分支里能看到的这段对话：做过什么、卡在哪里、怎么解决的、最后落在什么结论上。
二、对话里点到的报告、规格、任务书、脚本、数据文件，先读一遍再写；读不到的就不要写那些细节。
三、严禁编造。不虚构数字、不虚构实验、不虚构引用。记忆和文件对不上时以文件为准，并且可以直接告诉听众：当时记的是这样，文件里其实是那样。
四、这份稿子不新增任何实验，不跑训练，不改动项目里的其它文件。你只写这一个 txt。
五、弯路、返工、失败的尝试要保留。这类稿子最有价值的部分往往不是结果，而是"本来以为会怎样、后来发现不是"。${extraBlock(job.extra)}
${structureBlock()}

${SHARED_TONE}

${SHARED_RULES}

${reportBlock('')}

一次成稿。不要反问用户，除非缺的信息会让稿子根本写不下去；那种情况也只问一个问题，然后继续往下写。写完后不要改动项目里任何其它文件。`;
}

/**
 * 素材分块模式（源会话太长，不能 fork）的命令全文。
 * 目标会话是全新的、没有任何上下文，所有信息都必须来自磁盘上的素材块。
 */
function buildChunkedPrompt(job) {
  const { topic, materialDir, chunkCount, perSectionChars, minutes, outPath } = job;
  const targetChars = minutes * CHARS_PER_MINUTE;
  return `你是一个刚开的新会话，没有任何继承来的上下文。你要做的唯一一件事，是把磁盘上一份已经切好的对话素材，整理成一份适合用耳朵听的口语化 txt 听书稿。

【主题】
${topic}

${outputBlock(job)}

【素材在哪】
素材是原始对话的正文（只保留了人和模型的说话内容，工具调用和工具输出已经剔除），已经按顺序切成 ${chunkCount} 块，放在这个目录：
${materialDir}
文件依次是 ${pad2(1)}.txt 到 ${pad2(chunkCount)}.txt，编号就是时间顺序。

【必须这样干活，一块一块来】
这是硬性流程，为的是不把上下文撑爆。务必按顺序执行：
一、先读 ${pad2(1)}.txt 这一块，立刻写成 ${joinPath(materialDir, `节${pad2(1)}.txt`)}。每节大约 ${perSectionChars} 字。
二、然后读 ${pad2(2)}.txt，写 ${joinPath(materialDir, `节${pad2(2)}.txt`)}。以此类推，一块读一次、写一次。
三、同一时间手里只拿一块素材。不要一次读两块，不要先把所有块读完再动笔，不要回头反复读已经写过的块。
四、每一节开头用一两句话承上，结尾停在一个自然的气口上，因为最后几节会被直接拼在一起。
五、每一节都要写成完整成段的口语，不要写小标题清单式的内容。
六、${chunkCount} 块全部写完之后，按编号顺序把它们拼成最终稿，写到 ${outPath}。拼接用一条命令就够，例如（把变量换成实际路径）：
   $parts = Get-ChildItem -LiteralPath "${materialDir}" -Filter "节*.txt" | Sort-Object Name
   $sb = New-Object System.Text.StringBuilder
   foreach ($p in $parts) { [void]$sb.AppendLine((Get-Content -LiteralPath $p.FullName -Raw -Encoding UTF8)); [void]$sb.AppendLine() }
   [System.IO.File]::WriteAllText("${outPath}", $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
   注意两个地方必须显式写：读分节文件时带 -Encoding UTF8，写成品时用 UTF8Encoding($false)。少写一个就会读出乱码或写出带 BOM 的文件——拼完先看一眼头几个字是不是正常中文，是乱码就重拼，不要拿去交。
七、拼完之后通读一遍成品，只做必要的顺稿：去掉重复的过渡句、补上卷与卷之间的衔接、确认开头有收听说明、结尾有收束。改动用 Edit 局部改，不要整篇重写。

${lengthBlock(minutes, targetChars)}
按上面的分节字数写满 ${chunkCount} 节，总量自然就落在这个区间，不要在拼接后再大幅增删。分节字数只为让总量对得上目标时长：宁可每节短一点、把话说干净，也不要为了凑字数往里加水。两条打架时以总字数为准。

【内容来源：只用素材里真的发生过的事】
一、素材是原始对话正文。里面提到的报告、规格、脚本、数据文件，如果你能读到就去读，读不到的就不要写那些细节。
二、严禁编造。不虚构数字、不虚构实验、不虚构引用。素材里没说的，就不要说。
三、这份稿子不新增任何实验，不改动项目里的其它文件。你只写这一个 txt（以及中间产物那几节）。
四、弯路、返工、失败的尝试要保留。这类稿子最有价值的部分往往不是结果，而是"本来以为会怎样、后来发现不是"。
五、素材是切开的，跨块的因果关系可能被切断；拿不准的地方回到相邻块确认一次，但不要为了确认把全部块重读一遍。${extraBlock(job.extra)}
${structureBlock()}
注意：结构是按整篇稿子说的，不是按每一节说的。每一节只负责自己那一段内容在整篇里的位置。

${SHARED_TONE}

${SHARED_RULES}

${reportBlock(`素材一共 ${chunkCount} 块，请说明每一块落在哪一章。`)}

不要反问用户。写完后不要改动项目里任何其它文件；中间产物（素材块与分节文件）留着不用删。`;
}

// ── 主流程 ──────────────────────────────────────────────────────────────

/** 读源会话的当前模型表面；拿不到就返回 undefined。 */
async function readSurface(ctx, sessionId) {
  const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery;
  if (query === undefined || query === null) return undefined;
  try {
    if (typeof query.readSurface === 'function') return await query.readSurface(sessionId);
  } catch {
    // 落到下面用完整日志兜底。
  }
  try {
    if (typeof query.readSession === 'function') return await query.readSession(sessionId);
  } catch {
    // 两条路都不通，交给调用方降级。
  }
  return undefined;
}

/**
 * 读模型这边的真实预算：这一次请求要装多少 token、这个模型的窗口有多大。
 * 两个数都来自宿主服务（`session.requestContext()` 的 `contextWindow`、
 * `tokenMeter.measure(session)` 的 `totalTokens`），不是拍脑袋的常数。
 */
function measureBudget(ctx, agent) {
  const budget = { usedTokens: undefined, contextWindow: undefined, model: undefined };
  const session = agent?.session;
  if (session === undefined || session === null) return budget;

  try {
    const context = session.requestContext?.();
    if (context !== undefined && context !== null) {
      if (typeof context.model === 'string' && context.model.length > 0) budget.model = context.model;
      const window = Number(context.contextWindow);
      if (Number.isFinite(window) && window > 0) budget.contextWindow = window;
    }
  } catch {
    // 拿不到窗口就当下不知道，走字数兜底。
  }

  try {
    const meter = ctx.get?.('tokenMeter') ?? ctx.tokenMeter;
    if (meter !== undefined && meter !== null && typeof meter.measure === 'function') {
      const measurement = meter.measure(session);
      const total = Number(measurement?.totalTokens);
      if (Number.isFinite(total) && total >= 0) budget.usedTokens = total;
    }
  } catch {
    // 同上。
  }
  return budget;
}

/** 一块素材别超过窗口的百分之五，免得单块就把新会话压满。 */
function deriveChunkChars(settings, budget) {
  if (budget?.contextWindow === undefined) return settings.chunkChars;
  const cap = Math.max(1500, Math.floor(budget.contextWindow * 0.05));
  return Math.min(settings.chunkChars, cap);
}

/**
 * 用模型自己的预算决定投递方式。
 * 分支会整段继承上下文，所以只有当「已经占的 + 接下来写稿还要用的」装得下时才 fork；
 * 窗口或用量读不到，就退回按字数判，绝不硬来。
 */
function decideDelivery({ budget, materialChars, settings }) {
  const { usedTokens, contextWindow } = budget;

  if (settings.forkLimit > 0 && materialChars > settings.forkLimit) {
    return {
      mode: 'chunked',
      reason: `素材 ${materialChars} 字，超过配置的 forkLimit ${settings.forkLimit} 字`,
    };
  }

  if (usedTokens !== undefined && contextWindow !== undefined) {
    const ratio = usedTokens / contextWindow;
    const percent = Math.round(ratio * 100);
    if (ratio > settings.forkWindowRatio) {
      return {
        mode: 'chunked',
        reason: `模型窗口 ${contextWindow} token，这段对话已经占 ${usedTokens} token（${percent}%），超过 ${Math.round(settings.forkWindowRatio * 100)}% 就不再派生分支`,
      };
    }
    return {
      mode: 'fork',
      reason: `模型窗口 ${contextWindow} token，这段对话占 ${usedTokens} token（${percent}%），分支继承得起`,
    };
  }

  if (materialChars > settings.charFallback) {
    return {
      mode: 'chunked',
      reason: `读不到模型窗口，按字数判：素材 ${materialChars} 字，超过 ${settings.charFallback} 字`,
    };
  }
  return {
    mode: 'fork',
    reason: `读不到模型窗口，按字数判：素材 ${materialChars} 字，分支继承得起`,
  };
}

/** 把素材写成文件；返回实际写出的块数与目录。 */
async function writeMaterial(ctx, cwd, sessionId, chunks, stamp, signal) {
  const shortId = String(sessionId).replace(/[^0-9a-zA-Z]/gu, '').slice(-8);
  const dirName = `听书稿素材_${stamp}_${shortId}`;
  const dirPath = joinPath(cwd, dirName);
  const dirTarget = await ctx.fs.resolve(dirName, { cwd, signal });
  await ctx.fs.mkdir?.(dirTarget, signal);

  for (let index = 0; index < chunks.length; index += 1) {
    const name = `${pad2(index + 1)}.txt`;
    const target = await ctx.fs.resolve(name, { cwd: dirPath, signal });
    await ctx.fs.writeText(target, chunks[index], undefined, signal);
  }
  return { dirPath, dirName, written: chunks.length };
}

/** 一个操作：算文件名 → 量素材 → 选投递方式 → 下达命令。命令与工具共用这里。 */
async function launch(ctx, agent, options, settings, signal) {
  const sessionId = agent?.session?.header?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, text: '拿不到当前会话标识，无法派生分支。' };
  }

  const timeZone = typeof settings.timeZone === 'string' && settings.timeZone.length > 0 ? settings.timeZone : 'Asia/Shanghai';
  const minutes = options.minutes > 0 ? options.minutes : settings.minutes > 0 ? settings.minutes : DEFAULT_MINUTES;

  const cwd = await resolveWorkspace(ctx, agent, signal);
  const fallbackTopic = sanitizeTopic(pathBaseName(cwd)) || FALLBACK_TOPIC;
  const topic = sanitizeTopic(options.topic) || fallbackTopic;
  const stamp = todayStamp(timeZone);
  const version = await nextVersion(ctx, cwd, topic, stamp, signal);
  const fileName = `听书稿_${topic}_${stamp}_v${version}.txt`;
  const outPath = joinPath(cwd, fileName);

  // 先量两样东西：这段对话的正文素材，和模型这边的真实预算。
  const surface = await readSurface(ctx, sessionId);
  const transcript = surface === undefined ? '' : buildTranscript(surface.events);
  const materialChars = transcript.length;
  const budget = measureBudget(ctx, agent);
  const decision = decideDelivery({ budget, materialChars, settings });

  const job = { topic, stamp, version, outPath, fileName, minutes, extra: options.extra.trim() };

  if (decision.mode === 'fork') {
    let childSessionId;
    try {
      const forked = await ctx.sessionController.fork({ sessionId });
      childSessionId = forked?.sessionId;
    } catch (error) {
      const code = error?.code === undefined ? '' : `（${String(error.code)}）`;
      const message = error?.message === undefined ? String(error) : String(error.message);
      return {
        ok: false,
        text: `派生分支失败${code}：${message}\n如果提示没有可用的轮次，先在这个会话里聊完一轮再试。`,
      };
    }
    if (typeof childSessionId !== 'string' || childSessionId.length === 0) {
      return { ok: false, text: '派生分支失败：没有拿到子会话标识。' };
    }
    try {
      await ctx.sessionController.prompt(
        {
          requestId: uniqueId(),
          sessionId: childSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: buildPrompt(job) }],
          clientTimeZone: timeZone,
        },
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      const message = error?.message === undefined ? String(error) : String(error.message);
      return {
        ok: false,
        text: `分支已经分出来了（${childSessionId}），但命令没投递成功：${message}\n可以打开那条分支手工再发一次。`,
      };
    }
    return {
      ok: true,
      mode: 'fork',
      childSessionId,
      fileName,
      outPath,
      topic,
      stamp,
      version,
      minutes,
      materialChars,
      text: [
        '已经分出一条分支，并把写作命令投给它了。',
        `分支会话：${childSessionId}`,
        `目标文件：${outPath}`,
        `主题：${topic}　日期：${stamp}　当日第 ${version} 版　目标时长：约 ${minutes} 分钟`,
        `投递方式：分支继承上下文（${decision.reason}）`,
        '分支是独立会话，它会自己写完并回你一份自检报告；这里只能等它完成，不能替它写。',
      ].join('\n'),
    };
  }

  // 预算装不下：切块落盘，再开一个空会话按块写，避免一开局就顶到上下文上限。
  const chunkChars = deriveChunkChars(settings, budget);
  const chunks = planChunks(transcript, chunkChars, MAX_CHUNKS);
  if (chunks.length === 0) {
    return { ok: false, text: `读到了 ${materialChars} 字素材，但切块后是空的，没法开工。` };
  }

  let material;
  try {
    material = await writeMaterial(ctx, cwd, sessionId, chunks, stamp, signal);
  } catch (error) {
    const message = error?.message === undefined ? String(error) : String(error.message);
    return { ok: false, text: `素材落盘失败：${message}\n（目标目录应该在 ${cwd} 下）` };
  }

  let childSessionId;
  try {
    const created = await ctx.sessionController.create({ cwd });
    childSessionId = created?.sessionId;
  } catch (error) {
    const message = error?.message === undefined ? String(error) : String(error.message);
    return {
      ok: false,
      text: `素材已经切好（${material.dirPath}，${material.written} 块），但开新会话失败：${message}`,
    };
  }
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) {
    return { ok: false, text: `素材已经切好（${material.dirPath}），但没拿到新会话标识。` };
  }

  const perSectionChars = Math.max(
    120,
    Math.round((minutes * CHARS_PER_MINUTE) / material.written),
  );
  const prompt = buildChunkedPrompt({
    ...job,
    materialDir: material.dirPath,
    chunkCount: material.written,
    perSectionChars,
  });

  try {
    await ctx.sessionController.prompt(
      {
        requestId: uniqueId(),
        sessionId: childSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: timeZone,
      },
      signal ?? new AbortController().signal,
    );
  } catch (error) {
    const message = error?.message === undefined ? String(error) : String(error.message);
    return {
      ok: false,
      text: `会话已经开好（${childSessionId}）、素材已落盘（${material.dirPath}），但命令没投递成功：${message}`,
    };
  }

  return {
    ok: true,
    mode: 'chunked',
    childSessionId,
    fileName,
    outPath,
    topic,
    stamp,
    version,
    minutes,
    materialChars,
    materialDir: material.dirPath,
    chunkCount: material.written,
    text: [
      '这段对话按模型自己的预算装不下，直接派生分支会一开局就顶到上下文上限，所以改走「素材分块 + 新会话」。',
      `判断依据：${decision.reason}`,
      `新会话：${childSessionId}`,
      `素材目录：${material.dirPath}（${material.written} 块，共 ${materialChars} 字，每块约 ${chunkChars} 字）`,
      `目标文件：${outPath}`,
      `主题：${topic}　日期：${stamp}　当日第 ${version} 版　目标时长：约 ${minutes} 分钟`,
      `写作方式：一块读一次、写一节（每节约 ${perSectionChars} 字），最后按序拼成一稿。`,
      '新会话是独立的，它会自己跑完并回你一份自检报告；这里只能等它完成。',
    ].join('\n'),
  };
}

export const name = 'dsh-tingshu-branch';

export const inject = ['commands', 'tools', 'sessionController', 'fs', 'workingDirectory'];

export function apply(ctx, config) {
  const minutesConfig = Number(config?.minutes);
  const forkLimitConfig = Number(config?.forkLimit);
  const chunkCharsConfig = Number(config?.chunkChars);
  const ratioConfig = Number(config?.forkWindowRatio);
  const charFallbackConfig = Number(config?.charFallback);
  const timeZoneConfig = typeof config?.timeZone === 'string' ? config.timeZone : '';
  /** 配置在安装期算好一次；launch 每次调用都拿它的快照，不往 ctx 上挂东西。 */
  const settings = Object.freeze({
    minutes: Number.isFinite(minutesConfig) && minutesConfig > 0 ? Math.round(minutesConfig) : DEFAULT_MINUTES,
    timeZone: timeZoneConfig.length > 0 ? timeZoneConfig : 'Asia/Shanghai',
    /** 0（默认）＝完全按模型预算决定；正数＝额外加一道字数硬闸，两条任一触发就分块。 */
    forkLimit: Number.isFinite(forkLimitConfig) && forkLimitConfig > 0 ? Math.round(forkLimitConfig) : 0,
    forkWindowRatio:
      Number.isFinite(ratioConfig) && ratioConfig > 0 && ratioConfig < 1 ? ratioConfig : DEFAULT_FORK_WINDOW_RATIO,
    charFallback:
      Number.isFinite(charFallbackConfig) && charFallbackConfig > 0 ? Math.round(charFallbackConfig) : DEFAULT_CHAR_FALLBACK,
    chunkChars: Number.isFinite(chunkCharsConfig) && chunkCharsConfig > 0 ? Math.round(chunkCharsConfig) : DEFAULT_CHUNK_CHARS,
  });

  ctx.effect(
    () =>
      ctx.commands.register({
        definitionId: 'dsh-tingshu-branch',
        name: COMMAND_NAME,
        description:
          '把当前会话整理成一份适合听的口语化 txt 听书稿，文件名自带日期与当日版本号。会先读模型的上下文窗口和实际占用，装得下就派生分支继承上下文，装不下就切成素材块、另开一个空会话分块写，不会顶爆上下文。',
        input: { hint: '[-t 主题] [-m 分钟] [本次额外要求，可留空]' },
        handler: async (invocation) => {
          const options = parseRawInput(invocation?.rawInput);
          const result = await launch(ctx, invocation?.agent, options, settings, invocation?.signal);
          return result.ok
            ? { kind: 'success', text: result.text }
            : { kind: 'error', text: result.text };
        },
      }),
    'register /tingshu command',
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description:
          '把当前会话整理成一份口语化、适合听的 txt 听书稿，文件名自动带日期与当日版本号。会先读模型的上下文窗口和实际占用，装得下就派生分支继承上下文，装不下就切成素材块、另开一个空会话分块写，不会顶爆上下文。用户想「把这次对话做成听书稿」时用它；不要在同一个会话里自己写稿。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '稿件主题，用在文件名里；留空则取当前工作目录名。' },
            minutes: { type: 'integer', minimum: 1, maximum: 600, description: '目标收听时长（分钟），留空用默认值。' },
            extra: { type: 'string', description: '本次的额外要求，原样带给目标会话。' },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        timeoutMs: 120000,
        execute: async (args, exec) => {
          const agent = exec?.agent;
          if (agent === undefined) throw new Error('这个工具只能在会话里调用。');
          const minutesRaw = Number(args?.minutes);
          const options = {
            topic: typeof args?.topic === 'string' ? args.topic : '',
            minutes: Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.round(minutesRaw) : 0,
            extra: typeof args?.extra === 'string' ? args.extra : '',
          };
          const result = await launch(ctx, agent, options, settings, exec?.signal);
          if (!result.ok) throw new Error(result.text);
          return result.text;
        },
      }),
    'register tingshu_branch tool',
  );
}

/** 只给离线自测用，不参与运行时。 */
export const __test = {
  launch,
  measureBudget,
  decideDelivery,
  deriveChunkChars,
  buildTranscript,
  planChunks,
  buildPrompt,
  buildChunkedPrompt,
  stripNoise,
  todayStamp,
};
