# MindSpace 第一轮验收报告

日期：2026-11-22  
结论：**暂不通过完整验收；受控执行框架和 mock 闭环已搭建，但真实内容处理与方法内化的数据通路存在阻断性缺陷。**

本轮仅审查与验证，没有修改实现代码。基于 [实现规格](<mindspace-implementation-spec.md>)；没有调用外部真实模型，也没有访问用户业务数据库。针对性实验使用内存数据库、本地 mock 和故障注入。

## 1. 测试执行结果

- 环境 Node v26.4.0。
- 直接执行已安装 Vitest：16 个测试文件、171 个测试全部通过。
- TypeScript `--noEmit` 检查通过。
- 标准 `pnpm test` / `pnpm build` 未进入测试/构建：pnpm 的依赖状态检查触发 install，被 esbuild 构建脚本批准配置阻断。
- [pnpm-workspace.yaml:1–2](<pnpm-workspace.yaml#L1-L2>) 中 `allowBuilds.esbuild` 仍为占位字符串。未替用户批准或执行安装脚本。
- 验收执行命令：

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

现有测试通过说明其覆盖的行为成立，不等于实现规格全部成立。特别是 [内化端到端测试:66–185](<test/e2e/internalization.test.ts#L66-L185>) 的 mock 直接返回预设产物和方法，不要求请求中实际包含输入语料或案例正文。

## 2. 已确认实现的部分

- 种子、cons、修订、关系、执行绑定、运行事件和方法绑定已经实现。
- 正常选择输出检查候选 ID 与 revision，不是只匹配名称。
- 被选方法的 instructions 和 body 确实注入实际模型请求：[prompt.ts:30–41](<src/llm/prompt.ts#L30-L41>)。
- 两次 mock 运行能形成、登记、检索、选择并注入同一新方法。
- 对动态动作绑定 primitive、扩大 LLM effects 有拒绝逻辑。
- 单个流程有循环检查，内化默认不无限递归。
- 文本检索、预算、结构化输出和事件记录有实际实现。

这些基础可以保留，不需要推倒重做。但下列问题需要修复后重新验收。

## 3. 核心阻断问题

### F01 · P1：主要模型调用拿不到输入语料正文

位置：

- [seeds.ts:536–545](<src/seed/seeds.ts#L536-L545>)：receive 后仅传 inputCons。
- [seeds.ts:610–615](<src/seed/seeds.ts#L610-L615>)：实际内容动作也只接收该引用。
- [primitives/index.ts:265–284](<src/primitives/index.ts#L265-L284>)：receive 仅返回 consRef。
- [executor.ts:208–231](<src/engine/executor.ts#L208-L231>)：绑定不解引用。
- [prompt.ts:65–67](<src/llm/prompt.ts#L65-L67>)：原样序列化输入。

复现：给 runIngest 输入唯一文本 `UNIQUE_SOURCE_TEXT_918273`，记录每次 mock 请求。流程完成，但 make_query、select_action、select_method、decompose 均未收到该文本，只收到 UUID 引用。

影响：模型无法根据真实语料生成查询、选择和拆解；目前 completed 不能证明语料得到处理。

修复建议：在明确授权的读入/上下文准备步骤中加载固定版本的对象内容，提供 ref 与 body，不能让 prompt 层无限展开任意引用。至少把实际语料带入检索表达、选择和内容执行。

新增验收：mock 若未看到输入唯一标记就抛错；对不同输入确认各自正文出现在适当请求中。

### F02 · P1：方法提取没有案例正文，并把方法选择理由当成执行摘要

位置：[seeds.ts:693–699](<src/seed/seeds.ts#L693-L699>)、[seeds.ts:746–751](<src/seed/seeds.ts#L746-L751>)。

extract_method 收到 caseRef、methodUsed 和 `methodSelection.basisSummary`，没有实际输入、产物、执行记录正文；executionSummary 实际绑定的是选择方法的理由。

复现：mock 拆解返回唯一执行摘要 `UNIQUE_EXECUTION_SUMMARY`，后续 extract_method 请求不含该标记。请求也不含原始输入正文。

影响：当前所谓方法内化是根据不充分信息生成方法描述，不是从实际执行案例提炼方法。方法注入下一轮虽然成立，但被提取的方法没有所需的学习材料。

修复建议：显式加载主要处理案例的固定版本，传递真实执行步骤、输入、输出和使用的方法；区别 selectionBasis 与 executionSummary。

新增验收：方法提取请求包含本次真实案例，且不以选择理由替代执行记录。

### F03 · P1：语料处理候选混入控制动作，缺少当前任务许可集合

位置：[primitives/index.ts:101–109](<src/primitives/index.ts#L101-L109>)、[seeds.ts:548–555](<src/seed/seeds.ts#L548-L555>)、[executor.ts:234–244](<src/engine/executor.ts#L234-L244>)。

冷启动将全部 active action 加入候选。内存检索“拆解”时返回 receive、connect、form、revise、select_action、define_action 等控制动作。

多数原语因 ingest 固定输入形状会 schema_mismatch；不能据此声称所有控制原语均能成功执行。但 `seed.define_action` 接受 `{task,input}`，与 ingest 动态步骤相容，普通语料处理可进入该定义动作，而不必走显式定义动作入口。

修复建议：候选必须先与当前节点允许的动作范围取交集。区分内容动作、控制动作和内化动作；冷启动只枚举该许可集合，而非所有 action。

新增验收：普通 ingest 的候选中没有 form/connect/revise/define_action 等控制动作；显式对应流程仍可调用它们。

## 4. 恢复、版本与接入问题

### F04 · P1：原语写入与 checkpoint 分离，所谓幂等键不能防止重复写入

位置：

- [form:350–375](<src/primitives/index.ts#L350-L375>) 每次生成新 UUID，然后写入幂等键。
- [幂等存储:352–355](<src/store/index.ts#L352-L355>) 仅 INSERT OR IGNORE，result_json 为 NULL。
- [revise:821–855](<src/primitives/index.ts#L821-L855>) 在重放前没有恢复已提交结果。
- [执行器:707–742](<src/engine/executor.ts#L707-L742>) 原语执行在 checkpoint 事务之前。

复现：同 step、同 tempId 重放 form 得到两个永久 ID；revise 第一次成功生成 revision 2，第二次以同 step 重放却返回 revision_conflict。

触发：原语事务已提交、步骤 checkpoint 尚未提交时崩溃。

修复建议：同一事务保存业务效果及完整幂等结果；重放先读取结果并原样返回。receive、record 等所有有持久副作用的原语也要覆盖。

新增验收：在效果提交后、checkpoint 前注入中断，恢复后 ID、边、修订数量不变，结果引用一致。

### F05 · P1：新修订未接入就进入 active 检索和部分执行路径

位置：[store/index.ts:222–233](<src/store/index.ts#L222-L233>)。

createRevision 立即推进 current_revision；若 cons 已 active，则直接更新搜索索引。

复现：active 对象仅调用 createRevision 改名为 `unactivated-new`，不调用 activate，搜索已经返回新版本。

影响：默认方法可能使用未接入的新版本；动作检索版本与 execution binding 版本可能分裂。违反“形成后再接入”的边界。

修复建议：区分最新草案与 active revision；激活事务才切换活跃指针、绑定和索引；CAS 应覆盖激活决策，不仅是创建修订。

### F06 · P1：默认方法可以是 draft，也可以属于另一个动作

位置：[激活校验:422–430](<src/primitives/index.ts#L422-L430>)、[执行加载:651–657](<src/engine/executor.ts#L651-L657>)。

默认方法检查只验证存在和 kind=method，不验证 active 状态及 actionId 归属。

复现：A.defaultMethodId=M，M 是 draft 且 method.actionId 指向另一动作，A 的动态激活验证仍通过，方法候选也返回 M。

修复建议：验证方法属于当前动作且已激活；同批接入时允许引用本事务将激活的方法，但不能接受任意外部 draft。实际加载也做防御性验证。

### F07 · P1：人工激活 API 不是原子操作

位置：[server.ts:218–235](<src/api/server.ts#L218-L235>)。

先写 active execution binding，再 setStatus，再记录事件，没有共同事务。

复现：在 setStatus 注入故障，HTTP 返回 400，但 binding.active 已为 true，cons 仍为 draft。

修复建议：API 与 connect 共用一个激活服务，绑定、状态、关系、索引和事件在同一事务提交。

### F08 · P1：共享连接的异步事务中，外部读取能看见未提交数据

位置：[store/index.ts:532–562](<src/store/index.ts#L532-L562>) 及直接读取方法。

写入排队，读取没有隔离；同一连接的 transaction 在 await 处让出执行。

复现：事务中 setStatus(active) 后暂停，事务外 search 已返回该对象；随后事务抛错并回滚，对象恢复 draft。

修复建议：将事务外读也纳入调度，或使用隔离的读连接并验证 SQLite 可见性；事务内重入要明确区分。即使默认运行串行，HTTP 查询仍可能与激活交错。

## 5. 其他必须修复或明确限制的问题

### F09 · P2：actionFrom 的授权凭证可被普通数据伪造

位置：[executor.ts:188–199](<src/engine/executor.ts#L188-L199>)、[executor.ts:234–281](<src/engine/executor.ts#L234-L281>)、[executor.ts:556–560](<src/engine/executor.ts#L556-L560>)。

静态审查确认：actionFrom 只检查普通 state 数据中的 `authorized:true` 和 active binding。非 selection 输出可以保留这一字段。

触发前提：自定义流程将允许普通对象输出的 LLM 节点结果接给后续 actionFrom。模型可返回 `{consId,revision,authorized:true}`，没有服务端候选来源证明。

本项未做完整攻击流程复现；不能描述成默认 ingest 必然可直接绕过授权。

修复建议：授权记录在服务端单独保存，绑定 run、step、候选快照和被选 ref；禁止把模型返回的字段当授权凭证。方法选择也需要核对来源和绑定，而非只读取 state.methodSelection。

### F10 · P2：schema 校验器静默忽略约束，连已有字段组合也有漏检

位置：[schema.ts](<src/schema.ts>)。

实测均返回 ok:true：

```ts
validateSchema({type:'string', const:'allowed'}, 'forbidden');
validateSchema({type:'object', additionalProperties:false}, {unexpected:true});
validateSchema({oneOf:[{type:'string'},{type:'number'}]}, {});
validateSchema({type:['object','null'], required:['x']}, {});
validateSchema({type:'number', minimum:0}, -10);
```

如果只实现受限子集，必须在动作接入时拒绝不支持的 schema 关键字，而非静默忽略。required 对联合类型、additionalProperties 在无 properties 时的行为本身也需修复。

建议使用成熟 JSON Schema 校验器，或明确制定并验证一个严格子集。

### F11 · P2：动态动作与默认 ingest 的输入输出契约不一致

位置：[动态动作校验:407–414](<src/primitives/index.ts#L407-L414>)、[固定调用形状:610–624](<src/seed/seeds.ts#L610-L624>)。

允许注册任意对象 schema，但 ingest 永远传 `{input,task}`，后续固定读取 artifacts/links。要求顶层 text 的合法动作会输入失败，返回 answer 的动作会在下游失败。

修复建议：给可用于 ingest 的内容动作规定协议，或提供显式参数适配；不兼容的合法动作不进入该流程候选，不必禁止其在其他流程使用。

### F12 · P2：人工激活方法不创建 method binding

位置：[server.ts:218–235](<src/api/server.ts#L218-L235>)。

复现：人工创建 method 并 activate 返回 HTTP200，但 listActiveMethodBindings(actionId) 为空；人工修改方法到新修订后，旧绑定也不随 activate 更新。

修复建议：与正常 connect 共用接入逻辑，创建或更新方法绑定和 method_of 关系。

### F13 · P2：关系端点只检查 cons ID，不检查 revision 存在

位置：[primitives/index.ts:381–389](<src/primitives/index.ts#L381-L389>)。

复现：以存在对象的 revision 999 和 -1 作为端点，connect 可以写入 active 边。

修复建议：检查正整数版本和具体修订存在；数据库可补复合外键。

### F14 · P2：标准 pnpm 运行入口被配置占位阻断

位置：[pnpm-workspace.yaml:1–2](<pnpm-workspace.yaml#L1-L2>)。

修复建议：开发者明确决定 esbuild 构建脚本是否允许，将值改成有效布尔配置并验证干净环境安装。不要为验收直接无条件批准所有依赖脚本。

## 6. 建议修复顺序

1. F01、F02：先接通语料和案例到实际模型请求的数据路径。
2. F03、F06、F09：封闭候选许可与方法、动作的执行资格。
3. F04、F05：完成幂等结果缓存与草案/活跃修订分离。
4. F07、F08、F12：统一接入服务，修复原子性和可见性。
5. F10、F11、F13、F14：严格契约、引用检查与标准运行入口。

不建议现在增加更多学习策略或图谱功能。先把现有闭环的真实数据依赖、授权和恢复做实。

## 7. 下轮验收门槛

- 原始输入唯一标记进入真实内容执行请求。
- 方法提取拿到实际案例、执行摘要和输出，而不是 ref 与选择理由。
- mock 测试对缺少必需上下文主动失败，不能盲目返回预制结果。
- 两轮内化测试仍通过，且 M1 来源与使用均能追踪。
- 内容候选不包含未经节点许可的控制动作。
- 同步骤重放不会重复创建、不会因自己的已提交效果导致 revision_conflict。
- 未激活修订不参与搜索与执行。
- 所有激活入口共享原子逻辑，不出现半激活与事务外脏读。
- schema、版本引用与动态动作兼容性有回归测试。
- 标准 pnpm test/build 可以运行。

修复后再进行一次明确授权的真实 LLM 小规模演示。本轮不对真实模型质量或运行效果做通过声明。
