import { promises as fs } from 'fs';

async function moveDirectoryAcrossDevicesSafe(sourceDir, targetDir, fsImpl = fs) {
  try {
    await fsImpl.rename(sourceDir, targetDir);
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    await fsImpl.cp(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true });
    await fsImpl.rm(sourceDir, { recursive: true, force: true });
  }
}

export { moveDirectoryAcrossDevicesSafe };
