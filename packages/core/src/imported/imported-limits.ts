/** Retained texture payload limit for one imported scene, including mip chains and fixed textures. */
export const importedTextureBudget = 512 * 1024 * 1024;

/** Two generated RGBA16F cubemaps with seven levels, plus the RG16F DFG lookup. */
export const importedEnvironmentTextureBytes = 540640;
