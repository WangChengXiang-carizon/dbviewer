# Change Log

All notable changes to the "dbviewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- 初始开发与修复（见下面版本历史）

## [0.0.3] - 2026-03-04

- 修复并增强 SQL 查询面板：在 webview 中处理 `execute` 消息并返回结果；当在表级打开时注入默认 SQL（`SELECT * FROM \\`DB\\`.\\`TABLE\\` LIMIT 100;`），在数据库级打开时默认展示 `SHOW TABLES;`；对无结果集的语句返回受影响行信息。
- 修复表视图后端：使用 `information_schema.COLUMNS` 返回列信息并按前端期望别名（Field/Type/Null/Key/Default/Extra/Comment）；改用 `.query` 执行以避免 prepared-statement 参数错误；返回分页数据与外键引用以支持结构/数据/ER 页面渲染。
- 修复连接配置面板：实现 `save`/`test`/`delete` 消息处理；`test` 使用临时连接并立即断开，`delete` 后自动关闭编辑面板并刷新侧栏（加入短延迟以缓解删除首项的刷新竞态）。
- 修复侧栏连接图标显示问题：使用彩色 SVG 图标并为 `TreeItem` 设置稳定 `id`，保证局部刷新与颜色显示一致。
- 其他：若干编译与 lint 修复，改进错误提示与日志。

## [0.0.2] - 2026-03-03

- 支持 SSH 隧道连接（ssh2 forwardOut），并在隧道断开时自动重连（指数退避），添加 keepalive 设置
- 在连接配置面板添加 SSH 配置字段（SSH 主机/端口/用户/私钥/密码）
- 导入/导出连接（支持包含明文密码的导入导出）并在侧栏视图标题添加导入/导出按钮
- 单连接“刷新连接”功能：右键连接项可重连并刷新面板（复用刷新按钮）
- 连接配置持久化到 `~/.dbviewer/config.json`（同时保留 globalState），导入导出支持用户自选路径
- 密码可见切换（小眼睛）用于 MySQL 密码与 SSH 密码输入框
- 在 SSH 隧道或连接错误时给出用户提示并自动清理连接状态