/**
 * dsh-tingshu-branch — 听书稿分支。
 *
 * 一个操作，两个调用方（见 references/user-actions.md）：
 *   - 人：composer 里的 `/tingshu` 命令
 *   - 模型：`tingshu_branch` 工具
 * 两者都走同一个 launch()。
 *
 * 这个插件本身不写稿。它做三件确定性的事，然后把写作交给分支：
 *   1. 算日期与当日版本号，定死输出文件的绝对路径；
 *   2. 用 sessionController.fork 把当前会话分出一个分支（继承已完成的上下文）；
 *   3. 用 sessionController.prompt 把命令全文投给分支，让分支自己开写。
 */

const COMMAND_NAME = 'tingshu';
const TOOL_NAME = 'tingshu_branch';
const DEFAULT_MINUTES = 75;
/** 中文口播的大致字速，用来把「多少分钟」换算成字数。 */
const CHARS_PER_MINUTE = 260;

export const name = 'dsh-tingshu-branch';
export const inject = ['commands', 'tools', 'sessionController', 'fs'];

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

/**
 * 发给分支的命令全文。这是插件的产品本体：一份与项目无关的写作规格，
 * 只有输出路径、主题、日期版本与篇幅是插件算好的。
 */
function buildPrompt(job) {
  const { topic, stamp, version, outPath, fileName, minutes, extra } = job;
  const targetChars = minutes * CHARS_PER_MINUTE;
  const extraBlock =
    extra.length === 0
      ? ''
      : `\n【这一次的额外要求】\n用户还提了这句话，能照做就照做，做不到就用一句自然的话说明为什么：\n${extra}\n`;

  return `你在这个分支里工作。这个分支是从一个进行中的对话派生出来的，继承了那条对话里已经完成的全部上下文。你现在只做一件事：把这些上下文整理成一份适合用耳朵听的口语化 txt 听书稿，写到下面这个确切路径。

【主题】
${topic}

【输出文件】
绝对路径：${outPath}
文件名：${fileName}
编码：UTF-8，不带 BOM，不要写成 Markdown。
这个路径已经算好：日期是 ${stamp}，当天第 ${version} 版，且文件当前不存在。请原样使用——不要改名、不要改日期、不要改版本号、不要另建目录、不要覆盖同名文件。如果写入时发现文件已存在，把版本号加一改个新名字，并在最后告诉我你实际用的文件名。

【篇幅】
目标收听时长约 ${minutes} 分钟。中文口播大约每分钟 ${CHARS_PER_MINUTE} 字，所以正文控制在 ${targetChars} 字上下（上下浮动两成都可以）。宁可讲透几件事，也不要平铺一堆没讲清楚的事。

【内容来源：只用真的发生过的事】
一、素材就是你在本分支里能看到的这段对话：做过什么、卡在哪里、怎么解决的、最后落在什么结论上。
二、对话里点到的报告、规格、任务书、脚本、数据文件，先读一遍再写；读不到的就不要写那些细节。
三、严禁编造。不虚构数字、不虚构实验、不虚构引用。记忆和文件对不上时以文件为准，并且可以直接告诉听众：当时记的是这样，文件里其实是那样。
四、这份稿子不新增任何实验，不跑训练，不改动项目里的其它文件。你只写这一个 txt。
五、弯路、返工、失败的尝试要保留。这类稿子最有价值的部分往往不是结果，而是"本来以为会怎样、后来发现不是"。${extraBlock}
【结构】
一、开头给一小段收听说明：这份稿子讲什么、素材来自哪里、大概要听多久。
二、中间分成若干卷、若干章依次讲。每一章开头用一两句话交代这一章要讲什么，结尾用一两句话收束，让听众知道自己走到哪了。
三、章的顺序按"听的人能不能跟上"来排：先补必要的背景知识（如果听众可能是外行，就从零讲起，多用生活里的比方），再讲这条对话到底干了什么，最后讲结论、发现、经验教训和下一步。
四、结尾要有收束，不要突然截断。

【口吻】
像一个懂行的人坐在旁边给朋友讲，而不是念报告。可以用"我们""你"，可以适当感慨，但别煽情。该说"这一步我们其实做错了"就直说。

【为听而写：硬约束，写完逐条自查】
一、全文不出现阿拉伯数字。数字都用中文写：零点四八、二零二六年、百分之九十、第三章、十二点五分贝。
二、不出现英文缩写和术语原文。必须提到的名词，第一次给中文全称并解释一句，之后用中文简称。确实必须保留的字母标识最多留几个，第一次出现时交代一句"这个念作什么"。
三、不用列表、不用表格、不用代码块、不用反引号、不用星号加粗。全部是成段的口语。
四、句子短，能一口气读完。少用"首先、其次、综上所述"，多用"那么、所以、这里要注意"。
五、每讲完一个意思就空一行，给听众一个自然停顿。
六、不写"如上表所示""见图三"这种只有在纸上才成立的话。
七、少用括号；确需补充，就用一整句话讲出来。

【写完之后，在你的回复里逐项报告】
一、文件确实写到哪个绝对路径，一共多少行、多少字。
二、章节清单，一卷一行、一章一行。
三、全文阿拉伯数字出现次数，应该是零。
四、全文英文缩写出现次数，并列出你主动保留的那几个是哪些、念作什么。
五、是否出现了列表、表格、代码块，应该是零。
六、这份稿子听下来大概多少分钟。

一次成稿。不要反问用户，除非缺的信息会让稿子根本写不下去；那种情况也只问一个问题，然后继续往下写。写完后不要改动项目里任何其它文件。`;
}

