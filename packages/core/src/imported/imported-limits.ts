/** Retained texture payload limit for one imported scene, including mip chains and fixed textures. */
export const importedTextureBudget = 512 * 1024 * 1024;

/** Two generated RGBA16F face-apron atlases with seven levels, plus the RG16F DFG lookup. */
export const importedEnvironmentTextureBytes = 66 * 141 * 12 * 8 + 16384;

/** Tightly uploaded level rectangles plus the DFG; unused atlas space is not uploaded. */
export const importedEnvironmentUploadBytes = [64,32,16,8,4,2,1].reduce((sum,edge)=>sum+(edge+2)**2*12*8,16384);
