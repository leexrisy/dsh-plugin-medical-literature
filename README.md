# dsh-plugin-medical-literature
项目想法来源于本人之前想做的deepresearch，好像目前没有做医学文献检索的就用deepseek改了一版适配dsh的插件。简单用gemini 4 argon测试了一下检索skill，可以下载之后让agent根据用户习惯来修改不同检索源的检索skill，以下为插件介绍：

面向**医学 / 生命科学**的 DeepSeek Harness 插件：检索 PubMed、Europe PMC、arXiv、bioRxiv、medRxiv，生成引用（Vancouver / APA / GB/T 7714 / Nature / BibTeX / RIS / CSL-JSON），并读取开放获取全文用于核对“这句话是否有文献支持”。

工具统一使用 `medical_` 前缀，与 `@shlv/dsh-literature`（dblp + arXiv 的 CS 工具）区分，两者可以共存。

插件是零运行时依赖的纯 Node ESM 模块（只用 Node 内置的 `fetch` 和 `node:fs`），不依赖 Python、Biopython 或任何 npm 包。

---

## 1. 五个工具

| 工具 | 作用 |
|---|---|
| `medical_literature_search` | 多源检索 + 去重 + CSV/JSON 导出 |
| `medical_literature_get` | 单篇题录（含 volume/issue/pages、撤稿标记）+ 完整摘要 |
| `medical_literature_cite` | 题录 → 格式化引用 / `.bib` / `.ris` / CSL-JSON |
| `medical_literature_fulltext` | 开放获取全文 → 章节索引 + 有界正文 + Markdown 落盘 |
| `medical_literature_check` | 句子 → 最相关段落；参考文献表 → 重复/撤稿告警 |

### `medical_literature_search`

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 共享检索词。自由文本按源自动适配（arXiv 去停用词） |
| `queries` | object | **推荐。** 每个源一条原生 query，值原样发送；键即源名 |
| `sources` | string[] | 默认 `["pubmed","europepmc","arxiv","biorxiv"]`；可选 `medrxiv` |
| `max_results` | integer | **融合后**最终返回条数，1–100，默认 10 |
| `candidates` | integer | 每个源的召回窗口，1–100，默认 `max(20, 3×max_results)`；预期论文排在源内靠后时调大 |
| `fusion` | string | `rrf`（默认，只用各源自己的排名做倒数排名融合）/ `source`（按源分块）/ `bm25`（本地词频重排，显式要求才用） |
| `year_from` / `year_to` | integer | 出版年闭区间 |
| `sort` | `"relevance"` / `"date"` / `"cited"` | 默认 `relevance`；`date` 按日期倒序；`cited` 按 Europe PMC 被引次数倒序，**只能单源 `sources:["europepmc"]`** |
| `abstract_chars` | integer | 摘要截断长度，默认 600；0 = 不显示 |
| `save_path` | string | `.csv` / `.json` / `.jsonl`；相对路径按会话工作目录解析 |

**排序策略**：默认信任各引擎自己的排序——PubMed 的 Best Match 已经综合了 MeSH、字段权重、时间等信号，Europe PMC 和 arXiv 也一样。插件只做 **RRF（倒数排名融合）**：每个源的第 1 名得 `1/61`、第 2 名 `1/62`……跨源相加，**不重新按词频打分**。只有显式写 `fusion: "bm25"` 才会用本地 BM25 覆盖源排序（它不知道 MeSH/引用量/时间，通常更差）。想扩大召回就调大 `candidates` / `max_results`，而不是重排。

**经典 vs 前沿**：被引次数和时间是相反的信号。`sort: "cited"` 只走 Europe PMC 的 `CITED desc`，记录会带 `cited_by_count`；PubMed 没有引文排序。需要两者兼顾时分两次查——第一轨 Europe PMC `sort:"cited"` 捞 PROSEVA、CAPP2 这类奠基文献，第二轨 PubMed `sort:"date"`/`relevance` 捞最新试验，由模型分别呈现，不要混成一个分数。引文排序也偏袒老旧、宽泛的论文，查询里要先加设计过滤器或主题约束。

**为什么要分源写 query**：PubMed 认 `[tiab]` / `[MeSH Terms]`，Europe PMC 认 `TITLE_ABS:` / `MESH:` / `SRC:PPR`，arXiv 认 `ti:` / `abs:` / `cat:`。同一字符串发给三个引擎，轻则精度暴跌，重则 0 结果。插件会在发请求前拦截跨引擎语法并报错。完整语法见 [skills/medical-literature/SKILL.md](skills/medical-literature/SKILL.md)。

