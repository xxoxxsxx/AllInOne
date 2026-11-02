// 文字水印列表：模型校验与旧版平铺设置迁移，编辑器、渲染与持久化共用。
// 与 watermark-geometry.js 相同的 IIFE 模式，可在 Node vm 中独立测试。
(() => {
  'use strict';
  const FONTS=['sans','serif','mono','hand'];
  const POSITIONS=['seam','bottom-right','bottom-left','top-right','top-left','bottom-center','top-center','center-left','center-right','center','custom'];
  const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
  const num=(value,min,max,fallback)=>{const n=Number(value);return Number.isFinite(n)?clamp(n,min,max):fallback;};
  // 校验并补全一条水印记录；文字允许为空（新建后未输入），id 缺失且无兜底时返回 null。
  function normalizeLayer(raw,fallbackId){
    if(!raw||typeof raw!=='object')return null;
    const id=typeof raw.id==='string'&&raw.id.trim()?raw.id.trim().slice(0,40):String(fallbackId==null?'':fallbackId);
    if(!id)return null;
    return {id,text:typeof raw.text==='string'?raw.text.slice(0,40):'',
      font:FONTS.includes(raw.font)?raw.font:'sans',
      size:num(raw.size,6,180,45),opacity:num(raw.opacity,10,100,100),
      color:/^#[0-9a-fA-F]{6}$/.test(raw.color)?raw.color:'#ffffff',
      position:POSITIONS.includes(raw.position)?raw.position:'bottom-right',
      x:num(raw.x,0,100,50),y:num(raw.y,0,100,50)};
  }
  // 规范整张列表：丢弃无效项，保证 id 唯一；不限制条数。
  function normalizeLayers(list){
    const out=[],seen=new Set();
    (Array.isArray(list)?list:[]).forEach((raw,index)=>{
      const layer=normalizeLayer(raw,`wm-${index+1}`);
      if(!layer)return;
      let id=layer.id,suffix=1;
      while(seen.has(id))id=`${layer.id}~${suffix++}`;
      seen.add(id);
      out.push({...layer,id});
    });
    return out;
  }
  // 旧版平铺设置键 → 单条水印；仅当用户明确开启且填写了文字，位置缺省沿用旧的交界线正中。
  function migrateLegacyLayer(saved){
    if(!saved||typeof saved!=='object'||saved['watermark-on']!=='true')return null;
    const text=typeof saved['watermark-text']==='string'?saved['watermark-text'].trim():'';
    if(!text)return null;
    return normalizeLayer({id:'wm-1',text,
      font:saved['watermark-font'],
      size:saved['watermark-size'],opacity:saved['watermark-opacity'],
      color:saved['text-color'],
      position:POSITIONS.includes(saved['watermark-position'])?saved['watermark-position']:'seam',
      x:saved['watermark-x'],y:saved['watermark-y']},'wm-1');
  }
  window.FrameLabWatermarkLayers={normalizeLayer,normalizeLayers,migrateLegacyLayer};
})();
