# 墨记 InkNotes 增强补丁与扩展套件

为「墨记 InkNotes」桌面客户端提供自动拉取、导出按钮合并、文件优先（Obsidian 库直连镜像）、AI 助手侧边栏与反向链接面板等增强能力。

## 目录结构

- **[`ink-patch/`](ink-patch/)**：补丁核心工程
  - `src/`：功能实现（AI 面板、反向链接抽屉、文件镜像服务、自动拉取、导出菜单等）
  - `pack.cjs`：补丁检测与安全注入脚本（支持增量校验、防重复注入）
  - `restore.cjs`：一键回退到官方原版或上一版本备份
  - `tools/`：`app.asar` 扫描、锚点比对与分析工具
  - `test-*.cjs`：全功能自动化与单元测试用例
  - `DESIGN-filesystem.md`：文件优先架构设计文档
- **[`preview/`](preview/)**：预览与验证套件
  - `serve-dist.cjs`：轻量静态服务，用于本地预览 Web 端界面
  - `verify-ai-panel.cjs`：基于 Chrome/Edge CDP 的无头/自动化验证与截图脚本
  - `shots/`：UI 界面效果预览截图

## 快速使用

详细安装、配置与使用文档请参阅：👉 **[ink-patch/README.md](ink-patch/README.md)**