```json
{
  "queries": {
    "pubmed": "(CRISPR[tiab] OR \"Gene Editing\"[MeSH Terms]) AND 2024:2026[dp]",
    "europepmc": "TITLE_ABS:CRISPR AND MESH:\"Gene Editing\" AND PUB_YEAR:[2024 TO 2026]",
    "arxiv": "(abs:CRISPR OR abs:\"gene editing\") AND submittedDate:[202401010000 TO 202612312359]",
    "biorxiv": "TITLE_ABS:CRISPR AND TITLE_ABS:\"base editing\""
  },
  "max_results": 20,
  "save_path": "crispr_preprints.csv"
}
```

**召回技巧**：arXiv 用词干/通配符 `abs:patholog*`、`abs:histopatholog*`、`abs:prognos*`，否则 `pathology` 匹配不到 `pathological`；`totals` 远大于返回数时（如 `arxiv 5/444`），目标方法可能排在 42 位，需按名查或调大 `max_results`。

**已知系统名**（如 PathAgent、NOVA、SPARK）不要当概念查：`agent` 匹配不到 `agentic` 或 `PathAgent` 这个 token，SPARK/NOVA 还是会撞上普通词。直接 `ti:PathAgent OR ti:NOVA OR ti:SPARK`，并注意预印本在 arXiv、正式版在 PubMed/Europe PMC。

单个源失败不会让整个调用失败：错误进 `errors`，其余源照常返回；只有所有源都失败才抛错。

### `medical_literature_cite`

| 参数 | 说明 |
|---|---|
| `identifier` | 一条 DOI / PMID / PMCID / arXiv ID |
| `identifiers` | 多条（最多 50），生成一个参考文献列表 |
| `output` | `vancouver`（默认）、`apa`、`gb-t-7714`、`nature`、`bibtex`、`ris`、`csl-json` |
| `save_path` | 可选；`.bib` / `.ris` / `.json` 自动选择对应格式；显式 `output` 与扩展名冲突会报错 |

```jsonc
// 润色时插入一条引用
{ "identifier": "10.3390/cells13100800", "output": "vancouver" }

// 整理整份参考文献，导出给 Zotero
{ "identifiers": ["10.3390/cells13100800", "PMID:32939066", "arXiv:1706.03762"],
  "output": "bibtex", "save_path": "refs.bib" }
```

输出示例：

```text
# Vancouver
Laurent M, Geoffroy M, Pavani G, Guiraud S. CRISPR-Based Gene Therapies: From Preclinical to
Clinical Treatments. Cells. 2024;13(10):800. doi:10.3390/cells13100800

# APA 7
Laurent, M., Geoffroy, M., Pavani, G., & Guiraud, S. (2024). CRISPR-Based Gene Therapies: From
Preclinical to Clinical Treatments. Cells, 13(10), 800. https://doi.org/10.3390/cells13100800
```

- 元数据来自 PubMed / Europe PMC / Crossref，工具不会编造作者或年份。
- 模板是标准样式的近似实现，投稿前请按目标期刊的具体规则复核。
- 预印本使用 `@misc`（BibTeX）、`TY  - UNPB`（RIS）、`[EB/OL]`（GB/T）。

### `medical_literature_fulltext`

| 参数 | 说明 |
|---|---|
| `identifier` | DOI / PMID / PMCID / arXiv ID / URL |
| `section` | 可选，按章节标题过滤（如 `"methods"`） |
| `max_chars` | 返回给模型的正文上限，默认 12000 |
| `save` | 是否保存完整 Markdown，默认 `true` |
| `save_path` | 可选；默认 `literature/<id>/fulltext.md` |

```jsonc
{ "identifier": "PMID: 38786024", "section": "discussion", "max_chars": 8000 }
```

| 来源 | 全文途径 | 实测 |
|---|---|---|
| PMC / Europe PMC OA（有 PMCID） | `rest/{PMCID}/fullTextXML`（JATS） | ✅ 章节 + 参考文献完整 |
| arXiv | `arxiv.org/html/{id}` | ✅ 有 HTML 的论文 |
| bioRxiv / medRxiv | 无可靠途径 | ❌ PDF 端点 Cloudflare 429 |
| 付费墙期刊 | 无 | 只有摘要 |

**关于 403**：`europepmc.org/articles/...?pdf=render` 返回 Cloudflare 人机校验页，`pmc.ncbi.nlm.nih.gov/.../pdf/` 返回 reCAPTCHA 页，bioRxiv 返回 `429 error code: 1015`——这些是下载端点的反爬，不是付费墙，也不是代码问题。插件改用 **Europe PMC REST 的 JATS XML** 和 **arXiv HTML**，完全绕开 PDF 端点。

### `medical_literature_check`

用于润色时的两件事：**找支持句子的段落**，以及**审校一组参考文献**。

