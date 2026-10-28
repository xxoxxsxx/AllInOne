import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, RATIOS, canvasSize, layoutCells, cropImage } from '../public/collage/engine.js';

test('all collage layouts stay inside canvas without overlap at all supported ratios', () => {
  for (const template of TEMPLATES) for (const ratio of Object.keys(RATIOS)) {
    const {width,height} = canvasSize(ratio,4096);
    for (const [gap,margin] of [[0,0],[.012,.035],[.08,.15]]) {
      const cells = layoutCells(template.id,width,height,gap,margin);
      assert.equal(cells.length,template.count);
      for (const r of cells) {
        assert.ok(r.w>0 && r.h>0);
        assert.ok(r.x>=0 && r.y>=0 && r.x+r.w<=width+.001 && r.y+r.h<=height+.001);
      }
      for(let i=0;i<cells.length;i++) for(let j=i+1;j<cells.length;j++) {
        const a=cells[i],b=cells[j];
        const overlapX=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
        const overlapY=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        assert.ok(overlapX<=.001 || overlapY<=.001,`${template.id}: cells overlap`);
      }
    }
  }
});

test('crop remains within source and preserves target aspect for portrait and landscape photos',()=>{
  for(const [iw,ih] of [[4000,3000],[3000,4000],[800,800]])
    for(const [w,h] of [[400,100],[100,400],[300,300]])
      for(const zoom of [1,2,4]) for(const focus of [0,.5,1]) {
        const c=cropImage(iw,ih,w,h,zoom,focus,focus);
        assert.ok(c.sx>=0 && c.sy>=0 && c.sw>0 && c.sh>0);
        assert.ok(c.sx+c.sw<=iw+.001 && c.sy+c.sh<=ih+.001);
        assert.ok(Math.abs(c.sw/c.sh-w/h)<1e-8);
      }
});

test('export dimensions keep requested long edge and match preview geometry',()=>{
  for(const ratio of Object.keys(RATIOS)) {
    const preview=canvasSize(ratio,1000), output=canvasSize(ratio,4000);
    assert.equal(Math.max(output.width,output.height),4000);
    const a=layoutCells('hero3',preview.width,preview.height), b=layoutCells('hero3',output.width,output.height);
    a.forEach((r,i)=> { for(const key of ['x','y','w','h'] as const) assert.ok(Math.abs(r[key]*4-b[i][key])<4); });
  }
});
