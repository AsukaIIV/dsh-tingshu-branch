// 预算驱动的投递决策：不依赖任何硬编码字数线。
const m = await import('file:///C:/Users/User/.dsh/plugins/dsh-tingshu-branch/index.js');
const t = m.__test;

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok  ' + msg);
}

const settings = { minutes: 75, timeZone: 'Asia/Shanghai', forkLimit: 0, forkWindowRatio: 0.5, charFallback: 45000, chunkChars: 6000 };

// ── 一、窗口和用量都读得到：按比例判 ──────────────────────────────
{
  const budget = { usedTokens: 20000, contextWindow: 100000 };
  const d = t.decideDelivery({ budget, materialChars: 60000, settings });
  assert(d.mode === 'fork', '占用两成：派生分支（虽然素材有六万字）');
  assert(d.reason.includes('100000') && d.reason.includes('20000') && d.reason.includes('20%'), '理由里写清了窗口、占用和百分比');
}
{
  const budget = { usedTokens: 70000, contextWindow: 100000 };
  const d = t.decideDelivery({ budget, materialChars: 5000, settings });
  assert(d.mode === 'chunked', '占用七成：改走分块（哪怕素材只有五千字）');
  assert(d.reason.includes('70%'), '理由里写清了占用比例');
}
{
  // 刚好在线上：0.5 不算超，仍走分支
  const d = t.decideDelivery({ budget: { usedTokens: 50000, contextWindow: 100000 }, materialChars: 1000, settings });
  assert(d.mode === 'fork', '正好一半：仍走分支（阈值是「超过」才切）');
}
{
  // 小窗口模型：同样的占用比例，但窗口只有三万二
  const d = t.decideDelivery({ budget: { usedTokens: 18000, contextWindow: 32000 }, materialChars: 2000, settings });
  assert(d.mode === 'chunked', '窗口小的模型在同样的绝对占用下更早分块');
}

// ── 二、读不到预算：退回字数兜底，并且说明白 ──────────────────────
{
  const d = t.decideDelivery({ budget: { usedTokens: undefined, contextWindow: undefined }, materialChars: 30000, settings });
  assert(d.mode === 'fork', '读不到预算 + 三万字段素材：走分支');
  assert(d.reason.includes('读不到模型窗口'), '理由里明说是按字数兜底的');
}
{
  const d = t.decideDelivery({ budget: { usedTokens: undefined, contextWindow: undefined }, materialChars: 80000, settings });
  assert(d.mode === 'chunked', '读不到预算 + 八万字素材：分块');
}
{
  // 只有窗口没有用量，或只有用量没有窗口，都算「读不到」
  const onlyWindow = t.decideDelivery({ budget: { contextWindow: 100000 }, materialChars: 80000, settings });
  assert(onlyWindow.mode === 'chunked' && onlyWindow.reason.includes('读不到模型窗口'), '只有窗口没有用量：也退字数兜底');
  const onlyUsed = t.decideDelivery({ budget: { usedTokens: 1000 }, materialChars: 80000, settings });
  assert(onlyUsed.mode === 'chunked' && onlyUsed.reason.includes('读不到模型窗口'), '只有用量没有窗口：也退字数兜底');
}

// ── 三、用户显式配了 forkLimit：额外一道硬闸 ──────────────────────
{
  const strict = { ...settings, forkLimit: 10000 };
  const d = t.decideDelivery({ budget: { usedTokens: 1000, contextWindow: 100000 }, materialChars: 20000, settings: strict });
  assert(d.mode === 'chunked', '配了 forkLimit：字数超闸就分块，不看预算');
  assert(d.reason.includes('forkLimit'), '理由里点名是配置的字数闸');
}

// ── 四、分块大小跟着窗口走 ────────────────────────────────────────
{
  assert(t.deriveChunkChars(settings, { contextWindow: 1000000 }) === 6000, '窗口很大：仍是默认六千字一块');
  assert(t.deriveChunkChars(settings, { contextWindow: 40000 }) === 2000, '窗口四万：一块压到两千字（窗口的百分之五）');
  assert(t.deriveChunkChars(settings, { contextWindow: 8000 }) === 1500, '窗口很小时有下限一千五，不至于碎成渣');
  assert(t.deriveChunkChars(settings, {}) === 6000, '窗口不知道：用默认');
}

// ── 五、measureBudget 从真服务读数据 ──────────────────────────────
{
  const ctx = {
    get(name) {
      if (name !== 'tokenMeter') return undefined;
      return { measure: () => ({ totalTokens: 41234, surfaceTokens: 30000 }) };
    },
  };
  const agent = { session: { requestContext: () => ({ provider: 'cn', model: 'hy4', contextWindow: 200000 }) } };
  const b = t.measureBudget(ctx, agent);
  assert(b.usedTokens === 41234, 'measureBudget：读到 tokenMeter 的 totalTokens');
  assert(b.contextWindow === 200000 && b.model === 'hy4', 'measureBudget：读到 requestContext 的窗口与模型名');
}
{
  // 服务缺失 / 抛错都不能把插件带崩
  const broken = {
    get() {
      throw new Error('nope');
    },
  };
  const agent = {
    session: {
      requestContext() {
        throw new Error('no context');
      },
    },
  };
  const b = t.measureBudget(broken, agent);
  assert(b.usedTokens === undefined && b.contextWindow === undefined, 'measureBudget：服务全挂时安静降级，不抛错');
}

console.log('\nALL PASS (budget)');
