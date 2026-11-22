# MindSpace 第二轮验收报告

日期：2026-11-22  
被验版本：`84531bf`（验收前工作树干净）  
结论：**主要数据通路和多项恢复缺陷已修；仍暂不通过完整验收。**

参照：[第一轮报告](<mindspace-acceptance-report.md>)、[实现规格](<mindspace-implementation-spec.md>)。

本轮未修改实现源码；运行标准测试、构建、只读审查及内存数据库/mock/本地临时 HTTP 故障注入。没有调用外部真实模型。构建产物用于独立复现。以下不把内存重放等同于操作系统崩溃与磁盘耐久性验证。

## 1. 测试与修复确认

```text
pnpm test   → 19 个测试文件，205 个测试通过
pnpm build  → 通过
TEST_EXIT=0 BUILD_EXIT=0
```

第一轮为 171 个测试，本轮新增 34 个测试。标准 pnpm 入口已经恢复。

| 首轮问题 | 本轮结论 |
|---|---|
| F01 原始语料未进入请求 | 已修主路径：receive 返回 text，模型上下文包含语料；测试强制要求语料标记 |
| F02 方法提取缺案例正文 | 已修主路径：caseData、实际执行摘要与选择依据分开传入，测试有对应断言 |
| F03 内容候选混入控制动作 | 默认 ingest 已限定三个内容动作，控制动作不再混入；动态扩展策略仍需完善，见 R7 |
| F04 原语不幂等 | 实测 receive/form/revise/record 同 step 重放结果一致，实际应用 wrappedConnect 并发重放同边 ID |
| F05 未激活修订可见 | 已修：currentRevision 与 activeRevision 分离；新草案不影响默认读取和搜索 |
| F06 默认方法资格 | 已增加 active 状态与 actionId 归属检查；不再沿用首轮默认方法任意借用结论 |
| F07 激活非原子 | 原 setStatus 故障半激活已修；专用审计事件仍在事务外，见 R4 |
| F08 事务外脏读 | 单 store 主路径已修；跨 store AsyncLocalStorage 仍有边界缺陷，见 R6 |
| F09 授权可伪造 | 原 authorized:true 方式改为授权记录；授权记录仍可被流程输出覆盖，见 R1 |
| F10 Schema 静默忽略约束 | 首轮示例已修：不支持关键字被拒绝；schema 本身结构未完整验证，见 R3 |
| F11 动态动作契约 | 增加了兼容筛选；仍主要检查字段名称，未完全检查字段类型，见 R7 |
| F12 人工方法激活无绑定 | 创建和同动作升版绑定已修；关系版本与跨动作改绑残留，见 R5 |
| F13 非法关系版本 | 经 connect 使用 999、-1、1.5 均被 unknown_reference 拒绝 |
| F14 pnpm 配置 | 已修，标准测试构建通过 |

### 核心数据通路证据