| 参数 | 说明 |
|---|---|
| `claim` | 要核对的句子；省略则只做参考文献审计 |
| `identifier` / `identifiers` | 1–10 条 DOI / PMID / PMCID / arXiv ID |
| `top_k` | 每个来源返回几段，默认 3 |
| `deep` | 是否读取 OA 全文，默认 `true`；`false` 只用摘要、更快 |

```jsonc
// 这句话是否有文献支持？
{ "claim": "CRISPR-based therapy has been approved for sickle cell disease",
  "identifiers": ["PMID: 38786024"], "top_k": 3 }

// 参考文献表是否有重复 / 撤稿？
{ "identifiers": ["PMID: 38786024", "10.3390/cells13100800"], "deep": false }
```

输出每段的 `coverage`（句子关键词命中比例）、`score`（BM25）和所在章节；同时给出：

- **重复**：同一 DOI / 标题对应多条引用
- **撤稿**：题录带 `retracted` 时警告
- **极性差异**：句子含否定词而最相关段落不含（或反之）时提示人工核对
- **弱匹配**：最高 coverage 低于阈值时提示“可能不支持”

**必须明确的限制**：这是**词面检索**（BM25 + 关键词覆盖），不是语义蕴含判断。它能可靠地把范围缩到几段，是否真的支持结论仍要读原文。实测中：

- “CRISPR 疗法已获批用于镰状细胞病” → 第一段直接命中摘要里 FDA 批准 Casgevy 的那句（coverage 0.71）
- “碱基编辑不产生双链断裂” → 正确句在 top 3 内，但缩写 DSB 导致 Cas9 段落排第一，同时触发极性警告
- “碱基编辑治愈所有实体瘤” → 无支持段落，触发 partial-match 警告

---

## 2. 安装到 DSH profile

插件按 DSH bundle 规范打包：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `medical-literature` 行。

```bash
# 先把 PLUGIN 指向本仓库（任意位置）
PLUGIN=/path/to/dsh-medical-literature-plugin
cd ~/.dsh/profiles/web
pnpm add link:$PLUGIN
```

把包名加入 `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-plugin-medical-literature"]
    }
  }
}
```

profile 默认开启配置热重载：改 `cordis.patch.yml` 或重新 `pnpm add` 可触发重组。**新增或修改工具 schema 时，已运行的 `dsh web` 仍缓存旧定义，需要新开会话或重启服务**；只改 skill 文本则下一次读取即可生效。

### 安装检索/引用 skill

```bash
PLUGIN=/path/to/dsh-medical-literature-plugin
mkdir -p ~/.dsh/skills
ln -sfn $PLUGIN/skills/medical-literature ~/.dsh/skills/medical-literature
```

skill provider 会监听根目录，创建后无需重启即可出现在会话的 skill 目录里。

Skill 自带一个 PICO 拆解模板（人群/干预/对照/结局/研究类型 → MeSH + 自由词 + `[pt]` 过滤器）和一个 MeSH 映射脚本：

```bash
node ~/.dsh/skills/medical-literature/scripts/mesh-map.mjs "chronic kidney disease"
# → PubMed 实际翻译："renal insufficiency, chronic"[MeSH Terms]
# → descriptor D051436，条目词 Chronic Kidney Diseases / Chronic Renal Insufficiency ...
```

它还能提前暴露缩写歧义：`MACE` 会被 PubMed 映射成 *Myristica*（肉豆蔻），`ATTR` 映射成 TTR 蛋白。

卸载：

```bash
cd ~/.dsh/profiles/web
pnpm remove dsh-plugin-medical-literature
# 从 dsh.profile.bundles 删除包名
rm ~/.dsh/skills/medical-literature
```

---

## 3. 数据源与限速

| 源 | 接口 | 说明 |
|---|---|---|
| PubMed | E-utilities `esearch` + `efetch`（MEDLINE） | 题录、摘要、MeSH、DOI、卷期页码、PMC |
| Europe PMC | REST `search` + `{PMCID}/fullTextXML` | 覆盖 MEDLINE/PMC/预印本；OA 全文 |
| arXiv | Atom API + HTML | 预印本；全文走 HTML |
| bioRxiv / medRxiv | Europe PMC 预印本索引（`SRC:PPR` + `PUBLISHER`） | 关键词检索可靠；全文不可用 |

限速由 `lib/http.js` 统一处理：NCBI 350 ms/请求、Europe PMC 150 ms、arXiv API 3 s、arXiv HTML 1 s、Crossref 250 ms；429/5xx 自动重试并遵守 `Retry-After`。

### 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `NCBI_EMAIL` | NCBI 要求的联系邮箱，建议设置 |
| `NCBI_API_KEY` | 提高 E-utilities 限额（3 → 10 请求/秒） |
| `CROSSREF_EMAIL` | Crossref 的 `mailto`，进入其礼貌池 |

