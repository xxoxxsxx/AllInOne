import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWatermark, normalizeWatermarks, watermarkLayout, watermarkHitTest, moveWatermark, resizeWatermark, drawWatermarks, SIZE_LIMITS, collectWatermarkFontSpecs } from '../public/collage/watermarks.js';

function context() {
  const calls:any[]=[];
  const ctx:any={font:'',save(){},restore(){},measureText(text:string){const size=Number(this.font.match(/([\d.]+)px/)[1]);return {width:text.length*size*.5,actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};},fillText(...args:any[]){calls.push({args,font:this.font,color:this.fillStyle,alpha:this.globalAlpha});}};
  return {ctx,calls};
}
const mark=(id='a',extra={})=>normalizeWatermark({id,text:'Hello',x:.5,y:.5,size:40,font:'sans',color:'#ffffff',opacity:1,visible:true,...extra})!;

test('multiple watermarks survive normalization with distinct IDs and independent styles',()=>{
  const list=normalizeWatermarks(Array.from({length:15},(_,i)=>({...mark('same'),text:`Mark ${i}`,size:20+i})));
  assert.equal(list.length,15);
  assert.equal(new Set(list.map(m=>m.id)).size,15);
  assert.equal(list[14].text,'Mark 14');
  assert.equal(list[0].size,20);
  assert.equal(list[14].size,34);
  assert.deepEqual(normalizeWatermarks(null),[]);
  const collision=normalizeWatermarks([mark('wm-2'),mark('wm-2'),mark('wm-3'),mark('wm-3')]);
  assert.equal(new Set(collision.map(m=>m.id)).size,collision.length);
});

test('saved settings tolerate malformed input and clamp invalid numeric values',()=>{
  const normalized=normalizeWatermark({id:'bad',text:'Restored',font:'missing',size:1e9,x:-5,y:10,opacity:10,color:'invalid'});
  assert.ok(normalized);
  assert.equal(normalized.font,'sans');
  assert.equal(normalized.size,SIZE_LIMITS.max);
  assert.equal(normalized.x,0);assert.equal(normalized.y,1);
  assert.equal(normalized.opacity,1);
  assert.match(normalized.color,/^#[0-9a-f]{6}$/i);
  assert.deepEqual(normalizeWatermarks([null,42,'invalid']),[]);
});

test('resize adjusts only selected size, respects limits and leaves location unchanged',()=>{
  const original=mark();
  const larger=resizeWatermark(original,40,120);
  assert.equal(larger.size,80);
  assert.equal(larger.x,original.x);assert.equal(larger.y,original.y);
  assert.equal(original.size,40);
  assert.equal(resizeWatermark(original,40,100000).size,SIZE_LIMITS.max);
  assert.equal(resizeWatermark(original,40,-100000).size,SIZE_LIMITS.min);
  assert.equal(moveWatermark(original,100,-100,1000,500).x,.6);
  assert.equal(moveWatermark(original,100,-100,1000,500).y,.3);
});

test('watermark geometry scales consistently between preview and export',()=>{
  const {ctx}=context();
  const a=watermarkLayout(ctx,mark(),1000,750)!,b=watermarkLayout(ctx,mark(),4000,3000)!;
  for(const key of ['left','top','width','height','baselineY','centerX','centerY','size'] as const)assert.ok(Math.abs(b[key]-a[key]*4)<1e-8,key);
});

test('overlapping watermarks prefer selected layer and otherwise topmost',()=>{
  const {ctx}=context();
  const layouts=[watermarkLayout(ctx,mark('a'),1000,750),watermarkLayout(ctx,mark('b'),1000,750)];
  assert.equal(watermarkHitTest(layouts,{x:500,y:375},0)?.mark.id,'b');
  assert.equal(watermarkHitTest(layouts,{x:500,y:375},0,'a')?.mark.id,'a');
  assert.equal(watermarkHitTest(layouts,{x:0,y:0},0),null);
});

test('export renderer draws each visible nonempty watermark with its own font and styling',()=>{
  const {ctx,calls}=context();
  drawWatermarks(ctx,[mark('a'),mark('b',{font:'serif',size:70,color:'#123456',opacity:.4}),mark('c',{visible:false}),mark('d',{text:''})],1000,750);
  assert.equal(calls.length,2);
  assert.notEqual(calls[0].font,calls[1].font);
  assert.equal(calls[1].color,'#123456');assert.equal(calls[1].alpha,.4);
  assert.equal(collectWatermarkFontSpecs([mark('a'),mark('b')]).length,1);
});
