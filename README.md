# PDF 电子签名工具

纯前端实现的 PDF 电子签名工具，支持手机触屏操作。

## 功能

- 📄 **PDF 上传与预览** - 支持多页文档，缩放、翻页
- ✍️ **手写签名** - 触屏/鼠标绘制，支持颜色、粗细调节，20步撤回
- 🔤 **文字签名** - 输入姓名，实时预览
- 📅 **日期填写** - 年月日输入，今日快捷按钮
- 💾 **账号保存** - 注册登录后保存签名历史，随时调用
- 🗑️ **签名删除** - 点击选中后删除
- 📥 **导出 PDF** - 签名嵌入 PDF 下载

## 技术栈

- PDF.js - PDF 渲染
- pdf-lib - PDF 导出编辑
- Flask + SQLite - 后端账号系统

## 快速启动

### 仅前端（静态模式）

```bash
cd pdf-sign
python -m http.server 3030
# 访问 http://localhost:3030
```

### 后端模式（支持账号保存）

```bash
# 安装依赖
pip install flask flask-cors

# 启动后端（端口 5050）
python server.py
# 访问 http://localhost:5050
```

## 项目结构

```
pdf-sign/
├── index.html   # 页面结构
├── style.css    # 样式
└── app.js       # 前端逻辑

server.py        # Flask 后端（账号系统）
signatures.db    # SQLite 数据库（自动生成）
```
