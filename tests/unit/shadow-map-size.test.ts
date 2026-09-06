import { expect, it } from 'vitest';
import { validateShadowMapSize } from '../../packages/core/src/rendering/raster-renderer.js';
it('retains the default and explicitly admits bounded quality choices',()=>{
 expect(validateShadowMapSize(undefined,4096)).toBe(2048);
 for(const size of [1024,2048,4096])expect(validateShadowMapSize(size,4096)).toBe(size);
 for(const size of [null,0,2049,8192,NaN,'4096'])expect(()=>validateShadowMapSize(size,8192)).toThrow();
 expect(()=>validateShadowMapSize(4096,2048)).toThrow(expect.objectContaining({code:'UNSUPPORTED_LIMIT'}));
});
