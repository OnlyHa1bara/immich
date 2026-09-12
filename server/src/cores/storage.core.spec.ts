import { Stats } from 'node:fs';
import { vitest } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetPathType } from 'src/enum.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

vitest.mock('src/constants.js', () => ({
  IWorker: 'IWorker',
}));

describe('StorageCore', () => {
  describe('isImmichPath', () => {
    beforeAll(() => {
      StorageCore.setMediaLocation('/photos');
    });

    it('should return true for APP_MEDIA_LOCATION path', () => {
      const immichPath = '/photos';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return true for paths within the APP_MEDIA_LOCATION', () => {
      const immichPath = '/photos/new/';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION and same starts', () => {
      const nonImmichPath = '/photos_new';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION', () => {
      const nonImmichPath = '/some/other/path';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });
  });

  describe('moveFile', () => {
    let sut: StorageCore;
    let mocks: ServiceMocks;

    beforeEach(() => {
      mocks = getMocks();
      sut = StorageCore.create(
        mocks.asset as never,
        mocks.config as never,
        mocks.crypto as never,
        mocks.move as never,
        mocks.person as never,
        mocks.storage as never,
        mocks.systemMetadata as never,
        mocks.logger as never,
      );
      mocks.systemMetadata.get.mockResolvedValue({ storageTemplate: { hashVerificationEnabled: false } });
    });

    const oldPath = '/data/upload/original.jpg';
    const historicalPath = '/data/library/original.jpg';
    const calculatedPath = '/data/library/original+1.jpg';
    const assetInfo = { sizeInBytes: 10, checksum: Buffer.from('expected-checksum') };

    const history = {
      id: 'move-id',
      entityId: 'asset-id',
      pathType: AssetPathType.Original,
      oldPath,
      newPath: historicalPath,
    };

    const p6 = () => {
      mocks.move.getByEntity.mockResolvedValue(history);
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === historicalPath));
    };

    it('should return true for a no-op without matching move history', async () => {
      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath: historicalPath,
          newPath: historicalPath,
        }),
      ).resolves.toBe(true);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('should return false when an original move has no asset info', async () => {
      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath,
          newPath: historicalPath,
        }),
      ).resolves.toBe(false);

      expect(mocks.move.create).not.toHaveBeenCalled();
    });

    it('should return false and retain history when neither incomplete move path exists', async () => {
      mocks.move.getByEntity.mockResolvedValue(history);
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath,
          newPath: historicalPath,
          assetInfo,
        }),
      ).resolves.toBe(false);

      expect(mocks.move.delete).not.toHaveBeenCalled();
    });

    it('should return false and retain history when rename fails outside EXDEV', async () => {
      mocks.move.create.mockResolvedValue({
        id: history.id,
        entityId: history.entityId,
        pathType: history.pathType,
        oldPath,
        newPath: historicalPath,
      });
      mocks.storage.rename.mockRejectedValue({ code: 'EACCES', message: 'permission denied' });

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath,
          newPath: historicalPath,
          assetInfo,
        }),
      ).resolves.toBe(false);

      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.move.delete).not.toHaveBeenCalled();
    });

    it('should complete p6 recovery at the historical target without renaming to a newly calculated duplicate path', async () => {
      p6();
      mocks.storage.stat.mockResolvedValue({ size: assetInfo.sizeInBytes } as Stats);

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath,
          newPath: calculatedPath,
          assetInfo,
        }),
      ).resolves.toBe(true);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.move.update).not.toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: history.entityId, originalPath: historicalPath });
      expect(mocks.move.delete).toHaveBeenCalledWith(history.id);
    });

    it('should clean up stale history after the database path was saved before the prior attempt crashed', async () => {
      mocks.move.getByEntity.mockResolvedValue(history);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.storage.stat.mockResolvedValue({ size: assetInfo.sizeInBytes } as Stats);

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath: historicalPath,
          newPath: historicalPath,
          assetInfo,
        }),
      ).resolves.toBe(true);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: history.entityId, originalPath: historicalPath });
      expect(mocks.move.delete).toHaveBeenCalledWith(history.id);
    });

    it.each([
      {
        name: 'size mismatch',
        configure: () => {
          mocks.storage.stat.mockResolvedValue({ size: assetInfo.sizeInBytes - 1 } as Stats);
        },
      },
      {
        name: 'checksum mismatch',
        configure: () => {
          mocks.systemMetadata.get.mockResolvedValue({ storageTemplate: { hashVerificationEnabled: true } });
          mocks.storage.stat.mockResolvedValue({ size: assetInfo.sizeInBytes } as Stats);
          mocks.crypto.hashFile.mockResolvedValue(Buffer.from('different-checksum'));
        },
      },
    ])('should retain move history when p6 recovery has a $name', async ({ configure }) => {
      p6();
      configure();

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: history.pathType,
          oldPath,
          newPath: calculatedPath,
          assetInfo,
        }),
      ).resolves.toBe(false);

      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.move.delete).not.toHaveBeenCalled();
    });

    it('should accept an unverified sidecar p6 recovery only when both directories are on the same device', async () => {
      const sidecarOldPath = '/data/upload/original.jpg.xmp';
      const sidecarNewPath = '/data/library/original.jpg.xmp';
      mocks.move.getByEntity.mockResolvedValue({
        ...history,
        pathType: AssetFileType.Sidecar,
        oldPath: sidecarOldPath,
        newPath: sidecarNewPath,
      });
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === sidecarNewPath));
      mocks.storage.stat.mockImplementation((path) => {
        if (path === sidecarNewPath) {
          return Promise.resolve({ size: 1, dev: 1 } as Stats);
        }
        if (path === sidecarOldPath) {
          return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        }
        return Promise.resolve({ dev: 1 } as Stats);
      });

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: AssetFileType.Sidecar,
          oldPath: sidecarOldPath,
          newPath: `${sidecarNewPath}.new`,
        }),
      ).resolves.toBe(true);

      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: history.entityId,
        type: AssetFileType.Sidecar,
        path: sidecarNewPath,
      });
      expect(mocks.move.delete).toHaveBeenCalledWith(history.id);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Accepting unverified recovery'));
    });

    it('should retain unverified sidecar p6 history when the directories are on different devices', async () => {
      const sidecarOldPath = '/data/upload/original.jpg.xmp';
      const sidecarNewPath = '/data/library/original.jpg.xmp';
      mocks.move.getByEntity.mockResolvedValue({
        ...history,
        pathType: AssetFileType.Sidecar,
        oldPath: sidecarOldPath,
        newPath: sidecarNewPath,
      });
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === sidecarNewPath));
      mocks.storage.stat.mockImplementation((path) => {
        if (path === sidecarNewPath) {
          return Promise.resolve({ size: 1, dev: 2 } as Stats);
        }
        if (path === sidecarOldPath) {
          return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        }
        return Promise.resolve({ dev: path.startsWith('/data/upload') ? 1 : 2 } as Stats);
      });

      await expect(
        sut.moveFile({
          entityId: history.entityId,
          pathType: AssetFileType.Sidecar,
          oldPath: sidecarOldPath,
          newPath: `${sidecarNewPath}.new`,
        }),
      ).resolves.toBe(false);

      expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
      expect(mocks.move.delete).not.toHaveBeenCalled();
    });
  });
});