/** 一个操作：算文件名 → 派生分支 → 下达命令。命令与工具共用这里。 */
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

  const prompt = buildPrompt({
    topic,
    stamp,
    version,
    outPath,
    fileName,
    minutes,
    extra: options.extra.trim(),
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
      text: `分支已经分出来了（${childSessionId}），但命令没投递成功：${message}\n可以打开那条分支手工再发一次。`,
    };
  }

  return {
    ok: true,
    childSessionId,
    fileName,
    outPath,
    topic,
    stamp,
    version,
    minutes,
    text: [
      `已经分出一条分支，并把写作命令投给它了。`,
      `分支会话：${childSessionId}`,
      `目标文件：${outPath}`,
      `主题：${topic}　日期：${stamp}　当日第 ${version} 版　目标时长：约 ${minutes} 分钟`,
      `分支是独立会话，它会自己写完并回你一份自检报告；这里只能等它完成，不能替它写。`,
    ].join('\n'),
  };
}

export function apply(ctx, config) {
  const minutesConfig = Number(config?.minutes);
  const timeZoneConfig = typeof config?.timeZone === 'string' ? config.timeZone : '';
  /** 配置在安装期算好一次；launch 每次调用都拿它的快照，不往 ctx 上挂东西。 */
  const settings = Object.freeze({
    minutes: Number.isFinite(minutesConfig) && minutesConfig > 0 ? Math.round(minutesConfig) : DEFAULT_MINUTES,
    timeZone: timeZoneConfig.length > 0 ? timeZoneConfig : 'Asia/Shanghai',
  });

  ctx.effect(
    () =>
      ctx.commands.register({
        definitionId: 'dsh-tingshu-branch',
        name: COMMAND_NAME,
        description:
          '把当前会话分出一个分支，让它把这段对话整理成一份适合听的口语化 txt 听书稿，文件名自带日期与当日版本号。',
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
          '为当前会话派生一个分支，并让分支把这段对话整理成一份口语化、适合听的 txt 听书稿，文件名自动带日期与当日版本号。用户想「把这次对话做成听书稿」时用它；不要在同一个会话里自己写稿。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '稿件主题，用在文件名里；留空则取当前工作目录名。' },
            minutes: { type: 'integer', minimum: 1, maximum: 600, description: '目标收听时长（分钟），留空用默认值。' },
            extra: { type: 'string', description: '本次的额外要求，原样带给分支。' },
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
