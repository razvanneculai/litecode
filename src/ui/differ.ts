import { createPatch } from "diff";

export function computePatch(filePath: string, before: string, after: string): string {
  return createPatch(filePath, before, after, "", "");
}

export function computeNewFilePatch(filePath: string, after: string): string {
  return createPatch(filePath, "", after, "", "");
}

export function computeDeletePatch(filePath: string, before: string): string {
  return createPatch(filePath, before, "", "", "");
}
