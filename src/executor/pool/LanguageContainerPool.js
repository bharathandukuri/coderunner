import { WarmContainerPool, getWarmPool } from "./WarmContainerPool.js";

export const LanguageContainerPool = WarmContainerPool;
export const getLanguagePool = getWarmPool;
export const ContainerPool = WarmContainerPool;
export const getContainerPool = getWarmPool;

export default {
  LanguageContainerPool,
  getLanguagePool,
  ContainerPool,
  getContainerPool,
};
