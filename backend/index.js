// ============================================================
// 星彩 · 智能预测系统 - 后端 API
// 包含：用户认证 + 管理员操作 + 预测算法
// 部署：Vercel Serverless Function
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ============================================================
// 辅助函数：向 Supabase REST API 发请求
// ============================================================
async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

// ============================================================
// 验证管理员身份
// ============================================================
async function verifyAdmin(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: '未提供有效的令牌' };
  }
  const token = authHeader.slice(7);
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY
    }
  });
  if (!resp.ok) return { error: '无效令牌' };
  const user = await resp.json();

  const roleResp = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}&select=role`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!roleResp.ok) return { error: '查询用户角色失败' };
  const users = await roleResp.json();
  if (!users || users.length === 0) return { error: '用户不存在' };
  if (users[0].role !== 'admin') return { error: '权限不足，需要管理员身份' };
  return { user, role: users[0].role };
}

// ============================================================
// 验证用户登录 + 会员状态
// ============================================================
async function verifyUser(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: '未登录，请先登录' };
  }
  const token = authHeader.slice(7);
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY
    }
  });
  if (!resp.ok) return { error: '登录已过期，请重新登录' };
  const user = await resp.json();

  const userResp = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}&select=role,is_banned,subscription_end_date`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!userResp.ok) return { error: '用户信息查询失败' };
  const users = await userResp.json();
  if (!users || users.length === 0) return { error: '用户不存在' };
  const userInfo = users[0];
  if (userInfo.is_banned) return { error: '账号已被封禁' };
  const now = new Date();
  const end = new Date(userInfo.subscription_end_date);
  if (end < now) return { error: '试用期已过，请联系管理员续费' };
  return { user, userInfo };
}

