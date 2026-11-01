// 水印几何：用画布尺寸和字体实际测量值定位，预览与导出共享。
(() => {
  'use strict';
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function computePlacement({width, height, textWidth, ascent, descent, position, customX, customY, panelX, panelY, inset}) {
    const margin = Math.max(0, Math.min(inset, width / 2, height / 2));
    const w = Math.max(0, Math.min(textWidth, width - margin * 2));
    const a = Math.max(0, ascent);
    const d = Math.max(0, descent);
    const halfHeight = (a + d) / 2;
    let centerX = width / 2;
    let centerY = height / 2;
    if (position === 'custom') {
      centerX = clamp(Number.isFinite(customX) ? customX : .5, 0, 1) * width;
      centerY = clamp(Number.isFinite(customY) ? customY : .5, 0, 1) * height;
    } else if (position === 'seam') {
      centerX = panelX > 0 ? panelX : width / 2;
      centerY = panelY > 0 ? panelY : height / 2;
    } else {
      if (position.includes('left')) centerX = margin + w / 2;
      else if (position.includes('right')) centerX = width - margin - w / 2;
      if (position.startsWith('top')) centerY = margin + halfHeight;
      else if (position.startsWith('bottom')) centerY = height - margin - halfHeight;
    }
    centerX = clamp(centerX, margin + w / 2, width - margin - w / 2);
    centerY = halfHeight * 2 <= height - margin * 2
      ? clamp(centerY, margin + halfHeight, height - margin - halfHeight)
      : height / 2;
    return {x: centerX - w / 2, y: centerY + (a - d) / 2, width: w, ascent: a, descent: d, centerX, centerY};
  }

  function moveToNormalized({width, height, x, y}) {
    return {x: width > 0 ? clamp(x / width, 0, 1) : .5, y: height > 0 ? clamp(y / height, 0, 1) : .5};
  }

  window.FrameLabWatermarkGeometry = {computePlacement, moveToNormalized};
})();