- [receive:288–313](<src/primitives/index.ts#L288-L313>) 返回 `{consRef,text}` 并缓存完整幂等结果。
- [方法内化输入:726–730](<src/seed/seeds.ts#L726-L730>) 传入实际 caseData，而不只是 ref。
- [回归断言:307–312](<test/e2e/internalization.test.ts#L307-L312>) 检查原文标记、实际执行摘要和选择理由分离。

这次已经不能再用“模型完全看不到输入”评价当前实现，该问题确实修复了。

## 2. 仍需先修的高优先级问题

### R1 · P1：保留状态 `_authorizations` 可被 LLM 输出覆盖，仍能绕过候选授权

位置：

- [flow.ts:33–34](<src/engine/flow.ts#L33-L34>) 只要求 outputKey 非空，不禁止内部状态名称。
- [executor.ts:804–809](<src/engine/executor.ts#L804-L809>) 将普通步骤输出写入任意 outputKey。
- [executor.ts:89–104](<src/engine/executor.ts#L89-L104>) 从普通运行 state 读取授权记录，缺少独立来源验证。

独立复现：使用已激活的普通 LLM 动作，其输出 schema 允许对象；自定义流程第一节点把结果写到 `_authorizations`，第二节点使用 `actionFrom:'forged'`。第一节点返回：

```json
{
  "forged": {
    "consId": "seed.receive",
    "revision": 1,
    "candidates": []
  }
}
```

本次未向该 LLM 提供 receive 候选，也没有合法选择记录。实际结果：

```json
{
  "status":"completed",
  "received":{"text":"UNAUTHORIZED_RECEIVE","consRef":{"consId":"新建的UUID","revision":1}},
  "steps":[
    {"node":"forge","action":"probe.a","status":"succeeded"},
    {"node":"invoke","action":"seed.receive","status":"succeeded"}
  ]
}
```

影响与前提：需要自定义流程使用该 outputKey，并非默认 ingest 随便一个响应就能绕过所有权限。但自定义流程本身目前能通过校验，普通模型输出由此成为可信授权，违反执行器关键不变量。

建议：

1. 授权记录与用户/模型工作状态分开持久化，绑定 run、来源 step、候选快照和 selected ref。
2. 流程编译时禁止所有内部保留 outputKey；入口 state 和子流程输入也不能注入内部元数据。
3. 取授权时确认 selected 属于记录的候选，且记录来源为已成功的合法选择步骤。
4. 为上述实际调用 receive 的场景添加回归测试，不仅测试 authorized:true 的旧载荷。

### R2 · P1：每次应用初始化会覆盖已修订的种子方法，破坏持久学习结果

位置：

- [app.ts:26–28](<src/app.ts#L26-L28>) 每次 createApp 都执行 loadSeeds。
- [load-main.ts:49–58](<src/seed/load-main.ts#L49-L58>) 只要数据库内容与源码种子不同，就创建并激活源码种子修订。

独立内存复现：

1. 初始化种子。
2. 将 `seed.decompose.default` 创建新修订，body 与 instructions 均改为 `USER_NEW_METHOD`，并激活。
3. 再调用一次 loadSeeds，模拟下一次 createApp 的初始化路径。

结果：

```text
before_reload USER_NEW_METHOD
after_reload 执行动作「拆解」的默认方法：将输入拆解为临时对象与关系描述……
active_revision 3
```

旧修订记录没有被删除，但实际活跃方法被覆盖为源码定义。种子流程或倾向被修改后也受同类逻辑影响。这不是期望的“方法可修改并持续影响未来行为”。

建议：初始化只补缺失种子；种子升级使用显式版本迁移与来源信息。源码升级和用户/系统修订冲突时保留当前活跃版本或显式报告，不以内容不同作为自动重置依据。

新增测试：修订并激活种子方法后，关闭并重新打开数据库/createApp，活跃内容保持用户修改；独立测试开发者迁移规则。

## 3. 其他确认的残留问题

### R3 · P2：Schema 仅检查关键字白名单，不检查其结构；非法动态定义可激活并使运行抛异常

位置：[schema.ts:50–70](<src/schema.ts#L50-L70>)、[schema.ts:73–105](<src/schema.ts#L73-L105>)、[动作激活:494–502](<src/primitives/index.ts#L494-L502>)。

首轮 const/oneOf/minimum 被静默忽略的问题已变为明确拒绝，联合类型 required 与无 properties 的 additionalProperties 也已修复。

但以下 schema 通过关键字检查：

```json
{"type":"object","properties":{"x":null}}
```

独立复现：为动态 LLM 动作设置该 inputSchema，提供合法默认方法，正常 activate 成功；自定义流程以 `{x:1}` 调用。

```text
malformed_action_activated active
uncaught Cannot convert undefined or null to object
```

runFlow 直接抛 TypeError，而非受控 schema_mismatch 运行结果。

建议：激活时验证 schema 自身的元结构：properties 值、items 必须是合法子 schema，required 必须是字符串数组，type 为支持类型，enum 等字段类型合法；不支持布尔 schema 就明确拒绝。schema 校验错误不能逃逸为未捕获运行异常。

### R4 · P2：人工激活专用事件在事务外，导致 HTTP 失败但业务已提交

位置：[server.ts:218–228](<src/api/server.ts#L218-L228>)。

共享激活服务已经把绑定、状态与一般 cons_activated 事件放入事务，首轮半激活问题修复。

但 human_cons_activated 仍在事务提交后追加。真实本地 HTTP 注入仅该事件写入失败：

```text
POST /cons/event.fail/activate → HTTP400 injected audit failure
后续 getCons → status:active
```

建议：把专用审计事件放到同一事务，或定义明确的“业务提交成功、审计降级”语义，不返回会使调用者认为激活失败的普通400。

### R5 · P2：方法升版与改绑未清理旧关联

位置：[activateConsInTx:644–663](<src/primitives/index.ts#L644-L663>)、[setMethodBinding:407–415](<src/store/index.ts#L407-L415>)、[methodCandidatesCore:228–240](<src/primitives/index.ts#L228-L240>)。

经真实本地 HTTP 复现：

1. 方法@1 属于 decompose，激活。
2. 修订到@2并激活：绑定已更新到@2，但 method_of 边仍来自@1。
3. 修订@3，将 actionId 改为 classify 并激活：旧 decompose 绑定@2仍 active。
4. 查询 decompose 方法候选仍返回该方法@2。

不能由此直接断言旧方法一定能通过执行器所有后续检查；已证实的是绑定和关系生命周期不一致、候选返回旧版本。

建议：激活时同步更新方法所属关系和绑定，撤销不再适用的旧绑定；若要允许多版本并行，必须显式建模，不能由旧行意外残留决定。

### R6 · P2，限定多 store 场景：全局 AsyncLocalStorage 未绑定 store 身份

位置：[store/index.ts:30](<src/store/index.ts#L30>)、[store/index.ts:147–149](<src/store/index.ts#L147-L149>)、[事务实现](<src/store/index.ts#L597-L603>)。

普通单 store 读取现在会正确等待事务提交或回滚，本轮实测已通过。

但两个 store 共享同一个事务上下文标记。复现：B 事务临时把对象置 active 后暂停；在 A.transaction 中调用 B.getCons，跳过 B 队列并读到未提交 active；B 回滚后对象变回 draft。

建议：每个 store 使用独立 ALS，或 context 包含连接/store 身份，仅同实例事务允许重入。

## 4. 规格与低层接口的限制说明

### R7：动态内容动作接入策略仍不完整

[默认流程:573–582](<src/seed/seeds.ts#L573-L582>) 的允许列表固定为 decompose、classify、reference_case。它修复了控制动作混入，但新形成的合法内容动作不会自动进入默认 ingest 的可用范围。

若这是有意要求“新动作激活后，还需显式接入某个任务能力集合”，应将这一接入操作做成 cons 流程，并记录验收要求；否则当前形成动作流程并未完成其未来使用入口。不能简单恢复所有 action 作为候选。

此外，[兼容性筛选:370–384](<src/primitives/index.ts#L370-L384>) 主要检查字段名称，没有验证 input/task 类型与 artifacts/links 类型。例如要求 input 为 string 的动作，仍可能通过此筛选，但默认 ingest 传入的是对象。

该兼容性问题目前被默认固定白名单部分遮蔽；扩展内容动作集合前应补完整契约检查和测试。

### 低层 connect 并发与引用检查

- 实际 createSeedPrimitives wrappedConnect 已用外层事务和结果缓存兜底，并发重放返回同一边 ID。
- 裸 createPrimitives().connect 的缓存读取仍在事务外，并发直接调用可能写入两条边。仅作为低层接口隐患，不误报为默认应用恢复仍失败。
- connect 服务层已拒绝非法端点版本；数据库没有复合版本外键，直接 store.createEdge 不具有同等保障。若 store 作为公开可信底层接口使用，应补检查或标明职责。

## 5. 下轮建议验收范围

优先修 R1、R2，再修 R3–R5；单实例部署可暂将 R6 明确列为多 store 限制。

建议新增最小回归集：

1. 保留 outputKey 无法覆盖授权记录；入口/子流程输入也无法注入授权。
2. 已修订种子方法跨应用重启保持激活内容。
3. 非法 schema 在激活阶段失败，运行不会遗留未捕获异常。
4. 激活事件故障与业务状态具有一致提交语义。
5. 方法升版/改归属后候选和关系一致，旧绑定按策略撤销。
6. 新内容动作的“激活→加入许可集合→检索→执行”有明确闭环。

核心 mock 内化机制本轮比上一轮明显扎实：输入和案例不再缺失，多数存储错误已有实证修复。但授权和持久修改仍存在 P1，不能用205个测试全绿代替完整通过。真实模型验证仍未进行，本报告不评价知识正确性或模型效果。
