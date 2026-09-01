# 化解之道 Flipbook 阅读器（交付版）

基于 PDF 的翻页阅读器 POC，支持 PC 双页 / 手机单页自适应、插入 HTML 内容页、章节目录与埋点。

## 一、运行环境要求

- **Node.js**：建议 v18 或 v20（已验证 v20 可用）。从 https://nodejs.org 下载安装 LTS 版即可。
- **网络**：首次运行需要联网，用于加载埋点 SDK（finder.js，见下文说明）。
- 操作系统：Windows / macOS / Linux 均可。

## 二、安装依赖

在本目录下打开终端（命令行），执行：

```bash
npm install
```

该命令会根据 `package-lock.json` 安装 `vite`、`page-flip`、`pdfjs-dist` 等依赖，会在本目录生成 `node_modules/`（首次安装稍慢，需等待完成）。

## 三、启动程序

在项目目录下打开终端（命令行），执行：

```bash
npm run dev
```

启动成功后，终端会输出本地访问地址，通常为：

```
  ➜  Local:   http://localhost:5173/
```

在浏览器打开该地址即可使用。

> 默认 PDF 为 `public/sample.pdf`。如需替换为自己的 PDF，直接替换该文件即可（保持文件名 `sample.pdf`）。

本程序**同一份代码自动适配 PC 端与手机端**，无需切换配置：
- 判定规则为「触屏 + 窄屏（屏幕宽度 ≤ 768px）」自动进入手机端单页布局；
- 使用鼠标指针的设备（即使窗口拉得很窄）一律按 PC 端双页布局处理。

下面分别说明两种端的使用方式。

### 3.1 PC 端运行

1. 在电脑上执行 `npm run dev` 启动服务。
2. 用电脑浏览器（推荐 Chrome / Edge）打开终端输出的地址，通常为 `http://localhost:5173/`。
3. PC 端表现为**双页翻书**布局，左侧为功能图标栏（目录 / 缩略图 / 搜索等），支持鼠标拖拽翻页、文字选择。

### 3.2 手机端运行

手机需与运行 `npm run dev` 的电脑处于**同一局域网**（连同一个 Wi-Fi），并按以下步骤让服务暴露到局域网：

1. 在电脑上用以下命令启动（加 `--host` 参数，允许局域网内其他设备访问）：

   ```bash
   npm run dev -- --host
   ```

   或用 npx 直接指定：

   ```bash
   npx vite --host
   ```

2. 启动后终端会额外输出 `Network` 地址，例如：

   ```
   ➜  Local:   http://localhost:5173/
   ➜  Network: http://192.168.1.23:5173/
   ```

3. 在手机浏览器（推荐 Chrome / Safari）地址栏输入上面的 **Network 地址**（即 `http://<电脑局域网IP>:5173/`）。
4. 手机端自动表现为**单页**布局，顶部为工具栏（首页 / 目录 / 搜索等），支持触摸滑动翻页。

> 说明：
> - 电脑的局域网 IP 可在电脑上执行 `ipconfig`（Windows）/ `ifconfig`（macOS/Linux）查看，一般为 `192.168.x.x` 或 `10.x.x.x`。
> - 若手机无法访问，请检查电脑防火墙是否放行 5173 端口，或确认手机与电脑在同一 Wi-Fi。
> - 若只是想在电脑上预览手机端效果，也可在浏览器中打开开发者工具（F12）切换为手机模拟视图，窗口宽度 ≤ 768px 且模拟触控时即会呈现手机布局。

## 四、关于埋点 SDK（finder.js）的说明

`index.html` 第 212 行同步加载了施耐德埋点 SDK：

```html
<script src="https://nsma-web.schneider-electric.cn/finder.js"></script>
```

- 该文件托管在施耐德内网域名，**需要联网**才能加载。
- 若无法访问该地址（如离线环境），页面会等待加载超时，可能导致页面**白屏或启动变慢**；埋点数据不会上报，但翻页、插入 HTML 页等核心阅读功能不受影响。
- 如果你不需要埋点，可注释掉 `index.html` 中第 211–212 行（埋点相关注释与 `<script>` 标签），程序可完全离线运行。

## 五、插入 HTML 内容页（可选功能）

插入页数据位于 `data/v19_single_pages/`（已随本包提供），由 `public/insert-config.json` 配置映射到 PDF 的具体页码。

- 如需增删插入页：编辑 `public/insert-config.json`，并将对应 HTML 放入 `data/v19_single_pages/`。
- `public/insert-config.json` 为实际配置，`poc-config.example.json` 为配置样例，可供参考。

## 六、目录说明

```
flipbook_delivery/
├── index.html              # 入口页面（含 finder.js 引用）
├── package.json            # 依赖与启动脚本
├── package-lock.json       # 依赖锁定
├── vite.config.js          # Vite 配置
├── public/                 # 静态资源（sample.pdf、字体、配置 JSON、text-index.json）
├── src/                    # 源码（app / core / platforms）
├── scripts/                # 构建脚本
└── data/
    └── v19_single_pages/   # 插入的 HTML 单页内容（运行时必需）
```

## 七、常见问题

1. **端口被占用**：若 5173 被占用，Vite 会自动使用 5174 等下一个可用端口，以终端输出为准。
2. **页面空白**：先确认 `npm install` 已完成；若长时间空白，多为 finder.js 加载受限（见第四节）。
3. **PDF 不显示**：确认 `public/sample.pdf` 存在且未损坏。

---
交付时间：2026-08-25

## 八、Nginx `/pdf` 生产部署

项目的 Vite 生产路径固定为 `/pdf/`。完整源码包内同时包含源码与已经构建好的
`dist/`：可以直接部署 `dist`，也可以在远程服务器重新构建。

### 8.1 从源码重新构建

```bash
npm ci
npm run build
```

构建会把 `public/sample.pdf`、字体、配置文件以及插入页 `data/` 一并放入 `dist/`。

### 8.2 部署到远程 Nginx

```bash
sudo mkdir -p /usr/share/nginx/html/pdf
sudo cp -a dist/. /usr/share/nginx/html/pdf/
sudo cp deploy/nginx.conf /etc/nginx/conf.d/flipbook-pdf.conf
sudo nginx -t
sudo nginx -s reload
```

部署后访问：

```text
http://你的服务器地址/pdf/
```

PDF.js 会访问 `/pdf/sample.pdf`，`deploy/nginx.conf` 已配置标准 Range/206、`.mjs`
MIME、静态资源缓存以及 `/pdf/` SPA 回退。如果服务器已有自己的 `server {}`，请把
该配置中的 `/pdf` locations 合并到现有站点，不要同时保留两个冲突的默认 server。

### 8.3 Docker（可选）

```bash
docker build -t flipbook-delivery .
docker run --rm -p 8080:80 flipbook-delivery
```

访问 `http://localhost:8080/pdf/`。
