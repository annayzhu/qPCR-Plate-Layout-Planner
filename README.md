# qPCR 板布局规划工具 / qPCR Plate Layout Planner

浏览器端中英文双语工具，用于规划 96/384 孔 qPCR 实验、手动校正版布局、核算反应体系与试剂需求，并导出单板 Excel 或全部孔板 ZIP。当前版本聚焦单重反应；CNV 多重反应不混入本工具。

## 核心规则 / Core rules

- 技术复孔从左向右连续排布，不跨行。
- 384 孔板默认采用固定 9 mm 八道排枪隔行上样：先
  `A/C/E/G/I/K/M/O`，再 `B/D/F/H/J/L/N/P`；也可切换为连续孔位上样。
- 隔行来源板默认按样本输入顺序从 A–H 向下放置，再移动到下一列；
  同一样本在不同基因和不同孔板中保持相同的来源行与八道样本组。
- 隔行模式推荐按基因排列，并让每个基因从新的 16 行复孔列块开始；
  孔板预览和 Excel 始终保留真实的 A–P 物理行序。
- 384 孔隔行模式可将同一基因的反应混合液分装到 A–H 八连排；
  每管按对应通道在两次上样中的实际孔数计算，Blank 替代水另行加入。
- 可为样本设置“细胞系 + 比较组”。设置后，以“细胞系 × 比较组 × 单个目的基因 × 全部内参”为自动排板完整单元：只要单板可容纳就不跨板，即使因此增加孔板或留下空孔。
- 超大比较单元默认拒绝生成；明确指定桥接样本后才允许拆分，并在涉及的每块板重复该桥接样本的目的基因及全部内参。未设置比较组时沿用原有样本级跨板规则。
- 优化顺序为：比较单元完整性、孔板数、跨板内参/桥接重做、基因跨板批次、板内引物与样本切换。
- 手动编辑支持单孔、Shift 连选、Ctrl/⌘ 不连续多选、拖动框选、复制/粘贴与平移；修改孔以独立颜色和边框标记，并重新执行全局校验，但提醒不限制保存或导出。
- 反应用量按实际占用孔计算，包括跨板重复内参和手动编辑后的孔位。

## 反应计算 / Reaction calculation

输入每孔 cDNA、上游引物、下游引物、反应预混液、反应总体积及配液余量。上、下游引物体积分开填写，并根据实际移入反应孔的引物液浓度分别计算终浓度：

```text
Forward primer final (nM) = primer solution (µM) × forward volume (µL) / total volume (µL) × 1000
Reverse primer final (nM) = primer solution (µM) × reverse volume (µL) / total volume (µL) × 1000
Water = total volume - master mix - forward primer - reverse primer - cDNA
Prepare volume = required volume × (1 + overage%)
```

默认示例为 10 µL 体系：5 µL 预混液、10 µM 上、下游引物液各 0.2 µL（每条引物终浓度 200 nM）、1 µL cDNA、3.6 µL 无核酸酶水及 12% 配液余量。若将 100 µM 原始储备液先稀释为 10 µM 工作液再加入反应，应填写 10 µM。该示例不是品牌固定处方，应以具体试剂说明书和本地 SOP 为准。

在 384 孔 A–H 八连排分装模式中，每管的 gene mix 为同一基因配方，包含预混液、上/下游引物和基础用水，不含后加的 cDNA。程序分别统计 A–H 通道对应的两次目标板物理行，以便不满 8 个样本的末组也能按实际孔数分装。

## Excel 输出 / Excel output

每块孔板工作簿包含：

- `Plate_Map`
- `Well_Detail`
- `Gene_Requirements`
- `Gene_8Channel_Setup`
- `Sample_cDNA`
- `Total_Requirements`
- `Design_Summary`
- `Reaction_Setup`

`Well_Detail` 会记录细胞系、比较组、桥接状态与跨板原因，并在 384 孔八道隔行模式下记录上样批次、来源行 A–H 和八道样本组；`Sample_cDNA` 按最终实际孔位统计桥接重复用量。批量导出 ZIP 还包含全部孔板总览工作簿。

## 特别说明 / Special note

本工具不自动添加 NTC、no-RT、阳性模板或板间校准样本。默认按实际移取的 10 µM 引物液计算每条引物终浓度；未输入 cDNA 浓度和逆转录稀释倍数，因此不能换算原始 RNA/组织样本量。仅供科研使用（RUO）。

## 本地运行 / Local development

依赖 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
npm run lint
npm run test:unit
npm run build
node --test tests/rendered-html.test.mjs
```

## 代码结构 / Architecture

- `lib/platePlanner.ts`：自动排板、派生指标与布局规则校验。
- `lib/plannerSession.ts`：Planner Session 的唯一 lifecycle seam；统一实验设置、Plate Editing Session、反应体系、生成来源，以及 v1–v9 保存格式的恢复与序列化。
- `lib/plateEditingSession.ts`：手动编辑的唯一业务入口；统一管理选择、框选、复制/粘贴、赋值、清空、恢复、平移、确认状态及 30 步撤销/重做，并在每次修改后刷新指标和校验结果。
- `lib/reactionCalculator.ts`：从当前 Plate Plan 计算反应体系和试剂需求。
- `lib/exportExcel.ts`：将当前 Plate Plan 投影为实验人员使用的 Excel 工作簿。
- `app/QpcrPlanner.tsx`：负责界面展示、浏览器事件与用户提示，不再自行实现孔位编辑规则。

Planner Session 由 `createPlannerSession()` 建立，通过
`dispatchPlannerSession()` 执行生成、设置更新和孔板编辑；`lib/plannerDraftStorage.ts` 浏览器 adapter 只负责读取、写入或删除 `localStorage` 草稿。历史 v1–v8 数据由
`restorePlannerSession()` 统一迁移为当前 v9 格式。编辑场景和保存兼容性分别集中在
`tests/plateEditingSession.test.ts` 与 `tests/plannerSession.test.ts`，避免针对内部 helper 重复建立碎片测试。

只有点击“保存”后，实验方案才会写入当前浏览器的 `localStorage`，并在下次打开时自动恢复。“重置工具”会清除本机保存记录并恢复初始状态；样本名称不会由应用主动上传。
