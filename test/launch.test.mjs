// 用桩件跑 launch() 的两条分支，验证 fs / sessionController 的调用姿势、以及「按模型预算决定」是否真的生效。
const m = await import(new URL('../index.js', import.meta.url).href);
const t = m.__test;

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok  ' + msg);
}

const CWD = 'C:\\Users\\User\\Desktop\\论文复刻';

function makeEvents(chars) {
  const events = [];
  let total = 0;
  let i = 0;
  while (total < chars) {
    const text = `第${i}轮：这里讲清楚一个设计取舍，为什么这么做，后来发现哪里不对，怎么改的。`.repeat(6);
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: '提问：' + text }] } });
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答：' + text }] } } });
    total += text.length * 2;
    i += 1;
  }
  return events;
}

/**
 * 桩件：`budget` 为 undefined 时表示宿主没给 tokenMeter / requestContext，
 * 插件应当退回字数兜底。
 */
function makeCtx({ events, forkFails = false, budget }) {
  const written = [];
  const prompts = [];
  const forked = [];
  const created = [];
  const madeDirs = [];

  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return { readSurface: async () => ({ events }) };
      if (name === 'tokenMeter' && budget !== undefined) {
        return { measure: () => ({ totalTokens: budget.usedTokens, surfaceTokens: budget.usedTokens }) };
      }
      return undefined;
    },
    fs: {
      async resolve(path, opts) {
        return { path, cwd: opts?.cwd };
      },
      processPath(target) {
        return target.cwd ? `${target.cwd}\\${target.path}` : target.path;
      },
      async mkdir(target) {
        madeDirs.push(target.cwd ? `${target.cwd}\\${target.path}` : target.path);
      },
      async listDir() {
        return [];
      },
      async writeText(target, content) {
        written.push({ path: target.cwd ? `${target.cwd}\\${target.path}` : target.path, content });
      },
    },
    sessionController: {
      async fork(request) {
        forked.push(request);
        if (forkFails) {
          const error = new Error('session "x" has no completed turn to fork from');
          error.code = 'session/fork-unavailable';
          throw error;
        }
        return { sessionId: 'child-fork' };
      },
      async create(request) {
        created.push(request);
        return { sessionId: 'child-new' };
      },
      async prompt(request) {
        prompts.push(request);
        return { accepted: true };
      },
    },
  };
  return { ctx, written, prompts, forked, created, madeDirs };
}

function makeAgent(budget) {
  return {
    session: {
      header: { id: 'session-abcdef12-3456-7890', cwd: CWD },
      requestContext: budget === undefined ? undefined : () => ({ provider: 'cn', model: 'hy4', contextWindow: budget.contextWindow }),
    },
  };
}

const settings = {
  minutes: 75,
  timeZone: 'Asia/Shanghai',
  forkLimit: 0,
  forkWindowRatio: 0.5,
  charFallback: 45000,
  chunkChars: 6000,
};

// ── 一、预算宽松：fork，不写素材 ──────────────────────────────────
{
  const budget = { usedTokens: 20000, contextWindow: 100000 };
  const h = makeCtx({ events: makeEvents(3000), budget });
  const agent = makeAgent(budget);
  const result = await t.launch(h.ctx, agent, { topic: '短测试', minutes: 20, extra: '' }, settings, undefined);
  assert(result.ok === true, '预算宽松：成功');
  assert(result.mode === 'fork', '预算宽松：走 fork');
  assert(h.forked.length === 1 && h.forked[0].sessionId === agent.session.header.id, '预算宽松：fork 收到了源会话 id');
  assert(h.written.length === 0, '预算宽松：没有写素材文件');
  assert(h.prompts.length === 1, '预算宽松：命令投递了一次');
  assert(h.prompts[0].mode === 'queue' && h.prompts[0].sessionId === 'child-fork', '预算宽松：投给分支、queue 模式');
  assert(h.prompts[0].clientTimeZone === 'Asia/Shanghai', '预算宽松：带上时区');
  assert(result.outPath === `${CWD}\\听书稿_短测试_${result.stamp}_v1.txt`, '预算宽松：输出路径按命名规则拼好');
  assert(result.text.includes('100000') && result.text.includes('20000'), '预算宽松：返回里写清了窗口与占用');
}

