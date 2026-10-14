# 原生会话同步公共输入 0.1.0

包 B54-NATIVE-SESSION-SYNC。公共实现由 W0-I 维护；当前处于候选验证。固定上游 c13f7d93fff0f578886985a3f673b4b21b7f6ac8，完整补丁及源码指纹见同目录 native-sync-source.json；新增实现位于 integration/patches/0017-native-session-sync.patch。原有 AAA 界面覆盖层、锁文件和原生会话身份保持。

正式对话与轻量 thread shell 均提供可选 `nativeSessionObservation`（缺失或 null 表示尚无原生观察证据）：

```ts
{
  provider: 'codex' | 'dsh';
  instanceId: ProviderInstanceId;
  nativeId: string;
  status: 'ready' | 'running' | 'waiting_approval' | 'waiting_answer' | 'unknown';
  checkedAt: string; // ISO，最近一次写入此观察内容的核验时间
  syncVersion: string; // 同一绑定内的内容/状态指纹
}
```

字段由原有原生绑定的只读读取产生，消息、轮次、观察和检查点随同一正式事件事务提交。`session.status` 仍表示 T3 本地运行归属；本字段不会获取、停止或接管原生 writer。服务端初始/重新进入 shell 查询、`thread-upserted` shell 流及详情快照/`thread.native-session-synced` 详情流均携带此字段；客户端 shell reducer 整体保留字段，详情 reducer 由正式事件更新。

`latestTurn` 是已核验的原生最新轮次或原有 T3 轮次：state 为 running/completed/interrupted/error。unknown 读取保留已同步消息和上一轮次，不能据上一 completed 宣称当前原生已结束。ready 表示读取时原生空闲，不表示会话永久结束。checkedAt 不是新鲜度期限；相同读不写重复事件，界面不自行设 TTL。

观察范围为已进入的原 T3 对话，HTTP 详情读取登记短期观察，活跃 WS 详情订阅持续观察；5 秒轮询，HTTP 登记无活跃订阅时 120 秒后释放。Flow shell 展示最近已持久化观察，不因 Flow 列表本身对所有会话启动观察。原生读取不可用时写 unknown，保留原记录。公共字段不序列化检查点、认证材料或原生私有日志。

界面消费优先关系：

1. 原有本地 pending 审批/回答保留最高提示优先级；原有本地 running/starting/background 仍显示进行中。
2. 原生 waiting_approval/waiting_answer 显示原生待审批/待回答；running 显示原生进行中，覆盖本地 stopped/settled 的已结束归类。仅供阅读，不生成 T3 审批按钮或原生停止按钮。
3. 本地 session.updatedAt 早于最新原生轮 completedAt（缺失时 startedAt/requestedAt）的错误属于上次本地记录，不覆盖较新原生结果，详情可附原时间；相等或更新的明确本地错误保留原提示。checkedAt 不用于错误归属判断。原生 ready 按 latestTurn 的 completed/error/interrupted 显示原生空闲/上轮异常/上轮中断，保留本地状态区别。
ready 配合 latestTurn running/null 时显示原生空闲/idle，详情分别注明轮次状态待核验/尚无已同步轮次。

4. unknown 显示原生待核验；缺失/null 显示原生未核验。本地 stopped/settled 可标为本地已结束，不能借此声称原生已经结束。状态和 category 同步映射，筛选不得把原生 working 放进已结束组。

W1 只改原 Flow 节点显示与 category、共享只读状态映射、原 ChatView 的独立状态提示及必要受控测试/现有客户端构建。保持样式、节点身份、原路由、草稿和既有 FlowCanvas；不改 ChatView isWorking/Stop/Send、公共 DTO、session runtime 归属、锁文件或黑板。只在 node.progress 写提示会被黑板覆盖，应在详情 banner stack 显示独立提示。

验证分层：公共受控检查、候选实际进程、S 原两会话页面体验分别记录。已有 DSH 两轮补齐不调用模型。新的 Codex 真实续聊沿 C 已授权的新 run、唯一 S ledger、原准确 IDs/gpt-6-astra low/最多两次执行；旧到期 run 保持封存。
