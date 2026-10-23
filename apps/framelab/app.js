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
  cameraPath(overlay); overlay.clip();
  overlay.drawImage(template,0,0,1080,720);
  overlay.globalCompositeOperation = 'destination-out';
  roundedScreenPath(overlay); overlay.fill(); overlay.restore();
}
const presets = {'3:4':[1080,1440], '9:16':[1080,1920], '1:1':[1080,1080], '4:3':[1440,1080], '16:9':[1920,1080]};
const settingIds = ['ratio','quality','layout','format','blur','camera-size','watermark-on','watermark-text','watermark-size','watermark-opacity','watermark-position','text-color'];
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
function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('frame-lab-settings-v1'));
    // Migrate the original watermark defaults while preserving custom text.
    if(saved && !('text-color' in saved)) {
      saved['watermark-position']='seam';saved['watermark-size']='45';
      saved['watermark-opacity']='100';
      if(!saved['watermark-text']) saved['watermark-text']='RICOH';
    }
    if (!saved || typeof saved !== 'object') return;
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
  drawWatermark(target,W,H);
}
// Text is composited last so it spans the seam in either layout.
function watermarkLayout(W,H) {
  const text=$('watermark-text').value.trim();
  if(!$('watermark-on').checked || !text) return null;
  return {text,size:W*Number($('watermark-size').value)/1000,
    alpha:Number($('watermark-opacity').value)/100,position:$('watermark-position').value};
}
function drawWatermark(target,W,H) {
  const mark=watermarkLayout(W,H);
  if(!mark) return;
  const inset=Math.min(W,H)*.028;
  target.save();
  target.font=`600 ${mark.size}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  const metrics=target.measureText(mark.text);
  const width=Math.min(metrics.width,W-2*inset);
  let x=inset;
  if(mark.position.includes('right')) x=W-inset-width;
  else if(!mark.position.includes('left')) x=(W-width)/2;
  const ascent=metrics.actualBoundingBoxAscent ?? mark.size*.8;
  const descent=metrics.actualBoundingBoxDescent ?? mark.size*.2;
  let y=H/2+(ascent-descent)/2;
  if(mark.position.startsWith('top')) y=inset+ascent;
  else if(mark.position.startsWith('bottom')) y=H-inset-descent;
  if(mark.position==='seam') {
    const p=panels(W,H), cx=p.x>0?p.x:W/2, cy=p.y>0?p.y:H/2;
    x=cx-width/2;y=cy+(ascent-descent)/2;
  }
  target.globalAlpha=mark.alpha;
  target.shadowColor='rgba(0,0,0,.45)';target.shadowBlur=mark.size*.14;target.shadowOffsetY=mark.size*.04;
  target.fillStyle=$('text-color').value;
  target.fillText(mark.text,x,y,W-2*inset);
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
  toggleWatermarkDefaults();
}
function sync() {
  $('zoom').value = zoom; $('zoom-value').textContent = `${Math.round(zoom*100)}%`;
  $('horizontal').value = focusX*100; $('vertical').value = focusY*100;
  render(ctx, canvas.width, canvas.height);
}
function reset() { zoom = 1; focusX = focusY = .5; sync(); }
async function selectFile(file) {
  if (!file) return;
  const version = ++loadVersion;
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (version !== loadVersion) return;
    photo = image; $('filename').textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight}`; reset();
  } catch(error) { if (version === loadVersion) notify(error.message); }
  finally { URL.revokeObjectURL(url); $('file').value = ''; }
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
settingIds.forEach(id => $(id).addEventListener('input',()=>{setPreviewSize();sync();saveSettings();}));
function toggleWatermarkDefaults() {$('watermark-defaults').hidden=!$('watermark-on').checked;}
$('sample').addEventListener('click', async () => {
  const version = ++loadVersion;
  const image = await loadImage(window.TEMPLATE_ASSETS.sample);
  if (version !== loadVersion) return;
  photo = image; $('filename').textContent = '月牙与夜航 · 示例照片'; reset();
});
canvas.addEventListener('pointerdown',e => {
  if (!photo) return;
  const bounds = canvas.getBoundingClientRect();
  const p=panels(canvas.width,canvas.height);
  const x=(e.clientX-bounds.left)*canvas.width/bounds.width, y=(e.clientY-bounds.top)*canvas.height/bounds.height;
  if(x<p.x || y<p.y) return;
  const crop = cropFor(photo,p.w,p.h);
  drag = {x:e.clientX,y:e.clientY,px:focusX,py:focusY,crop,displayScale:bounds.width/canvas.width,panelWidth:p.w};
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e => {
  if (!drag) return;
  const imagePerClient = drag.crop.width/(drag.displayScale*drag.panelWidth);
  const freeX = photo.naturalWidth-drag.crop.width, freeY = photo.naturalHeight-drag.crop.height;
  const clamp = x => Math.min(1,Math.max(0,x));
  if (freeX > .001) focusX = clamp(drag.px-(e.clientX-drag.x)*imagePerClient/freeX);
  if (freeY > .001) focusY = clamp(drag.py-(e.clientY-drag.y)*imagePerClient/freeY);
  sync();
});
['pointerup','pointercancel','lostpointercapture'].forEach(type => canvas.addEventListener(type,() => {drag = null;}));
let resultURL, resultFile;
async function exportBlob() {
  if(!photo || !template) throw Error('照片尚未加载完成');
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
  restoreSettings();toggleWatermarkDefaults();setPreviewSize();
  try {
    [template,photo]=await Promise.all([loadImage(window.TEMPLATE_ASSETS.template),loadImage(window.TEMPLATE_ASSETS.sample)]);
    prepareCameraOverlay();sync();$('download').disabled=$('open-result').disabled=false;
  } catch(error) {notify(error.message);}
})();
