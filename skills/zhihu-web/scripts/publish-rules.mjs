// publish-rules.mjs —— 发布版的「剔除规则」与「联系方式」单一来源
//
// 为什么单独成文件：
//   render-publish.mjs 负责剔除，verify-publish.mjs 负责断言「确实剔干净了」。
//   两边各写一份 isAnon / isOrg / isPaid，改了一处没改另一处，闸门就会静默放行 ——
//   闸门和渲染不同源，等于没有闸门。
//
// 判定口径（与《发布版报告》的五道硬闸门一致）：
//   · 匿名用户：author 含「匿名」
//   · 机构号/广告主：author_type === 'organization' 或 is_advertiser 真值
//   · 严选付费：answer_type 存在且 !== 'normal'（实测三值：normal / paid / paid_column_content）
export const isAnon = (r) => /匿名/.test(String(r.author || ''));
export const isOrg = (r) => r.author_type === 'organization' || !!r.is_advertiser;
export const isPaid = (r) => !!r.answer_type && r.answer_type !== 'normal';

export const DEFAULT_CONTACT = '（请在此填写撤稿/授权联系方式）';

/** 占位符与「看起来像联系方式但其实不是」的写法。只在已提取出的联系串上判定，不扫全文。 */
export const PLACEHOLDER_CONTACT = /〔[^〕]*〕|（请在此填写[^）]*）|请在此填写|你的邮箱|your@email|example\.com/i;

/** 联系方式是否可用：邮箱 / 链接 / 知乎私信，三者有其一。 */
export function contactLooksUsable(s) {
  const t = String(s || '').trim();
  if (!t || PLACEHOLDER_CONTACT.test(t)) return false;
  return /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/|知乎私信|私信/.test(t);
}

/** 按默认口径剔除，并分别记录三类被剔对象（顺序 anon → org → paid，与页面披露的计数一致）。 */
export function excludedSets(rows, { keepAnon = false, keepOrg = false, keepPaid = false } = {}) {
  const reasons = { anon: [], org: [], paid: [] };
  const kept = rows.filter((r) => {
    if (!keepAnon && isAnon(r)) { reasons.anon.push(r); return false; }
    if (!keepOrg && isOrg(r)) { reasons.org.push(r); return false; }
    if (!keepPaid && isPaid(r)) { reasons.paid.push(r); return false; }
    return true;
  });
  return { kept, reasons, dropped: rows.length - kept.length };
}

/** 样本正文总量（字数），用于计算引用占比。 */
export function sampleChars(kept) {
  return kept.reduce((a, r) => a + (r.content || '').length, 0);
}
