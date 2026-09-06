"""Generated HDR signal test for the optional offline denoiser adapter."""
import pathlib,sys,numpy as np
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'scripts'))
from lightmap_denoise import find_denoiser
filter=find_denoiser(sys.argv[sys.argv.index('--')+1])
truth=np.broadcast_to(np.array([2.0,.5,.125],np.float32),(96,96,3)).copy()
noise=np.maximum(truth+np.random.default_rng(64).normal(0,.12,truth.shape).astype(np.float32),0)
result=filter.apply(noise);interior=np.s_[16:-16,16:-16,:]
before=float(np.mean((noise[interior]-truth[interior])**2));after=float(np.mean((result[interior]-truth[interior])**2))
if after>=before*.5 or np.max(np.abs(result[interior].mean(axis=(0,1))-truth[0,0]))>.06:raise RuntimeError('Denoiser failed HDR noise/bias contract')
filter.close();print('HDR_DENOISE_PASSED',{'inputMse':before,'outputMse':after},flush=True)
