import {
  WarmContainerPool,
  getWarmPool,
  _resetWarmPool,
} from './WarmContainerPool.js';

export const DatabaseContainerPool = WarmContainerPool;
export const getDatabasePool = getWarmPool;
export const _resetDatabasePool = _resetWarmPool;

export default {
  DatabaseContainerPool,
  getDatabasePool,
  _resetDatabasePool,
};
