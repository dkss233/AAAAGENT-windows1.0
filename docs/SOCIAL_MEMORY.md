# Windows：QQ 机器人与桌宠社交记忆

移植自上游 `134d7d4`，核对文档版本 `7f2984b`。Windows 桌宠已接入独立社交缓存，并与本机维里奈 QQ 机器人的发送回执连接。

## 使用方式

先启动社交服务，再启动桌宠。现有 QQ 机器人收到消息并取得平台发送回执后，会把这一轮的发言和实际回复排入持久队列。后台使用云端 DeepSeek 生成摘要，桌宠每 15 秒拉取允许共享的摘要，可以回答“你最近在群里聊了什么”。

群、成员和消息用稳定标识区分，QQ 标识进入社交服务前做确定性散列，原始发送回执仍保留在机器人原数据库中。昵称仅作显示。群友的经历不归给当前用户，QQ 公开人设不覆盖私人桌宠的人设。首次启用不会把旧群聊或测试数据导入正式记忆。

本机已经保留原 QQ 聊天、联网搜索、表情包和反馈登记流程。新社交服务只总结已送达的回复，不再额外生成、领取或发送第二条 QQ 回复。没有发送回执的失败、超时和结果不明消息不进入参与经历。

## 启停

在 `windows/code/desktop-pet` 下执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action start
powershell -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action restart
powershell -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action stop
```

用户登录时的后台任务名为 `AAAAGENT-SocialMemory-Local`，无运行时限，进程退出后等待 10 秒恢复；当前方式依赖用户登录。默认只监听 `127.0.0.1:18766`，QQ 管理页继续使用 `18765`。本机软件服务不等于本地模型：正式摘要调用配置的 HTTPS 云端模型，没有本地推理或本地模型回退。

配置、角色身份和三类服务凭据保存在 `.local/social-service/service.json`，Node 运行时与其 SQLite 原生依赖保持同一 ABI。本机选用机器人随包的 Node 22。服务凭据、数据库、连接配置及目录由 Windows SID ACL 保护；模型密钥引用现有受保护文件，不写入源码。默认每日最多 100 次摘要请求，独立于原 QQ 回答计数。

初次连接本机现有迁移包，可执行：

```powershell
node tools/pet-cloud/configure-windows.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action start
node tools/pet-cloud/configure-windows.mjs --connect
```

脚本仅连接迁移包当前绑定的群，保留服务角色及凭据；检测到其他角色连接时拒绝覆盖。迁移包侧的适配器源码与安装补丁见 `tools/pet-cloud/qq-bridge/`。桌宠连接保存到 `.local/data/social-connection.json`，重启已更新的桌宠后自动拉取。

## 记忆、撤回与故障

- `.local/social-service/social.sqlite`：群发言、实际回复、发送回执、摘要及共享策略。
- `.local/data/social-cache.sqlite`：桌宠只读拉取的社交摘要、公开人设和游标。
- `.local/data/companion.sqlite`：原私人对话和长期记忆，社交服务不会打开或上传该数据库。
- QQ 迁移包 `data/social-outbox.sqlite`：仅存新近已送达回复的待同步记录；重启、服务离线或请求超时后重试相同事件，不重发 QQ 消息。

关闭群共享或遗忘经历后，缓存会撤回相关来源及派生摘要。缓存超过五分钟未成功同步便停止参与新回答；推理期间发生撤回，旧回答也不会发布。已在私人对话里复述或另存为私人记忆的内容，由原有私人记忆遗忘功能处理。

`cli.mjs status` / `jobs` 可查看服务状态。遗忘使用 `node tools/pet-cloud/cli.mjs forget <数据目录> <经历ID>`。模型结果不明会保留待核查状态，不自动重复收费请求；只在明确失败时按既有有限重试规则处理。源群记录目前没有自动清理期限。

Windows 渠道扩展 `POST /v1/{roleId}/participations` 使用 channel 凭据，提交 `{event, reply, receipt}`。服务验证群作用域和启用策略，对相同事件去重，摘要根据实际回复生成；它不把摘要模型的新文本当作已发送回复。私人历史及额外字段拒绝接收。

## 已执行验证

2026-10-17，在 Windows 上完成：

- 完整 TypeScript 编译、649 项现有记忆/模型适配器回归检查。
- 27 项社交、连接、回执、恢复、撤回和权限检查；QQ 适配器 4 项检查，原搜索流程 8 项回归检查。
- 6 次真实云端 `deepseek-flash` 调用，覆盖 QQ 回答、摘要生成、桌宠读取、重启恢复和遗忘后的回答；本地模型调用为 0。
- 云端测试使用隔离数据库、合成群友与模拟 QQ 发送回执，未向真实 QQ 群发送测试消息，未导入正式私人记忆。真实群内送达还需自然新消息确认。

测试入口：`node tools/pet-cloud/cloud-check.mjs`；结果在 `.local/social-integration-20261017/cloud-validation.json`。该命令会调用云端模型；不会运行本地模型或发送 QQ 消息。
