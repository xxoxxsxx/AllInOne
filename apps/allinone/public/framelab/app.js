'use strict';
const $ = id => document.getElementById(id);
const canvas = $('preview'), ctx = canvas.getContext('2d');
const frame = document.createElement('canvas');
frame.width = 1080; frame.height = 720;
const frameCtx = frame.getContext('2d');
const background = document.createElement('canvas');
const backgroundCtx = background.getContext('2d');
const cameraOverlay = document.createElement('canvas');
cameraOverlay.width = 2160; cameraOverlay.height = 1440;
let template, photo, zoom = 1, focusX = .5, focusY = .5, loadVersion = 0, drag, toastTimer;
// LCD opening, measured in the original 1080 × 720 template.
const screen = {left:276, top:243, right:660, bottom:499, radius:2.5};
// Camera body spans rows 200-524; keep a little air around it when panels get short.
const CAMERA_BAND = 380;
function notify(message) { $('status').textContent = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('status').textContent = '', 4500); }
function loadImage(src) { return new Promise((resolve,reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('无法读取图片，请换用 JPG、PNG 或 WebP 图片。')); img.src = src; }); }
// Cover crop of the photo for any target aspect, honoring zoom and focus.
// The screen and the lower panel share zoom and focus, so they stay in step.
function cropFor(image, aspectWidth, aspectHeight) {
  const iw = image.naturalWidth, ih = image.naturalHeight, aspect = aspectWidth/aspectHeight;
  let width = Math.min(iw, ih*aspect), height = width/aspect;
  width /= zoom; height /= zoom;
  return {x:(iw-width)*focusX, y:(ih-height)*focusY, width, height};
}
function roundedScreenPath(context) {
  const {left:l,top:t,right:r,bottom:b,radius:d} = screen;
  context.beginPath(); context.moveTo(l+d,t);
  context.lineTo(r-d,t); context.quadraticCurveTo(r,t,r,t+d);
  context.lineTo(r,b-d); context.quadraticCurveTo(r,b,r-d,b);
  context.lineTo(l+d,b); context.quadraticCurveTo(l,b,l,b-d);
  context.lineTo(l,t+d); context.quadraticCurveTo(l,t,l+d,t); context.closePath();
}
// Trace the body only; the beige tabletop and original cast shadow are excluded.
function cameraPath(context) {
  context.beginPath(); context.moveTo(259,495);
  context.lineTo(263,239); context.quadraticCurveTo(264,210,285,208);
  context.lineTo(414,209); context.quadraticCurveTo(415,204,422,204);
  context.lineTo(514,204); context.quadraticCurveTo(520,204,522,210);
  context.lineTo(738,208); context.quadraticCurveTo(775,200,803,207);
  context.quadraticCurveTo(810,210,809,231);
  context.quadraticCurveTo(818,233,819,254); context.lineTo(822,496);
  context.quadraticCurveTo(823,519,804,524); context.lineTo(280,521);
  context.quadraticCurveTo(258,520,259,495); context.closePath();
}
function prepareCameraOverlay() {
  const overlay = cameraOverlay.getContext('2d');
  overlay.clearRect(0,0,cameraOverlay.width,cameraOverlay.height);
  overlay.save(); overlay.scale(2,2);
  overlay.imageSmoothingEnabled = true;
  overlay.imageSmoothingQuality = 'high';
  cameraPath(overlay); overlay.clip();
  overlay.drawImage(template,0,0,1080,720);
  // Remove the tabletop-contaminated outer pixels without blurring body detail.
  // The stroke straddles the silhouette: only its inner half erodes the image.
  overlay.globalCompositeOperation = 'destination-out';
  overlay.lineWidth = 4;
  overlay.lineJoin = 'round';
  cameraPath(overlay); overlay.stroke();
  roundedScreenPath(overlay); overlay.fill(); overlay.restore();
}
const presets = {'3:4':[1080,1440], '9:16':[1080,1920], '1:1':[1080,1080], '4:3':[1440,1080], '16:9':[1920,1080]};
// 基础设置与拍摄信息水印沿用原有设置键；文字水印列表另存 frame-lab-text-layers-v1。
const settingIds = ['ratio','quality','layout','format','blur','camera-size','exif-watermark-on','exif-watermark-font','exif-watermark-position','exif-watermark-size','exif-watermark-opacity','exif-text-color','exif-watermark-x','exif-watermark-y'];
const {computePlacement, moveToNormalized} = window.FrameLabWatermarkGeometry;
const {normalizeLayers, migrateLegacyLayer} = window.FrameLabWatermarkLayers;
const WATERMARK_FONTS = {
  sans:'-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
  serif:'"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif',
  mono:'ui-monospace,"SFMono-Regular",Menlo,Consolas,"PingFang SC",monospace',
  hand:'"FrameLab Hand","Kaiti SC",STKaiti,KaiTi,cursive',
};
// 文字水印列表：模型是唯一数据源，编辑控件只是当前选中条目的镜像。
const LAYERS_KEY='frame-lab-text-layers-v1';
let textLayers=[],layerSerial=0;
let activeWatermark = 'exif', showWatermarkSelection = false;
const {EXIF_FIELDS, buildExifFields, buildExifCaption} = window.FrameLabExifFormat;
let exifFields = buildExifFields(null), selectedExif = new Set();
function dimensions() {
  const factor = $('quality').value === 'high' ? 2 : 1;
  return presets[$('ratio').value].map(n => n*factor);
}
function panels(W,H) {
  const horizontal = $('layout').value === 'horizontal' || ($('layout').value === 'auto' && W>H);
  return horizontal ? {cw:Math.floor(W/2),ch:H,x:Math.floor(W/2),y:0,w:W-Math.floor(W/2),h:H} : {cw:W,ch:Math.floor(H/2),x:0,y:Math.floor(H/2),w:W,h:H-Math.floor(H/2)};
}
function saveSettings() {
  try { localStorage.setItem('frame-lab-settings-v1',JSON.stringify(Object.fromEntries(settingIds.map(id=>[id,$(id).type==='checkbox'?String($(id).checked):$(id).value])))); } catch {}
}
function readLegacySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('frame-lab-settings-v1'));
    // Migrate the original watermark defaults while preserving custom text.
    if(saved && !('text-color' in saved)) {
      saved['watermark-position']='seam';saved['watermark-size']='45';
      saved['watermark-opacity']='100';
      if(!saved['watermark-text']) saved['watermark-text']='RICOH';
    }
    return saved && typeof saved === 'object' ? saved : null;
  } catch { return null; }
}
function restoreSettings() {
  try {
    const saved = readLegacySettings();
    if (!saved) return;
    for (const id of settingIds) {
      const el=$(id), value=saved[id];
      if (typeof value !== 'string') continue;
      if (el.tagName === 'SELECT') { if ([...el.options].some(o=>o.value===value)) el.value=value; }
      else if (el.type === 'color') { if(/^#[0-9a-f]{6}$/i.test(value)) el.value=value; }
      else if (el.type === 'checkbox') { if(value==='true'||value==='false') el.checked=value==='true'; }
      else if (el.type === 'text' || el.tagName === 'TEXTAREA') { el.value=value; }
      else if (Number.isFinite(Number(value)) && Number(value)>=Number(el.min) && Number(value)<=Number(el.max)) el.value=value;
    }
  } catch {}
}
// Three separable box passes approximate a Gaussian without Canvas.filter.
// Clamp edge samples and average premultiplied colors to avoid dark alpha halos.
function blurPixels(image, radius) {
  if (radius < 1) return image;
  const {width:w,height:h,data} = image, n=data.length;
  let src=new Float32Array(n), dst=new Float32Array(n);
  for(let i=0;i<n;i+=4) {
    const a=data[i+3]/255;
    src[i]=data[i]*a;src[i+1]=data[i+1]*a;src[i+2]=data[i+2]*a;src[i+3]=data[i+3];
  }
  const diameter=radius*2+1;
  for(let pass=0;pass<3;pass++) {
    for(const horizontal of [true,false]) {
      const length=horizontal?w:h, lines=horizontal?h:w, step=horizontal?4:w*4;
      for(let line=0;line<lines;line++) {
        const base=horizontal?line*w*4:line*4;
        for(let c=0;c<4;c++) {
          let sum=0;
          for(let k=-radius;k<=radius;k++) sum+=src[base+Math.min(length-1,Math.max(0,k))*step+c];
          for(let pos=0;pos<length;pos++) {
            dst[base+pos*step+c]=sum/diameter;
            sum+=src[base+Math.min(length-1,pos+radius+1)*step+c]-src[base+Math.max(0,pos-radius)*step+c];
          }
        }
      }
      [src,dst]=[dst,src];
    }
  }
  for(let i=0;i<n;i+=4) {
    const alpha=src[i+3];
    for(let c=0;c<3;c++) data[i+c]=alpha>0?src[i+c]*255/alpha:0;
    data[i+3]=alpha;
  }
  return image;
}
let cachedBackgroundPhoto, cachedBackgroundKey;
function render(target,W,H) {
  if (!photo || !template) return;
  const p=panels(W,H), crop=cropFor(photo,p.w,p.h);
  target.clearRect(0,0,W,H); target.imageSmoothingQuality='high';
  // Render the full chosen composition inside the LCD without stretching it.
  frameCtx.fillStyle='#0a0c0e'; frameCtx.fillRect(0,0,1080,720);
  const fit=Math.min(1080/p.w,720/p.h), fw=p.w*fit, fh=p.h*fit;
  frameCtx.drawImage(photo,crop.x,crop.y,crop.width,crop.height,(1080-fw)/2,(720-fh)/2,fw,fh);
  // A fixed-size background keeps blur identical between preview and export.
  const blur=Number($('blur').value);
  const key=[(p.cw/p.ch).toFixed(6),zoom,focusX,focusY,blur].join(':');
  if(cachedBackgroundPhoto!==photo || cachedBackgroundKey!==key) {
    // Bound work on tall mobile layouts; exports reuse the same blurred pixels.
    const factor=Math.min(720/p.cw,960/p.ch);
    background.width=Math.max(1,Math.round(p.cw*factor));
    background.height=Math.max(1,Math.round(p.ch*factor));
    const bg=cropFor(photo,p.cw,p.ch),bw=background.width,bh=background.height;
    backgroundCtx.drawImage(photo,bg.x,bg.y,bg.width,bg.height,-bw*.25,-bh*.25,bw*1.5,bh*1.5);
    if(blur>0) {
      const image=backgroundCtx.getImageData(0,0,bw,bh);
      backgroundCtx.putImageData(blurPixels(image,Math.max(1,Math.round(blur*bw/1080))),0,0);
    }
    cachedBackgroundPhoto=photo;cachedBackgroundKey=key;
  }
  target.drawImage(background,0,0,p.cw,p.ch);
  target.fillStyle='rgba(0,0,0,.12)'; target.fillRect(0,0,p.cw,p.ch);
  const base=Math.min(p.cw/1080,p.ch/600);
  const scale=Math.min(base*Number($('camera-size').value)/100,p.cw*.88/570,p.ch*.84/330);
  target.save(); target.beginPath();target.rect(0,0,p.cw,p.ch);target.clip();
  target.translate(p.cw/2-540*scale,p.ch/2-364*scale);target.scale(scale,scale);
  target.save();target.shadowColor='rgba(0,0,0,.38)';target.shadowBlur=22*scale;target.shadowOffsetY=14*scale;
  target.fillStyle='#171916';cameraPath(target);target.fill();target.restore();
  target.save();roundedScreenPath(target);target.clip();
  target.drawImage(frame,screen.left,screen.top,screen.right-screen.left,screen.bottom-screen.top);
  const shade=target.createLinearGradient(0,screen.top,0,screen.top+4);shade.addColorStop(0,'#0006');shade.addColorStop(1,'#0000');
  target.fillStyle=shade;target.fillRect(screen.left,screen.top,384,4);target.restore();
  target.drawImage(cameraOverlay,0,0,1080,720);target.restore();
  target.drawImage(photo,crop.x,crop.y,crop.width,crop.height,p.x,p.y,p.w,p.h);
  for (const layer of textLayers) drawWatermark(target,W,H,layer.id);
  drawWatermark(target,W,H,'exif');
}
// 文字水印列表管理；拍摄信息水印保持内置唯一层。
function loadLayers() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LAYERS_KEY)); } catch {}
  if (Array.isArray(raw)) { textLayers = normalizeLayers(raw); return; }
  // 一次性迁移：旧版唯一文字水印 → 列表首条，保留文字、样式与位置。
  const seeded = migrateLegacyLayer(readLegacySettings() || {});
  textLayers = seeded ? [seeded] : [];
  saveLayers();
}
function saveLayers() { try { localStorage.setItem(LAYERS_KEY, JSON.stringify(textLayers)); } catch {} }
function activeLayer() { return textLayers.find(layer => layer.id === activeWatermark) || null; }
function selectLayer(id) { activeWatermark = id; syncWatermarkEditor(); sync(); }
function addLayer() {
  layerSerial += 1;
  const layer = {id:`wm-${layerSerial}-${Math.random().toString(36).slice(2,7)}`, text:`水印 ${layerSerial}`,
    font:'sans', size:45, opacity:100, color:'#ffffff', position:'bottom-right', x:82, y:88};
  textLayers.push(layer);
  saveLayers();
  selectLayer(layer.id);
  const input=$('watermark-text'); input.focus(); input.select();
  notify('已添加一条水印：输入文字，在预览拖动摆放，右下角圆点调整大小。');
}
function deleteLayer(id) {
  const index = textLayers.findIndex(layer => layer.id === id);
  if (index < 0) return;
  textLayers.splice(index, 1);
  if (activeWatermark === id) activeWatermark = textLayers.length ? textLayers[textLayers.length-1].id : 'exif';
  saveLayers();
  toggleWatermarkDefaults();
  sync();
}
function duplicateLayer(id) {
  const source = textLayers.find(layer => layer.id === id);
  if (!source) return;
  layerSerial += 1;
  const copy = {...source, id:`wm-${layerSerial}-${Math.random().toString(36).slice(2,7)}`};
  if (copy.position === 'custom') { copy.x = Math.min(100, copy.x + 4); copy.y = Math.min(100, copy.y + 4); }
  textLayers.splice(textLayers.indexOf(source) + 1, 0, copy);
  saveLayers();
  selectLayer(copy.id);
}
// 拍摄信息水印读取控件；文字水印读取列表模型，所有画布共用同一几何与绘制方式。
function watermarkDetails(target) {
  if (target === 'exif') {
    const text = buildExifCaption(exifFields, [...selectedExif]);
    if (!$('exif-watermark-on').checked || !text) return null;
    const fontId=$('exif-watermark-font').value;
    return {kind:'exif', prefix:'exif-watermark', text, fontId, font: WATERMARK_FONTS[fontId] || WATERMARK_FONTS.sans,
      weight: fontId==='hand' ? '400' : '600',
      size: Number($('exif-watermark-size').value), alpha: Number($('exif-watermark-opacity').value)/100,
      color: $('exif-text-color').value,
      position: $('exif-watermark-position').value, customX: Number($('exif-watermark-x').value)/100,
      customY: Number($('exif-watermark-y').value)/100};
  }
  const layer = textLayers.find(item => item.id === target);
  if (!layer || !layer.text.trim()) return null;
  return {kind:layer.id, text:layer.text, fontId:layer.font, font: WATERMARK_FONTS[layer.font] || WATERMARK_FONTS.sans,
    weight: layer.font==='hand' ? '400' : '600',
    size: layer.size, alpha: layer.opacity/100, color: layer.color,
    position: layer.position, customX: layer.x/100, customY: layer.y/100};
}
function watermarkLayout(target,W,H,kind) {
  const mark=watermarkDetails(kind);
  if(!mark) return null;
  const size=W*mark.size/1000, p=panels(W,H), inset=Math.min(W,H)*.028;
  target.save();
  target.font=`${mark.weight} ${size}px ${mark.font}`;
  const metrics=target.measureText(mark.text);
  // fillText(maxWidth) 会压缩宽字串；包围盒使用压缩后的宽度。
  const placement=computePlacement({width:W,height:H,textWidth:metrics.width,
    ascent:metrics.actualBoundingBoxAscent || size*.8, descent:metrics.actualBoundingBoxDescent || size*.2,
    position:mark.position,customX:mark.customX,customY:mark.customY,panelX:p.x,panelY:p.y,inset});
  target.restore();
  return {...mark,...placement,size};
}
function drawWatermark(target,W,H,kind) {
  const mark=watermarkLayout(target,W,H,kind);
  if(!mark) return;
  const inset=Math.min(W,H)*.028;
  target.save();
  target.font=`${mark.weight} ${mark.size}px ${mark.font}`;
  target.globalAlpha=mark.alpha;
  target.shadowColor='rgba(0,0,0,.45)';target.shadowBlur=mark.size*.14;target.shadowOffsetY=mark.size*.04;
  target.fillStyle=mark.color;
  target.fillText(mark.text,mark.x,mark.y,W-2*inset);
  target.restore();
}
function setPreviewSize() {
  const [w,h]=dimensions(), k=Math.min(1,1440/Math.max(w,h));
  canvas.width=Math.round(w*k);canvas.height=Math.round(h*k);
  $('ratio-label').textContent=`成品比例 / ${$('ratio').value}`;
  $('dimensions').textContent=`导出 ${w} × ${h} 像素`;
  $('blur-value').textContent=$('blur').value==='0'?'无虚化':$('blur').value;
  $('camera-value').textContent=$('camera-size').value+'%';
  $('watermark-size-value').textContent=Math.round(Number($('watermark-size').value)/10*100)/100+'%';
  $('watermark-opacity-value').textContent=$('watermark-opacity').value+'%';
  $('exif-watermark-size-value').textContent=Math.round(Number($('exif-watermark-size').value)/10*100)/100+'%';
  $('exif-watermark-opacity-value').textContent=$('exif-watermark-opacity').value+'%';
  toggleWatermarkDefaults();
}
function sync() {
  $('zoom').value = zoom; $('zoom-value').textContent = `${Math.round(zoom*100)}%`;
  $('horizontal').value = focusX*100; $('vertical').value = focusY*100;
  render(ctx, canvas.width, canvas.height);
  if (showWatermarkSelection) {
    const mark=watermarkLayout(ctx,canvas.width,canvas.height,activeWatermark);
    if(mark) {
      const pad=canvas.width*.009;
      ctx.save(); ctx.strokeStyle='#6fddbc'; ctx.lineWidth=Math.max(2,canvas.width*.002);
      ctx.setLineDash([pad*.8,pad*.5]);
      ctx.strokeRect(Math.max(0,mark.x-pad),Math.max(0,mark.y-mark.ascent-pad),
        Math.min(canvas.width,mark.width+pad*2),Math.min(canvas.height,mark.ascent+mark.descent+pad*2));
      const handle=watermarkResizeHandle(mark);
      ctx.setLineDash([]); ctx.fillStyle='#12364d';
      ctx.beginPath(); ctx.arc(handle.x,handle.y,handle.radius,0,Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(handle.x-handle.radius*.4,handle.y+handle.radius*.4);
      ctx.lineTo(handle.x+handle.radius*.4,handle.y-handle.radius*.4); ctx.stroke();
      ctx.restore();
    }
  }
}
// Keep the resize grip visible and touchable even near the canvas edges.
function watermarkResizeHandle(mark) {
  const scale=canvas.width/(canvas.getBoundingClientRect().width || canvas.width);
  const radius=10*scale, pad=canvas.width*.009;
  return {x:Math.max(radius,Math.min(canvas.width-radius,mark.x+mark.width+pad)),
    y:Math.max(radius,Math.min(canvas.height-radius,mark.y+mark.descent+pad)),radius};
}
function reset() { zoom = 1; focusX = focusY = .5; sync(); }
const exifButtons = [...$('exif-chips').querySelectorAll('button[data-exif-field]')];
function showExif(exif, loading = false) {
  exifFields = buildExifFields(exif);
  selectedExif = new Set(EXIF_FIELDS.filter(key => exifFields[key]));
  for (const button of exifButtons) {
    const key = button.dataset.exifField, value = exifFields[key];
    button.hidden = !value;
    button.textContent = value;
    button.setAttribute('aria-label', `${button.dataset.label} ${value}`);
    button.setAttribute('aria-pressed', String(selectedExif.has(key)));
  }
  const hasInfo = selectedExif.size > 0;
  $('exif-chips').hidden = !hasInfo;
  $('exif-status').hidden = hasInfo;
  $('exif-status').textContent = loading ? '正在检测拍摄信息…' : '未检测到拍摄信息（或图片不含 EXIF）';
  syncWatermarkEditor();
  if (template && photo) { sync(); refreshWatermarkFonts(); }
}
async function readExif(file) {
  try {
    if (typeof exifr === 'undefined' || typeof exifr.parse !== 'function') return null;
    return await exifr.parse(file, {pick:['FNumber','ExposureTime','ISO','FocalLength','FocalLengthIn35mmFormat','FocalLengthIn35mmFilm','LensModel','Make','Model']});
  } catch { return null; }
}
for (const button of exifButtons) {
  button.addEventListener('click', () => {
    const key = button.dataset.exifField;
    if (selectedExif.has(key)) selectedExif.delete(key); else selectedExif.add(key);
    button.setAttribute('aria-pressed', String(selectedExif.has(key)));
    syncWatermarkEditor();
    sync();
    refreshWatermarkFonts();
  });
}
async function selectFile(file) {
  if (!file) return;
  const version = ++loadVersion;
  showExif(null, true);
  const exifPromise = readExif(file);
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (version !== loadVersion) return;
    photo = image; $('filename').textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight}`; reset();
    exifPromise.then(exif => { if (version === loadVersion) showExif(exif); });
  } catch(error) { if (version === loadVersion) { showExif(null); notify(error.message); } }
  finally { URL.revokeObjectURL(url); if (version === loadVersion) $('file').value = ''; }
}
$('file').addEventListener('change',e => selectFile(e.target.files[0]));
const dropzone = $('dropzone');
['dragenter','dragover'].forEach(type => dropzone.addEventListener(type,e => {e.preventDefault();dropzone.classList.add('dragging');}));
['dragleave','drop'].forEach(type => dropzone.addEventListener(type,e => {e.preventDefault();dropzone.classList.remove('dragging');}));
dropzone.addEventListener('drop',e => selectFile(e.dataTransfer.files[0]));
window.addEventListener('dragover',e => e.preventDefault());
window.addEventListener('drop',e => e.preventDefault());
$('zoom').addEventListener('input',e => {zoom = Number(e.target.value);sync();});
$('horizontal').addEventListener('input',e => {focusX = Number(e.target.value)/100;sync();});
$('vertical').addEventListener('input',e => {focusY = Number(e.target.value)/100;sync();});
$('reset').addEventListener('click',reset);
settingIds.forEach(id => $(id).addEventListener('input',()=>{
  if (id === 'exif-watermark-x' || id === 'exif-watermark-y') { $('exif-watermark-position').value='custom'; activeWatermark='exif'; }
  if (id === 'exif-watermark-on' && $('exif-watermark-on').checked) activeWatermark='exif';
  setPreviewSize(); sync(); saveSettings();
  if (['exif-watermark-font','exif-watermark-on'].includes(id)) refreshWatermarkFonts();
}));
// 文字水印编辑器：控件写入当前选中条目，模型是唯一数据源。
const textEditorBindings = [
  ['watermark-text', layer => { layer.text = $('watermark-text').value; }],
  ['watermark-font', layer => { layer.font = $('watermark-font').value; refreshWatermarkFonts(); }],
  ['watermark-size', layer => { layer.size = Number($('watermark-size').value); }],
  ['watermark-opacity', layer => { layer.opacity = Number($('watermark-opacity').value); }],
  ['watermark-position', layer => { layer.position = $('watermark-position').value; }],
  ['text-color', layer => { layer.color = $('text-color').value; }],
];
for (const [id, apply] of textEditorBindings) $(id).addEventListener('input', () => {
  const layer = activeLayer(); if (!layer) return;
  apply(layer);
  setPreviewSize(); sync(); saveLayers();
});
for (const axis of ['x','y']) $('watermark-'+axis).addEventListener('input', () => {
  const layer = activeLayer(); if (!layer) return;
  layer.position = 'custom'; $('watermark-position').value = 'custom';
  layer.x = Number($('watermark-x').value); layer.y = Number($('watermark-y').value);
  setPreviewSize(); sync(); saveLayers();
});
$('add-watermark').addEventListener('click', addLayer);
function syncWatermarkEditor() {
  const exifMark = watermarkDetails('exif');
  showWatermarkSelection = !!watermarkDetails(activeWatermark);
  const button=$('edit-exif');
  button.disabled=!exifMark;
  button.setAttribute('aria-pressed', String(activeWatermark==='exif' && !!exifMark));
  for (const axis of ['x','y']) $('exif-watermark-'+axis+'-value').textContent=$('exif-watermark-'+axis).value+'%';
  renderLayerList();
  syncTextEditorControls();
}
function renderLayerList() {
  $('watermark-count').textContent = `${textLayers.length} 条`;
  $('watermark-empty').hidden = textLayers.length > 0;
  $('watermark-list').replaceChildren(...textLayers.map(layer => {
    const item = document.createElement('li');
    const name = layer.text.trim() || '未命名水印';
    const select = document.createElement('button');
    select.type='button'; select.className='watermark-chip'; select.dataset.layerId=layer.id;
    select.setAttribute('aria-pressed', String(activeWatermark===layer.id));
    select.setAttribute('aria-label', `编辑水印：${name}`);
    const label = document.createElement('span');
    label.className='watermark-chip-name'; label.textContent=name;
    select.append(label);
    select.addEventListener('click', () => selectLayer(layer.id));
    const remove = document.createElement('button');
    remove.type='button'; remove.className='watermark-chip-remove'; remove.textContent='×';
    remove.setAttribute('aria-label', `删除水印：${name}`);
    remove.addEventListener('click', () => deleteLayer(layer.id));
    item.append(select, remove);
    return item;
  }));
}
function syncTextEditorControls() {
  const layer = activeLayer();
  $('watermark-defaults').hidden = !layer;
  if (!layer) return;
  const values = {'watermark-text':layer.text,'watermark-font':layer.font,'watermark-size':String(layer.size),
    'watermark-opacity':String(layer.opacity),'watermark-position':layer.position,'text-color':layer.color,
    'watermark-x':String(layer.x),'watermark-y':String(layer.y)};
  for (const [id,value] of Object.entries(values)) {
    const el = $(id);
    if (document.activeElement !== el && el.value !== value) el.value = value;
  }
  $('watermark-size-value').textContent = Math.round(layer.size/10*100)/100+'%';
  $('watermark-opacity-value').textContent = layer.opacity+'%';
  $('watermark-x-value').textContent = layer.x+'%';
  $('watermark-y-value').textContent = layer.y+'%';
}
function toggleWatermarkDefaults() {
  $('watermark-defaults').hidden=!activeLayer();
  $('exif-watermark-defaults').hidden=!$('exif-watermark-on').checked;
  syncWatermarkEditor();
}
$('edit-exif').addEventListener('click',()=>{
  if (!watermarkDetails('exif')) return;
  activeWatermark='exif'; syncWatermarkEditor(); sync(); canvas.focus();
});
$('sample').addEventListener('click', async () => {
  const version = ++loadVersion;
  showExif(null);
  const image = await loadImage(window.TEMPLATE_ASSETS.sample);
  if (version !== loadVersion) return;
  photo = image; $('filename').textContent = '月牙与夜航 · 示例照片'; reset();
});
// 本地手写字体按需加载；预览与导出都等字体就绪后重绘。
async function ensureWatermarkFonts() {
  if (!document.fonts || typeof document.fonts.load !== 'function') return;
  const used=['exif',...textLayers.map(layer=>layer.id)].map(watermarkDetails).filter(Boolean);
  await Promise.all(used.map(mark => document.fonts.load(`${mark.weight} 32px ${mark.font}`, mark.text)));
}
let fontLoadVersion=0;
function refreshWatermarkFonts() {
  const version=++fontLoadVersion;
  ensureWatermarkFonts().then(()=>{if(version===fontLoadVersion && template && photo) sync();}).catch(()=>{});
}
function canvasPoint(e) {
  const bounds=canvas.getBoundingClientRect();
  return {x:(e.clientX-bounds.left)*canvas.width/bounds.width,
    y:(e.clientY-bounds.top)*canvas.height/bounds.height, bounds};
}
function watermarkAt(point) {
  const tolerance=18*canvas.width/point.bounds.width;
  // 命中顺序为绘制顺序的逆序（后绘制的水印在上层），拍摄信息水印保持在最上。
  const order=[...textLayers].reverse().map(layer=>layer.id); order.push('exif');
  const hits=order.map(kind=>watermarkLayout(ctx,canvas.width,canvas.height,kind)).filter(mark=>mark &&
    point.x>=mark.x-tolerance && point.x<=mark.x+mark.width+tolerance &&
    point.y>=mark.y-mark.ascent-tolerance && point.y<=mark.y+mark.descent+tolerance);
  if (hits.length===1) return hits[0];
  // 水印重叠时优先选择当前编辑目标；列表可以切换目标，确保每条都可拖动。
  return hits.find(mark=>mark.kind===activeWatermark) || hits[0] || null;
}
canvas.addEventListener('pointerdown',e => {
  if (!photo || drag || (e.pointerType==='mouse' && e.button!==0)) return;
  const point=canvasPoint(e);
  const selected=showWatermarkSelection && watermarkLayout(ctx,canvas.width,canvas.height,activeWatermark);
  if (selected) {
    const handle=watermarkResizeHandle(selected);
    if (Math.hypot(point.x-handle.x,point.y-handle.y)<=handle.radius*1.8) {
      drag={kind:selected.kind,mode:'resize',pointerId:e.pointerId,startY:e.clientY,
        startSize:watermarkDetails(selected.kind).size};
      canvas.setPointerCapture(e.pointerId);
      return;
    }
  }
  const mark=watermarkAt(point);
  if (mark) {
    activeWatermark=mark.kind; syncWatermarkEditor();
    drag={kind:mark.kind,pointerId:e.pointerId,startX:point.x,startY:point.y,centerX:mark.centerX,centerY:mark.centerY};
  } else {
    const p=panels(canvas.width,canvas.height);
    if(point.x<p.x || point.y<p.y) return;
    const crop=cropFor(photo,p.w,p.h);
    drag={kind:'photo',pointerId:e.pointerId,x:e.clientX,y:e.clientY,px:focusX,py:focusY,crop,displayScale:point.bounds.width/canvas.width,panelWidth:p.w};
  }
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e => {
  if (!drag || e.pointerId!==drag.pointerId) return;
  const clamp=x=>Math.min(1,Math.max(0,x));
  if (drag.mode==='resize') {
    // Vertical motion changes size only; position and photo composition stay intact.
    const size=drag.startSize*Math.pow(2,(e.clientY-drag.startY)/100);
    if (drag.kind==='exif') {
      const input=$('exif-watermark-size');
      input.value=String(Math.round(Math.max(Number(input.min),Math.min(Number(input.max),size))));
      $('exif-watermark-size-value').textContent=Number(input.value)/10+'%';
    } else {
      const layer=activeLayer();
      if (layer) layer.size=Math.round(Math.max(6,Math.min(180,size)));
      syncTextEditorControls();
    }
  } else if (drag.kind==='photo') {
    const imagePerClient=drag.crop.width/(drag.displayScale*drag.panelWidth);
    const freeX=photo.naturalWidth-drag.crop.width, freeY=photo.naturalHeight-drag.crop.height;
    if(freeX>.001) focusX=clamp(drag.px-(e.clientX-drag.x)*imagePerClient/freeX);
    if(freeY>.001) focusY=clamp(drag.py-(e.clientY-drag.y)*imagePerClient/freeY);
  } else {
    const point=canvasPoint(e);
    const pos=moveToNormalized({width:canvas.width,height:canvas.height,
      x:drag.centerX+point.x-drag.startX,y:drag.centerY+point.y-drag.startY});
    if (drag.kind==='exif') {
      $('exif-watermark-position').value='custom';
      $('exif-watermark-x').value=String(Math.round(pos.x*1000)/10);
      $('exif-watermark-y').value=String(Math.round(pos.y*1000)/10);
    } else {
      const layer=textLayers.find(item=>item.id===drag.kind);
      if (layer) {
        layer.position='custom';
        layer.x=Math.round(pos.x*1000)/10;
        layer.y=Math.round(pos.y*1000)/10;
        syncTextEditorControls();
      }
    }
  }
  sync();
});
['pointerup','pointercancel','lostpointercapture'].forEach(type => canvas.addEventListener(type,e => {
  if (!drag || e.pointerId!==drag.pointerId) return;
  const wasWatermark=drag.kind!=='photo', wasExif=drag.kind==='exif';
  drag=null;
  if (!wasWatermark) return;
  if (wasExif) saveSettings(); else saveLayers();
}));
let resultURL, resultFile;
async function exportBlob() {
  if(!photo || !template) throw Error('照片尚未加载完成');
  try { await ensureWatermarkFonts(); } catch { throw Error('水印字体加载失败，请重试'); }
  const [w,h]=dimensions(), output=document.createElement('canvas');output.width=w;output.height=h;
  render(output.getContext('2d'),w,h);
  const type=$('format').value;
  const blob=await new Promise(resolve=>output.toBlob(resolve,type,.95));
  if(!blob) throw Error('图片生成失败，请重试');
  return new File([blob],`frame-lab-${w}x${h}.${type==='image/png'?'png':'jpg'}`,{type});
}
async function performExport(preview) {
  $('download').disabled=$('open-result').disabled=true;
  try {
    const file=await exportBlob();
    if(preview) {
      if(resultURL) URL.revokeObjectURL(resultURL);
      resultFile=file;resultURL=URL.createObjectURL(file);
      $('result-image').src=$('result-link').href=resultURL;
      $('share-result').hidden=!(navigator.canShare && navigator.canShare({files:[file]}));
      $('result-dialog').showModal();
    } else {
      const url=URL.createObjectURL(file), link=document.createElement('a');link.href=url;link.download=file.name;
      document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
      notify('图片已生成，下载已开始。');
    }
  } catch(error) {notify(error.message);}
  finally {$('download').disabled=$('open-result').disabled=false;}
}
$('download').addEventListener('click',()=>performExport(false));
$('open-result').addEventListener('click',()=>performExport(true));
$('close-result').addEventListener('click',()=>$('result-dialog').close());
// A separate tap preserves user activation for file sharing on mobile browsers.
$('share-result').addEventListener('click',async()=>{
  try {await navigator.share({files:[resultFile],title:'Frame Lab 相机拼图'});}
  catch(error) {if(error.name!=='AbortError') notify('分享未成功，可以长按成品图片保存，或打开原尺寸图片。');}
});
(async()=>{
  restoreSettings();
  loadLayers();
  layerSerial=textLayers.length;
  if (textLayers.length) activeWatermark=textLayers[textLayers.length-1].id;
  toggleWatermarkDefaults();setPreviewSize();
  refreshWatermarkFonts();
  try {
    const [loadedTemplate,samplePhoto]=await Promise.all([loadImage(window.TEMPLATE_ASSETS.template),loadImage(window.TEMPLATE_ASSETS.sample)]);
    template=loadedTemplate;
    if (!photo) photo=samplePhoto;
    prepareCameraOverlay();sync();$('download').disabled=$('open-result').disabled=false;
  } catch(error) {notify(error.message);}
})();
