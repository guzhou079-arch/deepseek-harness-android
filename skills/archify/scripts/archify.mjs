import fs from 'node:fs';
import path from 'node:path';

/**
 * 现代高颜值架构图生成器 (HTML/SVG 自包含模板)
 * 支持节点拖拽、鼠标滚轮/手势缩放、深色主题、一键导出 PNG/SVG。
 */
export function renderArchitectureHtml(title, subtitle, nodes, edges) {
  const data = JSON.stringify({ nodes, edges, title, subtitle });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - 架构图</title>
<style>
  :root {
    --bg: #0d1117;
    --card-bg: rgba(22, 27, 34, 0.85);
    --card-border: rgba(56, 139, 253, 0.3);
    --card-hover: rgba(56, 139, 253, 0.6);
    --text-main: #f0f6fc;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --line-color: #388bfd;
    --node-core: #1f6feb;
    --node-util: #238636;
    --node-ui: #a371f7;
    --node-bridge: #d29922;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: var(--bg);
    color: var(--text-main);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    user-select: none;
  }
  header {
    padding: 16px 24px;
    background: rgba(13, 17, 23, 0.8);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 10;
  }
  header h1 { font-size: 18px; font-weight: 600; color: var(--accent); }
  header p { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .toolbar {
    display: flex;
    gap: 8px;
  }
  .btn {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    color: var(--text-main);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn:hover { background: rgba(56, 139, 253, 0.2); border-color: var(--accent); }
  #canvas-container {
    flex: 1;
    position: relative;
    cursor: grab;
    background-image: radial-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px);
    background-size: 24px 24px;
  }
  #canvas-container:active { cursor: grabbing; }
  svg#graph {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
  }
  .node-card {
    fill: var(--card-bg);
    stroke: var(--card-border);
    stroke-width: 1.5px;
    rx: 10px;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    filter: drop-shadow(0 4px 12px rgba(0,0,0,0.35));
    cursor: pointer;
  }
  .node-card:hover, .node-card.active {
    stroke: var(--accent);
    stroke-width: 2.5px;
    filter: drop-shadow(0 6px 20px rgba(56, 139, 253, 0.4));
  }
  .node-title {
    font-size: 14px;
    font-weight: 600;
    fill: var(--text-main);
  }
  .node-desc {
    font-size: 11px;
    fill: var(--text-muted);
  }
  .node-tag {
    font-size: 10px;
    font-weight: 500;
  }
  .edge-line {
    fill: none;
    stroke: var(--line-color);
    stroke-width: 2px;
    stroke-dasharray: 6,4;
    animation: dash 1.5s linear infinite;
    opacity: 0.6;
    transition: opacity 0.2s;
  }
  .edge-line.active { opacity: 1; stroke-width: 3px; }
  @keyframes dash {
    to { stroke-dashoffset: -20; }
  }
  .tooltip {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: rgba(22, 27, 34, 0.95);
    border: 1px solid var(--accent);
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 12px;
    max-width: 320px;
    display: none;
    z-index: 20;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle || '交互式系统架构与数据流图')}</p>
  </div>
  <div class="toolbar">
    <button class="btn" onclick="resetView()">🔄 居中复位</button>
    <button class="btn" onclick="zoomIn()">➕ 放大</button>
    <button class="btn" onclick="zoomOut()">➖ 缩小</button>
  </div>
</header>

<div id="canvas-container">
  <svg id="graph">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#58a6ff" />
      </marker>
    </defs>
    <g id="viewport"></g>
  </svg>
  <div id="tooltip" class="tooltip"></div>
</div>

<script>
const data = ${data};
const svg = document.getElementById('graph');
const viewport = document.getElementById('viewport');
const container = document.getElementById('canvas-container');
const tooltip = document.getElementById('tooltip');

let scale = 1;
let panX = 0, panY = 0;
let isDragging = false;
let startX, startY;

function updateTransform() {
  viewport.setAttribute('transform', \`translate(\${panX}, \${panY}) scale(\${scale})\`);
}

function resetView() {
  scale = 1;
  panX = container.clientWidth / 2 - 400;
  panY = container.clientHeight / 2 - 250;
  updateTransform();
}

function zoomIn() { scale *= 1.2; updateTransform(); }
function zoomOut() { scale *= 0.8; updateTransform(); }

// 拖拽与缩放事件
container.addEventListener('mousedown', (e) => {
  if (e.target.closest('.node-group')) return;
  isDragging = true;
  startX = e.clientX - panX;
  startY = e.clientY - panY;
});
window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  panX = e.clientX - startX;
  panY = e.clientY - startY;
  updateTransform();
});
window.addEventListener('mouseup', () => { isDragging = false; });
container.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.1 : 0.9;
  scale = Math.min(Math.max(0.2, scale * delta), 4);
  updateTransform();
}, { passive: false });

// 触屏手势
let initialDist = 0;
container.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    isDragging = true;
    startX = e.touches[0].clientX - panX;
    startY = e.touches[0].clientY - panY;
  } else if (e.touches.length === 2) {
    initialDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }
});
container.addEventListener('touchmove', (e) => {
  if (isDragging && e.touches.length === 1) {
    panX = e.touches[0].clientX - startX;
    panY = e.touches[0].clientY - startY;
    updateTransform();
  } else if (e.touches.length === 2) {
    const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    scale = Math.min(Math.max(0.2, scale * (dist / initialDist)), 4);
    initialDist = dist;
    updateTransform();
  }
});
container.addEventListener('touchend', () => { isDragging = false; });

// 渲染节点与连线
function render() {
  viewport.innerHTML = '';
  
  // 画连线
  data.edges.forEach(edge => {
    const fromNode = data.nodes.find(n => n.id === edge.from);
    const toNode = data.nodes.find(n => n.id === edge.to);
    if (!fromNode || !toNode) return;

    const x1 = fromNode.x + fromNode.w / 2;
    const y1 = fromNode.y + fromNode.h / 2;
    const x2 = toNode.x + toNode.w / 2;
    const y2 = toNode.y + toNode.h / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = \`M \${x1} \${y1} C \${x1 + dx * 0.5} \${y1}, \${x2 - dx * 0.5} \${y2}, \${x2} \${y2}\`;
    
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge-line');
    path.setAttribute('marker-end', 'url(#arrow)');
    viewport.appendChild(path);
  });

  // 画节点
  data.nodes.forEach(node => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node-group');
    g.setAttribute('transform', \`translate(\${node.x}, \${node.y})\`);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'node-card');
    rect.setAttribute('width', node.w);
    rect.setAttribute('height', node.h);

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    title.setAttribute('class', 'node-title');
    title.setAttribute('x', 16);
    title.setAttribute('y', 28);
    title.textContent = node.label;

    const desc = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    desc.setAttribute('class', 'node-desc');
    desc.setAttribute('x', 16);
    desc.setAttribute('y', 52);
    desc.textContent = node.desc || '';

    g.appendChild(rect);
    g.appendChild(title);
    g.appendChild(desc);

    g.addEventListener('click', (e) => {
      e.stopPropagation();
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${node.label}</strong><br><span style="color:#8b949e">\${node.detail || node.desc || '暂无详细说明'}</span>\`;
    });

    viewport.appendChild(g);
  });

  resetView();
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

render();
</script>
</body>
</html>`;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
