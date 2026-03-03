# Change Log

All notable changes to the "dbviewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release

## [0.0.2] - 2026-03-03

- 支持 SSH 隧道连接（ssh2 forwardOut），并在隧道断开时自动重连（指数退避），添加 keepalive 设置
- 在连接配置面板添加 SSH 配置字段（SSH 主机/端口/用户/私钥/密码）
- 导入/导出连接（支持包含明文密码的导入导出）并在侧栏视图标题添加导入/导出按钮
- 单连接“刷新连接”功能：右键连接项可重连并刷新面板（复用刷新按钮）
- 连接配置持久化到 `~/.dbviewer/config.json`（同时保留 globalState），导入导出支持用户自选路径
- 密码可见切换（小眼睛）用于 MySQL 密码与 SSH 密码输入框
- 在 SSH 隧道或连接错误时给出用户提示并自动清理连接状态