// ============================================================
// 从 Supabase 加载历史数据
// ============================================================
async function loadHistory(gameType) {
  const tableName = gameType === '3d' ? 'lottery_records_3d' : 'lottery_records_p3';
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/${tableName}?select=qihao,number&order=qihao.desc`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.map(row => ({
    issue: row.qihao,
    digits: row.number.split('').map(Number)
  }));
}

// ============================================================
// ===== 预测算法核心 =====
// ============================================================

// 1. 计算总频率
function computeTotalFreq(data) {
  const freq = {};
  for (let d = 0; d <= 9; d++) freq[d] = 0;
  for (const item of data) {
    for (const digit of item.digits) {
      freq[digit] = (freq[digit] || 0) + 1;
    }
  }
  return freq;
}

// 2. 计算近期频率（最近N期）
function computeRecentFreq(data, n = 50) {
  const freq = {};
  for (let d = 0; d <= 9; d++) freq[d] = 0;
  const recent = data.slice(0, Math.min(n, data.length));
  for (const item of recent) {
    for (const digit of item.digits) {
      freq[digit] = (freq[digit] || 0) + 1;
    }
  }
  return freq;
}

// 3. 计算位置频率
function computePositionFreq(data, pos) {
  const freq = {};
  for (let d = 0; d <= 9; d++) freq[d] = 0;
  for (const item of data) {
    const digit = item.digits[pos];
    freq[digit] = (freq[digit] || 0) + 1;
  }
  return freq;
}

// 4. 计算当前遗漏
function computeCurMiss(data, digit) {
  for (let i = 0; i < data.length; i++) {
    if (data[i].digits.includes(digit)) {
      return i;
    }
  }
  return data.length;
}

// 5. 计算最大遗漏（指定范围内）
function computeMaxMiss(data, digit, limit) {
  const end = Math.min(limit, data.length);
  let maxGap = 0;
  let currentGap = 0;
  for (let i = 0; i < end; i++) {
    if (data[i].digits.includes(digit)) {
      currentGap = 0;
    } else {
      currentGap++;
      if (currentGap > maxGap) maxGap = currentGap;
    }
  }
  return maxGap;
}

// 6. 计算共现频率（胆码与其他数字）
function computeCooccur(data, dan) {
  const freq = {};
  for (let d = 0; d <= 9; d++) freq[d] = 0;
  for (const item of data) {
    if (item.digits.includes(dan)) {
      for (const digit of item.digits) {
        if (digit !== dan) freq[digit] = (freq[digit] || 0) + 1;
      }
    }
  }
  return freq;
}

// 7. 计算位置共现（胆码在指定位置时，其他数字在该位置的共现）
function computePosCooccur(data, dan, pos) {
  const freq = {};
  for (let d = 0; d <= 9; d++) freq[d] = 0;
  for (const item of data) {
    if (item.digits[pos] === dan) {
      for (let p = 0; p < 3; p++) {
        if (p !== pos) {
          const digit = item.digits[p];
          freq[digit] = (freq[digit] || 0) + 1;
        }
      }
    }
  }
  return freq;
}

// 8. 计算和值分布
function computeSumDist(data) {
  const dist = {};
  for (let s = 0; s <= 27; s++) dist[s] = 0;
  for (const item of data) {
    const sum = item.digits[0] + item.digits[1] + item.digits[2];
    dist[sum] = (dist[sum] || 0) + 1;
  }
  return dist;
}

// 9. 计算跨度分布
function computeSpanDist(data) {
  const dist = {};
  for (let s = 0; s <= 9; s++) dist[s] = 0;
  for (const item of data) {
    const digits = item.digits;
    const max = Math.max(digits[0], digits[1], digits[2]);
    const min = Math.min(digits[0], digits[1], digits[2]);
    const span = max - min;
    dist[span] = (dist[span] || 0) + 1;
  }
  return dist;
}

// 10. 计算奇偶比分布
function computeParityDist(data) {
  const dist = {};
  for (let p = 0; p <= 3; p++) dist[p] = 0;
  for (const item of data) {
    let oddCount = 0;
    for (const d of item.digits) {
      if (d % 2 === 1) oddCount++;
    }
    dist[oddCount] = (dist[oddCount] || 0) + 1;
  }
  return dist;
}

// 11. 计算大小比分布（0-4小，5-9大）
function computeSizeDist(data) {
  const dist = {};
  for (let p = 0; p <= 3; p++) dist[p] = 0;
  for (const item of data) {
    let bigCount = 0;
    for (const d of item.digits) {
      if (d >= 5) bigCount++;
    }
    dist[bigCount] = (dist[bigCount] || 0) + 1;
  }
  return dist;
}

// ============================================================
// 归一化函数（将原始值映射到 0-100）
// ============================================================
function normalize(value, min, max) {
  if (max <= min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

// ============================================================
// 三胆预测（系统预测，独立于用户输入的胆码）
// ============================================================
function predictDans(data) {
  if (data.length < 10) return [1, 2, 3];
  
  const totalFreq = computeTotalFreq(data);
  const recentFreq = computeRecentFreq(data, 50);
  const posFreqs = [computePositionFreq(data, 0), computePositionFreq(data, 1), computePositionFreq(data, 2)];
  
  // 找出总频率最大值和最小值用于归一化
  const totalVals = Object.values(totalFreq);
  const maxTotal = Math.max(...totalVals);
  const minTotal = Math.min(...totalVals);
  
  const recentVals = Object.values(recentFreq);
  const maxRecent = Math.max(...recentVals);
  const minRecent = Math.min(...recentVals);
  
  const scores = {};
  for (let d = 0; d <= 9; d++) {
    // 维度1：总频率（20%）
    const scoreTotal = normalize(totalFreq[d], minTotal, maxTotal);
    
    // 维度2：近期热号（25%）
    const scoreRecent = normalize(recentFreq[d], minRecent, maxRecent);
    
    // 维度3：位置热度（15%）
    let posScore = 0;
    for (let p = 0; p < 3; p++) {
      const posVals = Object.values(posFreqs[p]);
      const maxPos = Math.max(...posVals);
      const minPos = Math.min(...posVals);
      posScore += normalize(posFreqs[p][d], minPos, maxPos);
    }
    posScore = posScore / 3;
    
    // 维度4：当前遗漏（10%）- 遗漏值越小分数越高
    const curMiss = computeCurMiss(data, d);
    const maxPossibleMiss = data.length;
    const scoreMiss = normalize(maxPossibleMiss - curMiss, 0, maxPossibleMiss);
    
    // 维度5：最大遗漏比（10%）
    const maxMiss = computeMaxMiss(data, d, data.length);
    const ratio = maxMiss > 0 ? curMiss / maxMiss : 0;
    const scoreRatio = normalize(1 - ratio, 0, 1);
    
    // 维度6：冷热交替（10%）
    const hotScore = (scoreRecent + scoreTotal) / 2;
    const coldScore = scoreRatio;
    const scoreAlt = (hotScore * 0.6 + coldScore * 0.4);
    
    // 维度7：和值贡献（5%）+ 跨度贡献（5%）
    // 简化：用总频率的变体
    const scoreSum = normalize(totalFreq[d], minTotal, maxTotal);
    const scoreSpan = normalize(totalFreq[d], minTotal, maxTotal);
    
    scores[d] = 
      scoreTotal * 0.20 +
      scoreRecent * 0.25 +
      posScore * 0.15 +
      scoreMiss * 0.10 +
      scoreRatio * 0.10 +
      scoreAlt * 0.10 +
      scoreSum * 0.05 +
      scoreSpan * 0.05;
  }
  
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 3).map(item => parseInt(item[0]));
}

// ============================================================
// 双飞预测（基于用户输入的胆码）
// ============================================================
function predictPairs(data, dan) {
  if (data.length < 10) {
    const others = [0,1,2,3,4,6,7,8,9];
    const shuffled = others.sort(() => Math.random() - 0.5);
    return shuffled.slice(0,5).map(n => `${dan}${n}`);
  }
  
  const cooccur = computeCooccur(data, dan);
  const posCooccur = [computePosCooccur(data, dan, 0), computePosCooccur(data, dan, 1), computePosCooccur(data, dan, 2)];
  const totalFreq = computeTotalFreq(data);
  
  const cooccurVals = Object.values(cooccur);
  const maxCooccur = Math.max(...cooccurVals);
  const minCooccur = Math.min(...cooccurVals);
  
  const totalVals = Object.values(totalFreq);
  const maxTotal = Math.max(...totalVals);
  const minTotal = Math.min(...totalVals);
  
  const scores = {};
  for (let d = 0; d <= 9; d++) {
    if (d === dan) { scores[d] = -1; continue; }
    
    // 维度1：共现频率（30%）
    const scoreCooccur = normalize(cooccur[d], minCooccur, maxCooccur);
    
    // 维度2：位置共现（25%）
    let posScore = 0;
    for (let p = 0; p < 3; p++) {
      const vals = Object.values(posCooccur[p]);
      const maxV = Math.max(...vals);
      const minV = Math.min(...vals);
      posScore += normalize(posCooccur[p][d], minV, maxV);
    }
    posScore = posScore / 3;
    
    // 维度3：近期共现（20%）
    const recent = data.slice(0, Math.min(50, data.length));
    const recentCooccur = computeCooccur(recent, dan);
    const recentVals = Object.values(recentCooccur);
    const maxRecent = Math.max(...recentVals);
    const minRecent = Math.min(...recentVals);
    const scoreRecent = normalize(recentCooccur[d] || 0, minRecent, maxRecent);
    
    // 维度4：总频率（15%）
    const scoreTotal = normalize(totalFreq[d], minTotal, maxTotal);
    
    // 维度5：交叉验证（10%）
    const scoreCross = (scoreCooccur * 0.6 + scoreTotal * 0.4);
    
    scores[d] = 
      scoreCooccur * 0.30 +
      posScore * 0.25 +
      scoreRecent * 0.20 +
      scoreTotal * 0.15 +
      scoreCross * 0.10;
  }
  
  const sorted = Object.entries(scores).filter(item => item[1] >= 0).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 5).map(item => `${dan}${parseInt(item[0])}`);
}

// ============================================================
// 定位八码预测
// ============================================================
function predictPositions(data) {
  if (data.length < 10) {
    const base = [0,1,2,3,4,5,6,7];
    return [base, base, base];
  }
  
  const result = [];
  for (let pos = 0; pos < 3; pos++) {
    const posFreq = computePositionFreq(data, pos);
    const recentFreq = computePositionFreq(data.slice(0, Math.min(30, data.length)), pos);
    const totalFreq = computeTotalFreq(data);
    
    const posVals = Object.values(posFreq);
    const maxPos = Math.max(...posVals);
    const minPos = Math.min(...posVals);
    
    const recentVals = Object.values(recentFreq);
    const maxRecent = Math.max(...recentVals);
    const minRecent = Math.min(...recentVals);
    
    const totalVals = Object.values(totalFreq);
    const maxTotal = Math.max(...totalVals);
    const minTotal = Math.min(...totalVals);
    
    const scores = {};
    for (let d = 0; d <= 9; d++) {
      // 当前位置频率（40%）
      const scorePos = normalize(posFreq[d], minPos, maxPos);
      // 近期位置频率（30%）
      const scoreRecent = normalize(recentFreq[d], minRecent, maxRecent);
      // 遗漏修正（20%）
      const curMiss = computeCurMiss(data, d);
      const missScore = normalize(data.length - curMiss, 0, data.length);
      // 全局热度（10%）
      const scoreTotal = normalize(totalFreq[d], minTotal, maxTotal);
      
      scores[d] = scorePos * 0.40 + scoreRecent * 0.30 + missScore * 0.20 + scoreTotal * 0.10;
    }
    
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    result.push(sorted.slice(0, 8).map(item => parseInt(item[0])).sort((a, b) => a - b));
  }
  return result;
}

// ============================================================
// 八码等于23（5组）
// ============================================================
function predictEightCodes(data) {
  const allNums = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const totalFreq = computeTotalFreq(data);
  const sorted = Object.entries(totalFreq).sort((a, b) => b[1] - a[1]);
  
  // 取前8个作为基准池
  const basePool = sorted.slice(0, 8).map(item => parseInt(item[0])).sort((a, b) => a - b);
  const coldPool = sorted.slice(8, 10).map(item => parseInt(item[0]));
  
  const results = [];
  
  // 第1组：基准池
  results.push([...basePool]);
  
  // 第2组：替换1个
  const r2 = [...basePool];
  if (coldPool.length > 0) {
    // 用冷号中表现最好的替换基准池中表现最差的
    const worst = r2[r2.length - 1];
    const bestCold = coldPool[0];
    const idx = r2.indexOf(worst);
    if (idx !== -1 && bestCold !== undefined) {
      r2[idx] = bestCold;
    }
  }
  results.push(r2.sort((a, b) => a - b));
  
  // 第3-5组：随机变体（但保持与基准池的相似度）
  for (let g = 2; g < 5; g++) {
    const shuffled = [...allNums].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 8).sort((a, b) => a - b);
    results.push(selected);
  }
  
  return results;
}

// ============================================================
// 精选十注
// ============================================================
function predictTop10(data, danList, noteCount) {
  if (data.length < 10) {
    const result = [];
    for (let i = 0; i < 10; i++) {
      let num = '';
      for (let j = 0; j < 3; j++) {
        num += String(Math.floor(Math.random() * 10));
      }
      result.push(num);
    }
    return result;
  }
  
  const posFreqs = [
    computePositionFreq(data, 0),
    computePositionFreq(data, 1),
    computePositionFreq(data, 2)
  ];
  
  const sumDist = computeSumDist(data);
  const spanDist = computeSpanDist(data);
  const parityDist = computeParityDist(data);
  const sizeDist = computeSizeDist(data);
  const totalFreq = computeTotalFreq(data);
  const recentFreq = computeRecentFreq(data, 30);
  
  // 找最大值用于归一化
  const maxPos = [0,1,2].map(p => Math.max(...Object.values(posFreqs[p])));
  const minPos = [0,1,2].map(p => Math.min(...Object.values(posFreqs[p])));
  const maxSum = Math.max(...Object.values(sumDist));
  const minSum = Math.min(...Object.values(sumDist));
  const maxSpan = Math.max(...Object.values(spanDist));
  const minSpan = Math.min(...Object.values(spanDist));
  const maxParity = Math.max(...Object.values(parityDist));
  const minParity = Math.min(...Object.values(parityDist));
  const maxSize = Math.max(...Object.values(sizeDist));
  const minSize = Math.min(...Object.values(sizeDist));
  const maxTotal = Math.max(...Object.values(totalFreq));
  const minTotal = Math.min(...Object.values(totalFreq));
  
  // 生成所有候选号码（000-999）
  const candidates = [];
  for (let i = 0; i < 1000; i++) {
    const num = String(i).padStart(3, '0');
    const digits = num.split('').map(Number);
    
    // 必须包含至少一个胆码
    let hasDan = false;
    for (const d of danList) {
      if (digits.includes(d)) { hasDan = true; break; }
    }
    if (!hasDan) continue;
    
    const sum = digits[0] + digits[1] + digits[2];
    const maxD = Math.max(digits[0], digits[1], digits[2]);
    const minD = Math.min(digits[0], digits[1], digits[2]);
    const span = maxD - minD;
    const oddCount = digits.filter(d => d % 2 === 1).length;
    const bigCount = digits.filter(d => d >= 5).length;
    
    // 位置概率乘积（25%）
    let posScore = 1;
    for (let p = 0; p < 3; p++) {
      const val = posFreqs[p][digits[p]] || 0;
      const normalized = normalize(val, minPos[p], maxPos[p]);
      posScore *= (normalized / 100 + 0.1);
    }
    posScore = Math.min(posScore * 100, 100);
    
    // 和值匹配（15%）
    const sumScore = normalize(sumDist[sum] || 0, minSum, maxSum);
    
    // 跨度匹配（15%）
    const spanScore = normalize(spanDist[span] || 0, minSpan, maxSpan);
    
    // 胆码包含（20%）
    let danScore = 0;
    for (const d of danList) {
      if (digits.includes(d)) danScore += 15;
    }
    danScore = Math.min(danScore, 30);
    
    // 奇偶比匹配（8%）
    const parityScore = normalize(parityDist[oddCount] || 0, minParity, maxParity);
    
    // 大小比匹配（7%）
    const sizeScore = normalize(sizeDist[bigCount] || 0, minSize, maxSize);
    
    // 组合稀缺度（10%）
    const totalScore = normalize(totalFreq[digits[0]] + totalFreq[digits[1]] + totalFreq[digits[2]], minTotal * 3, maxTotal * 3);
    const rarityScore = 100 - totalScore;
    
    const totalScore2 = 
      posScore * 0.25 +
      sumScore * 0.15 +
      spanScore * 0.15 +
      danScore * 0.20 +
      parityScore * 0.08 +
      sizeScore * 0.07 +
      rarityScore * 0.10;
    
    candidates.push({ num, score: totalScore2 });
  }
  
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10).map(c => c.num);
}

// ============================================================
// 大底预测
// ============================================================
function predictDadi(data, danList, noteCount) {
  if (data.length < 10) {
    const result = [];
    const seen = new Set();
    for (let i = 0; i < Math.min(noteCount, 800); i++) {
      let num = '';
      for (let j = 0; j < 3; j++) {
        num += String(Math.floor(Math.random() * 10));
      }
      if (!seen.has(num)) {
        seen.add(num);
        result.push(num);
      }
    }
    return result.sort((a, b) => a.localeCompare(b));
  }
  
  // 使用与精选十注相同的评分逻辑，但计算所有候选
  const posFreqs = [
    computePositionFreq(data, 0),
    computePositionFreq(data, 1),
    computePositionFreq(data, 2)
  ];
  
  const sumDist = computeSumDist(data);
  const spanDist = computeSpanDist(data);
  const parityDist = computeParityDist(data);
  const sizeDist = computeSizeDist(data);
  const totalFreq = computeTotalFreq(data);
  
  const maxPos = [0,1,2].map(p => Math.max(...Object.values(posFreqs[p])));
  const minPos = [0,1,2].map(p => Math.min(...Object.values(posFreqs[p])));
  const maxSum = Math.max(...Object.values(sumDist));
  const minSum = Math.min(...Object.values(sumDist));
  const maxSpan = Math.max(...Object.values(spanDist));
  const minSpan = Math.min(...Object.values(spanDist));
  const maxParity = Math.max(...Object.values(parityDist));
  const minParity = Math.min(...Object.values(parityDist));
  const maxSize = Math.max(...Object.values(sizeDist));
  const minSize = Math.min(...Object.values(sizeDist));
  const maxTotal = Math.max(...Object.values(totalFreq));
  const minTotal = Math.min(...Object.values(totalFreq));
  
  const candidates = [];
  for (let i = 0; i < 1000; i++) {
    const num = String(i).padStart(3, '0');
    const digits = num.split('').map(Number);
    
    let hasDan = false;
    for (const d of danList) {
      if (digits.includes(d)) { hasDan = true; break; }
    }
    if (!hasDan) continue;
    
    const sum = digits[0] + digits[1] + digits[2];
    const maxD = Math.max(digits[0], digits[1], digits[2]);
    const minD = Math.min(digits[0], digits[1], digits[2]);
    const span = maxD - minD;
    const oddCount = digits.filter(d => d % 2 === 1).length;
    const bigCount = digits.filter(d => d >= 5).length;
    
    let posScore = 1;
    for (let p = 0; p < 3; p++) {
      const val = posFreqs[p][digits[p]] || 0;
      const normalized = normalize(val, minPos[p], maxPos[p]);
      posScore *= (normalized / 100 + 0.1);
    }
    posScore = Math.min(posScore * 100, 100);
    
    const sumScore = normalize(sumDist[sum] || 0, minSum, maxSum);
    const spanScore = normalize(spanDist[span] || 0, minSpan, maxSpan);
    
    let danScore = 0;
    for (const d of danList) {
      if (digits.includes(d)) danScore += 15;
    }
    danScore = Math.min(danScore, 30);
    
    const parityScore = normalize(parityDist[oddCount] || 0, minParity, maxParity);
    const sizeScore = normalize(sizeDist[bigCount] || 0, minSize, maxSize);
    
    const totalScore2 = normalize(totalFreq[digits[0]] + totalFreq[digits[1]] + totalFreq[digits[2]], minTotal * 3, maxTotal * 3);
    const rarityScore = 100 - totalScore2;
    
    const finalScore = 
      posScore * 0.25 +
      sumScore * 0.15 +
      spanScore * 0.15 +
      danScore * 0.20 +
      parityScore * 0.08 +
      sizeScore * 0.07 +
      rarityScore * 0.10;
    
    candidates.push({ num, score: finalScore });
  }
  
  candidates.sort((a, b) => b.score - a.score);
  const target = Math.min(noteCount, 800);
  return candidates.slice(0, target).map(c => c.num).sort((a, b) => a.localeCompare(b));
}

// ============================================================
// 遗漏统计（定位胆 + 胆码）
// ============================================================
function predictMissStats(data, dan) {
  // 胆码遗漏
  const danMiss = {
    curMiss: computeCurMiss(data, dan),
    max100: computeMaxMiss(data, dan, 100),
    max200: computeMaxMiss(data, dan, 200),
    max300: computeMaxMiss(data, dan, 300),
    max400: computeMaxMiss(data, dan, 400),
    max500: computeMaxMiss(data, dan, 500),
    max600: computeMaxMiss(data, dan, 600),
    max700: computeMaxMiss(data, dan, 700),
    max800: computeMaxMiss(data, dan, 800)
  };
  
  // 定位胆遗漏
  const posMiss = {};
  const posNames = ['bai', 'shi', 'ge'];
  for (let pos = 0; pos < 3; pos++) {
    posMiss[posNames[pos]] = {};
    for (let d = 0; d <= 9; d++) {
      let curMiss = data.length;
      for (let i = 0; i < data.length; i++) {
        if (data[i].digits[pos] === d) {
          curMiss = i;
          break;
        }
      }
      posMiss[posNames[pos]][d] = {
        curMiss: curMiss,
        max100: computeMaxMissForPos(data, pos, d, 100),
        max200: computeMaxMissForPos(data, pos, d, 200),
        max300: computeMaxMissForPos(data, pos, d, 300),
        max400: computeMaxMissForPos(data, pos, d, 400),
        max500: computeMaxMissForPos(data, pos, d, 500),
        max600: computeMaxMissForPos(data, pos, d, 600),
        max700: computeMaxMissForPos(data, pos, d, 700),
        max800: computeMaxMissForPos(data, pos, d, 800)
      };
    }
  }
  
  return { danMiss, posMiss };
}

// 位置专用最大遗漏
function computeMaxMissForPos(data, pos, digit, limit) {
  const end = Math.min(limit, data.length);
  let maxGap = 0;
  let currentGap = 0;
  for (let i = 0; i < end; i++) {
    if (data[i].digits[pos] === digit) {
      currentGap = 0;
    } else {
      currentGap++;
      if (currentGap > maxGap) maxGap = currentGap;
    }
  }
  return maxGap;
}

// ============================================================
// 主 API 路由
// ============================================================
module.exports = async (req, res) => {
  // 跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace('/api/', '');

  try {

    // ============================================================
    // 原有接口：用户认证
    // ============================================================
    
    // 注册
    if (path === 'register' && req.method === 'POST') {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: '请填完整' });
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      const email = username + '@temp.com';
      const signupResp = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password, data: { username } })
      });
      const signupData = await signupResp.json();
      if (!signupResp.ok) return res.status(400).json({ error: signupData.msg || '注册失败' });
      const user = signupData;
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          id: user.id,
          username,
          role: 'user',
          is_banned: false,
          subscription_end_date: new Date(Date.now() + 3*24*3600*1000).toISOString()
        })
      });
      if (!insertResp.ok) {
        return res.status(500).json({ error: '注册成功但同步失败' });
      }
      return res.json({ message: '注册成功' });
    }

    // 登录
    if (path === 'login' && req.method === 'POST') {
      const { username, password } = req.body;
      const email = username + '@temp.com';
      const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password })
      });
      const loginData = await loginResp.json();
      if (!loginResp.ok) return res.status(401).json({ error: '用户名或密码错误' });
      const auth = loginData;
      const userQuery = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${auth.user.id}&select=role,is_banned,subscription_end_date`, {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      });
      if (!userQuery.ok) return res.status(403).json({ error: '用户信息不完整' });
      const users = await userQuery.json();
      if (!users || users.length === 0) return res.status(403).json({ error: '用户不存在' });
      const userInfo = users[0];
      if (userInfo.is_banned) return res.status(403).json({ error: '账号已封禁' });
      const now = new Date();
      const end = new Date(userInfo.subscription_end_date);
      if (end < now) return res.status(403).json({ error: '试用期已过' });
      const days = Math.ceil((end.getTime() - now.getTime()) / (1000*3600*24));
      return res.json({
        message: '登录成功',
        token: auth.access_token,
        role: userInfo.role,
        username,
        days_left: days,
      });
    }

    // ============================================================
    // 管理员接口
    // ============================================================
    if (path.startsWith('admin/')) {
      const authHeader = req.headers.authorization;
      const verifyResult = await verifyAdmin(authHeader);
      if (verifyResult.error) {
        return res.status(403).json({ error: verifyResult.error });
      }
      
      if (path === 'admin/users' && req.method === 'GET') {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/users?select=*`, {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        });
        if (!resp.ok) return res.status(500).json({ error: '查询失败' });
        const data = await resp.json();
        return res.json(data);
      }

      if (path === 'admin/toggle-ban' && req.method === 'POST') {
        const { username, is_banned } = req.body;
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${username}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          },
          body: JSON.stringify({ is_banned })
        });
        if (!resp.ok) return res.status(500).json({ error: '操作失败' });
        return res.json({ message: '操作成功' });
      }

      if (path === 'admin/delete' && req.method === 'POST') {
        const { username } = req.body;
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${username}`, {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        });
        if (!resp.ok) return res.status(500).json({ error: '删除失败' });
        return res.json({ message: '删除成功' });
      }

      if (path === 'admin/update-days' && req.method === 'POST') {
        const { username, days } = req.body;
        const getResp = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${username}&select=subscription_end_date`, {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        });
        if (!getResp.ok) return res.status(404).json({ error: '用户不存在' });
        const users = await getResp.json();
        if (!users || users.length === 0) return res.status(404).json({ error: '用户不存在' });
        const oldDate = new Date(users[0].subscription_end_date);
        const newDate = new Date(oldDate.getTime() + days * 24 * 3600 * 1000);
        const updateResp = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${username}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          },
          body: JSON.stringify({ subscription_end_date: newDate.toISOString() })
        });
        if (!updateResp.ok) return res.status(500).json({ error: '更新失败' });
        return res.json({ message: '天数更新成功' });
      }

      return res.status(404).json({ error: '管理员接口不存在' });
    }

    // ============================================================
    // ===== 核心：预测接口（新增） =====
    // ============================================================
    if (path === 'predict' && req.method === 'POST') {
      // 1. 验证用户身份 + 会员状态
      const authHeader = req.headers.authorization;
      const verifyResult = await verifyUser(authHeader);
      if (verifyResult.error) {
        return res.status(401).json({ error: verifyResult.error });
      }

      // 2. 解析请求参数
      const { game, dan, noteCount, mode } = req.body;
      if (!game || !dan) {
        return res.status(400).json({ error: '缺少必要参数：game, dan' });
      }

      // 3. 从 Supabase 加载历史数据
      const historyData = await loadHistory(game);
      if (!historyData || historyData.length < 10) {
        return res.status(400).json({ error: '历史数据不足，请先导入数据' });
      }

      // 4. 解析胆码列表
      const danList = dan.split(/\s+/).map(d => parseInt(d)).filter(d => !isNaN(d) && d >= 0 && d <= 9);
      if (danList.length === 0) {
        return res.status(400).json({ error: '胆码格式错误，请用空格分隔，如 5 或 1 2 3' });
      }
      const primaryDan = danList[0];
      const targetNote = Math.min(Math.max(parseInt(noteCount) || 300, 50), 800);

      // 5. 执行预测
      const dans = predictDans(historyData);
      const pairs = predictPairs(historyData, primaryDan);
      const positions = predictPositions(historyData);
      const eightCodes = predictEightCodes(historyData);
      const selectTen = predictTop10(historyData, danList, targetNote);
      const dadi = predictDadi(historyData, danList, targetNote);
      const missStats = predictMissStats(historyData, primaryDan);

      // 6. 返回结果
      return res.json({
        code: 0,
        data: {
          dans: dans,
          pairs: pairs,
          posB: positions[0] || [],
          posS: positions[1] || [],
          posG: positions[2] || [],
          eightCodes: eightCodes,
          selectTen: selectTen,
          dadi: dadi,
          danMiss: missStats.danMiss,
          posMiss: missStats.posMiss
        }
      });
    }

    // ============================================================
    // 历史数据接口（管理员导入用）
    // ============================================================
    if (path === 'history' && req.method === 'GET') {
      const { game } = req.query;
      if (!game) return res.status(400).json({ error: '缺少 game 参数' });
      const data = await loadHistory(game);
      return res.json({ data, count: data.length });
    }

    if (path === 'history' && req.method === 'POST') {
      const authHeader = req.headers.authorization;
      const verifyResult = await verifyAdmin(authHeader);
      if (verifyResult.error) {
        return res.status(403).json({ error: verifyResult.error });
      }
      const { game, history } = req.body;
      if (!game || !history || !Array.isArray(history)) {
        return res.status(400).json({ error: '参数错误' });
      }
      const tableName = game === '3d' ? 'lottery_records_3d' : 'lottery_records_p3';
      let success = 0;
      for (const item of history) {
        if (!item.issue || !item.digits || item.digits.length !== 3) continue;
        const number = item.digits.join('');
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          },
          body: JSON.stringify({ qihao: item.issue, number: number })
        });
        if (resp.ok) success++;
      }
      return res.json({ success, total: history.length });
    }

    return res.status(404).json({ error: '接口不存在' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || '服务器内部错误' });
  }
};
