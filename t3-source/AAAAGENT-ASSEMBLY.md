# AAAAGENT T3 源码快照

上游 `c13f7d93fff0f578886985a3f673b4b21b7f6ac8`；项目源码 `3798c0e6da49fc03dec6a0b05bb4beb46d99edfe`。

本目录已应用 AAAAGENT 补丁、界面覆盖层及独立协作接口。可作为 Windows 构建起点。
原始补丁与覆盖层同时保留在 `../code/`，构建时由 `package-windows-t3.mjs` 生成逐文件 SHA256 清单。
本目录保留 Web／Server／Desktop 构建源码及包管理锁；移动端只保留构建许可依赖，未打包移动端 SDK 或二进制。
具体步骤见 [Windows 固定引擎与 T3 工作台](../code/workbench/integration/engine-pins/README.md)。

上游 MIT 许可证保留于 [LICENSE](LICENSE)，其他依赖和角色资源分别遵守 [第三方声明](../THIRD_PARTY_NOTICES.md)。Apple 设备 GLB 未确认可再分发，不在公开源码中；设备视图可以不依赖这些可选模型构建。授权使用者自行提供本地文件时，构建会自动载入。
