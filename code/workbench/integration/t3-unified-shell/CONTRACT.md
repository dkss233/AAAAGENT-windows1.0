# B54 统一工作区展示接缝 0.1

包：B54-WORKSPACE-UI-INTEGRATION；正式741／所有权714，设计0.4 SHA292988b2672c1eea43059a656c5aa43c8fd15f76ce86b2489f2a3baab795bc5b。输入沿740候选I源码72d5fe1、W1模块eebaf50／原生400aecb及精确测试ce3ee91，原T3 c13f7d93／14补丁845f5f。实际目录与下一固定Git ref见正式根OWNERSHIP；分支文档仅快照。

已有真实只读挂载口保持。原生同origin `/native/`、management Bearer建立候选HttpOnly会话、原只读RPC allowlist及禁写边界均不扩大。以下只描述父管理页与原生frame之间的浏览器展示联接，不提供业务权限。

## 生命周期与显示

W1是管理app/index/style/native portal、AAA工具栏/菜单/原主题接线及其测试的唯一实现者。I不独立写DOM、CSS、React或主题状态，负责约定、原来源/构建、候选运行和精确接收。

父页持有一个现存原生frame。进入/返回工程仅改变布局及可见性，不销毁frame、重复mount POST、重写src、重新鉴权或重置Flow视口；父快照更新沿原保持策略。260ms进出由W1实现可中断、reduced-motion及焦点，无持续覆盖层。鉴权真正失效继续沿原mount机制阻挡旧frame、显式重连；不能用展示事件绕过失效。

## 最小父子消息

消息使用 `postMessage`，准确targetOrigin为当前同origin，禁止 `*`。接收方同时核event.origin和event.source：父仅接受现存frame.contentWindow，子仅接受window.parent；独立顶层T3忽略此桥。路径变化/另窗口/失效或disposal后的旧来源均不控制父页。未知版本、类型或无效枚举忽略；不解析或执行HTML、任意URL、函数或工程命令。

统一信封字段：`source:"aaa-workspace-ui"`、`version:1`、`type`，以及下列限定展示字段：

| 方向 | type | 允许字段与行为 |
| --- | --- | --- |
| 子→父 | `shell.ready` | 无其他字段；仅请求当前展示快照，不创建会话 |
| 子→父 | `management.navigate` | `page`为overview/memory/projects/tasks/wechat/models/presentation/events之一；沿原selectPage进入该管理页，工程frame保持 |
| 子→父 | `appearance.set` | `mode`为light/dark/system；只改变本地浏览器外观 |
| 父→子 | `shell.state` | `mode`为light/dark/system，`resolved`为light/dark，`phase`为idle/connecting/ready/unavailable/offline/expired/error；同步显示，不复制token/session/environment正文 |

父页可直接调用自己的导航和主题实现，子页面工具栏/AAA菜单发上述展示意图；父状态改变或子ready发送当前shell.state。消息不携带凭据、用户对话、命令、供应商配置或模型结果。没有新增HTTP/RPC写口，不把返回管理当作退出或停止工程任务。

## 共享外观偏好

复用原生已存在单一appearance-mode存储键 `t3code:theme-appearance-mode`（原始字符串light/dark/system）。原`useTheme.readAppearanceModePreference`及`setAppearanceMode`是原生接线输入；管理appearance模块复用相同语义，禁止另建竞争偏好键或后端设置。原`storage`事件可同步其他文档；同文档及时应用并通知，必要的同origin桥用于受限存储时的内存同步。

初始化先读展示偏好，解析system时读`prefers-color-scheme:dark`；媒体变化只在system模式影响有效颜色。模式切换覆盖管理页、表单/状态/菜单/提示与工程区，刷新持久性依浏览器正常存储；存储抛错时本次选择仍可展示并明确不宣称已保存。保留`t3code:themes:v1`、原主题ID、主题半区与自定义主题数据；普通明暗模式切换不清理原数据。主题角色/默认米白暖灰配色及原主题接线属于W1界面实现；无新依赖、模型或业务设置。

## 组装与实际候选

固定Node24.13.1；tools/t3-native-54/prepare.mjs只读原源码和已有依赖缓存，显式W1overlay仅放行登记模块及AppSidebarLayout。run.mjs build --native-read继续固定原生base/只读标识。新增候选由I使用原serve-existing，参数：`--management-readonly --port 59914 --package B54-WORKSPACE-UI-INTEGRATION --runtime-dir artifacts/runtime/workspace-ui-integration-54 --ui-root <新W1管理UI目录>`。候选dist来自新I组装目录，不替换59913资源。

private候选session为0600，留本任务runtime，不进入文档/截图/消息。复用原T3/Host/home和已装361只读reader，不重启旧后台、新home/任务或provider。候选端口此处是分配，启动后以真实回执核PID/origin；不得用静态文档当已运行。

验收仅U01–U05及受影响相邻读链：实际管理→工程→原会话→返回、单工具栏/菜单、260ms与减少动态、全站三模式/首屏/刷新、1280与390、原身份/草稿/节点位置/缩放与只读边界。既有原对话可能含过去合成试验材料，不新生成；实际浏览器、受控验证及自然使用分开。不重跑旧整套工程测试，不把本包推进到主干合入、安装、ASR、派发、父子schema或设备。