// ── 二、预算吃紧：分块 + 开新会话（哪怕素材只有几千字） ────────────
{
  const budget = { usedTokens: 78000, contextWindow: 100000 };
  const h = makeCtx({ events: makeEvents(6000), budget });
  const agent = makeAgent(budget);
  const result = await t.launch(h.ctx, agent, { topic: '长测试', minutes: 60, extra: '多讲坑' }, settings, undefined);
  assert(result.ok === true, '预算吃紧：成功');
  assert(result.mode === 'chunked', '预算吃紧：走分块');
  assert(h.forked.length === 0, '预算吃紧：没有 fork（不然一开局就爆上下文）');
  assert(h.madeDirs.length === 1, '预算吃紧：建了素材目录');
  assert(result.materialDir.startsWith(`${CWD}\\听书稿素材_`), '预算吃紧：素材目录在会话目录下');
  assert(h.written.length === result.chunkCount, '预算吃紧：写出的块数与报告一致');
  assert(h.written.every((w) => w.path.startsWith(result.materialDir + '\\')), '预算吃紧：块文件都落在素材目录里');
  assert(h.written[0].path.endsWith('\\01.txt'), '预算吃紧：第一块叫 01.txt');
  assert(h.created.length === 1 && h.created[0].cwd === CWD, '预算吃紧：用 cwd 开了新会话');
  assert(h.prompts.length === 1 && h.prompts[0].sessionId === 'child-new', '预算吃紧：命令投给新会话');
  assert(result.text.includes('78%') || result.text.includes('78000'), '预算吃紧：返回里交代了判断依据');
  const text = h.prompts[0].content[0].text;
  assert(text.includes('节01.txt') && text.includes('01.txt'), '预算吃紧：命令给了读写文件名');
  assert(text.includes(result.outPath), '预算吃紧：命令钉死了最终输出路径');
  assert(text.includes('多讲坑'), '预算吃紧：带上了额外要求');
  assert(!text.includes('undefined') && !text.includes('NaN'), '预算吃紧：命令无空洞值');
}

// ── 三、宿主不给预算：退回字数兜底 ────────────────────────────────
{
  const h = makeCtx({ events: makeEvents(80000) });
  const agent = makeAgent(undefined);
  const result = await t.launch(h.ctx, agent, { topic: '兜底', minutes: 40, extra: '' }, settings, undefined);
  assert(result.ok === true && result.mode === 'chunked', '没有预算 + 八万字：走分块');
  assert(result.text.includes('读不到模型窗口'), '没有预算：返回里说明是按字数兜底的');
}
{
  const h = makeCtx({ events: makeEvents(5000) });
  const agent = makeAgent(undefined);
  const result = await t.launch(h.ctx, agent, { topic: '兜底二', minutes: 40, extra: '' }, settings, undefined);
  assert(result.ok === true && result.mode === 'fork', '没有预算 + 五千字：仍走分支');
}

// ── 四、fork 失败要给能看懂的原因 ─────────────────────────────────
{
  const budget = { usedTokens: 1000, contextWindow: 100000 };
  const h = makeCtx({ events: makeEvents(2000), forkFails: true, budget });
  const agent = makeAgent(budget);
  const result = await t.launch(h.ctx, agent, { topic: '失败', minutes: 30, extra: '' }, settings, undefined);
  assert(result.ok === false, 'fork 失败：如实返回失败');
  assert(result.text.includes('session/fork-unavailable'), 'fork 失败：带上错误码');
  assert(result.text.includes('先在这个会话里聊完一轮'), 'fork 失败：给出下一步该做什么');
}

console.log('\nALL PASS (launch)');
