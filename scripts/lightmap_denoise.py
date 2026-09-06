"""Offline OIDN RTLightmap CLI adapter. No native dependency enters browser bundles."""
import pathlib, subprocess, tempfile, shutil
import numpy as np

class LightmapDenoiser:
    def __init__(self, executable):
        self.executable=str(pathlib.Path(executable).resolve(strict=True))
        self.apply(np.ones((8,8,3),np.float32))
    def apply(self, rgb):
        source=np.ascontiguousarray(rgb,dtype='<f4')
        if source.ndim!=3 or source.shape[2]!=3 or not np.isfinite(source).all() or np.min(source)<0:
            raise ValueError('Denoising requires finite nonnegative RGB radiance')
        height,width=source.shape[:2]
        with tempfile.TemporaryDirectory(prefix='strata-lightmap-') as temporary:
            root=pathlib.Path(temporary);input=root/'input.pfm';output=root/'output.pfm'
            input.write_bytes(f'PF\n{width} {height}\n-1.0\n'.encode()+source[::-1].tobytes())
            result=subprocess.run([self.executable,'--device','cpu','--filter','RTLightmap','--hdr',str(input),'--output',str(output),'--threads','6','--maxmem','512'],capture_output=True,text=True,timeout=600)
            if result.returncode: raise RuntimeError('OIDN lightmap filtering failed: '+result.stderr+result.stdout)
            with output.open('rb') as f:
                if f.readline().strip()!=b'PF':raise RuntimeError('Unexpected OIDN image type')
                dimensions=f.readline().split()
                if dimensions!=[str(width).encode(),str(height).encode()]:raise RuntimeError('OIDN dimensions changed')
                scale=float(f.readline());raw=f.read()
            if len(raw)!=width*height*12 or scale==0:raise RuntimeError('Invalid OIDN image payload')
            filtered=np.frombuffer(raw,dtype='<f4' if scale<0 else '>f4').reshape(height,width,3)[::-1]*abs(scale)
            if not np.isfinite(filtered).all():raise RuntimeError('Nonfinite denoised lightmap')
            return np.maximum(filtered,0)
    def close(self): pass

def find_denoiser(option='none'):
    if option=='none':return None
    executable=shutil.which('oidnDenoise') if option=='auto' else option
    if not executable:raise RuntimeError('Pass --denoiser /path/to/oidnDenoise, or --denoiser none for raw diagnostics')
    return LightmapDenoiser(executable)
