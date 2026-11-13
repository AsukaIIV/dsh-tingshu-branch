const m = await import(new URL('../index.js', import.meta.url).href);
const t = m.__test;

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok  ' + msg);
}

// ── 造一个像超长会话的素材：400 轮，含噪声与工具调用 ────────────────
const events = [];
for (let i = 0; i < 400; i += 1) {
  events.push({
    type: 'user/message',
    data: {
      content: [
        {
          type: 'text',
          text:
            '<system-reminder>tools available blah</system-reminder>\n' +
            `<acp tokens="12" type="text" time="2026-11-13 10:00:00">m${String(i).padStart(5, '0')}</acp>\n` +
            `用户第${i}次提问：这一步为什么这样设计，我们到底要不要继续往下走，我担心的是精度和速度两边都顾不过来。` +
            '再补一句上下文，把上一轮讨论过的判据也带上，免得前后矛盾。'.repeat(3),
        },
      ],
    },
  });
  events.push({
    type: 'assistant/tool-call',
    data: { name: 'pwsh', arguments: '{"command":"Get-ChildItem -Recurse | Measure-Object"}' },
  });
  events.push({
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '这里是思维链，必须被丢掉，因为它不该出现在听书稿里。' },
          { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"dir"}' },
          {
            type: 'text',
            text:
              `第${i}轮回答：这件事的关键在于把两个问题拆开看。先是数据口径，然后是模型容量。` +
              '我们把能复现的部分都落到文件里，所以后面每一个数字都能指名到唯一来源。'.repeat(3) +
              '\n\nTime sampled while preparing turn 3\nBrowser time zone: Asia/Shanghai',
          },
        ],
      },
    },
  });
}

const transcript = t.buildTranscript(events);
console.log('transcript chars =', transcript.length);
assert(transcript.length > 100000, '素材抽出来超过十万字，能触发分块线');
assert(!transcript.includes('system-reminder'), '噪声：system-reminder 已清除');
assert(!transcript.includes('<acp'), '噪声：acp 标签已清除');
assert(!transcript.includes('Time sampled while'), '噪声：时间采样行已清除');
assert(!transcript.includes('思维链'), 'reasoning 块未进入素材');
assert(!transcript.includes('Get-ChildItem -Recurse'), '工具调用参数未进入素材');
assert(transcript.includes('【你说】') && transcript.includes('【我说】'), '说话人标注存在');

// ── 分块 ────────────────────────────────────────────────────────────
const chunks = t.planChunks(transcript, 6000, 60);
console.log('chunks =', chunks.length, 'sizes =', chunks.map((c) => c.length).join(','));
assert(chunks.length >= 15 && chunks.length <= 60, '块数落在合理区间，且不超过上限');
assert(chunks.every((c) => c.length <= 6600), '每块不超过目标字数（少量溢出允许）');
assert(chunks.join('').replace(/\s/gu, '').length === transcript.replace(/\s/gu, '').length, '切块没有丢字');
assert(chunks[0].startsWith('【你说】'), '第一块从开头开始，顺序没乱');

// 极端情况：一块就够
const small = t.planChunks(t.buildTranscript(events.slice(0, 4)), 6000, 60);
assert(small.length === 1, '短素材切成一块');

// 极端情况：块数超过上限时自动变粗
const veryLong = t.planChunks('甲'.repeat(1000000), 6000, 60);
console.log('veryLong chunks =', veryLong.length);
assert(veryLong.length <= 60, '超长文本被压到上限块数以内');

// ── 命令全文 ────────────────────────────────────────────────────────
const job = {
  topic: '冒烟测试',
  stamp: '20261113',
  version: 2,
  outPath: 'C:\\Users\\User\\Desktop\\论文复刻\\听书稿_冒烟测试_20261113_v2.txt',
  fileName: '听书稿_冒烟测试_20261113_v2.txt',
  minutes: 75,
  extra: '多讲一点踩过的坑',
};
const p1 = t.buildPrompt(job);
assert(p1.includes(job.outPath) && p1.includes('当天第 2 版'), 'fork 命令里钉死了输出路径与版本号');
assert(p1.includes('多讲一点踩过的坑'), 'fork 命令带上了额外要求');
assert(!p1.includes('undefined') && !p1.includes('NaN'), 'fork 命令无空洞值');

const p2 = t.buildChunkedPrompt({
  ...job,
  materialDir: 'C:\\Users\\User\\Desktop\\论文复刻\\听书稿素材_20261113_abcdef12',
  chunkCount: chunks.length,
  perSectionChars: 320,
});
assert(p2.includes('听书稿素材_20261113_abcdef12'), '分块命令带上素材目录');
assert(p2.includes('01.txt') && p2.includes('节01.txt'), '分块命令给出读写文件名');
assert(p2.includes(job.outPath), '分块命令带上最终输出路径');
assert(p2.includes('UTF8Encoding($false)'), '分块命令给出无 BOM 的拼接写法');
assert(!p2.includes('undefined') && !p2.includes('NaN'), '分块命令无空洞值');
assert(p2.includes('新会话') || p2.includes('没有继承'), '分块命令交代了「你是新会话」');

console.log('stamp =', t.todayStamp('Asia/Shanghai'), t.todayStamp('UTC'));
console.log('\nALL PASS');
