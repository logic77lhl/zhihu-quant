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
| `dictNeedBoundary` | | 默认 true，词典词要求前后不是中英文数字，避免「pandas」命中「pandas-profiling」 |
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

## 已有的坑

- **中文弯引号 `“”` 主要用于强调，不是书名。** 直接当书名抽会引入大量「当下」「中国」这类垃圾。必须配 `rejectChars`。
- **中文顿号、空格是词间分隔符。** 词典里不要写成「万历 十五年」。
- **同一回答内同一实体只计一次。** 一个回答推荐十本书，每本 `count` 各 +1，不重复累加。
- **`contextGuard` 会误伤。** 作者名离书名太远的情况会被丢掉，观察 `contextGuardDropped` 数量，太大就放宽。

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