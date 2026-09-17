// 一键连点器 + 配装分析
// 支持：结界连点 / 灵台连砍 / 连续强化 / 按游戏推荐最优四件装备
(() => {
  // ================= 通用工具 =================
  const CLICK_GAP = 220;      // 基础点击间隔 ms
  const WAIT_ENABLED = 8000;  // 等按钮从 disabled 恢复的最长时间 ms
  const WAIT_MODAL = 4000;    // 等强化结果弹窗出现的最长时间 ms
  let autoClicking = false;

  const isLingtai = location.pathname.includes('lingtai');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 模拟一次真实点击（兼容 Vue 的事件监听）
  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.focus({ preventScroll: true }); } catch {}
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // 等按钮可用（Vue 会在请求期间 disable 它）。false = 超时仍不可用
  function waitEnabled(el, timeout) {
    const start = Date.now();
    return new Promise((resolve) => {
      (function check() {
        if (!el.disabled) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, 80);
      })();
    });
  }

  // ================= 按钮定位 =================
  const KEYWORDS = /抽奖|点击|结界|击打|攻击|开启|领取/i;
  const BATCH_RE = /连?砍\s*(\d+)\s*刀/;          // "砍 10 刀" / "连砍 10 刀"
  const ENHANCE_RE = /强化|灵木不足|已满级|Enhance/i;

  function findBatchChopBtn() {
    for (const el of document.querySelectorAll('button')) {
      if (!el.offsetParent) continue;
      if (BATCH_RE.test((el.innerText || '').trim())) return el;
    }
    // 兜底：单刀按钮（同 class 的"穿上"按钮按文字排除）
    for (const el of document.querySelectorAll('button.lt-btn.chop')) {
      if (!el.offsetParent) continue;
      if ((el.innerText || '').includes('砍')) return el;
    }
    return null;
  }

  // 强化按钮：装备操作区的 lt-btn gold，文字含"强化"（排除"砍 N 刀"，它同 class）
  function findEnhanceBtn() {
    for (const el of document.querySelectorAll('button.lt-btn.gold')) {
      if (!el.offsetParent) continue;
      const text = (el.innerText || '').trim();
      if (BATCH_RE.test(text)) continue;
      if (ENHANCE_RE.test(text)) return el;
    }
    return null;
  }

  function findBarrierBtn() {
    const btn = document.querySelector('button.lottery-btn.barrier');
    if (btn && btn.offsetParent) return btn;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!el.offsetParent) continue;
      if (KEYWORDS.test((el.innerText || '').trim())) return el;
    }
    return null;
  }

  function findTargetBtn(mode) {
    if (!isLingtai) return findBarrierBtn();
    return mode === 'enhance' ? findEnhanceBtn() : findBatchChopBtn();
  }

  // ================= 弹窗处理（强化结果框）=================
  function findModal() {
    const m = document.querySelector('div.modal-overlay');
    return m && m.offsetParent ? m : null;
  }

  function waitModal(timeout) {
    const start = Date.now();
    return new Promise((resolve) => {
      (function check() {
        const m = findModal();
        if (m) return resolve(m);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(check, 60);
      })();
    });
  }

  // 只点右上角 X 或发 Esc。绝不点 footer 按钮——"分解装备"用的是同一套弹窗组件，
  // 它的 footer 是"确认分解"，盲点会把装备分解掉。
  function closeModal(modal) {
    const x = modal.querySelector('button[aria-label="Close modal"]');
    if (x) { fireClick(x); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
    }));
  }

  function waitModalGone(timeout) {
    const start = Date.now();
    return new Promise((resolve) => {
      (function check() {
        if (!findModal()) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, 60);
      })();
    });
  }

  // ================= 配装数据 =================
  const AFFIX_LABEL = {
    barrier_crit: '结界暴击', barrier_mult: '结界暴击倍数上限', chop_crit: '砍树暴击',
    chop_dmg: '攻击加成', attack: '攻击', luck: '幸运', free_amt: '免费额度加成',
    paid_rate: '付费掉率', paid_amt: '付费额度加成', intent_cap: '战意上限',
    raid_dmg: '仲裁伤害', exp_gain: '修为获取', lottery_rate: '抽奖概率',
    lottery_daily: '每日抽奖次数', chop_barrier_drop: '一刀掉结界（白送 1 次抽奖）',
    exchange_bonus: '兑换加成（活跃度兑换到账）',
  };
  // 服务端按此判定单位：flat 不带 %，其余带 %
  const FLAT_KEYS = new Set(['luck', 'chop_dmg', 'intent_cap', 'lottery_daily', 'barrier_mult', 'attack']);
  const SLOTS = [
    { key: 'axe', label: '斧', icon: '🪓' },
    { key: 'charm', label: '符', icon: '🧿' },
    { key: 'boots', label: '靴', icon: '🥾' },
    { key: 'seal', label: '印', icon: '🏵️' },
  ];
  const COLOR_LABEL = { white: '白', green: '绿', blue: '蓝', purple: '紫', orange: '橙' };
  const COLOR_RANK = { white: 1, green: 2, blue: 3, purple: 4, orange: 5 };

  // 装备加成的有效上限。超出封顶的部分服务端会截断，堆再多也是浪费，
  // 所以打分时按封顶后的数值算，否则会推荐一件「数字大但一半浪费」的装备。
  // 只放能从源码确认的两条；其余封顶是后台可配项，编译产物里只有字段名没有默认值。
  const AFFIX_CAPS = {
    // 战意基础层上限 10、硬顶 20（intent_stack_base_cap / intent_stack_hard_cap 默认值）
    intent_cap: { max: 10, why: '战意基础上限 10 → 硬顶 20，装备最多有效 +10 层' },
    // 抽奖页文案：装备日限「封顶 +3」（后台 hooks.lottery.daily_cap）
    lottery_daily: { max: 3, why: '抽奖装备日限封顶 +3 次' },
  };
  // 这几条也有服务端封顶，但具体数值是后台可配、编译产物里读不到
  const SOFT_CAPPED = {
    barrier_crit: '基础 + 装备 + 套装 + 战意合计封顶（crit_rate_cap_bp 默认 80%）',
    lottery_rate: '挪走未中奖概率有封顶，且未中奖有保底抽不干',
    exchange_bonus: '兑换到账加成有封顶（activity_exchange.bonus_cap_bp）',
  };
  const SET_BONUS_CRIT = 2; // 四槽全满 +2% 结界暴击

  // 每个游戏只吃自己的词条（源码里每条词条都带 where 声明作用范围）。
  // weights = 「该词条 +1 单位值多少分」。注意有的词条是 flat（层/次/点），
  // 有的是 pct（%），单位不同，所以跨词条的相对权重是启发式的，不是严格收益折算。
  const PROFILES = [
    {
      id: 'barrier', label: '打结界',
      weights: { barrier_crit: 10, intent_cap: 8, barrier_mult: 4 },
      setBonus: true, // 四槽全满 +2% 结界暴击，会计入组合打分
      note: '优先级：结界暴击 > 战意上限 > 暴击倍数上限。四槽全满额外 +2% 结界暴击，已计入打分，所以空槽塞一件无关装备也可能是对的。装备不改每次扣多少免费额度。'
        + '这条的真正价值：结界破碎给「当日抽奖上限 +N」，是攒抽奖次数的主路，而抽奖能出付费额度和活跃度。'
        + '另外活跃度本身就是进度乘数（未暴击时进度 = 消耗 + min(活跃度/上限×消耗, 消耗)，封顶翻倍），所以活跃度越高结界推得越快——装备在这条线上只负责暴击那部分。',
    },
    {
      id: 'chop_dmg', label: '砍树·砍血',
      weights: { attack: 10, chop_dmg: 10, chop_crit: 6, chop_barrier_drop: 3 },
      note: '攻击与攻击加成都是 flat 掉血，等价看待；砍树暴击翻倍。掉血 = 全员基础攻击 + 装备。适合快速砍树刷装备。',
    },
    {
      id: 'chop_free', label: '砍树·刷免费额度',
      // 这里的 10:6 跟付费那边不是一回事：幸运是 flat（点数，直接加在掉率上），
      // 免费额度加成是 pct（金额 ×(1+a)）。
      // 期望 = (基础掉率 + 幸运) × 平均金额 × (1+加成)，两边单位不同，
      // 基础掉率越低，1 点幸运相对越强（掉率 5% 时，+1 点 ≈ +20% 期望，
      // 而 +100% 金额只等于 +5% 期望）。所以「幸运压倒金额」这个排序是稳的，
      // 但 10:6 这个具体比例是拍的——基础掉率读不到，算不出真值。
      weights: { luck: 10, free_amt: 6, chop_crit: 1, chop_barrier_drop: 3 },
      note: '幸运（掉率，flat）> 免费额度加成（金额，%）。两者单位不同且基础掉率未知，排序可靠、比例不可靠。'
        + '砍树暴击只翻倍掉血、不进掷骰，给 1 分纯粹是平手时的打破平局项。'
        + '如果你不直接花免费额度，这条的产出还有第二重用途：免费额度是打结界的燃料（每次点击都扣），'
        + '燃料决定你能推多少进度、攒出多少次抽奖——所以要拿付费额度的话，这条不是废词条。',
    },
    {
      id: 'chop_paid', label: '砍树·刷付费额度',
      // 掉率和金额都给 10。后台里付费掉落是「chopPaidDrop 开关 + min/max 美元区间
      // 均匀随机（含两端）」，掉率是按百分比加成、金额也是按百分比加成。
      // 若两者都是乘在同一个独立随机量上的相对百分比，期望 = 掉率×(1+r) × 金额×(1+a)，
      // r 和 a 完全对称，1% 掉率 = 1% 金额，没有谁更值钱。
      // 之前我给的 10:6 是错的——那个「先掉率后金额」的理由只在「次数固定、金额线性叠加」
      // 时成立，乘性模型下不成立。
      // 唯一会让它们不对称的情况：付费掉率是「加百分点」而非「乘百分比」。
      // 那时 base 掉率越低，掉率词条越强。但客户端根本不印掉率数字
      // （图鉴「一刀掉落」只有标题和提示，一行数都没有），产物里读不到 base 值，所以按对称处理。
      weights: { paid_rate: 10, paid_amt: 10, chop_barrier_drop: 5 },
      note: '两条同权重：付费掉率和付费额度加成都是乘性百分比，对期望收益的边际贡献一样大，没有先后。'
        + '「一刀掉结界」= 下一刀极低概率白送 1 次抽奖（不砸全站血条），抽奖又能中付费额度，所以对你这条线有间接价值，给了 5 分。'
        + '免费额度那两条（幸运 / 免费额度加成）在这里是 0 分——两池互不挪用，堆免费不影响付费。'
        + '注意付费掉率/付费额度加成只在砍树掷骰时生效，去抽奖页穿它没用。',
    },
    {
      id: 'lottery', label: '抽奖',
      weights: { lottery_daily: 12, lottery_rate: 6 },
      note: '只有这两条真正作用于抽奖页：每日抽奖次数（直接加日限，封顶 +3）、抽奖概率（把未中奖档挪给奖品档，有保底）。两条都只有紫/橙能出，且需后台开启抽奖挂钩。',
      // 抽奖概率装备确实会抬高付费/活跃度档的绝对概率（从未中奖档挪权重），
      // 但挪过来的量是按各档基础概率等比例分的，装备改不了档位之间的相对比例。
      lever: '抽奖概率装备会提高抽到付费额度和活跃度的概率：它把「未中奖」档的权重挪给中奖档，付费/活跃度档的绝对概率因此变高。'
        + '但它不能定向——挪过来的量按各档基础概率等比例分配（挪出量 = 未中奖概率 × 装备百分比，每档分到 = 挪出量 × 该档基础概率 ÷ 参与档基础概率之和），'
        + '所以付费档在中奖档里的相对占比不变，且未中奖有保底、挪走量有封顶。装备也不能放大中奖金额，各档金额是后台奖池写死的固定值。'
        + '放大金额只能靠用「活跃度」作为消耗去抽（prize_multiplier 默认 2 倍，兑换码档不参与），这种抽法还默认剔除「谢谢参与」档并重分配概率。'
        + '另外注意：奖池表永远显示基础概率，穿了抽奖概率装备或开了加成都不会变，实际效果只在抽奖页那行小字里。',
    },
    {
      id: 'exchange', label: '活跃度 → 额度',
      weights: { exchange_bonus: 10 },
      note: '唯一一条能作用在「活跃度」上的装备词条，但方向是「花活跃度换额度时到账变多」，不是让你攒到更多活跃度。'
        + '后台释义原文：活跃度兑换到账 ×(1+加成)，消耗的活跃度不变（exchangeHook：「到账变多，消耗的活跃度不变。已兑不追。」）。'
        + '额度流水里有「活跃度兑换（付费额度）」这一类，所以它可以直接放大「活跃度 → 付费额度」的转化率。'
        + '兑换前换上、兑完换回，收益最高。只有紫/橙能出，且需后台开启兑换挂钩，加成有封顶（exchangeBonusCap）。'
        + '重要：没有任何词条能提高活跃度本身——16 条词条里一条都没有。活跃度只来自 API 用量（口径 input+output+cache，进度条满 +1，有上限）、签到和管理员调整。',
    },
    {
      id: 'raid', label: '仲裁',
      weights: { raid_dmg: 10 },
      note: '只看仲裁伤害。这个玩法可能尚未开放。',
    },
  ];

  // profile 是按「动作」分的（砍树 / 结界 / 抽奖 / 兑换），但玩家要的是「结果」。
  // 一个结果要跨好几个动作：想拿付费额度，得砍树 + 打结界攒抽奖次数 + 抽奖 + 兑换，
  // 每一步穿的那套都不一样。所以这里只做导航——告诉你按什么顺序换哪套——不参与打分。
  const GOALS = [
    {
      id: 'paid_activity',
      label: '付费额度 + 活跃度',
      note: '抽奖次数不是收益，它只是通往「付费额度 / 活跃度」两个奖池档的中转。'
        + '所以真正要堆的是「掷骰次数」和「每次掷骰的结果」，前者靠活跃度（结界进度乘数）和斧力，后者靠装备。',
      plan: [
        { pid: 'barrier',
          why: '打结界。破碎给「当日抽奖上限 +N」，是攒抽奖次数的主路。而且活跃度本身就是进度乘数：'
            + '未暴击时进度 = 消耗 + min(活跃度/上限×消耗, 消耗)，封顶翻倍；活跃度还抬高「点击随机送免费额度」的概率（满活跃度额外概率，不随进度衰减）。' },
        { pid: 'chop_paid',
          why: '砍树。直接出付费额度，还能掉结界晶核白送抽奖次数（barrier_draw）。'
            + '注意额度到上限后这一刀会折算成灵木（quota_to_wood），那时候堆掉率就白堆了。' },
        { pid: 'lottery',
          why: '抽奖。lottery_daily 直接加有效日限（封顶 +3），lottery_rate 从「谢谢参与」挪权重，'
            + '付费档和活跃度档的绝对概率等比例抬高——挪过来的量按各档基础概率分，不能定向。' },
        { pid: 'exchange',
          why: '用活跃度换付费额度时换上，兑完立刻换回。到账 ×(1+加成)、消耗的活跃度不变，是唯一能作用在活跃度上的词条。' },
        { pid: 'chop_free',
          why: '砍树（备选）。免费额度是打结界的燃料——每次点击都要花，燃料不够就推不动进度、攒不出抽奖次数。' },
      ],
    },
  ];

  function affixFmt(a) {
    if (a && a.fmt) return a.fmt;
    return FLAT_KEYS.has(a.key) ? 'flat' : 'pct';
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function affixText(a) {
    const f = affixFmt(a);
    const unit = f !== 'flat' && f !== 'daily' ? '%' : '';
    return `${AFFIX_LABEL[a.key] || a.key} +${fmtNum(a.num)}${unit}`;
  }

  function itemTitle(it) {
    const color = COLOR_LABEL[it.color] || it.color || '';
    const code = it.code ? ` #${it.code}` : '';
    const enh = it.enhance ? ` +${it.enhance}` : '';
    return `${color}·${it.name || ''}${enh}${code}`;
  }

  // ---------- 读取仓库数据 ----------
  async function fetchStatus() {
    const token = localStorage.getItem('auth_token');
    const deviceId = localStorage.getItem('lottery_barrier_device_id') || '';
    const url = new URL('/api/v1/game/status', location.origin);
    if (deviceId) url.searchParams.set('device_id', deviceId);
    try {
      url.searchParams.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {}

    const headers = { 'Accept-Language': 'zh' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url.toString(), { credentials: 'include', headers });
    if (!res.ok) {
      if (res.status === 401) throw new Error('未登录，请先登录网站');
      if (res.status === 403 || res.status === 404) throw new Error('灵台未开放或无权限');
      throw new Error(`接口返回 ${res.status}`);
    }
    const body = await res.json();
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) throw new Error(body.message || '接口返回错误');
      return body.data;
    }
    return body;
  }

  // ---------- 写操作（会真实修改装备）----------
  async function postGame(path, body) {
    const token = localStorage.getItem('auth_token');
    const headers = { 'Content-Type': 'application/json', 'Accept-Language': 'zh' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(new URL(`/api/v1${path}`, location.origin).toString(), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const msg = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    if (parsed && typeof parsed === 'object' && 'code' in parsed) {
      if (parsed.code !== 0) throw new Error(parsed.message || '接口返回错误');
      return parsed.data;
    }
    return parsed;
  }

  // 穿上会自动替换同槽旧件（源码文案「替换了同槽「{name}」」），不需要先卸下
  function equipItem(itemId) {
    return postGame('/game/equip', { item_id: itemId });
  }

  // bag + 四个槽位里穿着的，合起来才是全部装备
  function allItems(status) {
    const lo = status.loadout || {};
    return [...(status.bag || []), lo.axe, lo.charm, lo.boots, lo.seal].filter(Boolean);
  }

  // 组合打分。封顶作用在「合计」上而不是单件，所以不能逐件算分再相加：
  // 一件 intent_cap +8 配上另一件 +8，第二件只有 2 点是有效的。
  function scoreCombo(items, profile) {
    const totals = new Map();
    for (const it of items) {
      if (!it) continue;
      for (const a of it.affixes || []) {
        if (!profile.weights[a.key]) continue;
        totals.set(a.key, (totals.get(a.key) || 0) + (Number(a.num) || 0));
      }
    }
    let score = 0;
    for (const [k, v] of totals) {
      const cap = AFFIX_CAPS[k];
      score += profile.weights[k] * (cap ? Math.min(v, cap.max) : v);
    }
    // 四槽全满 +2% 结界暴击，等价于多一件带 barrier_crit +2 的装备
    if (profile.setBonus && items.filter(Boolean).length === SLOTS.length) {
      score += (profile.weights.barrier_crit || 0) * SET_BONUS_CRIT;
    }
    return score;
  }

  // 同分时的取舍：优先少换装（换装本身有成本，且穿上会顶掉旧件），
  // 再优先颜色/强化高的（后续强化潜力大）
  function comboRank(items, loadout) {
    let keep = 0, color = 0, enh = 0;
    SLOTS.forEach((slot, i) => {
      const it = items[i];
      const worn = loadout[slot.key] || null;
      if ((it && worn && it.id === worn.id) || (!it && !worn)) keep++;
      if (it) { color += COLOR_RANK[it.color] || 0; enh += it.enhance || 0; }
    });
    return { keep, color, enh };
  }

  function bestFiller(cands) {
    return cands.slice().sort((a, b) =>
      (COLOR_RANK[b.color] || 0) - (COLOR_RANK[a.color] || 0) ||
      (b.enhance || 0) - (a.enhance || 0))[0] || null;
  }

  function sumAffixes(items) {
    const map = new Map();
    for (const it of items) {
      for (const a of it.affixes || []) {
        const cur = map.get(a.key) || { key: a.key, num: 0, fmt: affixFmt(a) };
        cur.num += Number(a.num) || 0;
        map.set(a.key, cur);
      }
    }
    return map;
  }

  function relevantSig(item, profile) {
    return (item.affixes || [])
      .filter((a) => profile.weights[a.key])
      .map((a) => `${a.key}:${Number(a.num) || 0}`)
      .sort()
      .join('|');
  }

  // 逐槽候选：带相关词条的件（同词条组合只留一件）+ 当前穿着 + 凑套装的填充件 + 空槽
  function slotCandidates(items, slot, profile, loadout) {
    const all = items.filter((it) => it.slot === slot.key);
    const worn = loadout[slot.key] || null;

    // 同词条组合里挑哪件：优先已穿着的（省一次换装），再看颜色、强化
    const better = (a, b) => {
      if (!b) return true;
      const aw = !!(worn && a.id === worn.id);
      const bw = !!(worn && b.id === worn.id);
      if (aw !== bw) return aw;
      const ac = COLOR_RANK[a.color] || 0;
      const bc = COLOR_RANK[b.color] || 0;
      if (ac !== bc) return ac > bc;
      return (a.enhance || 0) > (b.enhance || 0);
    };

    const groups = new Map();
    const irrelevant = [];
    for (const it of all) {
      const sig = relevantSig(it, profile);
      if (!sig) { irrelevant.push(it); continue; }
      if (better(it, groups.get(sig))) groups.set(sig, it);
    }

    const list = [...groups.values()];
    if (profile.setBonus) {
      const filler = bestFiller(irrelevant.filter((it) => !(worn && it.id === worn.id)));
      if (filler) list.push(filler);
    }
    if (worn && !list.some((it) => it.id === worn.id)) list.push(worn);
    list.push(null); // 允许留空
    return { list, worn, hasAny: all.length > 0 };
  }

  const SEARCH_BUDGET = 300000; // 组合数上限，超了就剪枝，保证点一下立刻出结果

  // 封顶和套装都作用在「合计」上，所以逐槽取最高分不再等于全局最优
  // （两件 intent_cap +8 的第二件只有 2 点有效），必须搜组合。
  function analyze(status, profile) {
    const items = allItems(status);
    const loadout = status.loadout || {};
    const slots = SLOTS.map((slot) => slotCandidates(items, slot, profile, loadout));

    let pruned = false;
    if (slots.reduce((n, s) => n * s.list.length, 1) > SEARCH_BUDGET) {
      for (const s of slots) {
        if (s.list.length <= 8) continue;
        const top = s.list.filter(Boolean)
          .map((it) => ({ it, sc: scoreCombo([it], profile) }))
          .sort((a, b) => b.sc - a.sc)
          .slice(0, 7)
          .map((x) => x.it);
        if (s.worn && !top.some((it) => it.id === s.worn.id)) top.push(s.worn);
        s.list = [...top, null];
      }
      pruned = true;
    }

    let best = null;
    const cur = new Array(SLOTS.length);
    (function walk(i) {
      if (i === SLOTS.length) {
        const combo = cur.slice();
        const score = scoreCombo(combo, profile);
        if (!best || score > best.score + 1e-9) {
          best = { combo, score, rank: comboRank(combo, loadout) };
          return;
        }
        if (score > best.score - 1e-9) {
          const r = comboRank(combo, loadout);
          const b = best.rank;
          if (r.keep > b.keep ||
              (r.keep === b.keep && r.color > b.color) ||
              (r.keep === b.keep && r.color === b.color && r.enh > b.enh)) {
            best = { combo, score, rank: r };
          }
        }
      } else {
        for (const c of slots[i].list) { cur[i] = c; walk(i + 1); }
      }
    })(0);

    const picks = SLOTS.map((slot, i) => {
      const pick = best.combo[i];
      const worn = slots[i].worn;
      let reason;
      if (!pick) reason = slots[i].hasAny ? 'irrelevant' : 'none';
      else if (relevantSig(pick, profile)) reason = 'ok';
      else if (worn && pick.id === worn.id) reason = 'keep'; // 无用但已穿着，换掉没意义
      else reason = 'set';                                    // 纯为凑满四槽
      return { slot, best: pick, worn, reason };
    });

    const recItems = picks.map((p) => p.best).filter(Boolean);
    const curItems = SLOTS.map((s) => loadout[s.key]).filter(Boolean);
    return {
      picks,
      recTotals: sumAffixes(recItems),
      curTotals: sumAffixes(curItems),
      recFull: recItems.length === SLOTS.length,
      curFull: curItems.length === SLOTS.length,
      itemCount: items.length,
      recScore: best.score,
      curScore: scoreCombo(SLOTS.map((s) => loadout[s.key] || null), profile),
      pruned,
    };
  }

  // ---------- 在仓库格子上高亮推荐件 ----------
  function clearHighlight() {
    for (const el of document.querySelectorAll('[data-mc-hl]')) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeAttribute('data-mc-hl');
    }
  }

  // 仓库格子的 aria-label 形如「紫装 A1B2 强化 +3」，用 code 匹配
  function highlightPicks(picks) {
    clearHighlight();
    const codes = picks.map((p) => p.best && p.best.code)
      .filter((c) => c && String(c).length >= 3)
      .map(String);
    if (!codes.length) return 0;
    let n = 0;
    for (const el of document.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
      const al = el.getAttribute('aria-label') || '';
      if (codes.some((c) => al.includes(c))) {
        el.style.outline = '3px solid #22c55e';
        el.style.outlineOffset = '2px';
        el.setAttribute('data-mc-hl', '1');
        n++;
      }
    }
    return n;
  }

  // ================= 悬浮面板 =================
  const panel = document.createElement('div');
  panel.id = 'mc-panel';
  panel.style.cssText = `
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; max-width: 92vw;
    background: #1f2937; color: #fff; padding: 8px 12px;
    border-radius: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
    font: 13px/1.4 system-ui, sans-serif; user-select: none;
  `;
  const inputCss = 'width:52px;text-align:center;border-radius:6px;border:none;padding:4px 2px;font:inherit;background:#fff;color:#111;';
  const selCss = 'border-radius:6px;border:none;padding:4px 6px;font:inherit;background:#fff;color:#111;';
  panel.innerHTML = `
    <span id="mc-label">${isLingtai ? '灵台' : '结界连点'}</span>
    ${isLingtai ? `<select id="mc-mode" style="${selCss}">
      <option value="chop">砍 N 刀</option>
      <option value="enhance">强化装备</option>
    </select>` : ''}
    <input id="mc-count" type="number" min="1" max="200" value="10" style="${inputCss}">
    <span>次</span>
    <button id="mc-go" style="border:none;border-radius:999px;padding:5px 14px;background:#4f46e5;color:#fff;font:inherit;cursor:pointer;">⚡ 开始</button>
    <button id="mc-plan" style="border:none;border-radius:999px;padding:5px 12px;background:#0f766e;color:#fff;font:inherit;cursor:pointer;">🧮 配装</button>
  `;
  document.body.appendChild(panel);

  const countInput = panel.querySelector('#mc-count');
  const modeSel = panel.querySelector('#mc-mode');
  const label = panel.querySelector('#mc-label');
  const goBtn = panel.querySelector('#mc-go');
  const planBtn = panel.querySelector('#mc-plan');

  function say(text) { label.textContent = text; }
  function currentMode() { return modeSel ? modeSel.value : 'barrier'; }

  // ================= 连点主循环 =================
  goBtn.addEventListener('click', async () => {
    if (autoClicking) { autoClicking = false; return; }

    const mode = currentMode();
    const n = Math.max(1, Math.min(200, parseInt(countInput.value, 10) || 10));
    const first = findTargetBtn(mode);
    if (!first) {
      say(mode === 'enhance' ? '❗ 没找到强化按钮（先选中一件装备）' : '❗ 没找到目标按钮');
      return;
    }

    autoClicking = true;
    goBtn.textContent = '⏹ 停止';
    let ok = 0;
    let perClick = 0;

    for (let i = 1; i <= n; i++) {
      if (!autoClicking) break;

      // Vue 重渲染会替换元素，每轮重新定位
      const btn = (first.isConnected && first.offsetParent) ? first : findTargetBtn(mode);
      if (!btn) { say('❗ 按钮消失了'); break; }

      if (mode === 'chop') {
        const m = (btn.innerText || '').trim().match(BATCH_RE);
        if (m) perClick = parseInt(m[1], 10) || perClick;
      }

      if (btn.disabled) {
        say(`等待可用… ${ok}/${n}`);
        const alive = await waitEnabled(btn, WAIT_ENABLED);
        if (!autoClicking) break;
        if (!alive) {
          // 体力耗尽 / 灵木不足 / 已满级，按钮不会再恢复
          say(`按钮不可用，已停止（${ok}/${n}）`);
          break;
        }
      }

      fireClick(btn);
      ok = i;

      if (mode === 'enhance') {
        say(`强化 ${ok}/${n}`);
        // 强化不一定弹窗（属性无变化时只弹 toast），所以等待带超时
        const modal = await waitModal(WAIT_MODAL);
        if (modal) {
          closeModal(modal);
          await waitModalGone(2000);
        }
      } else if (perClick > 0) {
        say(`已点 ${ok}/${n}（≈${ok * perClick} 刀）`);
      } else {
        say(`已点 ${ok}/${n}`);
      }

      await sleep(CLICK_GAP);
    }

    const finished = ok === n;
    autoClicking = false;
    goBtn.textContent = '⚡ 开始';
    if (finished) {
      if (mode === 'enhance') say(`完成 ✓ 强化 ${ok} 次`);
      else if (perClick > 0) say(`完成 ✓ 共≈${ok * perClick} 刀`);
      else say('完成 ✓');
    } else if (!label.textContent.startsWith('❗') && !label.textContent.startsWith('按钮不可用')) {
      say(`已停止（${ok} 次）`);
    }
  });

  // ================= 配装分析卡片 =================
  let card = null;

  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.id = 'mc-card';
    card.style.cssText = `
      position: fixed; right: 20px; bottom: 76px; z-index: 2147483646;
      width: 380px; max-width: 94vw; max-height: 70vh; overflow: auto;
      background: #111827; color: #e5e7eb; padding: 14px 16px;
      border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
      font: 13px/1.6 system-ui, sans-serif;
    `;
    document.body.appendChild(card);
    return card;
  }

  function renderCard(html) {
    const c = ensureCard();
    c.innerHTML = html;
    const close = c.querySelector('#mc-card-close');
    if (close) {
      close.addEventListener('click', () => {
        clearHighlight();
        c.remove();
        card = null;
      });
    }
  }

  function totalsTable(res) {
    const keys = new Set([...res.recTotals.keys(), ...res.curTotals.keys()]);
    if (!keys.size) return '<p style="color:#9ca3af;">推荐组合没有任何加成词条。</p>';
    const rows = [];
    for (const k of keys) {
      const rec = res.recTotals.get(k);
      const cur = res.curTotals.get(k);
      const fmt = (rec && rec.fmt) || (cur && cur.fmt) || 'pct';
      const unit = fmt !== 'flat' && fmt !== 'daily' ? '%' : '';
      const rn = rec ? rec.num : 0;
      const cn = cur ? cur.num : 0;
      const diff = rn - cn;
      const color = diff > 0.0001 ? '#4ade80' : diff < -0.0001 ? '#f87171' : '#9ca3af';
      const sign = diff > 0 ? '+' : '';

      // 超过硬封顶的部分服务端会截断，标出来免得你以为白拿了
      const cap = AFFIX_CAPS[k];
      let note = '';
      if (cap && rn > cap.max + 1e-9) {
        note = `<div style="color:#fbbf24;font-size:11px;">超封顶：有效仅 ${fmtNum(cap.max)}${unit}，多出的 ${fmtNum(rn - cap.max)}${unit} 无效（${esc(cap.why)}）</div>`;
      } else if (SOFT_CAPPED[k] && rn > 0) {
        note = `<div style="color:#6b7280;font-size:11px;">${esc(SOFT_CAPPED[k])}</div>`;
      }

      rows.push(`<tr>
        <td style="padding:2px 6px 2px 0;">${esc(AFFIX_LABEL[k] || k)}${note}</td>
        <td style="padding:2px 6px;color:#9ca3af;text-align:right;vertical-align:top;">${fmtNum(cn)}${unit}</td>
        <td style="padding:2px 4px;color:#6b7280;vertical-align:top;">→</td>
        <td style="padding:2px 6px;text-align:right;vertical-align:top;">${fmtNum(rn)}${unit}</td>
        <td style="padding:2px 0 2px 6px;color:${color};text-align:right;vertical-align:top;">${diff ? sign + fmtNum(diff) + unit : '—'}</td>
      </tr>`);
    }
    return `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="color:#9ca3af;font-weight:400;">
        <th style="text-align:left;padding:0 6px 4px 0;">词条</th>
        <th style="text-align:right;padding:0 6px 4px;">当前</th><th></th>
        <th style="text-align:right;padding:0 6px 4px;">推荐</th>
        <th style="text-align:right;padding:0 0 4px 6px;">变化</th>
      </tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function picksList(res) {
    return res.picks.map((p) => {
      const s = p.slot;
      if (!p.best) {
        const why = p.reason === 'none' ? '仓库里没有这个槽的装备' : '没有相关词条，可以留空';
        return `<div style="padding:6px 0;border-top:1px solid #1f2937;">
          <div>${s.icon} <b>${s.label}</b> <span style="color:#6b7280;">— ${why}</span></div>
        </div>`;
      }
      const isWorn = p.worn && p.worn.id === p.best.id;
      const badge = isWorn
        ? '<span style="background:#065f46;color:#a7f3d0;border-radius:4px;padding:1px 6px;font-size:11px;">已穿着</span>'
        : '<span style="background:#7c2d12;color:#fed7aa;border-radius:4px;padding:1px 6px;font-size:11px;">需换上</span>';
      const dim = p.reason === 'set' || p.reason === 'keep';
      const setNote = p.reason === 'set'
        ? '<div style="color:#fbbf24;font-size:11px;">无相关词条，仅用于凑满四槽 +2% 结界暴击</div>'
        : p.reason === 'keep'
          ? '<div style="color:#6b7280;font-size:11px;">对本玩法无用，但已穿着，换下来也没收益</div>'
          : '';
      const affixes = (p.best.affixes || [])
        .map((a) => `<span style="color:${dim ? '#6b7280' : '#93c5fd'};">${esc(affixText(a))}</span>`)
        .join(' · ') || '<span style="color:#6b7280;">无词条</span>';
      const swapFrom = (!isWorn && p.worn)
        ? `<div style="color:#6b7280;font-size:11px;">替换掉：${esc(itemTitle(p.worn))}</div>`
        : '';
      return `<div style="padding:6px 0;border-top:1px solid #1f2937;">
        <div>${s.icon} <b>${s.label}</b> ${esc(itemTitle(p.best))} ${badge}</div>
        <div style="font-size:12px;">${affixes}</div>
        ${setNote}${swapFrom}
      </div>`;
    }).join('');
  }

  // 最近一次分析结果，供「一键换上」使用
  let lastPlan = null;
  let applying = false;

  // 真实修改装备：逐槽调 /game/equip。穿上会自动替换同槽旧件，所以每槽一次请求即可。
  async function applyLoadout() {
    if (applying || !lastPlan) return;
    const { picks, profile } = lastPlan;
    const todo = picks.filter((p) => p.best && !(p.worn && p.worn.id === p.best.id));
    if (!todo.length) return;

    const statusBox = card && card.querySelector('#mc-apply-status');
    const applyBtn = card && card.querySelector('#mc-apply');
    const confirmBox = card && card.querySelector('#mc-apply-confirm');
    if (confirmBox) confirmBox.remove();

    applying = true;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.style.opacity = '.6'; }

    const done = [];
    const failed = [];
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      if (statusBox) {
        statusBox.innerHTML = `<span style="color:#fbbf24;">正在换 ${i + 1}/${todo.length}：${esc(p.slot.label)}槽 ${esc(itemTitle(p.best))}…</span>`;
      }
      try {
        await equipItem(p.best.id);
        done.push(p);
      } catch (e) {
        failed.push({ p, msg: (e && e.message) || String(e) });
      }
      await sleep(280); // 别把请求打太密
    }

    applying = false;

    if (statusBox) {
      const okLine = done.length
        ? `<div style="color:#4ade80;">已换上 ${done.length} 件：${done.map((d) => esc(d.slot.label + '槽 ' + itemTitle(d.best))).join('、')}</div>`
        : '';
      const failLine = failed.length
        ? `<div style="color:#f87171;">失败 ${failed.length} 件：${failed.map((f) => esc(f.p.slot.label + '槽 — ' + f.msg)).join('；')}</div>`
        : '';
      statusBox.innerHTML = okLine + failLine +
        '<div style="color:#9ca3af;font-size:11px;">正在刷新数据…</div>';
    }

    // 重新拉一次状态，卡片显示换装后的真实结果；页面本身也刷新一下才能看到新槽位
    await runAnalysis({ afterApply: { done: done.length, failed } });
  }

  function renderApplyConfirm() {
    const box = card && card.querySelector('#mc-apply-status');
    if (!box || !lastPlan) return;
    const todo = lastPlan.picks.filter((p) => p.best && !(p.worn && p.worn.id === p.best.id));
    const lines = todo.map((p) => {
      const from = p.worn ? esc(itemTitle(p.worn)) : '空';
      return `<div>${p.slot.icon} ${esc(p.slot.label)}槽：${from} → <b>${esc(itemTitle(p.best))}</b></div>`;
    }).join('');
    box.innerHTML = `<div id="mc-apply-confirm" style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:8px;">
      <div style="color:#fbbf24;margin-bottom:4px;">确认要真实修改装备吗？将执行 ${todo.length} 次穿戴：</div>
      <div style="font-size:12px;margin-bottom:6px;">${lines}</div>
      <div style="color:#9ca3af;font-size:11px;margin-bottom:6px;">被替换下来的装备会回到仓库，不会分解或丢失。</div>
      <button id="mc-apply-yes" style="border:none;border-radius:8px;padding:4px 12px;background:#b45309;color:#fff;font:inherit;cursor:pointer;">确认换装</button>
      <button id="mc-apply-no" style="border:none;border-radius:8px;padding:4px 12px;background:#374151;color:#e5e7eb;font:inherit;cursor:pointer;margin-left:6px;">取消</button>
    </div>`;
    const yes = box.querySelector('#mc-apply-yes');
    const no = box.querySelector('#mc-apply-no');
    if (yes) yes.addEventListener('click', applyLoadout);
    if (no) no.addEventListener('click', () => { box.innerHTML = ''; });
  }

  async function runAnalysis(opts) {
    const profileId = (card && card.querySelector('#mc-profile'))
      ? card.querySelector('#mc-profile').value
      : (lastPlan && lastPlan.profile.id) || 'barrier';
    renderCard('<div style="color:#9ca3af;">读取仓库数据…</div>');
    let status;
    try {
      status = await fetchStatus();
    } catch (e) {
      renderCard(`<div style="display:flex;justify-content:space-between;gap:8px;">
        <b>配装分析</b>
        <button id="mc-card-close" style="border:none;background:transparent;color:#9ca3af;cursor:pointer;font:inherit;">✕</button>
      </div>
      <p style="color:#f87171;">读取失败：${esc(e.message || e)}</p>
      <p style="color:#9ca3af;font-size:12px;">需要先登录网站，并且管理员已开启灵台。</p>`);
      return;
    }

    const profile = PROFILES.find((p) => p.id === profileId) || PROFILES[0];
    const res = analyze(status, profile);
    const hl = isLingtai ? highlightPicks(res.picks) : 0;

    const options = PROFILES.map((p) =>
      `<option value="${p.id}"${p.id === profile.id ? ' selected' : ''}>${p.label}</option>`).join('');

    const swaps = res.picks.filter((p) => p.best && !(p.worn && p.worn.id === p.best.id)).length;
    const summary = swaps === 0
      ? '<span style="color:#4ade80;">当前穿的已经是最优组合，不用换。</span>'
      : `<span style="color:#fbbf24;">需要换 ${swaps} 件。</span>`;

    const hlNote = isLingtai
      ? (hl ? `<div style="color:#4ade80;font-size:11px;">已在仓库格子上用绿框标出 ${hl} 处（在「装备」标签页可见）。</div>` : '')
      : '<div style="color:#6b7280;font-size:11px;">仓库高亮只在灵台页面可用。</div>';

    // 供「一键换上」使用
    lastPlan = { picks: res.picks, profile, status };

    // 换装按钮：只有真的需要换、且拿得到 item_id 时才给
    const canApply = res.picks.some((p) =>
      p.best && p.best.id != null && !(p.worn && p.worn.id === p.best.id));
    const applyRow = canApply
      ? `<div style="margin-top:8px;">
          <button id="mc-apply" style="border:none;border-radius:8px;padding:5px 12px;background:#b45309;color:#fff;font:inherit;cursor:pointer;">🎽 一键换上这套（${swaps} 件）</button>
          <span style="color:#6b7280;font-size:11px;margin-left:6px;">会真实修改装备</span>
        </div>`
      : '';

    // 分数变化：只是同一玩法内的相对量，不是收益倍数，所以标明「相对分」
    const gain = res.recScore - res.curScore;
    const scoreLine = (res.recScore > 0 || res.curScore > 0)
      ? `<span style="color:#6b7280;font-size:11px;font-weight:400;"> · 相对分 ${fmtNum(res.curScore)} → ${fmtNum(res.recScore)}${
          gain > 0.0001 ? `（<span style="color:#4ade80;">+${fmtNum(gain)}</span>）` : ''}</span>`
      : '';

    // 封顶提示：推荐组合里已经堆到封顶的词条，多穿也没用
    const capped = [];
    for (const [k, cap] of Object.entries(AFFIX_CAPS)) {
      if (!profile.weights[k]) continue;
      const t = res.recTotals.get(k);
      if (t && t.num >= cap.max) capped.push(`${AFFIX_LABEL[k] || k} 已达上限（${cap.why}）`);
    }
    const soft = Object.keys(SOFT_CAPPED)
      .filter((k) => profile.weights[k] && res.recTotals.has(k))
      .map((k) => SOFT_CAPPED[k]);
    const capNote = (capped.length || soft.length)
      ? `<div style="margin-top:6px;font-size:11px;color:#9ca3af;">
          ${capped.map((t) => `<div style="color:#fbbf24;">⚠ ${esc(t)}</div>`).join('')}
          ${soft.map((t) => `<div>· ${esc(t)}</div>`).join('')}
        </div>`
      : '';

    const prunedNote = res.pruned
      ? '<div style="margin-top:6px;color:#fbbf24;font-size:11px;">装备较多，已对每槽只保留最优候选后搜索，结果可能不是绝对最优。</div>'
      : '';

    // 目标导航：把「要什么结果」翻译成「按什么顺序换哪套」。点一步就切到那套。
    const goal = GOALS[0];
    const goalRows = goal.plan.map((s, i) => {
      const gp = PROFILES.find((x) => x.id === s.pid);
      if (!gp) return '';
      const here = gp.id === profile.id;
      return `<button class="mc-goal-step" data-pid="${gp.id}" style="display:block;width:100%;text-align:left;border:none;background:${here ? '#134e4a' : 'transparent'};color:inherit;font:inherit;padding:4px 6px;border-radius:6px;cursor:pointer;">
        <b style="color:${here ? '#4ade80' : '#e5e7eb'};">${i + 1}. ${esc(gp.label)}</b>${here ? '<span style="color:#4ade80;font-size:10px;"> · 当前</span>' : ''}
        <div style="color:#9ca3af;font-size:11px;">${esc(s.why)}</div>
      </button>`;
    }).join('');
    const goalBlock = `<div style="margin-top:8px;padding:6px 8px;background:#1f2937;border-radius:8px;">
      <div style="color:#fbbf24;font-size:12px;">🎯 目标：${esc(goal.label)}<span style="color:#6b7280;font-size:11px;font-weight:400;"> · 点任意一步切到那套</span></div>
      <div style="color:#9ca3af;font-size:11px;margin:4px 0 6px;">${esc(goal.note)}</div>
      ${goalRows}
    </div>`;

    // 上一次换装的结果（applyLoadout 会带着 afterApply 重新分析）
    const ap = opts && opts.afterApply;
    const applyResult = ap
      ? `<div style="margin-top:8px;padding:6px 8px;background:#1f2937;border-radius:8px;font-size:12px;">
          ${ap.done ? `<div style="color:#4ade80;">✓ 已换上 ${ap.done} 件</div>` : ''}
          ${ap.failed && ap.failed.length
            ? `<div style="color:#f87171;">✕ 失败 ${ap.failed.length} 件：${esc(ap.failed.map((f) => f.p.slot.label + '槽 — ' + f.msg).join('；'))}</div>`
            : ''}
          <div style="color:#9ca3af;font-size:11px;">上方数据已是换装后的最新状态。页面槽位显示需刷新页面（F5）才同步。</div>
        </div>`
      : '';

    renderCard(`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <b>配装分析</b>
        <button id="mc-card-close" style="border:none;background:transparent;color:#9ca3af;cursor:pointer;font:inherit;">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="color:#9ca3af;">玩法</span>
        <select id="mc-profile" style="${selCss}flex:1;">${options}</select>
        <button id="mc-rerun" style="border:none;border-radius:8px;padding:4px 10px;background:#0f766e;color:#fff;font:inherit;cursor:pointer;">分析</button>
      </div>
      <div style="color:#9ca3af;font-size:11px;margin-bottom:6px;">
        装备 ${res.itemCount} 件 · 灵木 ${fmtNum(status.wood || 0)} · 背包 ${status.bag_used ?? '?'}/${status.bag_cap ?? '?'}
      </div>
      <div style="margin-bottom:6px;">${summary}</div>
      ${picksList(res)}
      ${applyRow}
      <div id="mc-apply-status" style="margin-top:6px;font-size:12px;"></div>
      ${applyResult}
      <div style="margin:10px 0 4px;color:#9ca3af;">合计对比${scoreLine}</div>
      ${totalsTable(res)}
      ${profile.setBonus ? `<div style="margin-top:6px;font-size:11px;color:${res.recFull ? '#4ade80' : '#fbbf24'};">
        套装：${res.recFull ? '推荐组合四槽已满，+2% 结界暴击生效（已计入打分）' : '推荐组合未填满四槽，拿不到 +2% 套装暴击'}
      </div>` : ''}
      ${capNote}
      ${hlNote}
      ${prunedNote}
      ${goalBlock}
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #1f2937;color:#9ca3af;font-size:11px;">
        ${esc(profile.note)}
      </div>
      ${profile.lever ? `<div style="margin-top:6px;padding:6px 8px;background:#1f2937;border-radius:8px;color:#fbbf24;font-size:11px;">
        ⚠ ${esc(profile.lever)}
      </div>` : ''}
      <div style="margin-top:6px;color:#6b7280;font-size:11px;">
        打分按「合计封顶后」的数值算，并把套装 +2% 计入，所以推荐的是整套最优组合，不是逐槽最高。词条是每件装备的独立快照，颜色只决定能否出史诗词条和分解产出。数据只在本地计算。
      </div>
    `);

    const sel = card.querySelector('#mc-profile');
    const rerun = card.querySelector('#mc-rerun');
    const apply = card.querySelector('#mc-apply');
    // 包一层：直接把 runAnalysis 当监听器会把 Event 对象传成 opts
    const reanalyze = () => runAnalysis();
    if (sel) sel.addEventListener('change', reanalyze);
    if (rerun) rerun.addEventListener('click', reanalyze);
    // 点目标导航里的某一步 = 切到那套配装并立刻重算
    card.querySelectorAll('.mc-goal-step').forEach((b) => {
      b.addEventListener('click', () => {
        const s = card.querySelector('#mc-profile');
        if (!s) return;
        s.value = b.getAttribute('data-pid');
        runAnalysis();
      });
    });
    // 点「一键换上」先弹确认，确认后才真正调接口
    if (apply) apply.addEventListener('click', renderApplyConfirm);
  }

  planBtn.addEventListener('click', () => runAnalysis());

  // ================= 面板拖动 =================
  let dragging = null;
  panel.addEventListener('pointerdown', (e) => {
    if (e.target !== panel) return;
    dragging = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = panel.getBoundingClientRect();
    panel.style.left = Math.max(0, rect.left + e.clientX - dragging.x) + 'px';
    panel.style.top = Math.max(0, rect.top + e.clientY - dragging.y) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    dragging = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => (dragging = null));
})();
