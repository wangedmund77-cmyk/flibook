// 入口文件（步骤4 后）：仅负责加载编排层 app.js，由 App 自行启动。
// 所有逻辑已拆分到：
//   - src/core/      （平台无关：pdf-engine / text-index / toc / state）
//   - src/platforms/ （端专属：pc.js / mobile.js）
//   - src/app.js     （编排层：装配 core + platforms，承载两端共用逻辑）
import './app.js';
