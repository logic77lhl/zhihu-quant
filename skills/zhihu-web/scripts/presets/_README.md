# 实体抽取预设

`extract-entities.mjs` 用预设文件定义「抽取什么实体」。**换实体类型不用改代码，写一个 JSON 就行。**

```bash
node extract-entities.mjs <answers.json> --preset books
node extract-entities.mjs <answers.json> --config ./my-company.json
node extract-entities.mjs <answers.json> --preset books --dict my-extra-words.txt
```

## 字段说明

| 字段 | 必需 | 说明 |
|---|---|---|
| `entityLabel` | ✅ | 显示用，如「书」「库名」「公司」 |
| `entityUnit` | | 「条回答」等，tooltip 用 |
| `tagLabel` | | 「来源」「分类」 |
| `countLabel` | ✅ | 「提及回答数」，出现在表头 |
| `minLength` / `maxLength` | | 长度过滤，默认 2 / 40 |
| `rejectChars` | | **正则字符类**，命中即丢弃。填虚词、语气词 |
| `requireChars` | | 反之，**必须**含这些字符之一 |
| `caseSensitive` | | 默认 false |
| `contextGuard` | | `{ near, re }` —— 命中位置前后 `near` 字符内必须匹配 `re`，否则丢弃。用于「书名号命中但作者名不在附近」这类降噪 |
| `rules` | ✅ | `{ tag, re, group?, anchor? }`。`re` 是**字符串形式**的正则（JSON 不能存字面量）。`group` 取捕获组，`anchor` 指定上下文截取锚点 |
| `dictTag` | | 词典层的来源标签 |
| `dict` | | 裸实体词表（一行一个或数组都行） |
| `dictNeedBoundary` | | 默认 true，词典词要求前后有边界，避免「pandas」命中「pandas-profiling」。**边界分左右两侧、各自独立**，见下 |
| `dictLeftGuard` | | `"loose"` = 左侧只要求前一个字符不是字母/数字/下划线（**汉字相邻照样命中**）。默认把汉字也算边界内。怎么选见下 |
| `dictRightGuard` | | `"loose"` = 右侧同理。默认把汉字也算边界内 |
| `fixtures` | | 抽取规则的**回归测试**。`{ why, text, expect[], reject[]?, counts?, exact? }`，一条 = 一条合成回答。改任何 `rules`/`dict`/边界开关后跑 `node test-preset-rules.mjs` |
| `noise` | | 直接进噪音表，命中即丢弃 |
| `maxSamples` | | 每个实体最多保留几条溯源，默认 8 |
| `ctxBefore` / `ctxAfter` | | 溯源快照取多少字，默认 50 / 110 |
| `notes` | | 数组。字符串直接进报告口径说明；函数可写 `({answers, entities, extraction}) => '...'`，但 **JSON 无法存函数**，需要动态内容时用 `--config` 指向 .mjs 或手写渲染层 |
| `extraStats` | | `{label, value}`，value 可为数字 |

## 写预设的顺序

1. **先看数据再写规则。** 跑一次 `fetch-answers.mjs`，然后

   ```bash
   node -e "const a=require('./q*-answers-full.json');
   console.log(a.map(x=>x.content).join('\n').slice(0,3000))"
   ```

   亲眼看这个领域的文本长什么样，不要凭想象写正则。

2. **先上高精度规则，再考虑词典。** 书名号、代码块、书名格式这类有明确标记的最准。

3. **统计噪声率。** 抽取完看 `extraction.rejectedSample`，如果被拒的里面大半是真实体，说明过滤太狠。

4. **务必人工验证 TOP 20 的溯源上下文。** 榜单头部错了，整份报告就没意义。

5. **把踩到的坑写成 `fixtures`。** 每修一个抽取 bug，就补一条 fixture 把它钉住 ——
   否则同一条规则下次改动时会悄悄回退。写完跑：

   ```bash
   node test-preset-rules.mjs          # 全部预设
   node test-preset-rules.mjs cpu      # 只跑一个
   ```

