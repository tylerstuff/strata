import { expect, it } from 'vitest';
import { environmentLevelApron, environmentLevelOffset } from '../../packages/core/src/imported/imported-environment-atlas.js';
it('preserves source texels and supplies adjacent faces and three-face corner means', () => {
  const bits=[0x3c00,0x4000,0x4200,0x4400,0x4500,0x4600]; // 1 through 6
  const source=new Uint16Array(2*2*12*4);
  for(let layer=0;layer<12;layer++)for(let p=0;p<4;p++)source.set([bits[layer%6]!,bits[layer%6]!,bits[layer%6]!,0x3c00],(layer*4+p)*4);
  const before=source.slice(), padded=environmentLevelApron(source,2);
  expect(source).toEqual(before);expect(padded.length).toBe(4*4*12*4);
  for(let layer=0;layer<12;layer++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)expect([...padded.subarray(((layer*4+y+1)*4+x+1)*4,((layer*4+y+1)*4+x+1)*4+4)])
    .toEqual([...source.subarray(((layer*2+y)*2+x)*4,((layer*2+y)*2+x)*4+4)]);
  expect(padded[0]).toBe(0x4200); // +X/+Y/+Z corner: mean(1,3,5)=3.
  expect(padded[16]).toBe(0x4500); // +X left edge extends to +Z.
  let end=0;for(let level=0;level<7;level++){expect(environmentLevelOffset(level)).toBe(end);end+=(64>>level)+2;}
  expect(end).toBe(141);
  expect(()=>environmentLevelApron(source,3)).toThrow();
});
