// 模型解析：`--model auto`（默认）会探测模型链，挑第一个可用的。
//
// 背景（2026-10-16 实测）：
//   默认模型 global:deepseek-v4.1-flash 在「上游限额」期间返回 HTTP 503。
//   而各脚本的失败重试是「4 次 × 1.2~1.5s 退避，失败后再把批次二分拆开各重试一遍」——
//   单批会烧掉几十秒，整轮下来几分钟空转、零产出，综述那步还会直接抛错退出。
//   同一时刻 cn:deepseek-v4.1-flash 正常：38 条回答的摘要 12 批 / 20 秒跑完。
//   **这看起来像「慢」，实际是「上游挂了还在硬重试」。**
//
// 做法：
//   开局发一次 1-token 探测请求（约 1.5s）挑出可用模型；结果缓存 10 分钟，
//   同一轮流水线的多个脚本只探测一次。探测顺序可用 ZHIHU_LLM_MODELS 覆盖。
//
// 兼容性：
//   - 显式传 `--model <名字>` 时**不探测**，行为与以前完全一致。
//   - auto 模式下，历史缓存的首段模型名只要在同一条链上（或曾是 auto/global/cn），
//     就视为同一份缓存继续沿用 —— 上游切换不该让几百批摘要全部作废重算。
//     实际使用的模型会写进产物 JSON（resolvedModel）并打在日志里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHAIN = (process.env.ZHIHU_LLM_MODELS
  || 'global:deepseek-v4.1-flash,cn:deepseek-v4.1-flash')
  .split(',').map((s) => s.trim()).filter(Boolean);

const CACHE_TTL_MS = 10 * 60 * 1000;
const cacheFile = path.join(os.tmpdir(), 'opencode', 'zhihu-llm-model.json');

function readCache(chain) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j.chain === chain.join(',') && chain.includes(j.model) && Date.now() - j.at < CACHE_TTL_MS) return j;
  } catch { /* 缓存坏了就重新探测 */ }
  return null;
}

function writeCache(chain, model) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ chain: chain.join(','), model, at: Date.now() }), 'utf8');
  } catch { /* 缓存写不进去不影响使用 */ }
}

async function probe(model, key, base) {
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    // 只关心「这条路由通不通」：429/503 是上游限额，200 即视为可用
    // （推理型模型在 max_tokens=1 时可能回空内容，不影响判断）。
    return r.status === 200 ? { ok: true } : { ok: false, why: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, why: e.name === 'TimeoutError' ? '超时' : e.message };
  }
}

/**
 * 解析 --model。
 * @param {string} requested 命令行原值（默认 'auto'）
 * @returns {{model: string, auto: boolean, cached?: boolean}} model = 实际调用用的名字
 */
export async function resolveModel(requested, { key, base = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1', chain = DEFAULT_CHAIN } = {}) {
  if (requested && requested !== 'auto') return { model: requested, auto: false };
  if (!key) throw new Error('缺少 WB2API_KEY，无法探测可用模型');
  const cached = readCache(chain);
  if (cached) return { model: cached.model, auto: true, cached: true };
  const failed = [];
  for (const m of chain) {
    const r = await probe(m, key, base);
    if (r.ok) {
      writeCache(chain, m);
      if (m !== chain[0]) console.log(`[模型] ${chain[0]} 不可用（${failed[0]?.replace(/^.*\(/, '') || '探测失败'}），auto 改用 ${m}`);
      return { model: m, auto: true };
    }
    failed.push(`${m}（${r.why}）`);
  }
  throw new Error(`模型链全部不可用：${failed.join('、')}\n  可用 ZHIHU_LLM_MODELS 换一条链，或用 --model <名字> 显式指定；网关地址见 references/setup.md 第 5 节`);
}

/**
 * auto 场景下判断旧缓存首段模型名是否兼容本次运行。
 * 规则：显式指定模型时要求完全一致；auto 时兼容整条链（上游切换不作废缓存）。
 * @param {string} oldModel 旧 tag 的第一段（如 'global:deepseek-v4.1-flash'）
 */
export function modelSegmentCompatible(oldModel, { requested, resolved, chain = DEFAULT_CHAIN } = {}) {
  if (!oldModel) return true;
  if (requested && requested !== 'auto') return oldModel === resolved;
  return oldModel === 'auto' || oldModel === resolved || chain.includes(oldModel);
}
