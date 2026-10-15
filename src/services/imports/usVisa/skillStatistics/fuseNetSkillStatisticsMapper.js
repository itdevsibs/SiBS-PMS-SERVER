// Maps FuseNet Skill Statistics rows through the same canonical Fuse report mapping.
import {
  getFusecomDataGrain,
  getFusecomFieldMappings,
  mapFusecomSkillStatisticsRow,
} from "./fusecomSkillStatisticsMapper.js";

export const FUSENET_SOURCE_SYSTEM = "FUSENET";

export function getFuseNetDataGrain(sheetName) {
  return getFusecomDataGrain(sheetName);
}

export function getFuseNetFieldMappings() {
  return getFusecomFieldMappings();
}

export function mapFuseNetSkillStatisticsRow(sourceRow = {}, options = {}) {
  return mapFusecomSkillStatisticsRow(sourceRow, {
    ...options,
    sourceSystem: FUSENET_SOURCE_SYSTEM,
  });
}
