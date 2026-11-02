// Pure watermark module for the Photography Collage tool.
// No DOM access at import time: callers pass the canvas 2D context in, so every
// function is testable from Node with a mock context. Drawing coordinates are
// canvas pixels; sizes are per-mille (‰) of canvas width; positions are the
// normalized center of the text block in [0,1].
// Text is never horizontally squashed: no maxWidth is passed to fillText, so a
// long line keeps its true glyph size and may extend past the canvas edge.

export const SIZE_LIMITS = {min:8, max:200};

export const WATERMARK_FONTS = {
  sans:{id:'sans',label:'无衬线',stack:'-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',weight:'600'},
  serif:{id:'serif',label:'衬线',stack:'"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif',weight:'600'},
  mono:{id:'mono',label:'等宽',stack:'ui-monospace,"SFMono-Regular",Menlo,Consolas,"PingFang SC",monospace',weight:'600'},
  hand:{id:'hand',label:'手写',stack:'"Collage Hand","Kaiti SC",STKaiti,KaiTi,cursive',weight:'400'},
};

export const WATERMARK_DEFAULTS = {text:'留白',font:'sans',size:42,color:'#ffffff',opacity:.9,x:.5,y:.5,visible:true};

export const clamp01 = v => Math.min(1,Math.max(0,Number(v)||0));

