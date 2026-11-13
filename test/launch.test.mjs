// 用桩件跑 launch() 的两条分支，验证 fs / sessionController 的调用姿势对不对。
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

function makeCtx({ events, forkFails = false }) {
  const written = [];
  const prompts = [];
  const forked = [];
  const created = [];
  const madeDirs = [];

  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return { readSurface: async () => ({ events }) };
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

const agent = { session: { header: { id: 'session-abcdef12-3456-7890', cwd: CWD } } };
const settings = { minutes: 75, timeZone: 'Asia/Shanghai', forkLimit: 45000, chunkChars: 6000 };

// ── 一、短对话：应该 fork，不写素材 ────────────────────────────────
{
  const h = makeCtx({ events: makeEvents(3000) });
  const result = await t.launch(h.ctx, agent, { topic: '短测试', minutes: 20, extra: '' }, settings, undefined);
  assert(result.ok === true, '短对话：成功');
  assert(result.mode === 'fork', '短对话：走 fork');
  assert(h.forked.length === 1 && h.forked[0].sessionId === agent.session.header.id, '短对话：fork 收到了源会话 id');
  assert(h.written.length === 0, '短对话：没有写素材文件');
  assert(h.prompts.length === 1, '短对话：命令投递了一次');
  assert(h.prompts[0].mode === 'queue' && h.prompts[0].sessionId === 'child-fork', '短对话：投给分支、queue 模式');
  assert(h.prompts[0].clientTimeZone === 'Asia/Shanghai', '短对话：带上时区');
  assert(result.outPath === `${CWD}\\听书稿_短测试_${result.stamp}_v1.txt`, '短对话：输出路径按命名规则拼好');
}

// ── 二、长对话：应该切块 + 开新会话 ────────────────────────────────
{
  const h = makeCtx({ events: makeEvents(120000) });
  const result = await t.launch(h.ctx, agent, { topic: '长测试', minutes: 60, extra: '多讲坑' }, settings, undefined);
  assert(result.ok === true, '长对话：成功');
  assert(result.mode === 'chunked', '长对话：走分块');
  assert(h.forked.length === 0, '长对话：没有 fork（不然一开局就爆上下文）');
  assert(h.madeDirs.length === 1, '长对话：建了素材目录');
  assert(result.materialDir.startsWith(`${CWD}\\听书稿素材_`), '长对话：素材目录在会话目录下');
  assert(h.written.length === result.chunkCount, '长对话：写出的块数与报告一致');
  assert(h.written.every((w) => w.path.startsWith(result.materialDir + '\\')), '长对话：块文件都落在素材目录里');
  assert(h.written[0].path.endsWith('\\01.txt'), '长对话：第一块叫 01.txt');
  assert(h.created.length === 1 && h.created[0].cwd === CWD, '长对话：用 cwd 开了新会话');
  assert(h.prompts.length === 1 && h.prompts[0].sessionId === 'child-new', '长对话：命令投给新会话');
  const text = h.prompts[0].content[0].text;
  assert(text.includes('节01.txt') && text.includes('01.txt'), '长对话：命令给了读写文件名');
  assert(text.includes(result.outPath), '长对话：命令钉死了最终输出路径');
  assert(text.includes('多讲坑'), '长对话：带上了额外要求');
  assert(!text.includes('undefined') && !text.includes('NaN'), '长对话：命令无空洞值');
  console.log('\n--- 命令片段 ---\n' + text.split('\n').slice(0, 24).join('\n') + '\n');
}

// ── 三、fork 失败要给能看懂的原因 ──────────────────────────────────
{
  const h = makeCtx({ events: makeEvents(2000), forkFails: true });
  const result = await t.launch(h.ctx, agent, { topic: '失败', minutes: 30, extra: '' }, settings, undefined);
  assert(result.ok === false, 'fork 失败：如实返回失败');
  assert(result.text.includes('session/fork-unavailable'), 'fork 失败：带上错误码');
  assert(result.text.includes('先在这个会话里聊完一轮'), 'fork 失败：给出下一步该做什么');
}

console.log('\nALL PASS (launch)');
