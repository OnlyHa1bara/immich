import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { ViewService } from 'src/services/view.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(ViewService.name, () => {
  let sut: ViewService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ViewService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getUniqueOriginalPaths', () => {
    it('should return unique original paths', async () => {
      const mockPaths = ['path1', 'path2', 'path3'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      const result = await sut.getUniqueOriginalPaths(authStub.admin);

      expect(result).toEqual(mockPaths);
      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledWith(authStub.admin.user.id);
    });

    it('should cache the result for repeated calls', async () => {
      const mockPaths = ['path1', 'path2'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      await sut.getUniqueOriginalPaths(authStub.admin);
      await sut.getUniqueOriginalPaths(authStub.admin);

      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledTimes(1);
    });

    it('should refresh the cache after an asset is created', async () => {
      const mockPaths = ['path1'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      await sut.getUniqueOriginalPaths(authStub.admin);
      sut.onAssetCreate({ asset: { id: 'asset-id', ownerId: authStub.admin.user.id } });
      await sut.getUniqueOriginalPaths(authStub.admin);

      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledTimes(2);
    });

    it('should refresh the cache after an asset is deleted', async () => {
      const mockPaths = ['path1'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      await sut.getUniqueOriginalPaths(authStub.admin);
      sut.onAssetDelete({ assetId: 'asset-id', userId: authStub.admin.user.id });
      await sut.getUniqueOriginalPaths(authStub.admin);

      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledTimes(2);
    });

    it('should refresh the cache after assets are bulk deleted', async () => {
      const mockPaths = ['path1'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      await sut.getUniqueOriginalPaths(authStub.admin);
      sut.onAssetDeleteAll({ assetIds: ['asset-1'], userId: authStub.admin.user.id });
      await sut.getUniqueOriginalPaths(authStub.admin);

      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAssetsByOriginalPath', () => {
    it('should return assets by original path', async () => {
      const path = '/asset';

      const asset1 = AssetFactory.create({ originalPath: '/asset/path1' });
      const asset2 = AssetFactory.create({ originalPath: '/asset/path2' });

      const mockAssets = [asset1, asset2];

      const mockAssetReponseDto = mockAssets.map((asset) => mapAsset(getForAsset(asset), { auth: authStub.admin }));

      mocks.view.getAssetsByOriginalPath.mockResolvedValue(mockAssets as any);

      const result = await sut.getAssetsByOriginalPath(authStub.admin, path);
      expect(result).toEqual(mockAssetReponseDto);
      await expect(mocks.view.getAssetsByOriginalPath(authStub.admin.user.id, path)).resolves.toEqual(mockAssets);
    });
  });
});