function isHexColor(v){return typeof v==='string'&&/^#[0-9a-f]{6}$/.test(v);}
function toFinite(v){const n=Number(v);return Number.isFinite(n)?n:null;}

// Validate and coerce one raw record (e.g. from localStorage or the editor).
// Returns a fully typed mark, or null when the record is unusable (missing
// text, or no id and no fallbackId). Extra unknown fields are dropped.
export function normalizeWatermark(raw,fallbackId){
  if(!raw||typeof raw!=='object')return null;
  const text=typeof raw.text==='string'?raw.text.trim():'';
  if(!text)return null;
  const font=WATERMARK_FONTS[raw.font]?raw.font:WATERMARK_DEFAULTS.font;
  const sizeRaw=toFinite(raw.size);
  const size=sizeRaw==null?WATERMARK_DEFAULTS.size:Math.min(SIZE_LIMITS.max,Math.max(SIZE_LIMITS.min,sizeRaw));
  const color=isHexColor(raw.color)?raw.color:WATERMARK_DEFAULTS.color;
  const opacityRaw=toFinite(raw.opacity);
  const opacity=opacityRaw==null?WATERMARK_DEFAULTS.opacity:clamp01(opacityRaw);
  const xRaw=toFinite(raw.x),yRaw=toFinite(raw.y);
  const id=typeof raw.id==='string'&&raw.id.trim()?raw.id.trim():(fallbackId==null?'':String(fallbackId));
  if(!id)return null;
  return {id,text,font,size,color,opacity,
    x:xRaw==null?WATERMARK_DEFAULTS.x:clamp01(xRaw),
    y:yRaw==null?WATERMARK_DEFAULTS.y:clamp01(yRaw),
    visible:raw.visible===false?false:true};
}

// Normalize a persisted/edited list: invalid entries dropped, ids kept when
// usable and made unique otherwise (deterministic wm-N fallbacks). No count cap.
export function normalizeWatermarks(list){
  const out=[],seen=new Set();
  (Array.isArray(list)?list:[]).forEach((raw,i)=>{
    const mark=normalizeWatermark(raw,`wm-${i+1}`);
    if(!mark)return;
    let id=mark.id,n=out.length+1;
    while(seen.has(id))id=`wm-${n++}`;
    seen.add(id);
    out.push({...mark,id});
  });
  return out;
}

// ctx.font string for a mark at a given canvas width.
export function watermarkFontSpec(mark,canvasWidth){
  const f=WATERMARK_FONTS[mark&&mark.font]||WATERMARK_FONTS.sans;
  const px=Math.max(1,(toFinite(mark&&mark.size)||WATERMARK_DEFAULTS.size)/1000*Math.max(1,Number(canvasWidth)||1));
  return `${f.weight} ${px}px ${f.stack}`;
}

// Probe spec for document.fonts.load(): fixed 32px so loading never depends on
// preview scale. Same family/weight => same load covers every size.
export function watermarkFontLoadSpec(mark){
  const f=WATERMARK_FONTS[mark&&mark.font]||WATERMARK_FONTS.sans;
  return `${f.weight} 32px ${f.stack}`;
}

// Unique load specs for the visible, non-empty marks (draw order irrelevant).
export function collectWatermarkFontSpecs(marks){
  const set=new Set();
  for(const mark of Array.isArray(marks)?marks:[]){
    if(!mark||mark.visible===false)continue;
    if(typeof mark.text!=='string'||!mark.text.trim())continue;
    set.add(watermarkFontLoadSpec(mark));
  }
  return [...set];
}

// Measure a mark and place its box. The box (left/top/width/height) is the ink
// extent; centerX/centerY are the clamped mark.x/y anchor in canvas pixels, and
// baselineY centers the ink box vertically on that anchor.
export function watermarkLayout(ctx,mark,canvasWidth,canvasHeight){
  if(!ctx||!mark||mark.visible===false)return null;
  const text=typeof mark.text==='string'?mark.text:'';
  if(!text.trim())return null;
  const W=Math.max(1,Number(canvasWidth)||1),H=Math.max(1,Number(canvasHeight)||1);
  const size=(toFinite(mark.size)||WATERMARK_DEFAULTS.size)/1000*W;
  ctx.save();
  ctx.font=watermarkFontSpec(mark,W);
  ctx.textAlign='center';
  ctx.textBaseline='alphabetic';
  const metrics=ctx.measureText(text);
  const ascent=metrics.actualBoundingBoxAscent||size*.8;
  const descent=metrics.actualBoundingBoxDescent||size*.2;
  ctx.restore();
  const width=metrics.width,height=ascent+descent;
  const centerX=clamp01(mark.x)*W,centerY=clamp01(mark.y)*H;
  const baselineY=centerY+(ascent-descent)/2;
  return {mark,left:centerX-width/2,top:baselineY-ascent,width,height,
    centerX,centerY,baselineY,ascent,descent,size};
}

// Draw one mark. Returns its layout so callers can reuse it for hit testing.
export function drawWatermark(ctx,mark,canvasWidth,canvasHeight){
  const layout=watermarkLayout(ctx,mark,canvasWidth,canvasHeight);
  if(!layout)return null;
  ctx.save();
  ctx.font=watermarkFontSpec(mark,canvasWidth);
  ctx.textAlign='center';
  ctx.textBaseline='alphabetic';
  ctx.globalAlpha=clamp01(mark.opacity);
  ctx.shadowColor='rgba(0,0,0,.45)';
  ctx.shadowBlur=layout.size*.14;
  ctx.shadowOffsetY=layout.size*.04;
  ctx.fillStyle=isHexColor(mark.color)?mark.color:WATERMARK_DEFAULTS.color;
  ctx.fillText(layout.mark.text,layout.centerX,layout.baselineY);
  ctx.restore();
  return layout;
}

// Draw all marks in array order (later entries on top). Returns the layouts of
// everything actually drawn, bottom-to-top, for hit testing.
export function drawWatermarks(ctx,marks,canvasWidth,canvasHeight){
  const layouts=[];
  for(const mark of Array.isArray(marks)?marks:[]){
    const layout=drawWatermark(ctx,mark,canvasWidth,canvasHeight);
    if(layout)layouts.push(layout);
  }
  return layouts;
}

// Resize-grip position for a selected watermark: just past the box's bottom
// right corner, clamped so the knob stays touchable inside the canvas.
// displayScale = canvas.width / cssWidth (>=1 when the canvas is shown smaller).
export function watermarkResizeHandle(layout,canvasWidth,canvasHeight,displayScale=1){
  if(!layout)return null;
  const W=Math.max(1,Number(canvasWidth)||1),H=Math.max(1,Number(canvasHeight)||1);
  const scale=Math.max(1e-6,Number(displayScale)||1);
  const radius=Math.max(10/scale,6);
  const pad=Math.max(radius*.8,W*.009);
  return {x:Math.max(radius,Math.min(W-radius,layout.left+layout.width+pad)),
    y:Math.max(radius,Math.min(H-radius,layout.top+layout.height+pad)),radius,pad};
}

// Preview-only selection marker (dashed box + grip). Never call on the export
// canvas — exports must contain watermark ink only.
export function drawWatermarkSelection(ctx,layout,handle){
  if(!ctx||!layout)return;
  const pad=handle&&handle.pad||Math.max(4,layout.size*.18);
  ctx.save();
  ctx.strokeStyle='#2f8f6b';
  ctx.lineWidth=Math.max(1.5,layout.size*.03);
  ctx.setLineDash([pad*.8,pad*.5]);
  ctx.strokeRect(layout.left-pad,layout.top-pad,layout.width+pad*2,layout.height+pad*2);
  ctx.setLineDash([]);
  if(handle){
    ctx.fillStyle='#12364d';
    ctx.beginPath();ctx.arc(handle.x,handle.y,handle.radius,0,Math.PI*2);ctx.fill();
    ctx.lineWidth=Math.max(1.5,handle.radius*.22);
    ctx.beginPath();
    ctx.moveTo(handle.x-handle.radius*.4,handle.y+handle.radius*.4);
    ctx.lineTo(handle.x+handle.radius*.4,handle.y-handle.radius*.4);
    ctx.stroke();
  }
  ctx.restore();
}

// Topmost-first hit test over rendered layouts. Overlap rule: the currently
// selected watermark wins when it also hits; otherwise the highest array index
// (drawn last, visually on top) wins. tolerance is in canvas pixels.
export function watermarkHitTest(layouts,point,tolerance=0,selectedId=null){
  if(!point||!Array.isArray(layouts))return null;
  const t=Math.max(0,Number(tolerance)||0);
  let topmost=null;
  for(const layout of layouts){
    if(!layout)continue;
    if(point.x<layout.left-t||point.x>layout.left+layout.width+t)continue;
    if(point.y<layout.top-t||point.y>layout.top+layout.height+t)continue;
    if(selectedId!=null&&layout.mark&&layout.mark.id===selectedId)return layout;
    topmost=layout;
  }
  return topmost;
}

export function pointNearHandle(point,handle,multiplier=1.8){
  if(!point||!handle)return false;
  const factor=Number(multiplier);
  return Math.hypot(point.x-handle.x,point.y-handle.y)<=handle.radius*(Number.isFinite(factor)&&factor>0?factor:1);
}

// Pure drag: shift the center by canvas-pixel deltas, clamped to the canvas.
export function moveWatermark(mark,deltaX,deltaY,canvasWidth,canvasHeight){
  if(!mark)return null;
  const W=Math.max(1,Number(canvasWidth)||1),H=Math.max(1,Number(canvasHeight)||1);
  return {...mark,x:clamp01(mark.x+(Number(deltaX)||0)/W),y:clamp01(mark.y+(Number(deltaY)||0)/H)};
}

// Pure pointer resize: vertical delta changes size ONLY; x/y are untouched so
// the text never drifts while resizing. Doubling takes `sensitivity` px of drag.
export function resizeWatermark(mark,startSize,deltaY,opts={}){
  if(!mark)return null;
  const min=toFinite(opts.min)==null?SIZE_LIMITS.min:opts.min;
  const max=toFinite(opts.max)==null?SIZE_LIMITS.max:opts.max;
  const base=Math.min(max,Math.max(min,toFinite(startSize)||WATERMARK_DEFAULTS.size));
  const sensitivity=toFinite(opts.sensitivity);
  const step=sensitivity!=null&&sensitivity>0?sensitivity:120;
  const size=Math.min(max,Math.max(min,base*Math.pow(2,(Number(deltaY)||0)/step)));
  return {...mark,size,x:mark.x,y:mark.y};
}