## 已有的坑

- **中文弯引号 `“”` 主要用于强调，不是书名。** 直接当书名抽会引入大量「当下」「中国」这类垃圾。必须配 `rejectChars`。
- **中文顿号、空格是词间分隔符。** 词典里不要写成「万历 十五年」。
- **同一回答内同一实体只计一次。** 一个回答推荐十本书，每本 `count` 各 +1，不重复累加。
- **`contextGuard` 会误伤。** 作者名离书名太远的情况会被丢掉，观察 `contextGuardDropped` 数量，太大就放宽。
- **规则开头的 `\\b` 在汉字前不成立。** JS 的 `\w` 只含 ASCII，汉字不是词字符，
  所以 `\b` 在「锐龙」「至强」「奔腾」这类**汉字起头**的词前面永远不匹配 ——
  位置 0 不匹配，前面是汉字、空格、标点也不匹配。实测 `锐龙7 8700G`、`锐龙 7 9700X`
  等 15 处被整片漏掉。用 `(?<![\\w])` 代替：对 ASCII 与 `\b` 等价，但允许汉字在前。
- **捕获组里不许混进裸前缀。** 规则捕获的必须是**完整型号名**。反例：`([3579]\\s?\\d{4}...)`
  作用在 `Ryzen 3 3200G` 上会捕获 `3 3200G`（阶级数字被吞），在 `Ryzen 55600X` 上会捕获
  `55600X`（现实中不存在的名字）。把 `[3579]\\s?` 放到组外、组里只留 `(\\d{4}[A-Z]{0,3})`
  即可 —— **匹配范围一字不变，只改捕获内容**。
- **实体名不该以「数字 + 空白」开头。** 型号名不会这么写，出现即说明捕获组吞了裸前缀。
  `verify-output.mjs` 与 `test-preset-rules.mjs` 都按这条断言，见到 `3 3200G` 直接 FAIL。

## 词典边界怎么选（`dictLeftGuard` / `dictRightGuard`）

词典层默认**两侧都把汉字算作边界内**（即「汉字紧邻＝不在边界上＝不命中」）。
但「汉字紧邻」在具体领域里的含金量完全不同，所以要**分领域、分左右**来定：

| 领域 | 左侧 | 右侧 | 为什么 |
|---|---|---|---|
| `cpu` | `loose` | 默认（严格） | 左：`还是不如12600KF`、`酷睿i9-12900K` 是常态，收紧会整片漏。右：`12400元`、`12400够用` 是价格/规格数字，必须挡住 |
| `pythonlibs` | `loose` | `loose` | 两侧紧邻汉字都是真命中：`觉得numpy和pandas`、`这个库就是requests的`、`用flask的开发团队` |
| `books` | 默认（严格） | 默认（严格） | 词典里有一批**普通词**（`原则` `断裂` `宪法` `商业模式` `科举`），放宽后 `不失原则`、`资金链断裂`、`八二宪法` 会被当成 5 本书 |

判断标准很简单：**词典词是不是「独特 token」**。
`12600KF`、`pandas` 这种汉字里不可能凑出来的，放宽；
`原则`、`断裂` 这种本身是日常用语的，收紧。
当时实际测过：cpu 放宽左侧多补回 2 个实体（`i9-12900K`、`i7-12700K`）+ 10 处计数，
pythonlibs 放宽两侧 50 个库计数上升，抽样全部是真命中；books 放宽立刻多出 5 本假书。

## 新增一个预设的最小模板

```json
{
  "entityLabel": "公司",
  "tagLabel": "来源",
  "countLabel": "提及回答数",
  "minLength": 2,
  "maxLength": 20,
  "rules": [
    { "tag": "代码块", "re": "`([A-Za-z][A-Za-z0-9_.+-]{1,30})`", "group": 1 }
  ],
  "dict": ["字节跳动", "腾讯", "阿里"],
  "noise": ["我们", "他们", "这个", "那个"],
  "notes": ["公司名靠代码块和词典两条线识别，召回有限。"]
}
```