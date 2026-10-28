import {TEMPLATES,RATIOS,clamp,canvasSize,layoutCells,cropImage,drawCollage} from './engine.js';

const $=id=>document.getElementById(id);
const preview=$('preview'),ctx=preview.getContext('2d');
const photos=new Map(),cells=Array.from({length:9},()=>emptyCell());
let template='grid4',ratio='1:1',selected=0,serial=0,generation=0,loading=false,exporting=false,raf=0,drag=null;
const MAX_PHOTOS=24,MAX_PIXELS=32_000_000,MAX_EDGE=2560,downloadUrls=new Set();
function emptyCell(){return {photoId:'',zoom:1,focusX:.5,focusY:.5};}
function count(){return TEMPLATES.find(t=>t.id===template).count;}
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function options(){return {template,gap:Number($('gap').value)/100,margin:Number($('margin').value)/100,background:$('background').value,cells,photos};}
function requestRender(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;render();});}
function render(){
  const size=canvasSize(ratio,1000);
  if(preview.width!==size.width||preview.height!==size.height){preview.width=size.width;preview.height=size.height;}
  drawCollage(ctx,{...options(),...size});
  const filled=cells.slice(0,count()).filter(c=>photos.has(c.photoId)).length;
  $('completion').textContent=filled===count()?'照片已就位，可以导出':`还需放入 ${count()-filled} 张照片`;
  $('canvas-info').textContent=`${ratio} · ${TEMPLATES.find(t=>t.id===template).name}`;
  $('export').disabled=filled!==count()||loading||exporting;
  updateSelection();
}
function updateSelection(){
  const r=layoutCells(template,preview.width,preview.height,options().gap,options().margin)[selected];
  if(!r)return;
  const box=preview.getBoundingClientRect(),stage=$('stage').getBoundingClientRect(),outline=$('selection');
  const sx=box.width/preview.width,sy=box.height/preview.height;
  outline.hidden=false;outline.style.left=`${box.left-stage.left+r.x*sx-1}px`;outline.style.top=`${box.top-stage.top+r.y*sy-1}px`;
  outline.style.width=`${r.w*sx}px`;outline.style.height=`${r.h*sy}px`;$('selection-label').textContent=`图片格 ${selected+1}`;
}
function updateCropUI(){
  const c=cells[selected];$('cell-number').textContent=String(selected+1);$('cell-select').value=String(selected);$('photo-select').value=c.photoId;
  for(const [id,key] of [['zoom','zoom'],['focus-x','focusX'],['focus-y','focusY']]){$(id).value=c[key];}
  $('zoom-val').textContent=`${c.zoom.toFixed(2)}×`;$('focus-x-val').textContent=`${Math.round(c.focusX*100)}%`;$('focus-y-val').textContent=`${Math.round(c.focusY*100)}%`;
  const disabled=!photos.has(c.photoId);for(const id of ['zoom','focus-x','focus-y','reset'])$(id).disabled=disabled;
}
function selectCell(i){selected=clamp(i,0,count()-1);updateCropUI();updateSelection();}
function rebuildCellSelectors(){
  $('cell-select').replaceChildren();$('swap-target').replaceChildren();
  for(let i=0;i<count();i++){for(const id of ['cell-select','swap-target']){const o=document.createElement('option');o.value=String(i);o.textContent=`图片格 ${i+1}`;$(id).append(o);}}
  $('swap-target').value=String((selected+1)%count());$('swap').disabled=count()<2;
}
function assignPhoto(id){cells[selected]={...emptyCell(),photoId:id};updateCropUI();requestRender();}
function renderPhotos(){
  $('photos').replaceChildren();$('photo-select').replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='暂不放入';$('photo-select').append(empty);
  for(const [id,p] of photos){
    const tile=document.createElement('div');tile.className='photo-tile';
    const button=document.createElement('button');button.className='photo-thumb';button.title=`放入选中图片格：${p.name}`;button.setAttribute('aria-label',button.title);
    const image=document.createElement('img');image.src=p.thumb;image.alt=p.name;button.append(image);button.addEventListener('click',()=>assignPhoto(id));
    const remove=document.createElement('button');remove.className='remove-photo';remove.textContent='×';remove.setAttribute('aria-label',`移除照片 ${p.name}`);remove.addEventListener('click',()=>removePhoto(id));
    const name=document.createElement('small');name.textContent=p.name;tile.append(button,remove,name);$('photos').append(tile);
    const option=document.createElement('option');option.value=id;option.textContent=p.name;$('photo-select').append(option);
  }
  $('photo-count').textContent=`${photos.size} 张`;updateCropUI();requestRender();
}
function removePhoto(id){
  if(cells.some(c=>c.photoId===id)&&!confirm('这张照片已放入拼图，移除后对应图片格将留空。继续吗？'))return;
  photos.get(id)?.image.close?.();photos.delete(id);cells.forEach((c,i)=>{if(c.photoId===id)cells[i]=emptyCell();});renderPhotos();
}
function usedPixels(){return [...photos.values()].reduce((sum,p)=>sum+p.width*p.height,0);}
function thumbnail(image,w,h){const c=document.createElement('canvas');const scale=Math.min(1,160/Math.max(w,h));c.width=Math.max(1,Math.round(w*scale));c.height=Math.max(1,Math.round(h*scale));const context=c.getContext('2d');context.imageSmoothingQuality='high';context.drawImage(image,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.8);}
async function decode(file){
  let image;
  if(window.createImageBitmap){
    let first;
    try{first=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{}
    if(first){
      const factor=Math.min(1,MAX_EDGE/Math.max(first.width,first.height));
      if(factor<1){try{image=await createImageBitmap(first,{resizeWidth:Math.max(1,Math.round(first.width*factor)),resizeHeight:Math.max(1,Math.round(first.height*factor)),resizeQuality:'high'});}catch{} }
      if(image){first.close();return {image,width:image.width,height:image.height};}
      if(factor===1)return {image:first,width:first.width,height:first.height};
      image=resize(first,first.width,first.height);first.close();return {image,width:image.width,height:image.height};
    }
  }
  const url=URL.createObjectURL(file);
  try{const img=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=()=>reject(new Error('图片解码失败'));el.src=url;});image=resize(img,img.naturalWidth,img.naturalHeight);return {image,width:image.width,height:image.height};}finally{URL.revokeObjectURL(url);}
}
function resize(image,w,h){const scale=Math.min(1,MAX_EDGE/Math.max(w,h)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*scale));c.height=Math.max(1,Math.round(h*scale));const context=c.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(image,0,0,c.width,c.height);return c;}
function addPhoto(p){const id=`photo-${++serial}`;p.thumb=thumbnail(p.image,p.width,p.height);photos.set(id,p);const free=cells.slice(0,count()).findIndex(c=>!c.photoId);if(free>=0)cells[free]={...emptyCell(),photoId:id};}
async function loadFiles(files){
  if(loading){status('照片正在读取，请稍候再添加。',true);return;}
  const version=generation;loading=true;requestRender();let added=0,errors=[];
  try{
    for(const file of files){
      if(version!==generation)break;
      if(photos.size>=MAX_PHOTOS){errors.push('照片库最多容纳 24 张，未读取的照片请分批制作');break;}
      if(!file.type.startsWith('image/')){errors.push(`${file.name} 不是图片`);continue;}
      if(file.size>30*1024*1024){errors.push(`${file.name} 超过 30 MB`);continue;}
      status(`正在读取：${file.name}`);
      try{const p=await decode(file);if(version!==generation){p.image.close?.();break;}if(usedPixels()+p.width*p.height>MAX_PIXELS){p.image.close?.();errors.push(`${file.name} 未加入：照片库已达到内存上限，请移除部分照片后重试`);continue;}addPhoto({...p,name:file.name});added++;renderPhotos();}catch{errors.push(`${file.name} 无法读取，请使用 JPG、PNG 或 WebP`);}
    }
    if(version===generation)status(`已加入 ${added} 张照片。${errors.length?errors.join('；'):'未放入画布的照片会保留在照片库，点击缩略图即可选用。'}`,!!errors.length);
  }finally{loading=false;$('files').value='';renderPhotos();}
}
$('files').addEventListener('change',e=>loadFiles([...e.target.files]));
$('clear').addEventListener('click',()=>{if(photos.size&&!confirm('清空当前照片库与画布？请先导出需要保留的作品。'))return;generation++;photos.forEach(p=>p.image.close?.());photos.clear();cells.forEach((_,i)=>cells[i]=emptyCell());renderPhotos();status('照片已清空。');});
for(const t of TEMPLATES){
  const button=document.createElement('button');button.className='template-button';button.dataset.template=t.id;button.setAttribute('aria-pressed',String(t.id===template));
  const diagram=document.createElement('span');diagram.className='template-diagram';diagram.setAttribute('aria-hidden','true');
  for(const r of layoutCells(t.id,38,28,.04,0)){const shape=document.createElement('i');Object.assign(shape.style,{left:`${r.x}px`,top:`${r.y}px`,width:`${r.w}px`,height:`${r.h}px`});diagram.append(shape);}
  const label=document.createElement('span');label.textContent=t.name;button.append(diagram,label);button.classList.toggle('active',t.id===template);
  button.addEventListener('click',()=>{template=t.id;selected=Math.min(selected,count()-1);document.querySelectorAll('[data-template]').forEach(b=>{const active=b.dataset.template===template;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});rebuildCellSelectors();updateCropUI();requestRender();});$('templates').append(button);
}
for(const name of Object.keys(RATIOS)){const button=document.createElement('button');button.className='ratio-button';button.textContent=name;button.classList.toggle('active',name===ratio);button.setAttribute('aria-pressed',String(name===ratio));button.addEventListener('click',()=>{ratio=name;$('ratio').value=name;document.querySelectorAll('.ratio-button').forEach(b=>{b.classList.toggle('active',b.textContent===name);b.setAttribute('aria-pressed',String(b.textContent===name));});requestRender();});$('ratios').append(button);}
for(const id of ['gap','margin'])$(id).addEventListener('input',()=>{$(`${id}-val`).textContent=`${Number($(id).value).toFixed(1)}%`;requestRender();});
function backgroundChanged(){document.querySelectorAll('[data-color]').forEach(b=>b.classList.toggle('selected',b.dataset.color===$('background').value));requestRender();}
$('background').addEventListener('input',backgroundChanged);document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{$('background').value=b.dataset.color;backgroundChanged();}));
$('cell-select').addEventListener('change',e=>selectCell(Number(e.target.value)));$('photo-select').addEventListener('change',e=>assignPhoto(e.target.value));
$('swap').addEventListener('click',()=>{const other=Number($('swap-target').value);if(other===selected){status('请选择另一张图片格进行交换。',true);return;}[cells[selected],cells[other]]=[cells[other],cells[selected]];updateCropUI();requestRender();status(`已交换图片格 ${selected+1} 与 ${other+1}。`);});
for(const [id,key] of [['zoom','zoom'],['focus-x','focusX'],['focus-y','focusY']])$(id).addEventListener('input',()=>{cells[selected][key]=Number($(id).value);updateCropUI();requestRender();});
$('reset').addEventListener('click',()=>{cells[selected]={...emptyCell(),photoId:cells[selected].photoId};updateCropUI();requestRender();});
function canvasPoint(e){const r=preview.getBoundingClientRect();return {x:(e.clientX-r.left)*preview.width/r.width,y:(e.clientY-r.top)*preview.height/r.height};}
preview.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;const point=canvasPoint(e),rects=layoutCells(template,preview.width,preview.height,options().gap,options().margin),index=rects.findIndex(r=>point.x>=r.x&&point.y>=r.y&&point.x<=r.x+r.w&&point.y<=r.y+r.h);
  if(index<0)return;selectCell(index);const c=cells[index],p=photos.get(c.photoId);if(!p)return;
  const r=rects[index],crop=cropImage(p.width,p.height,r.w,r.h,c.zoom,c.focusX,c.focusY);
  drag={pointer:e.pointerId,index,start:point,fx:c.focusX,fy:c.focusY,r,crop,iw:p.width,ih:p.height};preview.setPointerCapture(e.pointerId);e.preventDefault();
});
preview.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.pointer)return;const p=canvasPoint(e),d=drag,c=cells[d.index];c.focusX=d.iw-d.crop.sw>1?clamp(d.fx-(p.x-d.start.x)*d.crop.sw/d.r.w/(d.iw-d.crop.sw),0,1):.5;c.focusY=d.ih-d.crop.sh>1?clamp(d.fy-(p.y-d.start.y)*d.crop.sh/d.r.h/(d.ih-d.crop.sh),0,1):.5;updateCropUI();requestRender();});
for(const event of ['pointerup','pointercancel','lostpointercapture'])preview.addEventListener(event,()=>{drag=null;});
preview.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowDown'){selectCell((selected+1)%count());e.preventDefault();}else if(e.key==='ArrowLeft'||e.key==='ArrowUp'){selectCell((selected+count()-1)%count());e.preventDefault();}});
new ResizeObserver(updateSelection).observe(preview);
$('export').addEventListener('click',async()=>{
  if(loading||exporting||cells.slice(0,count()).some(c=>!photos.has(c.photoId))){status('请先给每张图片格放入照片。',true);return;}
  exporting=true;render();$('export').textContent='正在导出…';const canvas=document.createElement('canvas');
  try{const size=canvasSize(ratio,Number($('resolution').value));canvas.width=size.width;canvas.height=size.height;drawCollage(canvas.getContext('2d'),{...options(),...size,placeholder:false});const type=$('format').value;const blob=await new Promise(resolve=>canvas.toBlob(resolve,type,.94));if(!blob)throw new Error('浏览器无法生成图片，请尝试 2048 px');const url=URL.createObjectURL(blob);downloadUrls.add(url);const a=document.createElement('a');a.href=url;a.download=`collage-${template}-${Date.now()}.${type==='image/png'?'png':'jpg'}`;a.click();setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.delete(url);},60000);status(`已导出 ${size.width} × ${size.height} px 图片。`);}catch(e){status(`导出失败：${e.message||'请降低尺寸后重试'}`,true);}finally{canvas.width=canvas.height=1;exporting=false;$('export').textContent='导出图片 ↓';requestRender();}
});
$('demo').addEventListener('click',()=>{
  if(loading){status('请等待照片读取完成。',true);return;}
  if(photos.size+4>MAX_PHOTOS||usedPixels()+4*720*960>MAX_PIXELS){status('照片库空间不足，请先移除部分照片。',true);return;}
  const palettes=[['#d6d7c0','#788b79','#35594e'],['#d8d6cf','#afaca1','#696d69'],['#e7c7a7','#bf8765','#805f4b'],['#c1d3d6','#809b9d','#456569']];
  palettes.forEach((colors,i)=>{const c=document.createElement('canvas');c.width=720;c.height=960;const g=c.getContext('2d'),gradient=g.createLinearGradient(0,0,0,960);gradient.addColorStop(0,colors[0]);gradient.addColorStop(1,colors[1]);g.fillStyle=gradient;g.fillRect(0,0,720,960);g.fillStyle='#fdf6df';g.beginPath();g.arc(490-i*60,210+i*35,75,0,Math.PI*2);g.fill();for(let layer=0;layer<3;layer++){g.fillStyle=layer===2?colors[2]:colors[1];g.globalAlpha=.45+layer*.2;g.beginPath();g.moveTo(0,960);for(let x=0;x<=720;x+=12)g.lineTo(x,510+layer*125+Math.sin(x/150+i+layer)*65+Math.cos(x/70+i)*20);g.lineTo(720,960);g.closePath();g.fill();}g.globalAlpha=1;addPhoto({image:c,width:720,height:960,name:`示例 · 山野 ${i+1}`});});renderPhotos();status('已添加 4 张示例照片，可自由调整构图；你的原有照片仍保留在照片库。');
});
window.addEventListener('pagehide',e=>{if(e.persisted)return;generation++;photos.forEach(p=>p.image.close?.());downloadUrls.forEach(url=>URL.revokeObjectURL(url));});
rebuildCellSelectors();renderPhotos();render();
