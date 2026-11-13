// 补单条摘要：批处理因 max_tokens 截断反复失败的长回答，用单独的调用补上。
// 用法: node fill-one-summary.mjs <answers-full.json> <answerId> [--profile stories|stories]
import fs from 'node:fs';
import { resolveModel } from './llm-model.mjs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
const AID = argv.find((a) => /^\d+$/.test(a));
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (!IN || !AID) { console.error('用法: node fill-one-summary.mjs <answers-full.json> <answerId>'); process.exit(1); }
const PROFILE = opt('--profile', 'default');
const MODEL = opt('--model', 'auto');
const KEY = process.env.WB2API_KEY;
if (!KEY) { console.error('缺少环境变量 WB2API_KEY'); process.exit(1); }
const BASE = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
const { model: MODEL_ID } = await resolveModel(MODEL, { key: KEY, base: BASE });

const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const a = answers.find((x) => String(x.id) === String(AID));
if (!a) { console.error('找不到回答 ' + AID); process.exit(1); }

const OUT = IN.replace(/-answers-full\.json$/, '') + '-summaries.json';
const stateFile = OUT + '.state.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { perAnswer: {} };

const SYS = PROFILE === 'stories'
  ? '你是中文内容编辑。用户会给你一条知乎回答（编号 + 正文），它是一篇亲身叙事的故事。'
    + '请为它写一句要点摘要，要求：①不超过 55 字；②说清「谁与谁、因为什么事、最后怎么样了」，尤其是那个让人心酸的点；'
    + '③保留具体的细节名词（时间跨度、那句关键的话、那个具体场景）；④不要写「作者讲述了一个故事」这类空话；'
    + '⑤只输出 JSON 对象，不要 Markdown 代码块。'
  : '你是中文内容编辑。为这条知乎回答写一句不超过 55 字的要点摘要，说清核心主张，保留关键名词。'
    + '只输出 JSON 对象，不要 Markdown 代码块。';

const r = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: MODEL_ID, temperature: 0.3, max_tokens: 800, reasoning_effort: 'none',
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: `### id=${a.id} 作者=${a.author || ''} 赞=${a.votes || 0}\n${a.content}\n\n请输出 JSON 对象，形如 {"id":"${a.id}","summary":"..."}` },
    ],
  }),
});
const j = await r.json();
let txt = (j.choices?.[0]?.message?.content || j.choices?.[0]?.message?.reasoning_content || '').trim();
let obj = null;
const t = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
const s = t.indexOf('{'), e = t.lastIndexOf('}');
if (s >= 0 && e > s) { try { obj = JSON.parse(t.slice(s, e + 1)); } catch {} }
if (!obj || !obj.summary) { console.error('解析失败: ' + txt.slice(0, 300)); process.exit(1); }

state.perAnswer[String(a.id)] = String(obj.summary).trim();
fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');

// summaries.json 与 state 同步，保持两者一致
if (fs.existsSync(OUT)) {
  const fin = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  fin.perAnswer[String(a.id)] = state.perAnswer[String(a.id)];
  fs.writeFileSync(OUT, JSON.stringify(fin, null, 1), 'utf8');
}
console.log('已补：' + state.perAnswer[String(a.id)]);
