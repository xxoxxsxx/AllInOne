// Shared geometry and renderer: no DOM dependency, usable from Node tests.
export const TEMPLATES = [
  {id:'single',name:'单幅留白',count:1},
  {id:'double-h',name:'左右双拼',count:2},
  {id:'double-v',name:'上下双拼',count:2},
  {id:'strip',name:'三联画',count:3},
  {id:'strip-v',name:'上下三拼',count:3},
  {id:'hero2',name:'一主两辅',count:3},
  {id:'hero3',name:'一主三辅',count:4},
  {id:'grid4',name:'四宫格',count:4},
  {id:'grid6',name:'六宫格',count:6},
  {id:'grid9',name:'九宫格',count:9},
];
export const RATIOS = {'1:1':1,'3:4':3/4,'4:3':4/3,'9:16':9/16,'16:9':16/9};
export const clamp = (v,min,max) => Math.min(max,Math.max(min,v));
export function canvasSize(ratio,longEdge) {
  const r=RATIOS[ratio] || 1;
  return r>=1 ? {width:Math.round(longEdge),height:Math.round(longEdge/r)} : {width:Math.round(longEdge*r),height:Math.round(longEdge)};
}
export function layoutCells(templateId,width,height,gapRatio=.012,marginRatio=.035) {
  const short=Math.min(width,height),margin=short*clamp(marginRatio,0,.15),gap=short*clamp(gapRatio,0,.08);
  const x=margin,y=margin,w=width-2*margin,h=height-2*margin;
  const grid=(cols,rows)=>Array.from({length:cols*rows},(_,i)=>({x:x+(i%cols)*(w+gap)/cols,y:y+Math.floor(i/cols)*(h+gap)/rows,w:(w-gap*(cols-1))/cols,h:(h-gap*(rows-1))/rows}));
  if(templateId==='double-h') return grid(2,1);
  if(templateId==='double-v') return grid(1,2);
  if(templateId==='strip') return grid(3,1);
  if(templateId==='strip-v') return grid(1,3);
  if(templateId==='hero2'||templateId==='hero3') {
    const n=templateId==='hero2'?2:3,heroW=(w-gap)*.64,sideW=w-gap-heroW;
    return [{x,y,w:heroW,h},...Array.from({length:n},(_,i)=>({x:x+heroW+gap,y:y+i*(h+gap)/n,w:sideW,h:(h-gap*(n-1))/n}))];
  }
  if(templateId==='grid4') return grid(2,2);
  if(templateId==='grid6') return grid(2,3);
  if(templateId==='grid9') return grid(3,3);
  return [{x,y,w,h}];
}
export function cropImage(imageWidth,imageHeight,cellWidth,cellHeight,zoom=1,focusX=.5,focusY=.5) {
  const iw=Math.max(1,imageWidth),ih=Math.max(1,imageHeight),aspect=Math.max(1e-9,cellWidth/cellHeight);
  const z=clamp(Number(zoom)||1,1,4);
  const sw=Math.min(iw,ih*aspect)/z,sh=sw/aspect;
  return {sx:(iw-sw)*clamp(focusX,0,1),sy:(ih-sh)*clamp(focusY,0,1),sw,sh};
}
export function drawCollage(ctx,{width,height,template='grid4',gap=.012,margin=.035,background='#ffffff',cells=[],photos=new Map(),placeholder=true}) {
  const rects=layoutCells(template,width,height,gap,margin);
  ctx.save();ctx.clearRect(0,0,width,height);ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  rects.forEach((r,i)=>{
    const cell=cells[i],photo=cell&&photos.get(cell.photoId);
    if(photo) {
      const c=cropImage(photo.width,photo.height,r.w,r.h,cell.zoom,cell.focusX,cell.focusY);
      ctx.drawImage(photo.image,c.sx,c.sy,c.sw,c.sh,r.x,r.y,r.w,r.h);
    } else if(placeholder) {
      ctx.fillStyle='#eeede9';ctx.fillRect(r.x,r.y,r.w,r.h);
      ctx.fillStyle='#8b8d87';ctx.font=`${Math.max(12,Math.min(r.w,r.h)*.11)}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(i+1),r.x+r.w/2,r.y+r.h/2);
    }
  });ctx.restore();return rects;
}