---

## 4. 测试

```bash
cd /path/to/dsh-medical-literature-plugin

# 离线：解析器、去重、引用格式、JATS/HTML 全文解析、导出、工具注册、schema
node --test test/unit.test.mjs

# 联网：四源检索 + DOI/arXiv 解析 + 引用 + 两种全文路线
node test/live.mjs
node test/live.mjs "single cell atlas"

# 联网：12 个临床问题（PICO、指南、SR/MA、病例报告、零结果、已知文献核验）
node test/clinical-battery.mjs        # 全部
node test/clinical-battery.mjs 1 4    # 只跑 Q1-Q4
```

`clinical-battery.mjs` 是回归用的真实网络测试，不在 CI 里跑；Q11 预期 0 条，Q12 用
`EMPEROR-Reduced`（PMID 32865377）核对标题、第一作者、年份与 HR。

---

## 5. 实现说明与差异

- 零运行时依赖：只用 Node 内置 `fetch` 和 `node:fs`，不需要 Python、Biopython 或 npm 包。
- 检索走官方接口：PubMed E-utilities（`esearch` JSON + `efetch` MEDLINE）、Europe PMC REST、arXiv Atom API、Crossref。
- 全文只走开放获取路线：Europe PMC JATS XML 与 arXiv HTML；不解析 PDF，不绕过付费墙。
- 与“按 DOI 直接拼 PDF 链接”的做法不同：先用关键词检索确认版本与许可，再决定能否读全文；bioRxiv / medRxiv 只做元数据检索。

---

## 6. 边界与故障排查

**明确的边界**

- 付费墙论文没有合法全文，只能做摘要级核对；
- bioRxiv / medRxiv 全文目前拿不到（Cloudflare 429）；
- 引用模板是标准样式近似，不保证与特定期刊逐字一致；
- 全文核对是辅助：章节定位和词面匹配能缩小范围，结论是否成立仍需模型判断和人工复核。

**常见问题**

| 现象 | 处理 |
|---|---|
| 工具没出现 | 检查 `dsh.profile.bundles`、`pnpm add`、`node_modules/dsh-plugin-medical-literature`；`dsh --dump-config --profile web \| grep medical`；必要时重启 |
| 跨引擎语法报错 | 按报错提示改用该源字段：`[tiab]` / `TITLE_ABS:` / `abs:` |
| 全文 `found: false` | 付费墙或 bioRxiv/medRxiv；改用摘要并明确说明 |
| 403 / 429 | 不要抓 PDF；用 XML/HTML 路线或 DOI 落地页 |
| arXiv 结果不相关 | 用引号精确标题（`ti:"..."`）或加 `cat:` |
| 引用年份/作者不对 | 用 `medical_literature_get` 重新解析标识符，不要手改元数据 |

---

## 7. 许可证、免责声明与合规

**License**：MIT，见 [LICENSE](LICENSE)。可商用、修改、再分发，保留版权与许可声明即可。

**不是医疗器械，也不是医疗建议**

- 本插件只做文献检索、元数据整理、引用格式化和开放获取全文的只读解析。
- 不提供诊断、治疗、用药或临床决策建议；输出可能遗漏、过时或被模型误读。
- 任何临床决策前，请核对原始论文、指南与药品说明书，并由具备资质的专业人员判断。
- 软件按“现状”提供，不附带任何明示或默示担保。

**数据来源与再分发**

- 只调用 PubMed E-utilities、Europe PMC REST、arXiv API/HTML、Crossref 等公开接口；请遵守各站的速率限制与服务条款。
- 题录与摘要的版权归原作者/出版方；全文只抓取开放获取（PMC OA / arXiv HTML）并在本地保存，**不要再分发**。
- 不同文章的开放许可不同（CC BY、CC BY-NC、arXiv 许可等）；引用、翻译、转载前请查原文许可。
- 建议设置 `NCBI_EMAIL`（以及可选的 `NCBI_API_KEY`），既符合 NCBI 的礼貌使用要求，也能提高限速。

**隐私**

- 检索词会发送到上述第三方 API；不要在其中放入患者姓名、病历号或其他可识别信息。
- 插件不收集遥测，不上传本地文件；全文只写到当前工作区的 `literature/` 目录。

**商标**

- PubMed、Europe PMC、arXiv、bioRxiv、medRxiv、DeepSeek 等名称归各自所有者；本项目与它们没有隶属或背书关系。

**使用风险**

- 若用于临床、监管或商业决策，请自行完成合规评估（例如医疗器械软件 SaMD、GDPR/HIPAA、机构 IRB 要求）。
