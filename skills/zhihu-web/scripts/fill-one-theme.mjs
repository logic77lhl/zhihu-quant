// 补单条标签：打标批次因 max_tokens 截断失败时，用单独调用补上那几条。
// 用法: node fill-one-theme.mjs <answers-full.json> <answerId> [--summaries s.json] [--profile stories]
import fs from 'node:fs';
import { resolveModel } from './llm-model.mjs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
const AID = argv.find((a) => /^\d+$/.test(a));
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (!IN || !AID) { console.error('用法: node fill-one-theme.mjs <answers-full.json> <answerId>'); process.exit(1); }
const PROFILE = opt('--profile', 'default');
const MODEL = opt('--model', 'auto');
const KEY = process.env.WB2API_KEY;
if (!KEY) { console.error('缺少环境变量 WB2API_KEY'); process.exit(1); }
const BASE = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
const { model: MODEL_ID } = await resolveModel(MODEL, { key: KEY, base: BASE });

const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const a = answers.find((x) => String(x.id) === String(AID));
if (!a) { console.error('找不到回答 ' + AID); process.exit(1); }

const base = IN.replace(/-answers-full\.json$/, '');
const SUM = opt('--summaries', base + '-summaries.json');
const OUT = base + '-themes.json';
const stateFile = OUT + '.state.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { taxonomy: [], perAnswer: {} };

const summaries = fs.existsSync(SUM) ? JSON.parse(fs.readFileSync(SUM, 'utf8')) : null;
const feed = summaries?.perAnswer?.[String(a.id)] || (a.content || '').replace(/\s+/g, ' ').slice(0, 600);
const TAX = state.taxonomy.map((t) => `${t.id} ${t.name}：${t.desc}`).join('\n');

const SYS = PROFILE === 'stories'
  ? `你在给知乎「故事征集」问题的回答按故事类型打标签。可选标签如下（只能从中选，不能新造）：\n${TAX}\n\n`
    + '为下面这条故事选出 1~3 个**最能刻画这个故事**的标签，优先选转折点和结局形态对应的标签。'
    + '若只是简短感慨、抖机灵、推销或与问题无关，themes 给空数组。'
    + '只输出 JSON 对象，不要 Markdown 代码块。'
  : `你在给知乎回答按观点打标签。可选标签如下（只能从中选，不能新造）：\n${TAX}\n\n`
    + '选出 1~3 个最主要的标签；只是简短赞同/调侃的给空数组。只输出 JSON 对象，不要 Markdown 代码块。';

const r = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: MODEL_ID, temperature: 0.3, max_tokens: 400, reasoning_effort: 'none',
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: `### id=${a.id}\n${feed}\n\n请输出 JSON 对象，形如 {"id":"${a.id}","themes":["T3","T8"]}` },
    ],
  }),
});
const j = await r.json();
const txt = (j.choices?.[0]?.message?.content || j.choices?.[0]?.message?.reasoning_content || '').trim();
const t = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
const s = t.indexOf('{'), e = t.lastIndexOf('}');
let obj = null;
if (s >= 0 && e > s) { try { obj = JSON.parse(t.slice(s, e + 1)); } catch {} }
if (!obj) { console.error('解析失败: ' + txt.slice(0, 300)); process.exit(1); }

const valid = new Set(state.taxonomy.map((x) => x.id));
const themes = (obj.themes || []).map(String).filter((x) => valid.has(x));
state.perAnswer[String(a.id)] = themes;
fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
console.log(`已补 ${a.id}: [${themes.join(', ')}]`);
console.log('（themes.json 需重新跑 extract-themes-llm.mjs 的聚合段，或直接重跑该脚本——打标结果已入 state，重跑不会重复调用）');
