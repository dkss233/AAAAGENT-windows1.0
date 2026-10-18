# 现有 QQ 机器人渠道适配

`social_bridge.py` 是本机迁移包实际使用的适配器副本，放在机器人 `app/` 目录，与原有 `core.py` 一起使用。`runtime.patch` 展示 Runtime 的完整接线：初始化、成功发送后入队、状态和关闭。`manage-local.patch` 将 QQ 重启时的 Node 进程筛选限定到 QQ 连接子进程，让独立社交服务继续运行。应用补丁前检查现有版本及上下文，保留原文件；当前本机部署已经接好，无需重复应用。

从迁移包根目录使用 `git apply --check --ignore-space-change` 检查两个补丁，再使用不带 `--check` 的相同命令应用。`--ignore-space-change` 兼容 Windows CRLF 与 LF 的上下文；公开副本已分别检查两种换行的补丁适用性。

只有 `gateway.send` 返回真实回复 ID、原消息已标记 `replied` 后，才调用 `record_delivery(item, reply, reply_id)`。失败、超时、不明结果或仅上传图片都不能调用该方法。适配器只向社交服务提交已确认交流，不向 QQ 发送任何消息。

独立出站队列保存事件及回执的确定性标识，请求超时后重试同一事件。服务端去重，生成摘要也不再次发送回复。原始 QQ 回执留在机器人自己的消息库中，可按散列标识对应核查。

配置位于机器人 `secrets/social-channel.json`，由 `configure-windows.mjs` 生成，只包括 channel 凭据和现有绑定群；不授予 admin 或桌宠私有数据库权限。目录和配置使用 Windows 私有 ACL，勿公开源码之外的运行目录。

将本目录 `check_social_bridge.py` 一并复制到迁移包 `app/`，随后使用迁移包的 Python 执行它；脚本依赖该迁移包的 `app.py`、`core.py` 及既有运行依赖，仓库没有附带完整 QQ 程序。检查入口在迁移包 `app/check_social_bridge.py`。云端联调入口在上一级 `cloud-check.mjs`；真实模型调用使用云端，QQ 发送端是明确标记的合成发送器，测试数据不进入正式社交缓存。
